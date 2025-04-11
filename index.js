require('dotenv').config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const axios = require('axios'); // To send data to the transcription service
const SileroVADStream = require('./silero_stream'); // Require from same directory

const app = express();

// --- Configuration ---
// Use environment variables with defaults
const MIN_SPEECH_DURATION = parseInt(process.env.VAD_MIN_SPEECH_DURATION_MS || '1000', 10); // Minimum speech duration in milliseconds
// IMPORTANT: Ensure the path '/transcribe' is correct for your STT service or update STT_URL in your .env file
const STT_URL = process.env.STT_URL || 'http://localhost:6021/transcribe'; // URL of the STT service

// Audio configuration (Input from client)
const INPUT_AUDIO_CONFIG = {
  sampleRate: 8000,
  channels: 1,
  bitsPerSample: 16,
};

// Path to the ONNX model (relative to this server.js file) - Keeping this hardcoded for now
const MODEL_PATH = path.join(__dirname, 'silero_vad.onnx');
if (!fs.existsSync(MODEL_PATH)) {
    console.error(`\n!!! FATAL ERROR: ONNX model not found at ${MODEL_PATH}`);
    console.error(`Ensure 'silero_vad.onnx' is inside the 'vad_service' directory.`);
    process.exit(1);
}

// --- VAD Stream Handler ---
const handleAudioStream = async (req, res) => {
  let speechStartTime = null;
  let vadStream = null; // Define vadStream here to access it in error handlers

  // The VAD service only detects speech and forwards audio.
  // It NOW waits for transcription and sends it back to the original client.
  // The client would need a separate mechanism (e.g., WebSocket) to get results.
  res.setHeader("Content-Type", "text/plain; charset=utf-8"); // Ensure correct encoding for text
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  console.log(`\n[${new Date().toISOString()}] VAD Service: New connection`);

  try {
      // Use environment variables for VAD parameters
      const vadThreshold = parseFloat(process.env.VAD_THRESHOLD || '0.2');
      const vadMinSilenceMs = parseInt(process.env.VAD_MIN_SILENCE_MS || '500', 10);
      const vadSpeechPadMs = parseInt(process.env.VAD_SPEECH_PAD_MS || '300', 10);
      const onnxProvider = process.env.ONNX_PROVIDER || 'cpu';

      vadStream = new SileroVADStream({
        inputSampleRate: INPUT_AUDIO_CONFIG.sampleRate,
        modelPath: MODEL_PATH,
        // Use parameters from environment variables or defaults
        threshold: vadThreshold,
        minSilenceDurationMs: vadMinSilenceMs,
        speechPadMs: vadSpeechPadMs,
        provider: onnxProvider // Pass provider from env
      });

      // Get the actual sample rate the VAD stream outputs (likely 16000Hz)
      const outputSampleRate = vadStream.options.sampleRate;
      console.log(`[VAD Service] VAD initialized. Outputting audio at ${outputSampleRate}Hz.`);
      console.log(` - Threshold: ${vadThreshold}, Min Silence: ${vadMinSilenceMs}ms, Padding: ${vadSpeechPadMs}ms, Provider: ${onnxProvider}`);

      req.pipe(vadStream)
        .on('error', (err) => {
          console.error(`\n!!! VAD Service: SileroVADStream Error: ${err.message}`);
          if (!res.writableEnded) {
              res.status(500).write(`VAD Processing Error: ${err.message}\n`);
              res.end();
          }
        })
        .on("data", async ({ speech: speechEvent, audioData: chunk }) => {
          // chunk is at VAD's internal rate (e.g., 16kHz)

          if (speechEvent.start) {
            console.log(`(${new Date().toISOString()}) VAD Service: Speech Start Detected`);
            speechStartTime = Date.now();
            // No file handling needed here
          }

          if (speechEvent.end) {
            const speechDuration = Date.now() - speechStartTime;
            console.log(`(${new Date().toISOString()}) VAD Service: Speech End Detected - Duration: ${(speechDuration / 1000).toFixed(2)}s`);

            // Reset start time for next segment
            speechStartTime = null;

            // Use the chunk directly from the end event (includes padding)
            const combinedAudio = chunk && chunk.length > 0 ? chunk : Buffer.alloc(0);

            if (!combinedAudio || combinedAudio.length === 0) {
              console.log("[VAD Service] Speech end event received no audio data, discarding.");
              return;
            }

            if (speechDuration >= MIN_SPEECH_DURATION) {
              console.log(`[VAD Service] Sending audio chunk (${(combinedAudio.length / 1024).toFixed(2)} KB, ${outputSampleRate}Hz) to STT Service...`);

              try {
                // Send raw audio buffer and sample rate to transcription service
                const response = await axios.post(STT_URL, combinedAudio, { // Use STT_URL
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'X-Sample-Rate': outputSampleRate // Send sample rate as a header
                    },
                    maxBodyLength: Infinity, // Allow large audio buffers
                    maxContentLength: Infinity
                });
                console.log(`[VAD Service] Successfully sent audio to STT Service. Status: ${response.status}`); // Updated log

                // Extract transcription from the response
                const transcription = response.data && response.data.transcription;

                if (transcription && !res.writableEnded) {
                    console.log(`[VAD Service] Received transcription: \"${transcription}\". Sending back to client.`);
                    // Send transcription back to the original client
                    res.write(transcription + "\n"); // Add newline as a delimiter
                } else if (!res.writableEnded) {
                     console.log("[VAD Service] Received empty or no transcription data from service.");
                     // Optionally send an indication back to client
                     // res.write("[No transcription]\n");
                }

              } catch (err) { // Renamed error variable for clarity
                console.error(`[VAD Service] Failed to send/receive from STT Service at ${STT_URL}`); // Updated log
                if (err.response) {
                    // The request was made and the server responded with a status code
                    // that falls out of the range of 2xx
                    console.error(` - Status: ${err.response.status}`);
                    console.error(` - Data: ${JSON.stringify(err.response.data)}`); // Log response data if available
                } else if (err.request) {
                    // The request was made but no response was received
                    console.error(' - No response received:', err.message);
                } else {
                    // Something happened in setting up the request that triggered an Error
                    console.error(' - Error setting up request:', err.message);
                }

                // Inform the client about the error
                 if (!res.writableEnded) {
                    res.write("[VAD Service: Error during transcription process]\n");
                 }
              }
            } else {
              console.log(`[VAD Service] Speech too short (${(speechDuration / 1000).toFixed(2)}s), discarding.`);
            }
          } // end speech.end handling
        }) // end vadStream.on('data')
        .on('finish', () => {
          console.log(`(${new Date().toISOString()}) VAD Service: VAD Stream finished processing.`);
          // Do NOT end the response here automatically.
          // End it only when the client connection ends (req.on('end'))
          // or if a critical error occurs.
          // if (!res.writableEnded) {
          //   res.end();
          // }
        });

  } catch (initError) {
      console.error(`[VAD Service] Failed to initialize VAD stream: ${initError.message}`);
      if (!res.writableEnded) {
          res.status(500).write(`VAD Initialization Error: ${initError.message}\n`);
          res.end();
      }
      return; // Stop further processing
  }

  req.on("end", () => {
    console.log(`(${new Date().toISOString()}) VAD Service: Client connection ended.`);
    // VAD stream 'finish' event usually handles ending the response.
    // Ensure it ends if it hasn't already.
    if (!res.writableEnded) {
        res.end();
    }
  });

  req.on("error", (err) => {
    console.error(`(${new Date().toISOString()}) VAD Service: Request stream error:`, err);
    if (vadStream) {
        vadStream.unpipe(req);
        vadStream.destroy(err);
    }
    if (!res.headersSent) {
        res.status(500).json({ message: "Error receiving audio stream" });
    } else if (!res.writableEnded) {
        res.end();
    }
  });
};


// --- Route Configuration ---
app.post('/speech-to-text-stream', handleAudioStream);

// Start the VAD server
const VAD_PORT = process.env.PORT || 6019;
app.listen(VAD_PORT, () => {
  console.log(`\n=== VAD Service Started ===`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Listening on port ${VAD_PORT}`);
  console.log(`Forwarding audio to: ${STT_URL}`); // Use STT_URL
  console.log(`========================\n`);
});

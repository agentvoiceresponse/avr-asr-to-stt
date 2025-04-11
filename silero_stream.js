const { Transform } = require('stream');
const ort = require('onnxruntime-node');

class SileroVADStream extends Transform {
  constructor(options = {}) {
    super({
      // Ensure chunks are treated as Buffers, and output objects are allowed
      writableObjectMode: false,
      readableObjectMode: true,
    });

    // --- Configuration ---
    this.options = {
      // Default Silero VAD sample rate
      sampleRate: options.sampleRate || 16000,
      // Frame size Silero VAD expects (adjust if necessary based on model)
      // Common sizes are 256, 512, 768, 1024, 1536 for 16kHz
      // e.g., 30ms at 16kHz = 480 samples. Using 512 for now.
      frameSize: options.frameSize || 512,
      // VAD thresholds and timing (adjust as needed)
      threshold: options.threshold || 0.5,
      minSilenceDurationMs: options.minSilenceDurationMs || 100, // Time to wait before declaring end
      speechPadMs: options.speechPadMs || 100, // Add padding before/after speech
      // ONNX model path
      modelPath: options.modelPath || './silero_vad.onnx', // Default path, make sure it exists
      // ONNX execution provider (e.g., 'cpu', 'cuda', 'dml')
      provider: options.provider || 'cpu',
      ...options // Allow overriding
    };

    // --- VAD State ---
    this.vadModel = null; // ONNX session
    this.state = {
      // h: null, // LSTM hidden state tensor - Model uses single state tensor
      // c: null, // LSTM cell state tensor - Model uses single state tensor
      state: null, // Combined state tensor for this model
      sr: null,    // Sample rate tensor
      inputBuffer: Buffer.alloc(0), // Buffer for incoming audio
      speechBuffer: [], // Buffer for detected speech frames + padding
      isSpeaking: false,
      silenceFramesCount: 0,
      speechStartReported: false,
    };

    // Calculate internal timing based on frame size and sample rate
    this.samplesPerMs = this.options.sampleRate / 1000;
    this.frameSizeInBytes = this.options.frameSize * 2; // Assuming 16-bit PCM
    this.minSilenceFrames = Math.ceil((this.options.minSilenceDurationMs * this.samplesPerMs) / this.options.frameSize);
    this.speechPadFrames = Math.ceil((this.options.speechPadMs * this.samplesPerMs) / this.options.frameSize);

    // Flag to ensure initialization happens only once
    this.isInitialized = false;

    // Start initialization immediately (or lazily on first data)
    this._initialize();
  }

  async _initialize() {
    try {
      console.log(`Initializing Silero VAD Stream...`);
      console.log(` - Model Path: ${this.options.modelPath}`);
      console.log(` - Sample Rate: ${this.options.sampleRate} Hz`);
      console.log(` - Frame Size: ${this.options.frameSize} samples`);
      console.log(` - ONNX Provider: ${this.options.provider}`);

      // TODO: Validate options (e.g., check if model file exists)

      this.vadModel = await ort.InferenceSession.create(this.options.modelPath, {
         executionProviders: [this.options.provider],
         // Optional: Add other session options like graph optimization level
      });
      console.log('ONNX session created successfully.');

      // Initialize state tensors h and c based on the model's expected input shape
      // This model uses a single 'state' tensor with shape [2, 1, 128]
      const stateShape = [2, 1, 128];
      const stateSize = stateShape.reduce((a, b) => a * b, 1);
      this.state.state = new ort.Tensor('float32', new Float32Array(stateSize).fill(0), stateShape);

      // Initialize sample rate tensor (int64, shape [1])
      this.state.sr = new ort.Tensor('int64', [BigInt(this.options.sampleRate)], [1]);

      console.log('VAD state and sr tensors initialized.');
      this.isInitialized = true;
      console.log("Silero VAD Stream Initialized.");

      // Allow processing to start if data arrived before init finished
      this.emit('initialized');

    } catch (error) {
      console.error('Failed to initialize Silero VAD Stream:', error);
      this.emit('error', new Error(`Failed to initialize VAD: ${error.message}`));
    }
  }

  async _transform(chunk, encoding, callback) {
    if (!this.isInitialized) {
      // Wait for initialization before processing data
      this.once('initialized', () => this._processChunk(chunk, callback));
      this.once('error', (err) => callback(err)); // Handle init errors
      return;
    }
    this._processChunk(chunk, callback);
  }

  async _processChunk(chunk, callback) {
    try {
      this.state.inputBuffer = Buffer.concat([this.state.inputBuffer, chunk]);

      while (this.state.inputBuffer.length >= this.frameSizeInBytes) {
        const audioFramePCM = this.state.inputBuffer.slice(0, this.frameSizeInBytes);
        this.state.inputBuffer = this.state.inputBuffer.slice(this.frameSizeInBytes);

        // 1. Convert frame to Float32Array
        const audioFrameFloat32 = this._bufferToFloat32(audioFramePCM);

        // 2. Prepare ONNX inputs
        const inputs = {
          // Input names depend on the specific Silero VAD model
          // Check model structure using Netron or similar tool
          input: new ort.Tensor('float32', audioFrameFloat32, [1, this.options.frameSize]),
          // sr: new ort.Tensor('int64', [BigInt(this.options.sampleRate)], [1]), // Sample rate tensor
          // h: this.state.h,
          // c: this.state.c,
          // --- Correct inputs based on Netron --- 
          state: this.state.state,
          sr: this.state.sr
        };

        // TODO: Add sr, h, c tensors to inputs AFTER initializing them correctly

        // 3. Run Inference
        const outputs = await this.vadModel.run(inputs);
        const probability = outputs.output.data[0]; // Name 'output' based on Netron
        const newState = outputs.stateN; // Name 'stateN' based on Netron

        // --- Placeholder until ONNX part is implemented ---
        // const probability = Math.random(); // Replace with actual inference
        // const newState_h = this.state.h;    // Replace with actual inference output
        // const newState_c = this.state.c;    // Replace with actual inference output
        // -------------------------------------------------

        // 4. Update state
        // this.state.h = newState_h;
        // this.state.c = newState_c;
        this.state.state = newState; // Update the single state tensor

        // 5. Handle speech detection logic
        this._handleSpeechLogic(probability, audioFramePCM);
      }
      callback();
    } catch (error) {
      console.error('Error processing audio chunk:', error);
      callback(error);
    }
  }

  _handleSpeechLogic(probability, audioFramePCM) {
    const isSpeech = probability >= this.options.threshold;

    if (isSpeech) {
      this.state.silenceFramesCount = 0; // Reset silence counter
      if (!this.state.isSpeaking) {
         // Start of speech detected
         this.state.isSpeaking = true;
         console.log(`(${new Date().toISOString()}) Speech Start Detected (prob: ${probability.toFixed(2)})`);
         
         // --- MODIFIED START LOGIC: Keep existing buffer for pre-padding --- 
         // Instead of clearing, we keep the frames already in speechBuffer 
         // (which likely contain recent silence/noise from before speech started, 
         // potentially up to speechPadFrames worth based on the silence logic)
         // const originalBuffer = this.state.speechBuffer;
         // this.state.speechBuffer = []; // conceptual clear
         // originalBuffer.forEach(frame => this.state.speechBuffer.push(frame));
         // --- END MODIFICATION (Simplified: Just don't clear!) --- 
         
         // Add current frame that triggered speech start
         this.state.speechBuffer.push(audioFramePCM);
         
         // Emit start event *once* per speech segment
         if (!this.state.speechStartReported) {
            // Pass the *current* audio buffer state (including prepended frames) 
            // This isn't standard, usually start doesn't carry audio.
            // We'll rely on the 'end' event's audioData which includes everything.
            this.push({ speech: { start: true, probability: probability } });
            this.state.speechStartReported = true;
         }
      } else {
         // Continuing speech
         this.state.speechBuffer.push(audioFramePCM);
         // Emit ongoing speech data - push the raw frame
         // Note: The audioData here is just the current frame, not the whole buffer
         this.push({ speech: { state: true, probability: probability }, audioData: audioFramePCM });
      }
    } else {
      // Non-speech frame
      if (this.state.isSpeaking) {
         this.state.silenceFramesCount++;
         // Still buffer audio during potential silence within speech or for padding
         this.state.speechBuffer.push(audioFramePCM);

         if (this.state.silenceFramesCount >= this.minSilenceFrames) {
            // End of speech detected after enough silence
            console.log(`(${new Date().toISOString()}) Speech End Detected (prob: ${probability.toFixed(2)}, silence frames: ${this.state.silenceFramesCount})`);
            this.state.isSpeaking = false;
            this.state.speechStartReported = false; // Reset for next segment
            this.state.silenceFramesCount = 0;

            // Combine buffered speech frames
            const speechAudioData = Buffer.concat(this.state.speechBuffer);
            this.state.speechBuffer = []; // Clear buffer

            // Emit end event with the complete audio segment
            this.push({ speech: { end: true, probability: probability }, audioData: speechAudioData });
         }
      } else {
         // Silence continues, keep adding frames to the buffer.
         // The buffer will be cleared only when speech ends.
         this.state.speechBuffer.push(audioFramePCM);
      }
    }
  }

  _bufferToFloat32(buffer) {
    // Assumes 16-bit Little Endian PCM input
    const float32Array = new Float32Array(buffer.length / 2);
    for (let i = 0; i < float32Array.length; i++) {
      float32Array[i] = buffer.readInt16LE(i * 2) / 32768.0;
    }
    return float32Array;
  }

  _flush(callback) {
    // Handle any remaining buffered data when the input stream ends
    console.log("Input stream ended. Flushing SileroVADStream.");
    if (this.state.isSpeaking && this.state.speechBuffer.length > 0) {
      // If stream ends mid-speech, treat it as an end event
      console.log("Stream ended mid-speech, forcing end event.");
      const speechAudioData = Buffer.concat(this.state.speechBuffer);
      this.push({ speech: { end: true, probability: 0.0 }, audioData: speechAudioData }); // Use 0 prob for forced end
      this.state.isSpeaking = false;
      this.state.speechBuffer = [];
    }
    // Clean up resources if needed (e.g., close ONNX session? Usually not needed here)
    callback();
  }
}

module.exports = SileroVADStream; 
/**
 * index.js
 * This file is the main entry point for the application using VAT to convert ASR to Speech-to-Text.
 * @author  AgentVoiceResponse
 * @see https://www.agentvoiceresponse.com
 */
const express = require("express");

require("dotenv").config();

const app = express();

/**
 * Handles an audio stream from the client and uses Deepgram API
 * to recognize the speech and stream the transcript back to the client.
 *
 * @param {Object} req - The Express request object
 * @param {Object} res - The Express response object
 */
const handleAudioStream = async (req, res) => {
  try {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    req.on("data", (chunk) => {});
    req.on("end", () => {});
    req.on("error", (err) => {
      console.error("Error receiving audio stream:", err);
      req.destroy();
      res.status(500).json({ message: "Error receiving audio stream" });
    });
  } catch (err) {
    console.error("Error handling audio stream:", err);
    res.status(500).json({ message: err.message });
  }
};

app.post("/speech-to-text-stream", handleAudioStream);

const port = process.env.PORT || 6015;
app.listen(port, () => {
  console.log(`ASR TO TTS listening on port ${port}`);
});

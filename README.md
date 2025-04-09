# AVR Speech-to-Text Integration

## Introduction

Currently, Agent Voice Response (AVR) supports ASR, LLM, and TTS modules. The goal of this proposal is to integrate an additional Speech-to-Text (STT) system into the AVR architecture. This integration requires the development of a Voice Activity Detection (VAD) system to manage the interaction between AVR and the STT provider.

## Proposed Architecture

![AVR ASR to STT Architecture](public/avr-asr-to-stt.png)

To achieve this integration, we propose developing two new Docker containers:

1. **avr-asr-to-tts**: This container will handle Voice Activity Detection (VAD) and noise filtering. It will process the incoming audio stream, detect speech, and forward only relevant segments to the STT service.

2. **avr-stt-[provider_name]**: This container will be responsible for interfacing with a specific STT provider, converting the processed audio into text, and returning the transcribed text to the AVR core.



## Key Considerations

- **VAD Implementation**: The avr-asr-to-tts container should implement an efficient VAD system that accurately detects speech while filtering out background noise and silence.

- **STT Service Flexibility**: The avr-stt-[provider_name] container should be designed in a modular way, allowing different STT providers to be integrated without major architectural modifications.

- **Compatibility**: Ensure that the system supports multiple STT providers, allowing future integrations without major architectural changes. Define a protocol and parameters to use between avr-asr-to-tts and avr-stt-[provider_name] to standardize communication and ensure interoperability.

- **Scalability**: The architecture should allow for horizontal scaling to handle increased demand efficiently.

- **Latency Optimization**: The system should minimize processing delays to maintain real-time performance.

## Conclusion

This proposed approach enhances AVR's capabilities by introducing a dedicated STT system with a robust VAD mechanism. Implementing these two new containers will ensure a scalable, flexible, and efficient integration of STT providers, paving the way for future enhancements in voice-based AI interactions.


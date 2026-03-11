# Voice to Text for VS Code

Privacy-first voice-to-text for macOS. Record, transcribe, and paste — all locally with OpenAI Whisper. No cloud, no API keys, no data leaves your machine.

## Features

- **100% local transcription** — powered by [whisper.cpp](https://github.com/ggerganov/whisper.cpp) with Metal GPU acceleration on Apple Silicon
- **Two models to choose from:**
  - **Large v3 Turbo** — Best accuracy, multilingual support (~1.5 GB)
  - **Base English** — Fast and lightweight, English only (~142 MB)
- **One-key recording** — Press `⌥;` (Option + semicolon) to toggle
- **System-wide paste** — Transcribed text is pasted at your cursor, wherever it is
- **Transcription history** — Browse, copy, and manage past transcriptions in the sidebar
- **Animated status bar** — Live waveform animation while recording
- **Zero configuration** — First-time setup handles everything automatically

## Requirements

- **macOS** (Apple Silicon recommended for Metal GPU acceleration)
- **Xcode Command Line Tools** — `xcode-select --install`
- **Homebrew** — [brew.sh](https://brew.sh) (used to install ffmpeg)

## Getting Started

1. Install the extension
2. Press `⌥;` to start your first recording
3. The extension will prompt you to run one-time setup (builds whisper-cli, downloads model)
4. Once setup completes, press `⌥;` again — speak, then press `⌥;` to stop and transcribe

## Switching Models

Run **Voice to Text: Switch Whisper Model** from the Command Palette (`⌘⇧P`) to switch between models. New models are downloaded automatically on first use.

## Settings

| Setting                      | Description                                            | Default          |
| ---------------------------- | ------------------------------------------------------ | ---------------- |
| `voicetotext.model`          | Whisper model (`large-v3-turbo` or `base.en`)          | `large-v3-turbo` |
| `voicetotext.language`       | Language code (e.g. `en`, `es`, `fr`, `auto`)          | `en`             |
| `voicetotext.audioDevice`    | Audio input device index (leave empty for auto-detect) | auto             |
| `voicetotext.whisperCliPath` | Custom path to whisper-cli binary                      | auto             |
| `voicetotext.modelPath`      | Custom path to a ggml model file                       | auto             |

## How It Works

1. **Recording** — ffmpeg captures audio from your microphone via macOS AVFoundation
2. **Transcription** — whisper-cli processes the audio locally using the selected model
3. **Paste** — The transcribed text is copied to your clipboard and pasted via Cmd+V

All processing happens on your machine. No audio or text is sent anywhere.

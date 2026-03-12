# Voice to Text — Local Whisper Transcription for VS Code

Privacy-first voice-to-text for macOS. Record, transcribe, and paste — all locally with OpenAI Whisper. No cloud, no API keys, no data leaves your machine.

![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-black?logo=apple)
![License](https://img.shields.io/badge/license-MIT-blue)
![OpenVSX Downloads](https://img.shields.io/open-vsx/dt/gorav/voicetotext?label=OpenVSX%20Downloads&color=purple)

## Features

- **100% local transcription** — powered by [whisper.cpp](https://github.com/ggerganov/whisper.cpp) with Metal GPU acceleration on Apple Silicon
- **Four models to choose from:**
  - **Large v3 Turbo** — Best accuracy, multilingual + translation (~1.5 GB)
  - **Small (Multilingual)** — Good balance, supports translation (~466 MB)
  - **Small English** — Fast with good accuracy, English only (~466 MB) ← default
  - **Base English** — Fastest, English only (~142 MB)
- **One-key recording** — Press `⌘⇧;` (Command + Shift + semicolon) to toggle
- **Live audio waveform** — Record button shows real-time voice visualization while recording
- **Streaming preview** — See partial transcription in the status bar while still speaking
- **Smart punctuation** — Auto-capitalizes sentences, fixes "i" → "I", adds trailing periods
- **System-wide paste** — Transcribed text is pasted at your cursor, wherever it is
- **Transcription history** — Browse, search, copy, and manage past transcriptions in the sidebar
- **Inline settings** — Switch models, language, and mic directly from the history panel
- **Model pre-warming** — Whisper loads into memory at startup for faster first transcription
- **Audio preprocessing** — Noise reduction, volume normalization, and compression for better accuracy
- **Cancel with Escape** — Discard a recording without transcribing
- **Zero configuration** — First-time setup handles everything automatically

## Prerequisites

Before installing, make sure you have:

1. **macOS** on Apple Silicon (M1/M2/M3/M4) — Intel Macs work too, but without Metal GPU acceleration
2. **Xcode Command Line Tools** — open Terminal and run:
   ```bash
   xcode-select --install
   ```
3. **Homebrew** — if you don't have it, install from [brew.sh](https://brew.sh):
   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```

That's it. The extension handles everything else (ffmpeg, cmake, whisper.cpp, model downloads) automatically on first use.

## Getting Started

### First Run

1. Press `⌘⇧;` or click the 🎙 button in the Voice to Text sidebar
2. The extension will detect that first-time setup is needed and ask to run it
3. Click **Run Setup** — this will:
   - Install `ffmpeg` and `cmake` via Homebrew (if not already installed)
   - Clone and build `whisper-cli` from whisper.cpp v1.7.5 with Metal GPU support
   - Download the Small English model (~466 MB) from Hugging Face
4. Setup takes 2–5 minutes depending on your internet speed. You'll see progress notifications.

### Recording

1. Press `⌘⇧;` to start recording — the button shows a live audio waveform
2. Speak naturally
3. Press `⌘⇧;` again to stop — the audio is transcribed locally and pasted at your cursor
4. Press `Escape` to cancel a recording without transcribing

### History Panel

Open the **Voice to Text** sidebar (mic icon in the activity bar) to see:

- All past transcriptions with timestamps and duration
- **Start Recording** button with live waveform visualization
- **Copy** / **Delete** buttons on each entry
- **Search** box to filter past transcriptions
- **Settings** section to change model, language, and microphone

### Switching Models

From the history panel's **⚙ Settings** section or the Command Palette (`⌘⇧P` → "Voice to Text: Switch Whisper Model").

### Multilingual & Translation

Select a non-English language in Settings. If you're on an English-only model, you'll be prompted to switch to a multilingual one. Non-English speech is automatically translated to English using whisper.cpp's built-in translation.

## Settings Reference

| Setting                      | Description                                            | Default    |
| ---------------------------- | ------------------------------------------------------ | ---------- |
| `voicetotext.model`          | Whisper model                                          | `small.en` |
| `voicetotext.language`       | Language code (e.g. `en`, `es`, `fr`, `auto`)          | `en`       |
| `voicetotext.audioDevice`    | Audio input device index (leave empty for auto-detect) | auto       |
| `voicetotext.whisperCliPath` | Custom path to a whisper-cli binary                    | auto       |
| `voicetotext.modelPath`      | Custom path to a ggml model file                       | auto       |

## How It Works

1. **Recording** — ffmpeg captures audio from your microphone via macOS AVFoundation at 16 kHz mono with noise reduction and volume normalization
2. **Transcription** — whisper-cli processes the audio locally using the selected Whisper model with Metal GPU acceleration
3. **Paste** — Text is inserted directly via the VS Code editor API, or pasted via clipboard + AppleScript for non-editor inputs

All processing happens on your machine. No audio or text is sent anywhere.

## Troubleshooting

**"Setup is still running..."** — The first-time setup is in progress. Wait for it to complete.

**No speech detected** — Check that the correct microphone is selected in Settings. Device `0` is often a virtual device that captures silence.

**Want to reset everything?**

```bash
rm -rf ~/.voicetotext
```

## Data Storage

```
~/.voicetotext/
├── whisper.cpp/          # whisper.cpp source + built binary
├── models/               # Downloaded Whisper model files
└── history.json          # Transcription history
```

Temporary recordings are stored in your system temp directory and deleted after transcription.

## License

MIT

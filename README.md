# Voice to Text — Local Whisper Transcription for VS Code

Privacy-first voice-to-text for macOS. Record, transcribe, and paste — all locally with OpenAI Whisper. No cloud, no API keys, no data leaves your machine.

![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-black?logo=apple)
![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **100% local transcription** — powered by [whisper.cpp](https://github.com/ggerganov/whisper.cpp) with Metal GPU acceleration on Apple Silicon
- **Two models to choose from:**
  - **Large v3 Turbo** — Best accuracy, multilingual support (~1.5 GB)
  - **Base English** — Fast and lightweight, English only (~142 MB)
- **One-key recording** — Press `⌥;` (Option + semicolon) to toggle
- **Record button in sidebar** — Click the mic button in the history panel to start/stop
- **System-wide paste** — Transcribed text is pasted at your cursor, wherever it is
- **Transcription history** — Browse, copy, and manage past transcriptions in the sidebar
- **Inline settings** — Switch models, language, and mic directly from the history panel
- **Animated status bar** — Live waveform animation while recording
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

That's it. The extension handles everything else (ffmpeg, whisper.cpp, model downloads) automatically on first use.

## Install from Source

Since this extension isn't on the VS Code Marketplace yet, install it manually:

```bash
# 1. Clone the repo
git clone https://github.com/goravsoni/voicetotext-vscode.git
cd voicetotext-vscode

# 2. Install dependencies
npm install

# 3. Compile TypeScript
npx tsc -p tsconfig.json

# 4. Copy build artifacts into the vsix structure
cp out/extension.js vsix-build/extension/out/extension.js
cp out/extension.js.map vsix-build/extension/out/extension.js.map
cp package.json vsix-build/extension/package.json
cp icon.png vsix-build/extension/icon.png

# 5. Package the .vsix
cd vsix-build
zip -r ../voicetotext-0.2.0.vsix "[Content_Types].xml" extension.vsixmanifest extension/
cd ..

# 6. Install in VS Code
code --install-extension voicetotext-0.2.0.vsix --force
```

Then reload VS Code (`⌘⇧P` → "Developer: Reload Window").

## Getting Started

### First Run

1. Press `⌥;` (Option + semicolon) or click the 🎙 button in the Voice to Text sidebar
2. The extension will detect that first-time setup is needed and ask to run it
3. Click **Run Setup** — this will:
   - Install `ffmpeg` via Homebrew (if not already installed)
   - Clone and build `whisper-cli` from whisper.cpp v1.7.5 with Metal GPU support
   - Download the Large v3 Turbo model (~1.5 GB) from Hugging Face
4. Setup takes 2–5 minutes depending on your internet speed. You'll see progress notifications.

### Recording

1. Press `⌥;` to start recording — the status bar shows a live waveform animation
2. Speak naturally
3. Press `⌥;` again to stop — the audio is transcribed locally and pasted at your cursor
4. That's it. The transcription also appears in your history panel.

### History Panel

Open the **Voice to Text** sidebar (mic icon in the activity bar) to see:

- All past transcriptions with timestamps and duration
- **Start Recording** button at the top for quick access
- **Copy** / **Paste at Cursor** / **Delete** buttons on each entry
- **Clear All** to wipe history
- **Settings** section (collapsible) to change model, language, and microphone

### Switching Models

You can switch models in two ways:

- From the history panel's **⚙ Settings** section — use the Model dropdown
- From the Command Palette — `⌘⇧P` → "Voice to Text: Switch Whisper Model"

If the selected model hasn't been downloaded yet, you'll be prompted to download it.

### Changing Your Microphone

If you have multiple audio devices (e.g., external mic, Zoom virtual audio), change the mic from:

- The history panel's **⚙ Settings** → Mic dropdown
- Or in VS Code settings: `voicetotext.audioDevice`

To see available devices, run in Terminal:

```bash
ffmpeg -f avfoundation -list_devices true -i "" 2>&1 | grep "AVFoundation"
```

## Settings Reference

All settings are accessible from the history panel's ⚙ Settings section, or from VS Code settings (`⌘,`).

| Setting                      | Description                                            | Default          |
| ---------------------------- | ------------------------------------------------------ | ---------------- |
| `voicetotext.model`          | Whisper model (`large-v3-turbo` or `base.en`)          | `large-v3-turbo` |
| `voicetotext.language`       | Language code (e.g. `en`, `es`, `fr`, `auto`)          | `en`             |
| `voicetotext.audioDevice`    | Audio input device index (leave empty for auto-detect) | auto             |
| `voicetotext.whisperCliPath` | Custom path to a whisper-cli binary                    | auto             |
| `voicetotext.modelPath`      | Custom path to a ggml model file                       | auto             |

## How It Works

1. **Recording** — ffmpeg captures audio from your microphone via macOS AVFoundation at 16 kHz mono
2. **Transcription** — whisper-cli processes the audio locally using the selected Whisper model with Metal GPU acceleration
3. **Paste** — The transcribed text is copied to your clipboard and pasted at the cursor via AppleScript System Events

All processing happens on your machine. No audio or text is sent anywhere.

## Troubleshooting

**"Setup is still running..."** — The first-time setup is in progress. Wait for it to complete.

**Transcription failed: exit code null** — Usually means whisper-cli crashed. Make sure you're on macOS with Xcode Command Line Tools installed. Try deleting `~/.voicetotext/whisper.cpp` and re-running setup.

**No speech detected** — Check that the correct microphone is selected in Settings. Device `0` is often a virtual device (Zoom, Teams) that captures silence.

**Recording captures silence** — Change your audio device. Open the history panel → Settings → Mic, and pick your actual microphone (usually "MacBook Pro Microphone").

**Want to reset everything?** — Delete the data directory and re-run setup:

```bash
rm -rf ~/.voicetotext
```

## Data Storage

All extension data lives in `~/.voicetotext/`:

```
~/.voicetotext/
├── whisper.cpp/          # whisper.cpp source + built binary
├── models/               # Downloaded Whisper model files
└── history.json          # Transcription history
```

Temporary recordings are stored in your system temp directory and deleted after transcription.

## License

MIT

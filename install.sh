#!/bin/bash
set -e

echo "=== VoiceInk VS Code Extension Installer ==="
echo ""

# Check dependencies
if ! command -v ffmpeg &> /dev/null; then
    echo "❌ ffmpeg not found. Install with: brew install ffmpeg"
    exit 1
fi
echo "✅ ffmpeg found"

if ! command -v cmake &> /dev/null; then
    echo "❌ cmake not found. Install with: brew install cmake"
    exit 1
fi
echo "✅ cmake found"

if ! command -v code &> /dev/null; then
    echo "❌ VS Code CLI (code) not found. Install from VS Code: Cmd+Shift+P → 'Shell Command: Install code command'"
    exit 1
fi
echo "✅ VS Code CLI found"

# Build whisper-cli
WHISPER_DIR="$HOME/VoiceInk-Dependencies/whisper.cpp"
WHISPER_CLI="$WHISPER_DIR/build/bin/whisper-cli"

if [ -f "$WHISPER_CLI" ]; then
    echo "✅ whisper-cli already built"
else
    echo "📦 Building whisper-cli from source (with Metal GPU support)..."
    mkdir -p "$HOME/VoiceInk-Dependencies"
    git clone https://github.com/ggerganov/whisper.cpp.git "$WHISPER_DIR" 2>/dev/null || true
    cmake -B "$WHISPER_DIR/build" -S "$WHISPER_DIR" -DWHISPER_METAL=ON
    cmake --build "$WHISPER_DIR/build" --config Release -j$(sysctl -n hw.ncpu)
    echo "✅ whisper-cli built"
fi

# Download model
MODEL_DIR="$HOME/.voiceink-vscode/models"
MODEL_PATH="$MODEL_DIR/ggml-large-v3-turbo.bin"

if [ -f "$MODEL_PATH" ]; then
    echo "✅ Model already downloaded"
else
    echo "📥 Downloading ggml-large-v3-turbo model (~1.5GB)..."
    mkdir -p "$MODEL_DIR"
    curl -L -o "$MODEL_PATH" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"
    echo "✅ Model downloaded"
fi

# Install VS Code extension
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VSIX="$SCRIPT_DIR/voiceink-0.1.0.vsix"

if [ ! -f "$VSIX" ]; then
    echo "❌ voiceink-0.1.0.vsix not found in $SCRIPT_DIR"
    exit 1
fi

echo "📦 Installing VS Code extension..."
code --install-extension "$VSIX" --force
echo "✅ Extension installed"

echo ""
echo "=== Done! ==="
echo "Reload VS Code (Cmd+Shift+P → 'Reload Window')"
echo "Hotkey: Cmd+Shift+; to toggle recording"
echo "Speak, then press Cmd+Shift+; again to transcribe and insert at cursor."

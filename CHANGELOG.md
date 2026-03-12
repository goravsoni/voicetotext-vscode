# Changelog

## 0.7.5 — 2026-03-11

- History pagination: page navigation (1, 2, 3…) with prev/next arrows, 6 entries per page
- Search hides pagination and filters across all entries

## 0.7.4 — 2026-03-11

- History pagination: shows 8 transcriptions at a time with "Show more" button

## 0.7.3 — 2026-03-11

- Settings panel now open by default

## 0.7.2 — 2026-03-11

- History panel UX redesign: larger record button, relative timestamps ("2m ago"), hover-only actions, collapsible settings, cleaner layout
- Slimmer waveform bars (40 bars at 95% height) for a more dynamic visual
- Cancel recording sound changed to Funk

## 0.7.0 — 2026-03-11

- Model management: delete downloaded models from the settings panel to free disk space
- Recording button stays accent color instead of turning red
- Smoother waveform animation (throttled to 150ms, 30 bars, smoothed levels)
- Recording sounds updated to Bottle (start) and Pop (stop)

## 0.6.2 — 2026-03-11

- Waveform visualizer now renders inside the record button — replaces button text with live audio bars while recording
- Default model changed to Small English (~466 MB) for faster transcription out of the box
- Improved recording start sound (Tink instead of Blow)
- Fixed audio level detection for waveform (handles silence correctly)

## 0.6.0 — 2026-03-11

- Live audio waveform in history panel — reacts to your voice in real time while recording
- Added Small English (~466 MB) and Small Multilingual (~466 MB) models — faster than Large v3 Turbo with good accuracy
- Non-English language selection now suggests Small Multilingual instead of Large v3 Turbo for better speed

## 0.5.0 — 2026-03-11

- Live preview: status bar shows a preview of what you're saying while still recording (streaming transcription every 3s)
- Model pre-warming: Whisper model loads into memory on extension startup — first transcription is noticeably faster
- Smart punctuation: auto-capitalizes sentences, fixes "i" → "I", adds trailing periods

## 0.5.0 — 2026-03-11

- Model pre-warming: Whisper model loads into memory at startup for faster first transcription
- Streaming preview: partial transcription shown in status bar while recording
- Smart punctuation: auto-capitalizes sentences, fixes "i" → "I", adds trailing periods
- Recording feedback sounds (start/stop/cancel)
- Cancel recording with Escape key
- Search box in history panel
- Removed "Paste at Cursor" button from history

## 0.4.9 — 2026-03-11

- Recording feedback sounds: subtle audio cue when recording starts, stops, or is cancelled
- Cancel recording with Escape key — discards audio without transcribing
- Search history — filter past transcriptions with a search box in the sidebar

## 0.4.8 — 2026-03-11

- Audio preprocessing pipeline: noise reduction, volume normalization, and dynamic compression for better accuracy from a distance
- Translation flag switched to `--translate` long form for reliability
- Short recordings padded with silence so Whisper can handle even 1-second clips

## 0.4.7 — 2026-03-11

- Hotkey changed to `⌘⇧;` (Command + Shift + semicolon) — no more stray `…` character from Option key
- Removed clipboard paste notification
- Short recordings now padded with silence so Whisper can transcribe even 1-second clips
- Clipboard is no longer read/saved — only written to when pasting into non-editor fields

## 0.4.6 — 2026-03-11

- Hotkey reverted to `⌥;` (Option + semicolon)

## 0.4.5 — 2026-03-11

- Fixed "Paste at Cursor" button in history panel — now focuses the last active editor before inserting text

## 0.4.4 — 2026-03-11

- Removed "Copied to clipboard" notification after copy

## 0.4.3 — 2026-03-11

- Non-English speech is now automatically translated to English using whisper.cpp's built-in translation
- Selecting a non-English language while on Base English model prompts to switch to Large v3 Turbo (which supports multilingual + translation)

## 0.4.2 — 2026-03-11

- Improved paste reliability: uses VS Code editor API when a text editor is focused, falls back to AppleScript Cmd+V for external apps
- Added small delay before AppleScript keystroke to let clipboard settle

## 0.4.1 — 2026-03-11

- Removed "Transcribed" notification popup after each transcription
- Strip leading/trailing ellipses from whisper output before pasting

## 0.4.0 — 2026-03-11

- Default model changed to Base English (~142 MB) for faster first-time setup
- Large v3 Turbo (~1.5 GB) still available — switch anytime from the history panel settings

## 0.3.2 — 2026-03-11

- Fixed setup failing with exit code 127 when cmake is not installed
- Setup now auto-detects missing cmake and ffmpeg, asks permission, then installs both via Homebrew
- Fixed PATH issue where VS Code's shell couldn't find Homebrew binaries (/opt/homebrew/bin)
- Clearer error message when Homebrew is not installed

## 0.2.0 — 2026-03-11

- Initial public release
- Local transcription with whisper.cpp and Metal GPU acceleration
- Two models: Large v3 Turbo (multilingual) and Base English
- One-key recording with ⌥; hotkey
- Record button in history panel sidebar
- Transcription history with copy, paste at cursor, and delete
- Inline settings panel (model, language, microphone)
- Auto-setup: builds whisper-cli, installs ffmpeg, downloads models
- System-wide paste via AppleScript

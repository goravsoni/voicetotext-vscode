/**
 * Voice to Text — Privacy-first local transcription for VS Code on macOS.
 *
 * Records audio via ffmpeg (avfoundation), transcribes locally with whisper.cpp,
 * and pastes the result at the cursor via the system clipboard + AppleScript.
 *
 * Supported models (all run 100% on-device with Metal GPU acceleration):
 *   - large-v3-turbo : Best accuracy, multilingual, ~1.5 GB  (default)
 *   - base.en        : Fast & lightweight, English only, ~142 MB
 *
 * First-time setup automatically clones whisper.cpp (v1.7.5), builds whisper-cli
 * with Metal support, and downloads the selected model from Hugging Face.
 *
 * Requirements: macOS, Xcode Command Line Tools, Homebrew (for ffmpeg).
 *
 * @module extension
 */

import * as vscode from 'vscode';
import { spawn, ChildProcess, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// ─── Constants ───────────────────────────────────────────────────────────────

const HOME_DIR = os.homedir();
const APP_DIR = path.join(HOME_DIR, '.voicetotext');
const MODEL_DIR = path.join(APP_DIR, 'models');
const WHISPER_SRC = path.join(APP_DIR, 'whisper.cpp');
const WHISPER_CLI = path.join(WHISPER_SRC, 'build', 'bin', 'whisper-cli');
const RECORDING_DIR = path.join(os.tmpdir(), 'voicetotext');
const HISTORY_PATH = path.join(APP_DIR, 'history.json');

/** Pinned whisper.cpp release — v1.7.5 is the last stable tag before a Metal regression on Apple Silicon. */
const WHISPER_CPP_TAG = 'v1.7.5';

/**
 * Available whisper.cpp models.
 * Each entry maps a user-facing model ID to its filename and download URL.
 */
const MODELS: Record<string, { file: string; url: string; label: string; size: string }> = {
    'large-v3-turbo': {
        file: 'ggml-large-v3-turbo.bin',
        url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
        label: 'Large v3 Turbo',
        size: '~1.5 GB',
    },
    'small': {
        file: 'ggml-small.bin',
        url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
        label: 'Small (Multilingual)',
        size: '~466 MB',
    },
    'small.en': {
        file: 'ggml-small.en.bin',
        url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin',
        label: 'Small English',
        size: '~466 MB',
    },
    'base.en': {
        file: 'ggml-base.en.bin',
        url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
        label: 'Base English',
        size: '~142 MB',
    },
};

// ─── History entry shape ─────────────────────────────────────────────────────

interface HistoryEntry {
    id: string;
    text: string;
    timestamp: string;
    durationMs: number;
}

// ─── Module-level state ──────────────────────────────────────────────────────

let statusBarItem: vscode.StatusBarItem;
let recordingProcess: ChildProcess | null = null;
let isRecording = false;
let isSettingUp = false;
let currentRecordingPath = '';
let recordingStartTime = 0;
let waveInterval: ReturnType<typeof setInterval> | null = null;
let waveFrame = 0;
let streamingInterval: ReturnType<typeof setInterval> | null = null;
let streamingText = '';

// ─── Pre-buffer: always-on mic capture for zero-latency recording start ─────

/** Duration in seconds of the rolling audio pre-buffer. */
const PRE_BUFFER_SECONDS = 3;
let preBufferProcess: ChildProcess | null = null;
const preBufferPath = path.join(os.tmpdir(), 'voicetotext', 'prebuffer.wav');

/**
 * Starts a background ffmpeg process that continuously records the mic
 * into a rolling WAV file. Uses segment muxer to keep only the last chunk.
 * When the user hits record, we snapshot this file to capture the last ~3s.
 */
function startPreBuffer(): void {
    if (preBufferProcess) { return; } // already running
    const device = getAudioDevice();
    const ffmpegPath = findBinary('ffmpeg') || 'ffmpeg';
    if (!ffmpegPath) { return; }

    // Use a simple overwriting approach: record to a file, restart every PRE_BUFFER_SECONDS
    // This gives us a file that always has the last few seconds of audio.
    const startCapture = () => {
        if (!isRecording) { // don't restart while actively recording
            try { if (fs.existsSync(preBufferPath)) { fs.unlinkSync(preBufferPath); } } catch {}
            preBufferProcess = spawn(ffmpegPath, [
                '-f', 'avfoundation', '-i', `:${device}`,
                '-af', 'highpass=f=80,lowpass=f=8000',
                '-ar', '16000', '-ac', '1', '-sample_fmt', 's16',
                '-t', String(PRE_BUFFER_SECONDS),
                '-y', preBufferPath,
            ], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PATH: getEnhancedPath() } });

            preBufferProcess.on('close', () => {
                preBufferProcess = null;
                // Restart the buffer loop (unless we're recording or shutting down)
                if (!isRecording) {
                    setTimeout(startCapture, 50);
                }
            });
            preBufferProcess.on('error', () => { preBufferProcess = null; });
        }
    };
    startCapture();
}

/** Stops the pre-buffer background recording. */
function stopPreBuffer(): void {
    if (preBufferProcess) {
        preBufferProcess.kill('SIGKILL');
        preBufferProcess = null;
    }
}

/**
 * Snapshots the current pre-buffer file. Returns the path to the snapshot,
 * or null if no usable pre-buffer exists.
 */
function snapshotPreBuffer(): string | null {
    // Kill the running pre-buffer so the WAV header is finalized
    if (preBufferProcess) {
        preBufferProcess.kill('SIGINT');
        preBufferProcess = null;
    }
    // Give ffmpeg a moment to finalize, then check the file
    if (fs.existsSync(preBufferPath)) {
        const stat = fs.statSync(preBufferPath);
        if (stat.size > 1000) { // has meaningful audio
            const snapshotDest = path.join(RECORDING_DIR, `prebuf_${Date.now()}.wav`);
            try {
                fs.copyFileSync(preBufferPath, snapshotDest);
                return snapshotDest;
            } catch { /* fall through */ }
        }
    }
    return null;
}

/**
 * Concatenates the pre-buffer audio with the main recording into a single WAV.
 * Returns the path to the combined file.
 */
function concatAudio(preBufferFile: string, mainFile: string): string {
    const ffmpegPath = findBinary('ffmpeg') || 'ffmpeg';
    const combinedPath = mainFile.replace(/\.wav$/, '_combined.wav');
    const listPath = mainFile.replace(/\.wav$/, '_list.txt');

    // ffmpeg concat demuxer needs a list file
    fs.writeFileSync(listPath, `file '${preBufferFile}'\nfile '${mainFile}'\n`);
    try {
        execSync(
            `"${ffmpegPath}" -y -f concat -safe 0 -i "${listPath}" -ar 16000 -ac 1 -sample_fmt s16 "${combinedPath}"`,
            { encoding: 'utf-8', env: { ...process.env, PATH: getEnhancedPath() }, stdio: 'pipe' }
        );
        // Clean up temp files
        try { fs.unlinkSync(listPath); } catch {}
        try { fs.unlinkSync(preBufferFile); } catch {}
        return combinedPath;
    } catch {
        // Concat failed — just use the main recording
        try { fs.unlinkSync(listPath); } catch {}
        try { fs.unlinkSync(preBufferFile); } catch {}
        return mainFile;
    }
}

/**
 * Plays a short system sound for recording feedback.
 * Uses macOS built-in sounds — no bundled audio files needed.
 */
function playSound(type: 'start' | 'stop' | 'cancel'): void {
    const sounds: Record<string, string> = {
        start: '/System/Library/Sounds/Bottle.aiff',
        stop: '/System/Library/Sounds/Pop.aiff',
        cancel: '/System/Library/Sounds/Funk.aiff',
    };
    try {
        spawn('afplay', [sounds[type]], { stdio: 'ignore', detached: true }).unref();
    } catch { /* non-critical — skip if sound fails */ }
}

/**
 * Pre-warms the Whisper model by running a tiny transcription on silence.
 * This loads the model into memory so the first real transcription is fast.
 */
function prewarmModel(): void {
    const whisperPath = getWhisperCliPath();
    const modelPath = getModelPath();
    if (!fs.existsSync(whisperPath) || !fs.existsSync(modelPath)) { return; }

    // Create a tiny 0.5s silent WAV file for the warm-up
    const silentPath = path.join(RECORDING_DIR, 'prewarm.wav');
    try {
        const ffmpegPath = findBinary('ffmpeg') || 'ffmpeg';
        execSync(
            `"${ffmpegPath}" -y -f lavfi -i anullsrc=r=16000:cl=mono -t 0.5 -sample_fmt s16 "${silentPath}"`,
            { encoding: 'utf-8', env: { ...process.env, PATH: getEnhancedPath() }, stdio: 'pipe' }
        );
        // Run whisper-cli in background — we don't care about the output
        const proc = spawn(whisperPath, ['-m', modelPath, '-f', silentPath, '-np', '-nt', '-t', '2'], {
            stdio: 'ignore', detached: true,
            env: { ...process.env, PATH: getEnhancedPath() },
        });
        proc.on('close', () => { try { fs.unlinkSync(silentPath); } catch {} });
        proc.unref();
    } catch { /* non-critical */ }
}

/**
 * Post-processes transcribed text with smart punctuation and formatting.
 * Fixes common issues: capitalization, "i" → "I", trailing periods, etc.
 */
function smartPunctuation(text: string): string {
    let result = text.trim();
    if (!result) { return result; }

    // Capitalize first letter
    result = result.charAt(0).toUpperCase() + result.slice(1);

    // Capitalize after sentence-ending punctuation
    result = result.replace(/([.!?])\s+([a-z])/g, (_, p, c) => `${p} ${c.toUpperCase()}`);

    // Fix standalone "i" → "I"
    result = result.replace(/\bi\b/g, 'I');
    // Fix "i'm" → "I'm", "i'll" → "I'll", "i've" → "I've", "i'd" → "I'd"
    result = result.replace(/\bI('m|'ll|'ve|'d|'ll)\b/gi, (m) => 'I' + m.slice(1).toLowerCase());

    // Add period at end if no sentence-ending punctuation
    if (!/[.!?]$/.test(result)) {
        result += '.';
    }

    return result;
}
let historyPanel: vscode.WebviewPanel | undefined;
let sidebarView: vscode.WebviewView | undefined;

/** Animated waveform frames shown in the status bar while recording. */
const WAVE_FRAMES = ['▁▃▅▇▅▃▁', '▃▅▇▅▃▁▃', '▅▇▅▃▁▃▅', '▇▅▃▁▃▅▇', '▅▃▁▃▅▇▅', '▃▁▃▅▇▅▃'];

// ─── Activation ──────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    // Ensure working directories exist
    if (!fs.existsSync(RECORDING_DIR)) { fs.mkdirSync(RECORDING_DIR, { recursive: true }); }
    if (!fs.existsSync(APP_DIR)) { fs.mkdirSync(APP_DIR, { recursive: true }); }

    // Status bar button — always visible, shows recording state
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'voicetotext.toggleRecording';
    statusBarItem.text = '$(mic) Voice to Text';
    statusBarItem.tooltip = '⌘⇧; to toggle recording';
    statusBarItem.show();

    // Pre-warm the Whisper model in the background for faster first transcription
    prewarmModel();

    // Start the rolling audio pre-buffer so we capture speech before the hotkey
    const missing = checkDependencies();
    if (missing.length === 0) { startPreBuffer(); }

    // Register commands
    const toggle = vscode.commands.registerCommand('voicetotext.toggleRecording', async () => {
        if (isSettingUp) {
            vscode.window.showInformationMessage('Voice to Text: Setup is still running...');
            return;
        }
        const missing = checkDependencies();
        if (missing.length > 0) {
            const choice = await vscode.window.showWarningMessage(
                `Voice to Text needs to set up: ${missing.join(', ')}. This is a one-time process.`,
                'Run Setup', 'Cancel'
            );
            if (choice === 'Run Setup') { await runSetup(); }
            return;
        }
        if (isRecording) { await stopRecording(); } else { await startRecording(); }
    });

    // Cancel recording — discard audio without transcribing
    const cancel = vscode.commands.registerCommand('voicetotext.cancelRecording', async () => {
        if (!isRecording) { return; }
        playSound('cancel');
        if (streamingInterval) { clearInterval(streamingInterval); streamingInterval = null; }
        streamingText = '';
        stopAudioLevelMonitor();
        if (recordingProcess) {
            recordingProcess.kill('SIGKILL');
            recordingProcess = null;
        }
        if (waveInterval) { clearInterval(waveInterval); waveInterval = null; }
        // Clean up pre-buffer snapshot
        const snap = (startRecording as any)._preBufferSnapshot as string | null;
        if (snap) { try { fs.unlinkSync(snap); } catch {} }
        (startRecording as any)._preBufferSnapshot = null;
        cleanupRecordingFile();
        resetStatusBar();
        // Restart pre-buffer for next recording
        startPreBuffer();
    });

    const setup = vscode.commands.registerCommand('voicetotext.setup', runSetup);
    const history = vscode.commands.registerCommand('voicetotext.showHistory', () => showHistoryPanel(context));
    const switchModel = vscode.commands.registerCommand('voicetotext.switchModel', handleSwitchModel);

    // Sidebar webview for transcription history
    const sidebarProvider = new HistorySidebarProvider(context);
    const sidebarReg = vscode.window.registerWebviewViewProvider('voicetotext.historyView', sidebarProvider);

    context.subscriptions.push(toggle, cancel, setup, history, switchModel, sidebarReg, statusBarItem);
}

// ─── Model switching ─────────────────────────────────────────────────────────

/**
 * Presents a quick-pick menu for the user to switch between available Whisper models.
 * If the selected model isn't downloaded yet, it will be fetched on the next recording.
 */
async function handleSwitchModel(): Promise<void> {
    const current = getSelectedModelId();
    const items = Object.entries(MODELS).map(([id, m]) => ({
        label: `${id === current ? '$(check) ' : '     '}${m.label}`,
        description: `${m.size}${id === current ? ' (active)' : ''}`,
        detail: fs.existsSync(path.join(MODEL_DIR, m.file)) ? 'Downloaded' : 'Will download on first use',
        id,
    }));

    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a Whisper model for transcription',
        title: 'Voice to Text: Switch Model',
    });

    if (pick && pick.id !== current) {
        await vscode.workspace.getConfiguration('voicetotext').update('model', pick.id, vscode.ConfigurationTarget.Global);
        const model = MODELS[pick.id];
        if (!fs.existsSync(path.join(MODEL_DIR, model.file))) {
            const dl = await vscode.window.showInformationMessage(
                `Switched to ${model.label}. The model (${model.size}) will be downloaded on next recording.`,
                'Download Now'
            );
            if (dl === 'Download Now') { await downloadModel(pick.id); }
        } else {
            vscode.window.showInformationMessage(`Switched to ${model.label}.`);
        }
    }
}

// ─── Sidebar Provider ────────────────────────────────────────────────────────

class HistorySidebarProvider implements vscode.WebviewViewProvider {
    constructor(private readonly context: vscode.ExtensionContext) {}

    resolveWebviewView(webviewView: vscode.WebviewView) {
        sidebarView = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = getHistoryHtml();
        setupWebviewMessageHandler(webviewView.webview, this.context);
    }
}

/**
 * Handles messages posted from the webview (history panel / sidebar).
 * Actions: copy, insert (paste at cursor), delete, clear.
 */
function setupWebviewMessageHandler(webview: vscode.Webview, context: vscode.ExtensionContext) {
    webview.onDidReceiveMessage(async (msg) => {
        const cfg = vscode.workspace.getConfiguration('voicetotext');
        if (msg.type === 'copy') {
            await vscode.env.clipboard.writeText(msg.text);
        } else if (msg.type === 'delete') {
            deleteFromHistory(msg.id);
        } else if (msg.type === 'clear') {
            clearHistory();
        } else if (msg.type === 'insert') {
            await pasteFromWebview(msg.text);
        } else if (msg.type === 'switchModel') {
            const modelId = msg.id;
            if (modelId && modelId in MODELS) {
                await cfg.update('model', modelId, vscode.ConfigurationTarget.Global);
                const model = MODELS[modelId];
                const modelFile = path.join(MODEL_DIR, model.file);
                if (!fs.existsSync(modelFile)) {
                    const dl = await vscode.window.showInformationMessage(
                        `Switched to ${model.label}. The model (${model.size}) needs to be downloaded.`,
                        'Download Now', 'Later'
                    );
                    if (dl === 'Download Now') { await downloadModel(modelId); }
                }
                refreshAllViews();
            }
        } else if (msg.type === 'setLanguage') {
            const newLang = msg.text;
            await cfg.update('language', newLang, vscode.ConfigurationTarget.Global);
            // English-only models don't support other languages — prompt to switch
            const currentModel = getSelectedModelId();
            if (newLang !== 'en' && (currentModel === 'base.en' || currentModel === 'small.en')) {
                const sw = await vscode.window.showInformationMessage(
                    `The ${MODELS[currentModel].label} model only supports English. Switch to Small (Multilingual) for ${newLang} + translation?`,
                    'Switch Model', 'Keep Current'
                );
                if (sw === 'Switch Model') {
                    await cfg.update('model', 'small', vscode.ConfigurationTarget.Global);
                    const model = MODELS['small'];
                    if (!fs.existsSync(path.join(MODEL_DIR, model.file))) {
                        const dl = await vscode.window.showInformationMessage(
                            `Small Multilingual (${model.size}) needs to be downloaded.`,
                            'Download Now', 'Later'
                        );
                        if (dl === 'Download Now') { await downloadModel('small'); }
                    }
                    refreshAllViews();
                }
            }
        } else if (msg.type === 'setAudioDevice') {
            await cfg.update('audioDevice', msg.text, vscode.ConfigurationTarget.Global);
        } else if (msg.type === 'deleteModel') {
            const modelId = msg.id;
            if (modelId && modelId in MODELS) {
                const model = MODELS[modelId];
                const modelFile = path.join(MODEL_DIR, model.file);
                if (fs.existsSync(modelFile)) {
                    const confirm = await vscode.window.showWarningMessage(
                        `Delete ${model.label} (${model.size})? You can re-download it later.`,
                        'Delete', 'Cancel'
                    );
                    if (confirm === 'Delete') {
                        fs.unlinkSync(modelFile);
                        vscode.window.showInformationMessage(`Deleted ${model.label}.`);
                        refreshAllViews();
                    }
                }
            }
        } else if (msg.type === 'toggleRecording') {
            vscode.commands.executeCommand('voicetotext.toggleRecording');
        }
    }, undefined, context.subscriptions);
}

// ─── History persistence ─────────────────────────────────────────────────────

function loadHistory(): HistoryEntry[] {
    try {
        if (fs.existsSync(HISTORY_PATH)) {
            return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
        }
    } catch { /* corrupted file — start fresh */ }
    return [];
}

function saveHistory(entries: HistoryEntry[]): void {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(entries, null, 2));
}

function addToHistory(text: string, durationMs: number): void {
    const entries = loadHistory();
    entries.unshift({
        id: Date.now().toString(),
        text,
        timestamp: new Date().toISOString(),
        durationMs,
    });
    if (entries.length > 100) { entries.length = 100; } // cap at 100 entries
    saveHistory(entries);
    refreshAllViews();
}

function deleteFromHistory(id: string): void {
    saveHistory(loadHistory().filter(e => e.id !== id));
    refreshAllViews();
}

function clearHistory(): void {
    saveHistory([]);
    refreshAllViews();
}

/** Re-renders both the sidebar and the standalone history panel. */
function refreshAllViews(): void {
    const html = getHistoryHtml();
    if (historyPanel) { historyPanel.webview.html = html; }
    if (sidebarView) { sidebarView.webview.html = html; }
}

/** Pushes the current recording state to all open webviews so the record button updates. */
function pushRecordingState(): void {
    // Set VS Code context key so keybindings can use "when": "voicetotext.isRecording"
    vscode.commands.executeCommand('setContext', 'voicetotext.isRecording', isRecording);
    const msg = { type: 'recordingState', recording: isRecording };
    try {
        if (historyPanel) { historyPanel.webview.postMessage(msg); }
        if (sidebarView) { sidebarView.webview.postMessage(msg); }
    } catch { /* webview may be disposed */ }
}

/** Pushes a normalized audio level (0–1) to webviews for waveform visualization. */
function pushAudioLevel(level: number): void {
    const msg = { type: 'audioLevel', level };
    try {
        if (historyPanel) { historyPanel.webview.postMessage(msg); }
        if (sidebarView) { sidebarView.webview.postMessage(msg); }
    } catch { /* webview may be disposed */ }
}

function showHistoryPanel(context: vscode.ExtensionContext): void {
    if (historyPanel) {
        historyPanel.reveal();
        historyPanel.webview.html = getHistoryHtml();
        return;
    }
    historyPanel = vscode.window.createWebviewPanel(
        'voicetotextHistory', 'Voice to Text History', vscode.ViewColumn.One, { enableScripts: true }
    );
    historyPanel.webview.html = getHistoryHtml();
    setupWebviewMessageHandler(historyPanel.webview, context);
    historyPanel.onDidDispose(() => { historyPanel = undefined; });
}

// ─── History webview HTML ────────────────────────────────────────────────────

/**
 * Generates the full HTML for the history webview.
 * Uses data-attribute event delegation so button handlers work reliably
 * regardless of transcription content (no inline onclick with template literals).
 */
/**
 * Generates the full HTML for the history webview.
 * Includes an inline settings panel (model, language, audio device)
 * so users never need to visit the extension config page.
 */
function getHistoryHtml(): string {
    const entries = loadHistory();
    const currentModelId = getSelectedModelId();
    const currentLang = getLanguage();
    const currentDevice = vscode.workspace.getConfiguration('voicetotext').get<string>('audioDevice') || '';
    const entriesJson = JSON.stringify(entries.map(e => ({ id: e.id, text: e.text })));

    // Model dropdown options
    const modelOptions = Object.entries(MODELS).map(([id, m]) => {
        const downloaded = fs.existsSync(path.join(MODEL_DIR, m.file));
        const suffix = downloaded ? '' : ' ⬇';
        const selected = id === currentModelId ? ' selected' : '';
        return `<option value="${id}"${selected}>${m.label} (${m.size})${suffix}</option>`;
    }).join('');

    // Downloaded models list with delete buttons
    const downloadedModels = Object.entries(MODELS)
        .filter(([, m]) => fs.existsSync(path.join(MODEL_DIR, m.file)))
        .map(([id, m]) => {
            const isActive = id === currentModelId;
            const activeTag = isActive ? ' <span class="badge">active</span>' : '';
            const deleteBtn = isActive ? '' : ` <button class="btn btn-danger btn-sm" data-action="deleteModel" data-model="${id}">Delete</button>`;
            return `<div class="model-row">${m.label} (${m.size})${activeTag}${deleteBtn}</div>`;
        }).join('');

    // Common language options
    const languages = [
        { code: 'en', name: 'English' }, { code: 'es', name: 'Spanish' },
        { code: 'fr', name: 'French' }, { code: 'de', name: 'German' },
        { code: 'ja', name: 'Japanese' }, { code: 'zh', name: 'Chinese' },
        { code: 'ko', name: 'Korean' }, { code: 'pt', name: 'Portuguese' },
        { code: 'it', name: 'Italian' }, { code: 'nl', name: 'Dutch' },
        { code: 'auto', name: 'Auto-detect' },
    ];
    const langOptions = languages.map(l => {
        const selected = l.code === currentLang ? ' selected' : '';
        return `<option value="${l.code}"${selected}>${l.name} (${l.code})</option>`;
    }).join('');

    // Detect audio devices for the dropdown
    let deviceOptions = `<option value="">Auto-detect</option>`;
    try {
        const output = execSync('ffmpeg -f avfoundation -list_devices true -i "" 2>&1 || true', { encoding: 'utf-8' });
        const lines = output.split('\n');
        let inAudio = false;
        for (const line of lines) {
            if (line.includes('AVFoundation audio devices')) { inAudio = true; continue; }
            if (inAudio) {
                const match = line.match(/\[AVFoundation.*\]\s*\[(\d+)\]\s*(.*)/);
                if (match) {
                    const idx = match[1];
                    const name = match[2].trim();
                    const selected = idx === currentDevice ? ' selected' : '';
                    deviceOptions += `<option value="${idx}"${selected}>[${idx}] ${name}</option>`;
                }
            }
        }
    } catch { /* keep just auto-detect */ }

    const PAGE_SIZE = 6;
    const rows = entries.map((e, i) => {
        const date = new Date(e.timestamp);
        const dur = (e.durationMs / 1000).toFixed(1);
        const safe = e.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        // Relative time
        const now = Date.now();
        const diff = now - date.getTime();
        let timeStr = '';
        if (diff < 60000) { timeStr = 'Just now'; }
        else if (diff < 3600000) { timeStr = `${Math.floor(diff / 60000)}m ago`; }
        else if (diff < 86400000) { timeStr = `${Math.floor(diff / 3600000)}h ago`; }
        else { timeStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
        return `
        <div class="entry">
            <div class="entry-header">
                <span class="time">${timeStr}</span>
                <span class="badge">${dur}s</span>
                <span class="actions">
                    <button class="icon-btn" data-index="${i}" data-action="copy" title="Copy">📋</button>
                    <button class="icon-btn icon-btn-danger" data-index="${i}" data-action="delete" title="Delete">✕</button>
                </span>
            </div>
            <div class="text">${safe}</div>
        </div>`;
    }).join('');

    return `<!DOCTYPE html>
<html><head><style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 12px; line-height: 1.5;
    }

    /* ── Record button ── */
    .record-btn {
        display: flex; align-items: center; justify-content: center; gap: 8px;
        width: 100%; padding: 12px 16px; margin-bottom: 12px;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none; border-radius: 10px; cursor: pointer;
        font-size: 0.95em; font-family: var(--vscode-font-family);
        transition: background 0.15s, transform 0.1s;
        position: relative; overflow: hidden;
        min-height: 48px;
    }
    .record-btn:hover { background: var(--vscode-button-hoverBackground); }
    .record-btn:active { transform: scale(0.98); }
    .record-btn.recording { background: var(--vscode-button-background); }
    .record-btn .btn-content { display: flex; align-items: center; gap: 8px; z-index: 1; }
    .record-btn canvas {
        position: absolute; top: 0; left: 0; width: 100%; height: 100%;
        display: none; z-index: 0;
    }
    .record-btn.recording canvas { display: block; }
    .record-btn.recording .btn-content { display: none; }
    .record-hint {
        font-family: var(--vscode-editor-font-family);
        background: rgba(255,255,255,0.15);
        padding: 1px 6px; border-radius: 4px; font-size: 0.8em;
        opacity: 0.7;
    }

    /* ── Search ── */
    .search-bar {
        margin-bottom: 12px;
    }
    .search-bar input {
        width: 100%;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent);
        padding: 6px 10px; border-radius: 6px;
        font-size: 0.85em; font-family: var(--vscode-font-family);
        outline: none;
    }
    .search-bar input:focus { border-color: var(--vscode-focusBorder); }

    /* ── Entries ── */
    .entry {
        background: var(--vscode-editor-inactiveSelectionBackground);
        border-radius: 8px; padding: 10px 12px; margin-bottom: 8px;
        border: 1px solid transparent; transition: border-color 0.15s;
    }
    .entry:hover { border-color: var(--vscode-focusBorder); }
    .entry:hover .actions { opacity: 1; }
    .entry-header {
        display: flex; align-items: center; gap: 8px;
        font-size: 0.78em; color: var(--vscode-descriptionForeground);
        margin-bottom: 4px;
    }
    .badge {
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        padding: 0px 6px; border-radius: 10px; font-size: 0.8em;
    }
    .actions {
        margin-left: auto; display: flex; gap: 4px;
        opacity: 0; transition: opacity 0.15s;
    }
    .icon-btn {
        background: none; border: none; cursor: pointer;
        font-size: 0.85em; padding: 2px 4px; border-radius: 4px;
        transition: background 0.1s;
    }
    .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1)); }
    .icon-btn-danger:hover { background: rgba(255,80,80,0.15); }
    .text {
        font-size: 0.9em; white-space: pre-wrap; word-break: break-word;
        line-height: 1.45;
    }

    /* ── Section divider ── */
    .section-label {
        display: flex; align-items: center; justify-content: space-between;
        font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.5px;
        color: var(--vscode-descriptionForeground);
        margin: 16px 0 8px 0; padding: 0 2px;
    }
    .section-label button {
        background: none; border: none; cursor: pointer;
        color: var(--vscode-descriptionForeground);
        font-size: 1em; padding: 0;
    }
    .section-label button:hover { color: var(--vscode-errorForeground); }

    /* ── Settings panel ── */
    .settings {
        background: var(--vscode-sideBar-background, var(--vscode-editor-background));
        border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
        border-radius: 8px; padding: 10px 12px; margin-top: 8px;
    }
    .settings-title {
        font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.5px;
        color: var(--vscode-descriptionForeground);
        cursor: pointer; user-select: none;
    }
    .settings-title:hover { color: var(--vscode-foreground); }
    .settings-body { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
    .setting-row {
        display: flex; align-items: center; gap: 8px;
    }
    .setting-row label {
        min-width: 55px; font-size: 0.82em;
        color: var(--vscode-descriptionForeground);
    }
    .setting-row select {
        flex: 1;
        background: var(--vscode-dropdown-background, var(--vscode-input-background));
        color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
        border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent));
        padding: 4px 8px; border-radius: 4px;
        font-size: 0.82em; font-family: var(--vscode-font-family);
    }
    .model-row {
        display: flex; align-items: center; gap: 6px;
        font-size: 0.8em; padding: 3px 0;
        color: var(--vscode-foreground);
    }
    .model-list { margin-top: 6px; }
    .btn-sm {
        background: transparent; color: var(--vscode-errorForeground);
        border: 1px solid var(--vscode-errorForeground);
        padding: 1px 8px; border-radius: 4px; font-size: 0.75em;
        cursor: pointer;
    }
    .btn-sm:hover { opacity: 0.8; }

    /* ── Empty state ── */
    .empty {
        text-align: center; color: var(--vscode-descriptionForeground);
        padding: 40px 16px; font-size: 0.9em;
    }
    .empty .hint { font-size: 0.82em; margin-top: 8px; opacity: 0.6; }
    .shortcut {
        font-family: var(--vscode-editor-font-family);
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        padding: 1px 6px; border-radius: 4px; font-size: 0.85em;
    }
    .entry-hidden { display: none; }
    .pagination {
        display: flex; align-items: center; justify-content: center; gap: 4px;
        margin: 8px 0; font-size: 0.82em;
    }
    .pagination button {
        background: transparent; border: none; cursor: pointer;
        color: var(--vscode-descriptionForeground);
        padding: 2px 8px; border-radius: 4px;
        font-family: var(--vscode-font-family); font-size: 0.9em;
    }
    .pagination button:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.05)); }
    .pagination button.active {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
    }
    .pagination button:disabled { opacity: 0.3; cursor: default; }
</style></head><body>

    <button id="recordBtn" class="record-btn">
        <canvas id="waveformCanvas"></canvas>
        <span class="btn-content">
            <span id="recordIcon">🎙</span>
            <span id="recordLabel">Start Recording</span>
            <span class="record-hint">⌘⇧;</span>
        </span>
    </button>

    ${entries.length > 0 ? `
    <div class="search-bar"><input id="searchBox" type="text" placeholder="Search ${entries.length} transcription${entries.length !== 1 ? 's' : ''}..." /></div>
    <div class="section-label"><span>History</span><button id="clearAll" title="Clear all">🗑</button></div>
    ` : ''}

    <div id="entriesContainer">
    ${entries.length === 0
        ? `<div class="empty">
                No transcriptions yet.<br>
                Press <span class="shortcut">⌘⇧;</span> to start recording.
                <div class="hint">100% local — nothing leaves your machine.</div>
           </div>`
        : rows}
    </div>
    ${entries.length > PAGE_SIZE ? '<div id="pagination" class="pagination"></div>' : ''}

    <div class="settings">
        <div class="settings-title" id="settingsToggle">⚙ Settings ▾</div>
        <div class="settings-body" id="settingsBody">
            <div class="setting-row">
                <label for="modelPicker">Model</label>
                <select id="modelPicker">${modelOptions}</select>
            </div>
            ${downloadedModels ? `<div class="model-list">${downloadedModels}</div>` : ''}
            <div class="setting-row">
                <label for="langPicker">Language</label>
                <select id="langPicker">${langOptions}</select>
            </div>
            <div class="setting-row">
                <label for="devicePicker">Mic</label>
                <select id="devicePicker">${deviceOptions}</select>
            </div>
        </div>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const entries = ${entriesJson};

        /* Settings toggle */
        document.getElementById('settingsToggle').addEventListener('click', () => {
            const body = document.getElementById('settingsBody');
            const toggle = document.getElementById('settingsToggle');
            if (body.style.display === 'none') {
                body.style.display = 'flex';
                toggle.textContent = '⚙ Settings ▾';
            } else {
                body.style.display = 'none';
                toggle.textContent = '⚙ Settings ▸';
            }
        });

        /* Settings change handlers */
        document.getElementById('modelPicker').addEventListener('change', (e) => {
            vscode.postMessage({ type: 'switchModel', id: e.target.value, text: '' });
        });
        document.getElementById('langPicker').addEventListener('change', (e) => {
            vscode.postMessage({ type: 'setLanguage', id: '', text: e.target.value });
        });
        document.getElementById('devicePicker').addEventListener('change', (e) => {
            vscode.postMessage({ type: 'setAudioDevice', id: '', text: e.target.value });
        });

        /* History button handlers */
        document.addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            if (btn.id === 'recordBtn') {
                vscode.postMessage({ type: 'toggleRecording', id: '', text: '' });
                return;
            }
            if (btn.id === 'clearAll') {
                vscode.postMessage({ type: 'clear', id: '', text: '' });
                return;
            }
            const action = btn.dataset.action;
            const index = btn.dataset.index;
            if (action === 'deleteModel') {
                const modelId = btn.dataset.model;
                if (modelId) {
                    vscode.postMessage({ type: 'deleteModel', id: modelId, text: '' });
                }
                return;
            }
            if (action && index !== undefined) {
                const entry = entries[parseInt(index)];
                if (!entry) return;
                vscode.postMessage({ type: action, id: entry.id, text: entry.text });
            }
        });

        /* Search / filter history */
        const searchBox = document.getElementById('searchBox');
        if (searchBox) {
            searchBox.addEventListener('input', (e) => {
                const query = e.target.value.toLowerCase();
                const container = document.getElementById('entriesContainer');
                const entryDivs = container.querySelectorAll('.entry');
                entryDivs.forEach((div) => {
                    const text = div.querySelector('.text')?.textContent?.toLowerCase() || '';
                    div.style.display = text.includes(query) ? '' : 'none';
                });
                // Hide pagination when searching
                const pag = document.getElementById('pagination');
                if (pag) pag.style.display = query ? 'none' : 'flex';
            });
        }

        /* Pagination — pages of 6 */
        const PAGE_SIZE = 6;
        let currentPage = 0;
        const allEntries = document.getElementById('entriesContainer')?.querySelectorAll('.entry') || [];
        const totalPages = Math.ceil(allEntries.length / PAGE_SIZE);

        function showPage(page) {
            currentPage = page;
            const start = page * PAGE_SIZE;
            const end = start + PAGE_SIZE;
            allEntries.forEach((div, i) => {
                div.style.display = (i >= start && i < end) ? '' : 'none';
            });
            renderPagination();
        }

        function renderPagination() {
            const pag = document.getElementById('pagination');
            if (!pag || totalPages <= 1) return;
            let html = '<button class="pg-prev" ' + (currentPage === 0 ? 'disabled' : '') + '>&lsaquo;</button>';
            for (let i = 0; i < totalPages; i++) {
                html += '<button class="pg-num' + (i === currentPage ? ' active' : '') + '" data-page="' + i + '">' + (i + 1) + '</button>';
            }
            html += '<button class="pg-next" ' + (currentPage === totalPages - 1 ? 'disabled' : '') + '>&rsaquo;</button>';
            pag.innerHTML = html;
        }

        if (totalPages > 1) {
            showPage(0);
            document.getElementById('pagination')?.addEventListener('click', (e) => {
                const btn = e.target.closest('button');
                if (!btn || btn.disabled) return;
                if (btn.classList.contains('pg-prev')) showPage(currentPage - 1);
                else if (btn.classList.contains('pg-next')) showPage(currentPage + 1);
                else if (btn.dataset.page !== undefined) showPage(parseInt(btn.dataset.page));
            });
        }

        /* Listen for recording state + audio level updates from the extension */
        const waveCanvas = document.getElementById('waveformCanvas');
        const recordBtn = document.getElementById('recordBtn');
        const waveCtx = waveCanvas ? waveCanvas.getContext('2d') : null;
        const levelHistory = [];
        const MAX_BARS = 40;
        let animFrameId = null;

        function resizeCanvas() {
            if (!waveCanvas || !recordBtn) return;
            waveCanvas.width = recordBtn.clientWidth * (window.devicePixelRatio || 1);
            waveCanvas.height = recordBtn.clientHeight * (window.devicePixelRatio || 1);
        }

        function drawWaveform() {
            if (!waveCtx || !waveCanvas) return;
            const w = waveCanvas.width;
            const h = waveCanvas.height;
            waveCtx.clearRect(0, 0, w, h);

            const barCount = levelHistory.length;
            if (barCount === 0) { animFrameId = requestAnimationFrame(drawWaveform); return; }

            const barWidth = Math.max(2, (w / MAX_BARS) * 0.4);
            const gap = (w / MAX_BARS) * 0.6;
            const startX = w - barCount * (barWidth + gap);

            for (let i = 0; i < barCount; i++) {
                const level = levelHistory[i];
                const barH = Math.max(3, level * h * 0.95);
                const x = startX + i * (barWidth + gap);
                const y = (h - barH) / 2;

                const alpha = 0.4 + level * 0.6;
                waveCtx.fillStyle = 'hsla(0, 0%, 100%, ' + alpha + ')';
                waveCtx.fillRect(Math.round(x), Math.round(y), Math.round(barWidth), Math.round(barH));
            }

            animFrameId = requestAnimationFrame(drawWaveform);
        }

        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.type === 'recordingState') {
                const btn = document.getElementById('recordBtn');
                const icon = document.getElementById('recordIcon');
                const label = document.getElementById('recordLabel');
                if (btn && icon && label) {
                    if (msg.recording) {
                        btn.classList.add('recording');
                        levelHistory.length = 0;
                        resizeCanvas();
                        if (!animFrameId) drawWaveform();
                    } else {
                        btn.classList.remove('recording');
                        if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
                        levelHistory.length = 0;
                    }
                }
            } else if (msg.type === 'audioLevel') {
                levelHistory.push(msg.level);
                if (levelHistory.length > MAX_BARS) levelHistory.shift();
            }
        });

        window.addEventListener('resize', resizeCanvas);
    </script>
</body></html>`;
}

// ─── Configuration helpers ───────────────────────────────────────────────────

/** Returns the model ID from user settings, falling back to base.en. */
function getSelectedModelId(): string {
    const cfg = vscode.workspace.getConfiguration('voicetotext').get<string>('model');
    return cfg && cfg in MODELS ? cfg : 'small.en';
}

/** Resolves the absolute path to the active model's .bin file. */
function getModelPath(): string {
    const custom = vscode.workspace.getConfiguration('voicetotext').get<string>('modelPath');
    if (custom && custom.length > 0) { return custom; }
    const model = MODELS[getSelectedModelId()];
    return path.join(MODEL_DIR, model.file);
}

function getLanguage(): string {
    return vscode.workspace.getConfiguration('voicetotext').get<string>('language') || 'en';
}

/** Resolves the whisper-cli binary path: user override → built copy → PATH. */
function getWhisperCliPath(): string {
    const cfg = vscode.workspace.getConfiguration('voicetotext').get<string>('whisperCliPath');
    if (cfg && cfg.length > 0 && fs.existsSync(cfg)) { return cfg; }
    if (fs.existsSync(WHISPER_CLI)) { return WHISPER_CLI; }
    const found = findBinary('whisper-cli');
    if (found) { return found; }
    return WHISPER_CLI;
}

function findBinary(name: string): string | null {
    try {
        return execSync(`which ${name}`, { encoding: 'utf-8', env: { ...process.env, PATH: getEnhancedPath() } }).trim();
    } catch { return null; }
}

// ─── Dependency checks ───────────────────────────────────────────────────────

/**
 * Returns a list of missing dependencies.
 * An empty array means everything is ready to record.
 */
function checkDependencies(): string[] {
    const missing: string[] = [];
    try { execSync('which ffmpeg', { stdio: 'ignore', env: { ...process.env, PATH: getEnhancedPath() } }); } catch { missing.push('ffmpeg'); }
    const whisperPath = getWhisperCliPath();
    if (!whisperPath || !fs.existsSync(whisperPath)) { missing.push('whisper-cli'); }
    if (!fs.existsSync(getModelPath())) {
        const m = MODELS[getSelectedModelId()];
        missing.push(`model (${m.label})`);
    }
    return missing;
}

// ─── First-time setup ────────────────────────────────────────────────────────

/**
 * One-time setup: checks for Homebrew, installs cmake + ffmpeg if missing,
 * clones & builds whisper.cpp, and downloads the selected model.
 * Asks the user for permission before installing anything.
 */
async function runSetup(): Promise<void> {
    isSettingUp = true;
    statusBarItem.text = '$(sync~spin) Voice to Text: Setting up...';
    try {
        // 0. Homebrew is required for installing dependencies
        if (!findBinary('brew')) {
            vscode.window.showErrorMessage(
                'Voice to Text: Homebrew is required. Install from https://brew.sh then try again.'
            );
            return;
        }

        // 1. Collect missing brew packages
        const brewInstalls: string[] = [];
        if (!findBinary('ffmpeg')) { brewInstalls.push('ffmpeg'); }
        if (!findBinary('cmake')) { brewInstalls.push('cmake'); }

        if (brewInstalls.length > 0) {
            const choice = await vscode.window.showInformationMessage(
                `Voice to Text needs to install: ${brewInstalls.join(', ')} via Homebrew. Proceed?`,
                'Install', 'Cancel'
            );
            if (choice !== 'Install') { return; }
            await runWithProgress(
                `Installing ${brewInstalls.join(' & ')}...`,
                `brew install ${brewInstalls.join(' ')}`
            );
        }

        // 2. Build whisper-cli
        if (!fs.existsSync(getWhisperCliPath())) { await buildWhisperCli(); }

        // 3. Download model
        if (!fs.existsSync(getModelPath())) { await downloadModel(getSelectedModelId()); }

        vscode.window.showInformationMessage('Voice to Text: Setup complete! Press ⌘⇧; to start recording.');
        // Start the pre-buffer now that dependencies are ready
        startPreBuffer();
    } catch (e: any) {
        vscode.window.showErrorMessage(`Voice to Text setup failed: ${e.message}`);
    } finally {
        isSettingUp = false;
        resetStatusBar();
    }
}

/**
 * Clones whisper.cpp at a pinned stable tag and builds whisper-cli with Metal GPU support.
 * Uses shallow clone (--depth 1) to minimize download size.
 */
async function buildWhisperCli(): Promise<void> {
    if (!fs.existsSync(WHISPER_SRC)) {
        await runWithProgress(
            'Cloning whisper.cpp...',
            `git clone --branch ${WHISPER_CPP_TAG} --depth 1 https://github.com/ggerganov/whisper.cpp.git "${WHISPER_SRC}"`
        );
    }
    const buildDir = path.join(WHISPER_SRC, 'build');
    if (!fs.existsSync(buildDir)) { fs.mkdirSync(buildDir, { recursive: true }); }
    await runWithProgress(
        'Building whisper-cli with Metal GPU (this may take a few minutes)...',
        `cd "${buildDir}" && cmake .. -DGGML_METAL=ON -DCMAKE_BUILD_TYPE=Release && cmake --build . --config Release -j$(sysctl -n hw.ncpu)`
    );
    if (!fs.existsSync(WHISPER_CLI)) {
        throw new Error('whisper-cli build failed — binary not found after cmake');
    }
}

/** Downloads a model by ID from Hugging Face to ~/.voicetotext/models/. */
async function downloadModel(modelId: string): Promise<void> {
    const model = MODELS[modelId];
    if (!model) { throw new Error(`Unknown model: ${modelId}`); }
    if (!fs.existsSync(MODEL_DIR)) { fs.mkdirSync(MODEL_DIR, { recursive: true }); }
    const dest = path.join(MODEL_DIR, model.file);
    await runWithProgress(
        `Downloading ${model.label} (${model.size})...`,
        `curl -L -o "${dest}" "${model.url}"`
    );
    if (!fs.existsSync(dest)) { throw new Error(`Model download failed for ${model.label}`); }
}

/**
 * Builds a PATH that includes common Homebrew and system binary locations.
 * VS Code's spawned shell often doesn't inherit the user's full PATH,
 * which causes cmake/git/curl to fail with exit code 127.
 */
function getEnhancedPath(): string {
    const existing = process.env.PATH || '';
    const extras = [
        '/opt/homebrew/bin', '/opt/homebrew/sbin',   // Apple Silicon Homebrew
        '/usr/local/bin', '/usr/local/sbin',          // Intel Homebrew / system
        '/usr/bin', '/usr/sbin', '/bin', '/sbin',     // macOS system
    ];
    const parts = existing.split(':');
    for (const p of extras) {
        if (!parts.includes(p)) { parts.push(p); }
    }
    return parts.join(':');
}

/** Runs a shell command inside a VS Code progress notification. */
async function runWithProgress(title: string, cmd: string): Promise<void> {
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: false },
        () => new Promise<void>((resolve, reject) => {
            const env = { ...process.env, PATH: getEnhancedPath() };
            const proc = spawn('bash', ['-c', cmd], { stdio: 'pipe', env });
            proc.on('close', code =>
                code === 0 ? resolve() : reject(new Error(`Command failed (exit ${code}): ${cmd}`))
            );
            proc.on('error', reject);
        })
    );
}

// ─── Audio device detection ──────────────────────────────────────────────────

/**
 * Determines which audio input device to use.
 * Priority: user setting → auto-detect built-in mic → fallback to device 0.
 * Filters out virtual audio devices (Zoom, Teams, BlackHole, etc.).
 */
function getAudioDevice(): string {
    const cfg = vscode.workspace.getConfiguration('voicetotext').get<string>('audioDevice');
    if (cfg && cfg.length > 0) { return cfg; }
    try {
        const output = execSync('ffmpeg -f avfoundation -list_devices true -i "" 2>&1 || true', { encoding: 'utf-8' });
        const lines = output.split('\n');
        let bestIndex = '0';
        const virtualKeywords = ['zoom', 'teams', 'virtual', 'aggregate', 'soundflower', 'blackhole', 'loopback'];
        for (const line of lines) {
            const match = line.match(/\[AVFoundation.*\]\s*\[(\d+)\]\s*(.*)/);
            if (match) {
                const idx = match[1];
                const name = match[2].toLowerCase();
                // Prefer a device with "microphone" in the name that isn't virtual
                if (name.includes('microphone') && !virtualKeywords.some(v => name.includes(v))) {
                    return idx;
                }
                if (!virtualKeywords.some(v => name.includes(v))) {
                    bestIndex = idx;
                }
            }
        }
        return bestIndex;
    } catch { return '0'; }
}

// ─── Recording ───────────────────────────────────────────────────────────────

/**
 * Starts recording audio via ffmpeg using the avfoundation input.
 * Audio is captured at 16 kHz mono (the format whisper expects).
 */
async function startRecording(): Promise<void> {
    const device = getAudioDevice();
    const ts = Date.now();
    currentRecordingPath = path.join(RECORDING_DIR, `rec_${ts}.wav`);
    recordingStartTime = ts;
    streamingText = '';

    // Snapshot the pre-buffer before starting the main recording
    const preBufferSnapshot = snapshotPreBuffer();
    // Store the snapshot path so stopRecording can use it
    (startRecording as any)._preBufferSnapshot = preBufferSnapshot;

    recordingProcess = spawn('ffmpeg', [
        '-f', 'avfoundation', '-i', `:${device}`,
        '-af', [
            'highpass=f=80',
            'lowpass=f=8000',
            'afftdn=nf=-25',
            'acompressor=threshold=-20dB:ratio=4:attack=5:release=50',
            'loudnorm=I=-16:TP=-1.5',
        ].join(','),
        '-ar', '16000', '-ac', '1', '-sample_fmt', 's16',
        '-y', currentRecordingPath,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    recordingProcess.on('error', (err) => {
        vscode.window.showErrorMessage(`Voice to Text: Recording failed: ${err.message}`);
        resetRecording();
    });

    isRecording = true;
    playSound('start');
    waveFrame = 0;
    statusBarItem.text = `$(primitive-dot) Voice to Text ${WAVE_FRAMES[0]}`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

    // Animate the waveform in the status bar
    waveInterval = setInterval(() => {
        waveFrame = (waveFrame + 1) % WAVE_FRAMES.length;
        const elapsed = ((Date.now() - recordingStartTime) / 1000).toFixed(0);
        const preview = streamingText ? ` "${streamingText.slice(0, 30)}${streamingText.length > 30 ? '…' : ''}"` : '';
        statusBarItem.text = `$(primitive-dot) ${elapsed}s ${WAVE_FRAMES[waveFrame]}${preview}`;
    }, 200);

    // Audio level metering: run a second ffmpeg that outputs RMS volume via astats
    startAudioLevelMonitor(device);

    // Streaming: periodically snapshot audio and transcribe for live preview
    streamingInterval = setInterval(() => { streamTranscribe(); }, 3000);

    pushRecordingState();
}

/**
 * Spawns a lightweight ffmpeg process that reads the mic and outputs RMS volume levels.
 * Uses the `astats` filter to print per-frame RMS, parsed into 0–1 and pushed to webviews.
 */
let levelProcess: ChildProcess | null = null;
function startAudioLevelMonitor(device: string): void {
    const ffmpegPath = findBinary('ffmpeg') || 'ffmpeg';
    // astats outputs per-channel RMS_level every ~100ms with metadata=1
    levelProcess = spawn(ffmpegPath, [
        '-f', 'avfoundation', '-i', `:${device}`,
        '-af', 'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level',
        '-f', 'null', '-',
    ], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PATH: getEnhancedPath() } });

    let stderrBuf = '';
    let lastPushTime = 0;
    let smoothedLevel = 0;
    levelProcess.stderr?.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop() || '';
        for (const line of lines) {
            const match = line.match(/RMS_level=([-\d.inf]+)/);
            if (match) {
                const raw = match[1];
                let level = 0;
                if (raw !== '-inf' && raw !== 'inf') {
                    const db = parseFloat(raw);
                    if (!isNaN(db)) { level = Math.max(0, Math.min(1, (db + 60) / 60)); }
                }
                // Smooth: ease toward the new level
                smoothedLevel = smoothedLevel * 0.6 + level * 0.4;
                // Throttle: push at most every 150ms
                const now = Date.now();
                if (now - lastPushTime >= 150) {
                    lastPushTime = now;
                    pushAudioLevel(smoothedLevel);
                }
            }
        }
    });

    levelProcess.on('error', () => { /* non-critical */ });
    levelProcess.unref();
}

function stopAudioLevelMonitor(): void {
    if (levelProcess) {
        levelProcess.kill('SIGKILL');
        levelProcess = null;
    }
}

/**
 * Takes a snapshot of the current recording and transcribes it for a live preview.
 * Runs in the background without interrupting the recording.
 */
function streamTranscribe(): void {
    if (!isRecording || !fs.existsSync(currentRecordingPath)) { return; }
    const stat = fs.statSync(currentRecordingPath);
    if (stat.size < 5000) { return; } // Not enough audio yet

    const snapshotPath = currentRecordingPath.replace(/\.wav$/, '_snap.wav');
    const ffmpegPath = findBinary('ffmpeg') || 'ffmpeg';

    try {
        // Copy current recording to a snapshot (ffmpeg can read a file being written)
        execSync(
            `"${ffmpegPath}" -y -i "${currentRecordingPath}" -ar 16000 -ac 1 -sample_fmt s16 "${snapshotPath}"`,
            { encoding: 'utf-8', env: { ...process.env, PATH: getEnhancedPath() }, stdio: 'pipe', timeout: 5000 }
        );
    } catch { return; }

    const whisperPath = getWhisperCliPath();
    const modelPath = getModelPath();
    const lang = getLanguage();

    const args = ['-m', modelPath, '-f', snapshotPath, '-l', lang, '-np', '-nt', '-t', '2'];
    if (lang !== 'en') { args.push('--translate'); }

    const proc = spawn(whisperPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.on('close', () => {
        try { fs.unlinkSync(snapshotPath); } catch {}
        const raw = stdout.trim()
            .replace(/^\[.*?\]\s*/g, '')
            .replace(/^\.{2,}\s*/g, '')
            .replace(/\s*\.{2,}$/g, '')
            .trim();
        if (raw.length > 0) { streamingText = raw; }
    });
}

/**
 * Stops recording, sends SIGINT to ffmpeg (so the WAV header is finalized),
 * then transcribes the audio and pastes the result.
 */
async function stopRecording(): Promise<void> {
    if (!recordingProcess) { resetRecording(); return; }
    playSound('stop');
    const durationMs = Date.now() - recordingStartTime;

    // Stop streaming transcription
    if (streamingInterval) { clearInterval(streamingInterval); streamingInterval = null; }
    streamingText = '';

    // Stop audio level monitor
    stopAudioLevelMonitor();

    // Stop wave animation
    if (waveInterval) { clearInterval(waveInterval); waveInterval = null; }
    statusBarItem.text = '$(sync~spin) Transcribing...';
    statusBarItem.backgroundColor = undefined;

    // SIGINT lets ffmpeg finalize the WAV header properly
    recordingProcess.kill('SIGINT');
    await new Promise<void>(resolve => {
        recordingProcess!.on('close', () => resolve());
        setTimeout(resolve, 3000); // safety timeout
    });
    recordingProcess = null;

    // Validate the recorded file
    if (!fs.existsSync(currentRecordingPath)) {
        vscode.window.showWarningMessage('Voice to Text: No audio file produced.');
        resetStatusBar();
        return;
    }
    const stat = fs.statSync(currentRecordingPath);
    if (stat.size < 100) {
        vscode.window.showWarningMessage('Voice to Text: Audio file too small — no speech captured.');
        cleanupRecordingFile();
        resetStatusBar();
        return;
    }

    // Pad short recordings with silence so Whisper has enough audio context
    let audioPath = await padAudioIfNeeded(currentRecordingPath);

    // Prepend the pre-buffer audio (captures speech before the hotkey was pressed)
    const preBufferSnapshot = (startRecording as any)._preBufferSnapshot as string | null;
    if (preBufferSnapshot && fs.existsSync(preBufferSnapshot)) {
        audioPath = concatAudio(preBufferSnapshot, audioPath);
    }
    (startRecording as any)._preBufferSnapshot = null;

    // Transcribe
    let text = await transcribe(audioPath);
    cleanupRecordingFile();
    // Clean up padded/combined files if different from the original
    if (audioPath !== currentRecordingPath) { try { fs.unlinkSync(audioPath); } catch {} }

    if (text) {
        // Apply smart punctuation and formatting
        text = smartPunctuation(text);
        addToHistory(text, durationMs);
        await insertTextAtCursor(text);
    }
    resetStatusBar();

    // Restart the pre-buffer for the next recording
    startPreBuffer();
}

function resetStatusBar(): void {
    statusBarItem.text = '$(mic) Voice to Text';
    statusBarItem.backgroundColor = undefined;
    isRecording = false;
    pushRecordingState();
}

// ─── Audio Padding ───────────────────────────────────────────────────────────

/**
 * Pads short audio files with silence to at least 1.5 seconds.
 * Whisper struggles with very short recordings — padding gives it enough context.
 * Returns the path to the (possibly padded) audio file.
 */
async function padAudioIfNeeded(audioPath: string): Promise<string> {
    const MIN_DURATION_SEC = 1.5;
    const ffmpegPath = findBinary('ffmpeg') || 'ffmpeg';

    // Probe the audio duration using ffprobe (bundled with ffmpeg)
    try {
        const ffprobePath = ffmpegPath.replace(/ffmpeg$/, 'ffprobe');
        const durationStr = execSync(
            `"${ffprobePath}" -v error -show_entries format=duration -of csv=p=0 "${audioPath}"`,
            { encoding: 'utf-8', env: { ...process.env, PATH: getEnhancedPath() } }
        ).trim();
        const duration = parseFloat(durationStr);
        if (!isNaN(duration) && duration >= MIN_DURATION_SEC) {
            return audioPath; // Long enough, no padding needed
        }
    } catch {
        // If ffprobe fails, pad anyway to be safe
    }

    // Pad with silence using ffmpeg's apad filter
    const paddedPath = audioPath.replace(/\.wav$/, '_padded.wav');
    try {
        execSync(
            `"${ffmpegPath}" -y -i "${audioPath}" -af "apad=whole_dur=${MIN_DURATION_SEC}" -ar 16000 -ac 1 "${paddedPath}"`,
            { encoding: 'utf-8', env: { ...process.env, PATH: getEnhancedPath() } }
        );
        return paddedPath;
    } catch {
        return audioPath; // Padding failed, use original
    }
}

// ─── Transcription ───────────────────────────────────────────────────────────

/**
 * Runs whisper-cli on the given audio file and returns the transcribed text.
 * Returns null if transcription fails or produces no output.
 */
async function transcribe(audioPath: string): Promise<string | null> {
    const whisperPath = getWhisperCliPath();
    const modelPath = getModelPath();
    const lang = getLanguage();

    return new Promise((resolve) => {
        const args = [
            '-m', modelPath,
            '-f', audioPath,
            '-l', lang,
            '-np',       // no prints (suppress whisper.cpp internal logs)
            '-nt',       // no timestamps
            '-t', '4',   // 4 threads — good balance for Apple Silicon
        ];

        // Translate non-English speech to English (whisper.cpp built-in feature)
        if (lang !== 'en') {
            args.push('--translate');
        }

        const proc = spawn(whisperPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';

        proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
        proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

        proc.on('close', (code) => {
            if (code !== 0) {
                // Surface only actual error lines, not the full whisper.cpp log
                const errorLines = stderr.split('\n')
                    .filter(l => l.includes('error') || l.includes('Error'))
                    .join('; ');
                vscode.window.showErrorMessage(
                    `Voice to Text: Transcription failed: ${errorLines || `exit code ${code}`}`
                );
                resolve(null);
                return;
            }
            const raw = stdout.trim();
            if (!raw || raw.length === 0) {
                vscode.window.showInformationMessage('Voice to Text: No speech detected.');
                resolve(null);
                return;
            }
            // Strip leading/trailing ellipses and brackets that whisper.cpp sometimes adds
            const cleaned = raw.replace(/^\[.*?\]\s*/g, '').replace(/^\.{2,}\s*/g, '').replace(/\s*\.{2,}$/g, '').trim();
            if (!cleaned || cleaned.length === 0) {
                vscode.window.showInformationMessage('Voice to Text: No speech detected.');
                resolve(null);
                return;
            }
            resolve(cleaned);
        });

        proc.on('error', (err) => {
            vscode.window.showErrorMessage(`Voice to Text: Failed to run whisper-cli: ${err.message}`);
            resolve(null);
        });
    });
}

// ─── Text insertion ──────────────────────────────────────────────────────────

/**
 * Pastes text at the user's cursor position.
 * Strategy:
 *   1. If a VS Code text editor is focused, insert directly via the editor API (most reliable).
 *   2. Otherwise, copy to clipboard and simulate Cmd+V via AppleScript with a short delay
 *      to ensure the clipboard is ready before the keystroke fires.
 */
async function insertTextAtCursor(text: string): Promise<void> {
    // Strategy 1: VS Code editor is active — use the editor API directly (no clipboard needed)
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        await editor.edit(editBuilder => {
            if (editor.selection.isEmpty) {
                editBuilder.insert(editor.selection.active, text);
            } else {
                editBuilder.replace(editor.selection, text);
            }
        });
        return;
    }

    // Strategy 2: No code editor focused (e.g. chatbot input, webview text area)
    // Write transcription to clipboard and simulate Cmd+V
    await vscode.env.clipboard.writeText(text);
    try {
        execSync(
            `osascript -e 'delay 0.15' -e 'tell application "System Events" to keystroke "v" using command down'`,
            { env: { ...process.env, PATH: getEnhancedPath() } }
        );
    } catch {
        // Silent fallback — text is on clipboard, user can paste manually
    }
}

/**
 * Paste triggered from the webview "Paste at Cursor" button.
 * The webview has focus, so activeTextEditor is likely undefined.
 * We focus the last active text editor first, then insert via the editor API.
 * Falls back to clipboard + paste command.
 */
async function pasteFromWebview(text: string): Promise<void> {
    // Try to focus the most recent text editor
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    // Small delay to let focus settle
    await new Promise(resolve => setTimeout(resolve, 100));

    const editor = vscode.window.activeTextEditor;
    if (editor) {
        await editor.edit(editBuilder => {
            if (editor.selection.isEmpty) {
                editBuilder.insert(editor.selection.active, text);
            } else {
                editBuilder.replace(editor.selection, text);
            }
        });
        return;
    }

    // No editor available — write to clipboard and simulate Cmd+V
    await vscode.env.clipboard.writeText(text);
    try {
        execSync(
            `osascript -e 'delay 0.15' -e 'tell application "System Events" to keystroke "v" using command down'`,
            { env: { ...process.env, PATH: getEnhancedPath() } }
        );
    } catch {
        // Silent fallback
    }
}

// ─── Cleanup & teardown ─────────────────────────────────────────────────────

/** Removes the temporary recording WAV file. */
function cleanupRecordingFile(): void {
    try {
        if (currentRecordingPath && fs.existsSync(currentRecordingPath)) {
            fs.unlinkSync(currentRecordingPath);
        }
    } catch { /* best-effort cleanup */ }
}

/** Resets all recording state (used on error paths). */
function resetRecording(): void {
    if (waveInterval) { clearInterval(waveInterval); waveInterval = null; }
    recordingProcess = null;
    isRecording = false;
    resetStatusBar();
}

/** Called when the extension is deactivated — cleans up any in-flight recording. */
export function deactivate(): void {
    if (recordingProcess) {
        recordingProcess.kill('SIGINT');
        recordingProcess = null;
    }
    stopPreBuffer();
    stopAudioLevelMonitor();
    if (waveInterval) { clearInterval(waveInterval); waveInterval = null; }
    cleanupRecordingFile();
}

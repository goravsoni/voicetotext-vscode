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
    statusBarItem.tooltip = 'Option+; to toggle recording';
    statusBarItem.show();

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

    const setup = vscode.commands.registerCommand('voicetotext.setup', runSetup);
    const history = vscode.commands.registerCommand('voicetotext.showHistory', () => showHistoryPanel(context));
    const switchModel = vscode.commands.registerCommand('voicetotext.switchModel', handleSwitchModel);

    // Sidebar webview for transcription history
    const sidebarProvider = new HistorySidebarProvider(context);
    const sidebarReg = vscode.window.registerWebviewViewProvider('voicetotext.historyView', sidebarProvider);

    context.subscriptions.push(toggle, setup, history, switchModel, sidebarReg, statusBarItem);
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
            vscode.window.showInformationMessage('Copied to clipboard');
        } else if (msg.type === 'delete') {
            deleteFromHistory(msg.id);
        } else if (msg.type === 'clear') {
            clearHistory();
        } else if (msg.type === 'insert') {
            await insertTextAtCursor(msg.text);
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
            await cfg.update('language', msg.text, vscode.ConfigurationTarget.Global);
        } else if (msg.type === 'setAudioDevice') {
            await cfg.update('audioDevice', msg.text, vscode.ConfigurationTarget.Global);
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
    const msg = { type: 'recordingState', recording: isRecording };
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

    const rows = entries.map((e, i) => {
        const date = new Date(e.timestamp);
        const timeStr = date.toLocaleString();
        const dur = (e.durationMs / 1000).toFixed(1);
        const safe = e.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `
        <div class="entry">
            <div class="meta">
                <span class="time">${timeStr}</span>
                <span class="badge">${dur}s</span>
            </div>
            <div class="text">${safe}</div>
            <div class="actions">
                <button class="btn btn-primary" data-index="${i}" data-action="copy">Copy</button>
                <button class="btn btn-secondary" data-index="${i}" data-action="insert">Paste at Cursor</button>
                <button class="btn btn-danger" data-index="${i}" data-action="delete">Delete</button>
            </div>
        </div>`;
    }).join('');

    return `<!DOCTYPE html>
<html><head><style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 16px; line-height: 1.5;
    }
    .header { margin-bottom: 12px; }
    .header h1 { font-size: 1.3em; margin-bottom: 2px; }
    .header .count {
        font-size: 0.85em; color: var(--vscode-descriptionForeground);
        margin-bottom: 8px;
    }

    /* ── Settings panel ── */
    .settings {
        background: var(--vscode-sideBar-background, var(--vscode-editor-background));
        border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
        border-radius: 8px; padding: 12px; margin-bottom: 16px;
    }
    .settings-title {
        font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.5px;
        color: var(--vscode-descriptionForeground); margin-bottom: 10px;
        cursor: pointer; user-select: none;
    }
    .settings-title:hover { color: var(--vscode-foreground); }
    .settings-body { display: flex; flex-direction: column; gap: 8px; }
    .setting-row {
        display: flex; align-items: center; gap: 8px;
    }
    .setting-row label {
        min-width: 70px; font-size: 0.85em;
        color: var(--vscode-descriptionForeground);
    }
    .setting-row select, .setting-row input {
        flex: 1;
        background: var(--vscode-dropdown-background, var(--vscode-input-background));
        color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
        border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent));
        padding: 4px 8px; border-radius: 4px;
        font-size: 0.85em; font-family: var(--vscode-font-family);
    }

    /* ── Toolbar ── */
    .toolbar { display: flex; gap: 8px; margin-bottom: 16px; }
    .toolbar button {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        border: none; padding: 5px 12px; cursor: pointer;
        border-radius: 4px; font-size: 0.85em;
    }
    .toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }

    /* ── Entries ── */
    .entry {
        background: var(--vscode-editor-inactiveSelectionBackground);
        border-radius: 8px; padding: 12px; margin-bottom: 10px;
        border: 1px solid transparent; transition: border-color 0.15s;
    }
    .entry:hover { border-color: var(--vscode-focusBorder); }
    .meta {
        display: flex; align-items: center; gap: 10px;
        font-size: 0.8em; color: var(--vscode-descriptionForeground);
        margin-bottom: 6px;
    }
    .badge {
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        padding: 1px 7px; border-radius: 10px; font-size: 0.8em;
    }
    .text { margin-bottom: 10px; white-space: pre-wrap; word-break: break-word; }
    .actions { display: flex; gap: 6px; }
    .btn {
        border: none; padding: 4px 12px; border-radius: 4px;
        cursor: pointer; font-size: 0.82em; transition: opacity 0.15s;
    }
    .btn:hover { opacity: 0.85; }
    .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .btn-danger { background: transparent; color: var(--vscode-errorForeground); border: 1px solid var(--vscode-errorForeground); }
    .empty {
        text-align: center; color: var(--vscode-descriptionForeground);
        padding: 48px 16px; font-size: 0.95em;
    }
    .empty .hint { font-size: 0.85em; margin-top: 8px; opacity: 0.7; }
    .shortcut {
        font-family: var(--vscode-editor-font-family);
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        padding: 1px 6px; border-radius: 4px; font-size: 0.85em;
    }

    /* ── Record button ── */
    .record-btn {
        display: flex; align-items: center; justify-content: center; gap: 8px;
        width: 100%; padding: 10px 16px; margin-bottom: 16px;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none; border-radius: 8px; cursor: pointer;
        font-size: 0.95em; font-family: var(--vscode-font-family);
        transition: background 0.15s, transform 0.1s;
    }
    .record-btn:hover { background: var(--vscode-button-hoverBackground); }
    .record-btn:active { transform: scale(0.98); }
    .record-btn.recording {
        background: var(--vscode-errorForeground, #f44);
        animation: pulse 1.2s ease-in-out infinite;
    }
    .record-hint {
        font-family: var(--vscode-editor-font-family);
        background: rgba(255,255,255,0.15);
        padding: 1px 6px; border-radius: 4px; font-size: 0.8em;
        opacity: 0.8;
    }
    @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.75; }
    }
</style></head><body>
    <div class="header">
        <h1>🎙 Voice to Text</h1>
        <div class="count">${entries.length} transcription${entries.length !== 1 ? 's' : ''}</div>
    </div>

    <button id="recordBtn" class="record-btn">
        <span id="recordIcon">🎙</span>
        <span id="recordLabel">Start Recording</span>
        <span class="record-hint">⌥ ;</span>
    </button>

    <div class="settings">
        <div class="settings-title" id="settingsToggle">⚙ Settings ▾</div>
        <div class="settings-body" id="settingsBody">
            <div class="setting-row">
                <label for="modelPicker">Model</label>
                <select id="modelPicker">${modelOptions}</select>
            </div>
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

    ${entries.length > 0 ? '<div class="toolbar"><button id="clearAll">Clear All</button></div>' : ''}
    ${entries.length === 0
        ? `<div class="empty">
                No transcriptions yet.<br>
                Press <span class="shortcut">⌥ ;</span> to start recording.
                <div class="hint">Audio is recorded and transcribed entirely on your machine.</div>
           </div>`
        : rows}
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
            if (action && index !== undefined) {
                const entry = entries[parseInt(index)];
                if (!entry) return;
                vscode.postMessage({ type: action, id: entry.id, text: entry.text });
            }
        });

        /* Listen for recording state updates from the extension */
        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.type === 'recordingState') {
                const btn = document.getElementById('recordBtn');
                const icon = document.getElementById('recordIcon');
                const label = document.getElementById('recordLabel');
                if (btn && icon && label) {
                    if (msg.recording) {
                        btn.classList.add('recording');
                        icon.textContent = '⏹';
                        label.textContent = 'Stop Recording';
                    } else {
                        btn.classList.remove('recording');
                        icon.textContent = '🎙';
                        label.textContent = 'Start Recording';
                    }
                }
            }
        });
    </script>
</body></html>`;
}

// ─── Configuration helpers ───────────────────────────────────────────────────

/** Returns the model ID from user settings, falling back to large-v3-turbo. */
function getSelectedModelId(): string {
    const cfg = vscode.workspace.getConfiguration('voicetotext').get<string>('model');
    return cfg && cfg in MODELS ? cfg : 'large-v3-turbo';
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
    try { return execSync(`which ${name}`, { encoding: 'utf-8' }).trim(); } catch { return null; }
}

// ─── Dependency checks ───────────────────────────────────────────────────────

/**
 * Returns a list of missing dependencies.
 * An empty array means everything is ready to record.
 */
function checkDependencies(): string[] {
    const missing: string[] = [];
    try { execSync('which ffmpeg', { stdio: 'ignore' }); } catch { missing.push('ffmpeg'); }
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
 * One-time setup: installs ffmpeg via Homebrew, clones & builds whisper.cpp,
 * and downloads the selected model. Shows progress notifications throughout.
 */
async function runSetup(): Promise<void> {
    isSettingUp = true;
    statusBarItem.text = '$(sync~spin) Voice to Text: Setting up...';
    try {
        // 1. ffmpeg
        if (!findBinary('ffmpeg')) {
            if (!findBinary('brew')) {
                vscode.window.showErrorMessage(
                    'Voice to Text: Homebrew is required to install ffmpeg. Install from https://brew.sh'
                );
                return;
            }
            await runWithProgress('Installing ffmpeg...', 'brew install ffmpeg');
        }
        // 2. whisper-cli
        if (!fs.existsSync(getWhisperCliPath())) { await buildWhisperCli(); }
        // 3. Model
        if (!fs.existsSync(getModelPath())) { await downloadModel(getSelectedModelId()); }

        vscode.window.showInformationMessage('Voice to Text: Setup complete! Press ⌥; to start recording.');
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

/** Runs a shell command inside a VS Code progress notification. */
async function runWithProgress(title: string, cmd: string): Promise<void> {
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: false },
        () => new Promise<void>((resolve, reject) => {
            const proc = spawn('bash', ['-c', cmd], { stdio: 'pipe' });
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

    recordingProcess = spawn('ffmpeg', [
        '-f', 'avfoundation', '-i', `:${device}`,
        '-ar', '16000', '-ac', '1', '-sample_fmt', 's16',
        '-y', currentRecordingPath,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    recordingProcess.on('error', (err) => {
        vscode.window.showErrorMessage(`Voice to Text: Recording failed: ${err.message}`);
        resetRecording();
    });

    isRecording = true;
    waveFrame = 0;
    statusBarItem.text = `$(primitive-dot) Voice to Text ${WAVE_FRAMES[0]}`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

    // Animate the waveform in the status bar
    waveInterval = setInterval(() => {
        waveFrame = (waveFrame + 1) % WAVE_FRAMES.length;
        const elapsed = ((Date.now() - recordingStartTime) / 1000).toFixed(0);
        statusBarItem.text = `$(primitive-dot) ${elapsed}s ${WAVE_FRAMES[waveFrame]}`;
    }, 200);

    pushRecordingState();
}

/**
 * Stops recording, sends SIGINT to ffmpeg (so the WAV header is finalized),
 * then transcribes the audio and pastes the result.
 */
async function stopRecording(): Promise<void> {
    if (!recordingProcess) { resetRecording(); return; }
    const durationMs = Date.now() - recordingStartTime;

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
    if (stat.size < 1024) {
        vscode.window.showWarningMessage('Voice to Text: Audio file too small — no speech captured.');
        cleanupRecordingFile();
        resetStatusBar();
        return;
    }

    // Transcribe
    const text = await transcribe(currentRecordingPath);
    cleanupRecordingFile();

    if (text) {
        addToHistory(text, durationMs);
        await insertTextAtCursor(text);
        vscode.window.showInformationMessage(`Voice to Text: Transcribed (${(durationMs / 1000).toFixed(1)}s)`);
    }
    resetStatusBar();
}

function resetStatusBar(): void {
    statusBarItem.text = '$(mic) Voice to Text';
    statusBarItem.backgroundColor = undefined;
    isRecording = false;
    pushRecordingState();
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
            resolve(raw);
        });

        proc.on('error', (err) => {
            vscode.window.showErrorMessage(`Voice to Text: Failed to run whisper-cli: ${err.message}`);
            resolve(null);
        });
    });
}

// ─── Text insertion ──────────────────────────────────────────────────────────

/**
 * Pastes text at the user's cursor position system-wide.
 * Copies to clipboard then simulates Cmd+V via AppleScript / System Events.
 * Falls back to a "copied to clipboard" message if AppleScript fails.
 */
async function insertTextAtCursor(text: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
    try {
        execSync(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`);
    } catch {
        vscode.window.showInformationMessage('Copied to clipboard. Paste with Cmd+V.');
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
    if (waveInterval) { clearInterval(waveInterval); waveInterval = null; }
    cleanupRecordingFile();
}

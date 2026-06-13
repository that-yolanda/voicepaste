import { vi } from "vitest";

// Mock window.__TAURI__
globalThis.window.__TAURI__ = {
  core: { invoke: vi.fn(() => Promise.resolve()) },
  event: { listen: vi.fn(() => Promise.resolve(() => {})) },
  autostart: {
    isEnabled: vi.fn(() => Promise.resolve(false)),
    enable: vi.fn(() => Promise.resolve()),
    disable: vi.fn(() => Promise.resolve()),
  },
  process: { relaunch: vi.fn() },
  clipboard: { writeText: vi.fn(() => Promise.resolve()) },
};

// Mock voiceSettings API
globalThis.window.voiceSettings = {
  getData: vi.fn(() =>
    Promise.resolve({ runtime: {}, parsedConfig: { app: {}, audio: {}, llm: {} } }),
  ),
  saveConfigObject: vi.fn(() => Promise.resolve({ ok: true })),
  getMicrophoneStatus: vi.fn(() => Promise.resolve({ status: "authorized" })),
  requestMicrophoneAccess: vi.fn(() => Promise.resolve({ status: "authorized", granted: true })),
  getAccessibilityStatus: vi.fn(() => Promise.resolve({ status: "authorized" })),
  openAccessibilitySettings: vi.fn(() => Promise.resolve()),
  reinitHotkey: vi.fn(() => Promise.resolve({ active: true })),
  getLoginItemSettings: vi.fn(() => Promise.resolve({ openAtLogin: false })),
  setLoginItemSettings: vi.fn(() => Promise.resolve({ openAtLogin: false })),
  recordHotkey: vi.fn(() =>
    Promise.resolve({ hotkey: "F13", displayString: "F13", keys: ["F13"] }),
  ),
  getStats: vi.fn(() => Promise.resolve({ totalSessions: 0, totalCharacters: 0, dailyCounts: {} })),
  getHistory: vi.fn(() => Promise.resolve([])),
  deleteHistory: vi.fn(() => Promise.resolve({ ok: true })),
  loadPrompts: vi.fn(() => Promise.resolve([])),
  savePrompts: vi.fn(() => Promise.resolve({ ok: true })),
  selectSoundFile: vi.fn(() => Promise.resolve(null)),
  checkForUpdates: vi.fn(() => Promise.resolve({ available: false })),
  downloadUpdate: vi.fn(() => Promise.resolve()),
  onUpdateProgress: vi.fn(() => () => {}),
  onEvent: vi.fn(() => () => {}),
  getModelRegistry: vi.fn(() => Promise.resolve([])),
  getDownloadedModels: vi.fn(() => Promise.resolve({ models: [] })),
  downloadModel: vi.fn(() => Promise.resolve({ ok: true })),
  onModelDownloadProgress: vi.fn(() => () => {}),
  deleteModel: vi.fn(() => Promise.resolve({ ok: true })),
  loadHotwords: vi.fn(() => Promise.resolve({ groups: [] })),
  saveHotwords: vi.fn(() => Promise.resolve({ ok: true })),
};

// Mock LucideIcons
globalThis.window.LucideIcons = {};

// Mock navigator
Object.defineProperty(globalThis.navigator, "language", {
  value: "zh-CN",
  writable: true,
});

// Mock matchMedia
globalThis.window.matchMedia = vi.fn((query) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}));

// Mock clipboard
globalThis.navigator.clipboard = {
  writeText: vi.fn(() => Promise.resolve()),
};

// Override document.getElementById to return a safe dummy element for any ID.
// This prevents crashes when settings.js queries elements we haven't set up.
const origGetElementById = document.getElementById.bind(document);
const dummyEl = () => {
  const el = document.createElement("div");
  return el;
};
document.getElementById = (id) => {
  return origGetElementById(id) || dummyEl();
};

// Similarly for querySelector
const origQuerySelector = document.querySelector.bind(document);
document.querySelector = (sel) => {
  return origQuerySelector(sel) || dummyEl();
};

// We still need actual elements for the heatmap grid rendering (renderHeatmap creates cells)
// Set up minimal DOM for critical elements
document.body.innerHTML = `
  <div id="hotkeyDisplay"></div>
  <div id="hotkeyModeSelector"><div class="seg-btn" data-val="toggle"></div></div>
  <div id="llmProviderGrid"></div>
  <div id="greetingText"></div>
  <div id="heatmapGrid"></div>
  <div id="promptList"></div>
  <div id="modelList"></div>
  <div id="hotwordGroups"></div>
  <div id="historyList"></div>
  <div id="promptHotkeyList"></div>
  <div id="offlineModelList"></div>
  <button id="hotkeyRecordBtn"></button>
  <span id="hotkeyHintRow"></span>
`;

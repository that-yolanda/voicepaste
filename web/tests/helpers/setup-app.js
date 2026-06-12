import { beforeAll, vi } from "vitest";

// Mock Tauri global APIs
globalThis.window.__TAURI__ = {
  core: {
    invoke: vi.fn(() => Promise.resolve()),
  },
  event: {
    listen: vi.fn(() => Promise.resolve(() => {})),
  },
  autostart: {
    isEnabled: vi.fn(() => Promise.resolve(false)),
    enable: vi.fn(() => Promise.resolve()),
    disable: vi.fn(() => Promise.resolve()),
  },
  process: {
    relaunch: vi.fn(),
  },
  clipboard: {
    writeText: vi.fn(() => Promise.resolve()),
  },
};

// Mock voiceOverlay API (created by tauri-bridge.js)
globalThis.window.voiceOverlay = {
  sendAudioChunk: vi.fn(() => Promise.resolve({ ok: true })),
  sendDiagnostic: vi.fn(() => Promise.resolve()),
  notifyAudioStopped: vi.fn(() => Promise.resolve()),
  sendAudioWarmupReady: vi.fn(() => Promise.resolve()),
  sendAudioWarmupFailed: vi.fn(() => Promise.resolve()),
  getConfig: vi.fn(() => Promise.resolve({})),
  onEvent: vi.fn(() => () => {}),
};

// Mock voiceSettings API (created by tauri-bridge.js)
globalThis.window.voiceSettings = {
  getData: vi.fn(() => Promise.resolve({})),
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

// Mock navigator.language
Object.defineProperty(globalThis.navigator, "language", {
  value: "en-US",
  writable: true,
});

// Mock navigator.platform
Object.defineProperty(globalThis.navigator, "platform", {
  value: "MacIntel",
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

// Mock getUserMedia
globalThis.navigator.mediaDevices = {
  getUserMedia: vi.fn(() => Promise.resolve({ getTracks: () => [] })),
};

// Mock AudioContext
class MockScriptProcessor {
  connect = vi.fn();
  disconnect = vi.fn();
}
globalThis.window.ScriptProcessorNode = MockScriptProcessor;

class MockAudioContext {
  constructor() {
    this.state = "running";
    this.sampleRate = 44100;
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
  createScriptProcessor() {
    const node = new MockScriptProcessor();
    node.onaudioprocess = null;
    return node;
  }
  createAnalyser() {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
      fftSize: 256,
      smoothingTimeConstant: 0.55,
      getFloatTimeDomainData: vi.fn(),
    };
  }
  get destination() {
    return {};
  }
}
globalThis.window.AudioContext = MockAudioContext;

// Mock requestAnimationFrame / cancelAnimationFrame
globalThis.requestAnimationFrame = vi.fn((cb) => {
  cb(Date.now());
  return 1;
});
globalThis.cancelAnimationFrame = vi.fn();

// Mock clipboard
globalThis.navigator.clipboard = {
  readText: vi.fn(() => Promise.resolve("")),
  writeText: vi.fn(() => Promise.resolve()),
};

// Set up DOM structure for app.js
beforeAll(() => {
  document.body.innerHTML = `
    <section class="stage" id="stage">
      <div class="bubble pill platform-mac" id="bubble">
        <span class="indicator" id="indicator">
          <span class="ind-dot"></span>
          <svg class="ind-spinner" viewBox="0 0 16 16">
            <circle class="track" cx="8" cy="8" r="6.5"></circle>
            <circle class="arc" cx="8" cy="8" r="6.5"></circle>
          </svg>
        </span>
        <div class="body" id="body">
          <div class="transcript" id="transcript">
            <span class="final-text" id="finalText"></span>
            <span class="partial-text" id="partialText"></span>
          </div>
          <div class="hint" id="hint" data-variant="text" data-visible="false">
            <span class="hint-label" id="hintLabel"></span>
          </div>
        </div>
        <span class="wave" id="waveformSlot">
          <span class="status-bars" id="statusBars" data-active="false">
            <span class="status-bar"></span>
            <span class="status-bar"></span>
            <span class="status-bar"></span>
            <span class="status-bar"></span>
          </span>
        </span>
      </div>
    </section>
    <div class="measure-text" id="measureText"></div>
  `;
});

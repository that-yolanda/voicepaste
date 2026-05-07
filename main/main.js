const path = require("node:path");
const fs = require("node:fs");
const {
  app,
  Menu,
  Tray,
  nativeImage,
  globalShortcut,
  ipcMain,
  systemPreferences,
  dialog,
  shell,
  nativeTheme,
} = require("electron");
const {
  createOverlayWindow,
  createSettingsWindow,
  positionOverlayWindow,
} = require("./windowManager");
const {
  CONFIG_PATH,
  loadConfig,
  readConfigFile,
  saveConfigText,
  getEditableConfig,
  saveConfig,
  resetConfigToDefault,
} = require("./config");
const { createAsrSession } = require("./asrService");
const { pasteTextToFocusedElement } = require("./pasteService");
const { logInfo, logError, resolveLogPath, closeLogger } = require("./logger");
const { uIOhook, UiohookKey } = require("uiohook-napi");
const {
  initUpdateService,
  checkForUpdates,
  downloadUpdate,
  quitAndInstall,
} = require("./updateService");

let currentConfig = loadConfig();
const ESC_HOTKEY = "Esc";
const DEBOUNCE_MS = 200;
const STALE_KEY_MS = 5000;
const HOLD_TRIGGER_DELAY_MS = 300;

const pressedKeys = new Map();

function normalizeKey(keycode) {
  if (keycode === UiohookKey.CtrlRight) return UiohookKey.Ctrl;
  if (keycode === UiohookKey.ShiftRight) return UiohookKey.Shift;
  if (keycode === UiohookKey.AltRight) return UiohookKey.Alt;
  if (keycode === UiohookKey.MetaRight) return UiohookKey.Meta;
  return keycode;
}
let isRecordingHotkey = false;
const recordingCombo = new Set();
let maxRecordingSize = 0;
let hotkeyRecorderResolve = null;
let isUiohookAvailable = false;
let uiohookStartError = null;
let registeredMainShortcut = null;
let hotkeyChordActive = false;
let holdStartTimer = null;
let holdTriggered = false;

function acceleratorTokenToKeycode(token) {
  const normalized = String(token || "")
    .trim()
    .toLowerCase();

  const simpleMap = {
    ctrl: UiohookKey.Ctrl,
    control: UiohookKey.Ctrl,
    commandorcontrol: process.platform === "darwin" ? UiohookKey.Meta : UiohookKey.Ctrl,
    cmdorctrl: process.platform === "darwin" ? UiohookKey.Meta : UiohookKey.Ctrl,
    shift: UiohookKey.Shift,
    alt: UiohookKey.Alt,
    option: UiohookKey.Alt,
    command: UiohookKey.Meta,
    cmd: UiohookKey.Meta,
    meta: UiohookKey.Meta,
    super: UiohookKey.Meta,
    space: UiohookKey.Space,
    enter: UiohookKey.Enter,
    return: UiohookKey.Enter,
    tab: UiohookKey.Tab,
    backspace: UiohookKey.Backspace,
    esc: UiohookKey.Escape,
    escape: UiohookKey.Escape,
    up: UiohookKey.ArrowUp,
    down: UiohookKey.ArrowDown,
    left: UiohookKey.ArrowLeft,
    right: UiohookKey.ArrowRight,
  };

  if (simpleMap[normalized]) {
    return simpleMap[normalized];
  }

  if (/^f\d{1,2}$/.test(normalized)) {
    const index = Number(normalized.slice(1));
    return UiohookKey[`F${index}`] || null;
  }

  if (/^[a-z]$/.test(normalized)) {
    return UiohookKey[normalized.toUpperCase()] || null;
  }

  if (/^[0-9]$/.test(normalized)) {
    return UiohookKey[`Num${normalized}`] || null;
  }

  return null;
}

function parseAcceleratorToKeycodes(accelerator) {
  if (typeof accelerator !== "string" || !accelerator.trim()) {
    return null;
  }

  const parts = accelerator
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  const codes = parts.map(acceleratorTokenToKeycode);
  return codes.every(Boolean) ? codes : null;
}

function getHotkeyMode() {
  return currentConfig.app?.hotkey_mode === "hold" ? "hold" : "toggle";
}

function getConfiguredHotkeyKeycodes() {
  const hotkey = getHotkey();
  if (Array.isArray(hotkey)) {
    return hotkey;
  }
  return parseAcceleratorToKeycodes(hotkey);
}

function shouldUseUiohookForHotkey() {
  return getHotkeyMode() === "hold" || Array.isArray(getHotkey());
}

function isConfiguredHotkeyPressed() {
  const hotkey = getHotkey();
  const keycodes = Array.isArray(hotkey) ? hotkey : parseAcceleratorToKeycodes(hotkey);
  if (!Array.isArray(keycodes) || keycodes.length === 0) {
    return false;
  }

  if (Array.isArray(hotkey)) {
    const exactPressed = new Set(pressedKeys.keys());
    return keycodes.every((key) => exactPressed.has(key));
  }

  const normalizedPressed = new Set([...pressedKeys.keys()].map(normalizeKey));
  const normalizedHotkey = new Set(keycodes.map(normalizeKey));
  return [...normalizedHotkey].every((key) => normalizedPressed.has(key));
}

function clearHoldStartTimer() {
  if (!holdStartTimer) {
    return;
  }

  clearTimeout(holdStartTimer);
  holdStartTimer = null;
}

function resetHotkeyGestureState() {
  hotkeyChordActive = false;
  holdTriggered = false;
  clearHoldStartTimer();
}

function handleHoldHotkeyPress() {
  if (appState !== "idle" || holdTriggered || holdStartTimer) {
    return;
  }

  holdStartTimer = setTimeout(() => {
    holdStartTimer = null;

    if (getHotkeyMode() !== "hold" || !isConfiguredHotkeyPressed() || appState !== "idle") {
      return;
    }

    holdTriggered = true;
    startRecordingFlow();
  }, HOLD_TRIGGER_DELAY_MS);
}

function handleHoldHotkeyRelease() {
  clearHoldStartTimer();

  if (!holdTriggered) {
    return;
  }

  holdTriggered = false;

  if (appState === "recording") {
    finishRecordingFlow();
    return;
  }

  if (appState === "connecting") {
    cancelRecordingFlow();
  }
}

uIOhook.on("keydown", (e) => {
  const now = Date.now();
  pressedKeys.set(e.keycode, now);

  for (const [key, time] of pressedKeys) {
    if (now - time > STALE_KEY_MS) pressedKeys.delete(key);
  }

  if (isRecordingHotkey) {
    if (e.keycode === UiohookKey.Escape && recordingCombo.size === 0) {
      isRecordingHotkey = false;
      pressedKeys.clear();
      if (hotkeyRecorderResolve) {
        hotkeyRecorderResolve([]);
        hotkeyRecorderResolve = null;
      }
      return;
    }
    recordingCombo.add(e.keycode);
    if (recordingCombo.size > maxRecordingSize) {
      maxRecordingSize = recordingCombo.size;
    }
    return;
  }

  if (!shouldUseUiohookForHotkey()) {
    return;
  }

  if (isConfiguredHotkeyPressed() && !hotkeyChordActive) {
    hotkeyChordActive = true;
    if (getHotkeyMode() === "hold") {
      handleHoldHotkeyPress();
    } else {
      handleHotkeyToggle();
    }
  }
});

uIOhook.on("keyup", (e) => {
  if (isRecordingHotkey && maxRecordingSize > 0) {
    const finalCombo = Array.from(recordingCombo);
    isRecordingHotkey = false;
    pressedKeys.clear();

    if (hotkeyRecorderResolve) {
      hotkeyRecorderResolve(finalCombo);
      hotkeyRecorderResolve = null;
    }
  }

  if (isRecordingHotkey) {
    recordingCombo.delete(e.keycode);
  }

  pressedKeys.delete(e.keycode);

  if (!shouldUseUiohookForHotkey()) {
    return;
  }

  if (!isConfiguredHotkeyPressed()) {
    hotkeyChordActive = false;
    if (getHotkeyMode() === "hold") {
      handleHoldHotkeyRelease();
    }
  }
});

function tryStartUiohook() {
  if (isUiohookAvailable) {
    return true;
  }

  try {
    uIOhook.start();
    isUiohookAvailable = true;
    uiohookStartError = null;
    logInfo("uIOhook started");
    return true;
  } catch (error) {
    uiohookStartError = error;
    logError("uIOhook start failed", {
      message: error.message || String(error),
    });
    return false;
  }
}

const keyNames = {
  [UiohookKey.Escape]: "Escape",
  [UiohookKey.F1]: "F1",
  [UiohookKey.F2]: "F2",
  [UiohookKey.F3]: "F3",
  [UiohookKey.F4]: "F4",
  [UiohookKey.F5]: "F5",
  [UiohookKey.F6]: "F6",
  [UiohookKey.F7]: "F7",
  [UiohookKey.F8]: "F8",
  [UiohookKey.F9]: "F9",
  [UiohookKey.F10]: "F10",
  [UiohookKey.F11]: "F11",
  [UiohookKey.F12]: "F12",
  [UiohookKey.F13]: "F13",
  [UiohookKey.Space]: "Space",
  [UiohookKey.Enter]: "Enter",
  [UiohookKey.Backspace]: "Backspace",
  [UiohookKey.Tab]: "Tab",
  [UiohookKey.Alt]: "L-Option",
  [UiohookKey.AltRight]: "R-Option",
  [UiohookKey.Shift]: "L-Shift",
  [UiohookKey.ShiftRight]: "R-Shift",
  [UiohookKey.Ctrl]: "L-Control",
  [UiohookKey.CtrlRight]: "R-Control",
  [UiohookKey.Meta]: "L-Command",
  [UiohookKey.MetaRight]: "R-Command",
  [UiohookKey.A]: "A",
  [UiohookKey.B]: "B",
  [UiohookKey.C]: "C",
  [UiohookKey.D]: "D",
  [UiohookKey.E]: "E",
  [UiohookKey.F]: "F",
  [UiohookKey.G]: "G",
  [UiohookKey.H]: "H",
  [UiohookKey.I]: "I",
  [UiohookKey.J]: "J",
  [UiohookKey.K]: "K",
  [UiohookKey.L]: "L",
  [UiohookKey.M]: "M",
  [UiohookKey.N]: "N",
  [UiohookKey.O]: "O",
  [UiohookKey.P]: "P",
  [UiohookKey.Q]: "Q",
  [UiohookKey.R]: "R",
  [UiohookKey.S]: "S",
  [UiohookKey.T]: "T",
  [UiohookKey.U]: "U",
  [UiohookKey.V]: "V",
  [UiohookKey.W]: "W",
  [UiohookKey.X]: "X",
  [UiohookKey.Y]: "Y",
  [UiohookKey.Z]: "Z",
  [UiohookKey.ArrowUp]: "Up",
  [UiohookKey.ArrowDown]: "Down",
  [UiohookKey.ArrowLeft]: "Left",
  [UiohookKey.ArrowRight]: "Right",
};

function formatHotkey(hotkey) {
  if (typeof hotkey === "string") return hotkey;
  if (Array.isArray(hotkey)) {
    return hotkey.map((k) => keyNames[k] || `Key(${k})`).join(" + ");
  }
  return "无";
}

let overlayWindow;
let settingsWindow;
let tray;
let appState = "idle";
let lastHotkeyAt = 0;
let latestTranscript = {
  finalText: "",
  partialText: "",
};
let asrSession = null;
let suppressCloseError = false;
let expectingSessionClose = false;
let receivedAudioChunkCount = 0;
let pendingAudioStopResolve = null;
let isQuitting = false;
let wsReady = false;
let audioWarmupReady = false;

function getHotkey() {
  return currentConfig.app.hotkey;
}

function getAccessibilityStatus() {
  if (process.platform !== "darwin") {
    return "granted";
  }

  return systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied";
}

async function ensureAccessibilityAccess() {
  const status = getAccessibilityStatus();
  logInfo("accessibility access status", { status });

  if (status === "granted") {
    return true;
  }

  const result = await dialog.showMessageBox({
    type: "warning",
    title: "需要辅助功能权限",
    message: "VoicePaste 需要辅助功能权限才能将识别结果自动粘贴到其他应用。",
    detail: "请前往 系统设置 > 隐私与安全 > 辅助功能，将 VoicePaste 添加到允许列表，然后重启应用。",
    buttons: ["打开系统设置", "取消"],
    defaultId: 0,
    cancelId: 1,
  });

  if (result.response === 0) {
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    );
  }

  return false;
}

async function ensureMicrophoneAccess() {
  if (process.platform !== "darwin") {
    return true;
  }

  const status = systemPreferences.getMediaAccessStatus("microphone");
  console.log("[ASR] microphone access status", status);
  logInfo("microphone access status", { status });

  if (status === "granted") {
    return true;
  }

  if (status === "not-determined") {
    try {
      const granted = await systemPreferences.askForMediaAccess("microphone");
      console.log("[ASR] microphone access requested", granted);
      logInfo("microphone access requested", { granted });
      return granted;
    } catch (error) {
      console.error("[ASR] microphone access request failed", error);
      logError("microphone access request failed", { message: error.message || String(error) });
      return false;
    }
  }

  return false;
}

function sendOverlayMessage(type, payload = {}) {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  overlayWindow.webContents.send("overlay:event", {
    type,
    payload,
  });
}

function resetTranscript() {
  latestTranscript = {
    finalText: "",
    partialText: "",
  };
}

function updateTranscript(payload) {
  latestTranscript = {
    finalText: payload.finalText ?? latestTranscript.finalText,
    partialText: payload.partialText ?? latestTranscript.partialText,
  };
}

function showOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  positionOverlayWindow(overlayWindow);
  overlayWindow.showInactive();
}

function hideOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  sendOverlayMessage("reset");
  overlayWindow.hide();
}

function setState(nextState) {
  appState = nextState;
  logInfo("state changed", { state: nextState });
  syncEscapeShortcut();
  sendOverlayMessage("state", { state: nextState });
}

function tryTransitionToRecording() {
  if (wsReady && audioWarmupReady && appState === "connecting") {
    setState("recording");
  }
}

function shouldEnableEscapeShortcut() {
  return appState === "connecting" || appState === "recording" || appState === "finishing";
}

function syncEscapeShortcut() {
  if (shouldEnableEscapeShortcut()) {
    if (!globalShortcut.isRegistered(ESC_HOTKEY)) {
      globalShortcut.register(ESC_HOTKEY, cancelRecordingFlow);
    }
    return;
  }

  if (globalShortcut.isRegistered(ESC_HOTKEY)) {
    globalShortcut.unregister(ESC_HOTKEY);
  }
}

async function cleanupSession() {
  if (asrSession) {
    suppressCloseError = true;
    asrSession.close();
    asrSession = null;
  }
}

function waitForRendererAudioStop(timeoutMs = 1200) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      pendingAudioStopResolve = null;
      resolve();
    };

    pendingAudioStopResolve = finish;
    setTimeout(finish, timeoutMs);
  });
}

async function startRecordingFlow() {
  if (appState !== "idle") {
    logInfo("start ignored", { appState });
    return;
  }

  logInfo("start recording flow");

  // Reload config to pick up any changes made in settings since last save
  reloadRuntimeConfig();

  const hasMicrophoneAccess = await ensureMicrophoneAccess();
  if (!hasMicrophoneAccess) {
    console.error("[ASR] microphone access denied");
    logError("microphone access denied");
    return;
  }

  const hasAccessibilityAccess = await ensureAccessibilityAccess();
  if (!hasAccessibilityAccess) {
    console.error("[Paste] accessibility access denied");
    logError("accessibility access denied");
    return;
  }

  resetTranscript();
  sendOverlayMessage("reset");
  showOverlay();
  setState("connecting");
  receivedAudioChunkCount = 0;
  wsReady = false;
  audioWarmupReady = false;
  sendOverlayMessage("audio:warmup");

  try {
    suppressCloseError = false;
    expectingSessionClose = false;
    asrSession = createAsrSession({
      connection: currentConfig.connection,
      audio: currentConfig.audio,
      request: currentConfig.request,
      onOpen: () => {
        wsReady = true;
        tryTransitionToRecording();
      },
      onTranscript: (final, partial) => {
        updateTranscript({
          finalText: final,
          partialText: partial,
        });
        sendOverlayMessage("transcript", latestTranscript);
      },
      onError: (message) => {
        wsReady = false;
        audioWarmupReady = false;
        sendOverlayMessage("recording:stop");
        setState("error");
        sendOverlayMessage("hint", {
          level: "error",
          text: message,
        });
        cleanupSession();
        setTimeout(() => {
          if (appState === "error") {
            setState("idle");
            hideOverlay();
          }
        }, 1400);
      },
      onClose: ({ code, reason }) => {
        asrSession = null;
        wsReady = false;
        audioWarmupReady = false;

        if (suppressCloseError || expectingSessionClose) {
          suppressCloseError = false;
          expectingSessionClose = false;
          return;
        }

        if (appState === "connecting" || appState === "recording" || appState === "finishing") {
          setState("error");
          sendOverlayMessage("hint", {
            level: "error",
            text: `ASR 连接已断开${reason ? `：${reason}` : code ? `（${code}）` : ""}`,
          });
          setTimeout(() => {
            if (appState === "error") {
              setState("idle");
              hideOverlay();
            }
          }, 1400);
        }
      },
    });
  } catch (error) {
    logError("start recording flow failed", { message: error.message || String(error) });

    const msg = error.message || String(error);
    const isConfigError = msg.startsWith("语音识别模型还未配置，缺少 ") || msg.includes("config");

    if (isConfigError) {
      hideOverlay();
      setState("idle");
      dialog.showMessageBox({
        type: "warning",
        title: "配置错误",
        message: "语音识别模型还未配置。",
        detail: `${msg}\n\n请打开配置页面检查识别服务和认证信息。`,
        buttons: ["知道了"],
        defaultId: 0,
      });
    } else {
      setState("error");
      sendOverlayMessage("hint", {
        level: "error",
        text: msg,
      });
      await cleanupSession();
      setTimeout(() => {
        if (appState === "error") {
          setState("idle");
          hideOverlay();
        }
      }, 1400);
    }
  }
}

async function finishRecordingFlow() {
  if (appState !== "recording") {
    logInfo("finish ignored", { appState });
    return;
  }

  logInfo("finish recording flow");

  if (!asrSession?.isReady()) {
    logError("finish failed because asr not ready");
    await cleanupSession();
    hideOverlay();
    setState("idle");
    return;
  }

  setState("finishing");
  sendOverlayMessage("recording:stop");
  await waitForRendererAudioStop();

  try {
    const finalText = await asrSession.commitAndAwaitFinal();
    expectingSessionClose = true;
    const transcriptSnapshot = asrSession.getTranscriptSnapshot();
    let textToPaste = (
      transcriptSnapshot.latestResultText ||
      finalText ||
      transcriptSnapshot.finalText
    ).trim();

    if (currentConfig.app.remove_trailing_period !== false) {
      if (textToPaste.endsWith("。") || textToPaste.endsWith(".")) {
        textToPaste = textToPaste.slice(0, -1);
      }
    }

    if (!textToPaste) {
      logInfo("finish completed with empty transcript");
      await cleanupSession();
      resetTranscript();
      hideOverlay();
      setState("idle");
      return;
    }

    const keepClipboard = currentConfig.app?.keep_clipboard !== false;
    const pasteResult = await pasteTextToFocusedElement(textToPaste, keepClipboard);

    if (!pasteResult.ok) {
      console.error("[Paste] failed", pasteResult.message);
      logError("paste failed", {
        message: pasteResult.message,
        permissionError: pasteResult.permissionError,
      });

      if (pasteResult.permissionError === "accessibility") {
        const result = await dialog.showMessageBox({
          type: "warning",
          title: "需要辅助功能权限",
          message: "VoicePaste 需要辅助功能权限才能自动粘贴文本。",
          detail: "请前往 系统设置 > 隐私与安全 > 辅助功能，将 VoicePaste 添加到允许列表。",
          buttons: ["打开系统设置", "知道了"],
          defaultId: 0,
          cancelId: 1,
        });
        if (result.response === 0) {
          shell.openExternal(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
          );
        }
      }

      await cleanupSession();
      hideOverlay();
      setState("idle");
      return;
    }
    await cleanupSession();
    resetTranscript();
    hideOverlay();
    setState("idle");
  } catch (error) {
    logError("finish recording flow failed", { message: error.message || String(error) });
    expectingSessionClose = false;
    sendOverlayMessage("hint", {
      level: "error",
      text: error.message || "结束录音失败",
    });
    await cleanupSession();
    setState("idle");
    setTimeout(() => hideOverlay(), 1200);
  }
}

async function cancelRecordingFlow() {
  if (appState !== "recording" && appState !== "finishing" && appState !== "connecting") {
    logInfo("cancel ignored", { appState });
    return;
  }

  logInfo("cancel recording flow", { appState });

  wsReady = false;
  audioWarmupReady = false;

  sendOverlayMessage("recording:stop");
  expectingSessionClose = true;
  resetHotkeyGestureState();
  await cleanupSession();
  resetTranscript();
  sendOverlayMessage("reset");
  hideOverlay();
  setState("idle");
}

function handleHotkeyToggle() {
  const now = Date.now();

  if (now - lastHotkeyAt < DEBOUNCE_MS) {
    logInfo("hotkey ignored by debounce");
    return;
  }

  lastHotkeyAt = now;
  logInfo("hotkey pressed", { appState, hotkey: getHotkey() });

  if (appState === "idle") {
    startRecordingFlow();
    return;
  }

  if (appState === "recording") {
    finishRecordingFlow();
  }
}

function registerShortcuts() {
  if (registeredMainShortcut) {
    globalShortcut.unregister(registeredMainShortcut);
    registeredMainShortcut = null;
  }

  resetHotkeyGestureState();

  const hotkey = getHotkey();
  if (!shouldUseUiohookForHotkey() && typeof hotkey === "string" && hotkey.trim() !== "") {
    const mainRegistered = globalShortcut.register(hotkey, handleHotkeyToggle);
    if (mainRegistered) {
      registeredMainShortcut = hotkey;
    }
    logInfo("register main hotkey", { hotkey, registered: mainRegistered });
  } else {
    const started = tryStartUiohook();
    logInfo("register main hotkey using uIOhook", {
      hotkey,
      mode: getHotkeyMode(),
      started,
      parsed: getConfiguredHotkeyKeycodes(),
    });
  }
}

function reloadRuntimeConfig() {
  currentConfig = loadConfig();
}

function resolveTheme() {
  const preference = currentConfig.app?.theme || "system";
  if (preference === "system") return nativeTheme.shouldUseDarkColors ? "dark" : "light";
  return preference;
}

function getTrayIconPath() {
  if (app.isPackaged) {
    if (process.platform === "win32") {
      return path.join(process.resourcesPath, "trayIcon.ico");
    }
    return path.join(process.resourcesPath, "trayTemplate.png");
  }

  if (process.platform === "win32") {
    return path.join(__dirname, "..", "build", "trayIcon.ico");
  }
  return path.join(__dirname, "..", "build", "trayTemplate.png");
}

function createTrayImage() {
  const iconPath = getTrayIconPath();
  if (!fs.existsSync(iconPath)) {
    return nativeImage.createEmpty();
  }

  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    return nativeImage.createEmpty();
  }

  if (process.platform === "darwin") {
    image.setTemplateImage(true);
  }
  return image;
}

function showSettingsWindow() {
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    settingsWindow = createSettingsWindow();
    settingsWindow.on("close", (event) => {
      if (isQuitting) {
        return;
      }
      event.preventDefault();
      settingsWindow.hide();
      if (app.dock) app.dock.hide();
    });
  }

  if (app.dock) app.dock.show();
  settingsWindow.show();
  settingsWindow.focus();
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: "打开配置",
      click: () => showSettingsWindow(),
    },
    {
      label: "系统权限",
      click: () => showSettingsWindow(),
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        app.quit();
      },
    },
  ]);
}

function createTray() {
  const image = createTrayImage();
  tray = new Tray(image);
  tray.setToolTip("VoicePaste");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", () => {
    showSettingsWindow();
  });
}

app.whenReady().then(() => {
  logInfo("app ready", {
    hotkey: getHotkey(),
    logPath: resolveLogPath(),
    configPath: CONFIG_PATH,
  });
  reloadRuntimeConfig();
  tryStartUiohook();

  overlayWindow = createOverlayWindow();
  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });

  createTray();
  registerShortcuts();
  showSettingsWindow();

  initUpdateService((type, payload) => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send("settings:event", {
        type: "update-status",
        payload: { type, ...payload },
      });
    }
  });

  ipcMain.handle("update:check", async () => {
    await checkForUpdates();
  });

  ipcMain.handle("update:download", async () => {
    await downloadUpdate();
  });

  ipcMain.handle("update:install", async () => {
    if (tray) {
      tray.destroy();
      tray = null;
    }

    try {
      quitAndInstall();
    } catch (err) {
      logError("update:install failed", { message: err?.message || String(err) });
    }

    // nativeUpdater.quitAndInstall() on macOS (Electron 41) returns without
    // error but doesn't actually quit the app. Call app.quit() explicitly.
    app.quit();
  });

  ipcMain.handle("asr:audio-chunk", (_event, base64Chunk) => {
    receivedAudioChunkCount += 1;
    if (receivedAudioChunkCount <= 3) {
      console.log("[ASR] renderer chunk arrived", {
        index: receivedAudioChunkCount,
        base64Length: base64Chunk.length,
      });
    }

    if (!asrSession) {
      return { ok: false, message: "ASR 会话未建立" };
    }

    asrSession.appendAudio(base64Chunk);
    return { ok: true };
  });

  ipcMain.handle("app:get-config", () => ({
    hotkey: getHotkey(),
  }));

  ipcMain.handle("settings:get-login-item", () => {
    return app.getLoginItemSettings();
  });

  ipcMain.handle("settings:set-login-item", (_event, enabled) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
    return app.getLoginItemSettings();
  });

  ipcMain.handle("settings:record-hotkey", async () => {
    if (!tryStartUiohook()) {
      const platformHint =
        process.platform === "darwin"
          ? "请先在系统设置 > 隐私与安全 > 辅助功能中授权 VoicePaste，然后重启应用。"
          : "请确认当前系统允许全局键盘监听后重试。";
      const detail = uiohookStartError?.message ? `\n\n底层错误：${uiohookStartError.message}` : "";
      throw new Error(`无法录制快捷键。${platformHint}${detail}`);
    }

    if (registeredMainShortcut) {
      globalShortcut.unregister(registeredMainShortcut);
      registeredMainShortcut = null;
    }

    isRecordingHotkey = true;
    recordingCombo.clear();
    maxRecordingSize = 0;
    pressedKeys.clear();

    try {
      const keys = await new Promise((resolve) => {
        hotkeyRecorderResolve = resolve;
      });

      return {
        keys,
        displayString: formatHotkey(keys),
      };
    } finally {
      registerShortcuts();
    }
  });

  ipcMain.handle("settings:get-data", async () => {
    const microphoneStatus =
      process.platform === "darwin"
        ? systemPreferences.getMediaAccessStatus("microphone")
        : "granted";
    const accessibilityStatus = getAccessibilityStatus();

    return {
      configPath: CONFIG_PATH,
      configText: readConfigFile(),
      parsedConfig: getEditableConfig(),
      runtime: {
        hotkey: getHotkey(),
        hotkeyDisplay: formatHotkey(getHotkey()),
        microphoneStatus,
        accessibilityStatus,
        version: app.getVersion(),
        platform: process.platform,
        theme: {
          preference: currentConfig.app?.theme || "system",
          resolved: resolveTheme(),
        },
      },
    };
  });

  ipcMain.handle("settings:save-config", async (_event, payload) => {
    saveConfigText(String(payload?.configText || ""));
    reloadRuntimeConfig();
    registerShortcuts();

    logInfo("settings saved", {
      hotkey: getHotkey(),
    });

    return {
      ok: true,
      configText: readConfigFile(),
      runtime: {
        hotkey: getHotkey(),
        hotkeyDisplay: formatHotkey(getHotkey()),
      },
    };
  });

  ipcMain.handle("settings:save-config-object", async (_event, configObject) => {
    saveConfig(configObject);
    reloadRuntimeConfig();
    registerShortcuts();

    logInfo("settings saved (object)", { hotkey: getHotkey() });

    return {
      ok: true,
      configText: readConfigFile(),
      parsedConfig: getEditableConfig(),
      runtime: {
        hotkey: getHotkey(),
        hotkeyDisplay: formatHotkey(getHotkey()),
      },
    };
  });

  ipcMain.handle("settings:reset-config", async () => {
    resetConfigToDefault();
    reloadRuntimeConfig();
    registerShortcuts();

    logInfo("config reset to default");

    return {
      ok: true,
      configText: readConfigFile(),
      parsedConfig: getEditableConfig(),
      runtime: {
        hotkey: getHotkey(),
      },
    };
  });

  ipcMain.handle("settings:open-accessibility-settings", async () => {
    if (process.platform === "darwin") {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      );
    }
  });

  ipcMain.handle("settings:get-microphone-status", async () => {
    const status =
      process.platform === "darwin"
        ? systemPreferences.getMediaAccessStatus("microphone")
        : "granted";

    logInfo("settings microphone status", { status });
    return { status };
  });

  ipcMain.handle("settings:get-accessibility-status", async () => {
    const status = getAccessibilityStatus();
    logInfo("settings accessibility status", { status });
    return { status };
  });

  ipcMain.handle("settings:request-microphone-access", async () => {
    if (process.platform !== "darwin") {
      return { status: "granted", granted: true };
    }

    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.show();
      settingsWindow.focus();
    }

    app.focus({ steal: true });
    const currentStatus = systemPreferences.getMediaAccessStatus("microphone");
    if (currentStatus === "granted") {
      return { status: "granted", granted: true };
    }

    if (currentStatus === "not-determined") {
      const granted = await systemPreferences.askForMediaAccess("microphone");
      const status = systemPreferences.getMediaAccessStatus("microphone");
      logInfo("settings microphone requested", { granted, status });
      return { status, granted };
    }

    logInfo("settings microphone request skipped", { status: currentStatus });
    return { status: currentStatus, granted: false };
  });

  ipcMain.on("renderer:diagnostic", (_event, payload) => {
    console.log("[Renderer]", payload);
    logInfo("renderer diagnostic", payload);
  });

  nativeTheme.on("updated", () => {
    const resolved = resolveTheme();
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send("settings:event", {
        type: "theme-changed",
        payload: { resolved },
      });
    }
  });

  ipcMain.handle("settings:set-theme", async (_event, preference) => {
    if (!["dark", "light", "system"].includes(preference)) {
      throw new Error("Invalid theme");
    }
    const config = getEditableConfig();
    config.app = config.app || {};
    config.app.theme = preference;
    saveConfig(config);
    reloadRuntimeConfig();
    return { preference, resolved: resolveTheme() };
  });

  ipcMain.on("renderer:audio-stopped", () => {
    if (pendingAudioStopResolve) {
      pendingAudioStopResolve();
    }
  });

  ipcMain.on("renderer:audio-warmup-ready", () => {
    audioWarmupReady = true;
    tryTransitionToRecording();
  });

  ipcMain.on("renderer:audio-warmup-failed", (_event, payload) => {
    logError("audio warmup failed", { message: payload?.message });
    wsReady = false;
    audioWarmupReady = false;
    sendOverlayMessage("recording:stop");
    cleanupSession();
    setState("error");
    sendOverlayMessage("hint", {
      level: "error",
      text: payload?.message || "音频设备初始化失败",
    });
    setTimeout(() => {
      if (appState === "error") {
        setState("idle");
        hideOverlay();
      }
    }, 1400);
  });

  app.on("activate", () => {
    logInfo("app activate");
    if (!overlayWindow) {
      overlayWindow = createOverlayWindow();
    }
    showSettingsWindow();
  });
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

process.on("uncaughtException", (error) => {
  logError("uncaught exception", { message: error.message || String(error) });
});

process.on("unhandledRejection", (error) => {
  logError("unhandled rejection", {
    message: error?.message || String(error),
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

app.on("will-quit", () => {
  logInfo("app will quit");
  globalShortcut.unregisterAll();
  closeLogger();
});

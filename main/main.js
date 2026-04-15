const path = require("node:path");
const fs = require("node:fs");
const { app, Menu, Tray, nativeImage, globalShortcut, ipcMain, systemPreferences, dialog, shell } = require("electron");
const { createOverlayWindow, createSettingsWindow, positionOverlayWindow } = require("./windowManager");
const { CONFIG_PATH, loadConfig, readConfigFile, saveConfigText, getEditableConfig, saveConfig, resetConfigToDefault } = require("./config");
const { createAsrSession } = require("./asrService");
const { pasteTextToFocusedElement } = require("./pasteService");
const { logInfo, logError, resolveLogPath } = require("./logger");
let currentConfig = loadConfig();
const ESC_HOTKEY = "Esc";
const DEBOUNCE_MS = 200;

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
let isRecordingHotkey = false;

function getHotkey() {
  return currentConfig.app.hotkey;
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

  overlayWindow.hide();
}

function setState(nextState) {
  appState = nextState;
  logInfo("state changed", { state: nextState });
  syncEscapeShortcut();
  sendOverlayMessage("state", { state: nextState });
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

  resetTranscript();
  showOverlay();
  setState("connecting");
  sendOverlayMessage("reset");
  receivedAudioChunkCount = 0;

  try {
    suppressCloseError = false;
    expectingSessionClose = false;
    asrSession = createAsrSession({
      connection: currentConfig.connection,
      audio: currentConfig.audio,
      request: currentConfig.request,
      onOpen: () => {
        setState("recording");
        sendOverlayMessage("recording:start");
      },
      onTranscript: (final, partial) => {
        updateTranscript({
          finalText: final,
          partialText: partial,
        });
        sendOverlayMessage("transcript", latestTranscript);
      },
      onError: (message) => {
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
    const isConfigError = msg.startsWith("缺少 ") || msg.includes("config");

    if (isConfigError) {
      hideOverlay();
      setState("idle");
      dialog.showMessageBox({
        type: "warning",
        title: "配置错误",
        message: `VoicePaste 配置不完整，无法开始录音。`,
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
    const textToPaste = (
      transcriptSnapshot.latestResultText ||
      finalText ||
      transcriptSnapshot.finalText
    ).trim();

    if (!textToPaste) {
      logInfo("finish completed with empty transcript");
      await cleanupSession();
      resetTranscript();
      hideOverlay();
      setState("idle");
      return;
    }

    const pasteResult = await pasteTextToFocusedElement(textToPaste);

    if (!pasteResult.ok) {
      console.error("[Paste] failed", pasteResult.message);
      logError("paste failed", { message: pasteResult.message, permissionError: pasteResult.permissionError });

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
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
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

  sendOverlayMessage("recording:stop");
  expectingSessionClose = true;
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
  const hotkey = getHotkey();
  const mainRegistered = globalShortcut.register(hotkey, handleHotkeyToggle);
  logInfo("register main hotkey", { hotkey, registered: mainRegistered });

  if (!mainRegistered) {
    logError("register main hotkey failed", { hotkey });
    throw new Error(`无法注册全局热键 ${hotkey}`);
  }
}

function reloadRuntimeConfig() {
  currentConfig = loadConfig();
}

function inputToAccelerator(input) {
  const codeToKey = (code) => {
    if (!code) return null;
    if (code.startsWith("Key")) return code.slice(3);
    if (code.startsWith("Digit")) return code.slice(5);
    if (/^F\d{1,2}$/.test(code)) return code;
    const map = {
      Space: "Space", Backspace: "Backspace", Delete: "Delete",
      Insert: "Insert", Enter: "Return",
      ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
      Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
      BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'",
      Backquote: "`", Backslash: "\\", Comma: ",", Period: ".",
      Slash: "/", Minus: "-", Equal: "=",
    };
    return map[code] || null;
  };

  const key = codeToKey(input.code);
  if (!key) return null;

  const parts = [];
  if (input.control) parts.push("Control");
  if (input.meta) parts.push("Cmd");
  if (input.alt) parts.push("Alt");
  if (input.shift) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

function setupSettingsHotkeyRecording(win) {
  win.webContents.on("before-input-event", (event, input) => {
    if (!isRecordingHotkey) return;
    if (input.type !== "keyDown") return;

    event.preventDefault();

    if (input.key === "Escape" && !input.control && !input.meta && !input.alt && !input.shift) {
      isRecordingHotkey = false;
      win.webContents.send("settings:event", { type: "hotkey-recording-cancelled" });
      return;
    }

    const modifierKeys = ["Control", "Alt", "Shift", "Meta"];
    if (modifierKeys.includes(input.key)) {
      const mods = [];
      if (input.control) mods.push("Ctrl");
      if (input.meta) mods.push("Cmd");
      if (input.alt) mods.push("Alt");
      if (input.shift) mods.push("Shift");
      win.webContents.send("settings:event", {
        type: "hotkey-recording-modifiers",
        payload: { display: mods.join("+") + "+" },
      });
      return;
    }

    const accelerator = inputToAccelerator(input);
    if (accelerator) {
      isRecordingHotkey = false;
      win.webContents.send("settings:event", {
        type: "hotkey-recording-done",
        payload: { accelerator },
      });
    }
  });
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
    setupSettingsHotkeyRecording(settingsWindow);
    settingsWindow.on("close", (event) => {
      if (isQuitting) {
        return;
      }
      event.preventDefault();
      settingsWindow.hide();
    });
  }

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
  overlayWindow = createOverlayWindow();
  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });

  createTray();
  registerShortcuts();
  showSettingsWindow();

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

  ipcMain.handle("settings:get-data", async () => {
    const microphoneStatus = process.platform === "darwin"
      ? systemPreferences.getMediaAccessStatus("microphone")
      : "granted";

    return {
      configPath: CONFIG_PATH,
      configText: readConfigFile(),
      parsedConfig: getEditableConfig(),
      runtime: {
        hotkey: getHotkey(),
        microphoneStatus,
        version: app.getVersion(),
        platform: process.platform,
      },
    };
  });

  ipcMain.handle("settings:save-config", async (_event, payload) => {
    const previousHotkey = getHotkey();
    saveConfigText(String(payload?.configText || ""));
    reloadRuntimeConfig();

    if (previousHotkey !== getHotkey()) {
      globalShortcut.unregister(previousHotkey);
      registerShortcuts();
    }

    logInfo("settings saved", {
      hotkey: getHotkey(),
    });

    return {
      ok: true,
      configText: readConfigFile(),
      runtime: {
        hotkey: getHotkey(),
      },
    };
  });

  ipcMain.handle("settings:save-config-object", async (_event, configObject) => {
    const previousHotkey = getHotkey();
    saveConfig(configObject);
    reloadRuntimeConfig();

    if (previousHotkey !== getHotkey()) {
      globalShortcut.unregister(previousHotkey);
      registerShortcuts();
    }

    logInfo("settings saved (object)", { hotkey: getHotkey() });

    return {
      ok: true,
      configText: readConfigFile(),
      parsedConfig: getEditableConfig(),
      runtime: {
        hotkey: getHotkey(),
      },
    };
  });

  ipcMain.handle("settings:reset-config", async () => {
    const previousHotkey = getHotkey();
    resetConfigToDefault();
    reloadRuntimeConfig();

    if (previousHotkey !== getHotkey()) {
      globalShortcut.unregister(previousHotkey);
      registerShortcuts();
    }

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
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
      );
    }
  });

  ipcMain.handle("settings:start-hotkey-recording", () => {
    isRecordingHotkey = true;
    logInfo("hotkey recording started");
    return { ok: true };
  });

  ipcMain.handle("settings:stop-hotkey-recording", () => {
    isRecordingHotkey = false;
    logInfo("hotkey recording stopped");
    return { ok: true };
  });

  ipcMain.handle("settings:get-microphone-status", async () => {
    const status = process.platform === "darwin"
      ? systemPreferences.getMediaAccessStatus("microphone")
      : "granted";

    logInfo("settings microphone status", { status });
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

  ipcMain.on("renderer:audio-stopped", () => {
    if (pendingAudioStopResolve) {
      pendingAudioStopResolve();
    }
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
});

app.on("will-quit", () => {
  logInfo("app will quit");
  globalShortcut.unregisterAll();
});

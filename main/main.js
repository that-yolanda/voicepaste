const path = require("node:path");
const { app, globalShortcut, ipcMain, systemPreferences } = require("electron");
const { createOverlayWindow, positionOverlayWindow, getOverlayBounds } = require("./windowManager");
const { loadConfig } = require("./config");
const { createAsrSession } = require("./asrService");
const { pasteTextToFocusedElement } = require("./pasteService");
const config = loadConfig();

const HOTKEY = config.app.hotkey;
const ESC_HOTKEY = "Esc";
const DEBOUNCE_MS = 200;

let overlayWindow;
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

async function ensureMicrophoneAccess() {
  if (process.platform !== "darwin") {
    return true;
  }

  const status = systemPreferences.getMediaAccessStatus("microphone");
  console.log("[ASR] microphone access status", status);

  if (status === "granted") {
    return true;
  }

  if (status === "not-determined") {
    try {
      const granted = await systemPreferences.askForMediaAccess("microphone");
      console.log("[ASR] microphone access requested", granted);
      return granted;
    } catch (error) {
      console.error("[ASR] microphone access request failed", error);
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
    return;
  }

  const hasMicrophoneAccess = await ensureMicrophoneAccess();
  if (!hasMicrophoneAccess) {
    console.error("[ASR] microphone access denied");
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
      url: config.asr.wsUrl,
      resourceId: config.asr.resourceId,
      appId: config.auth.appId,
      accessToken: config.auth.accessToken,
      language: config.asr.language,
      sampleRate: config.asr.sampleRate,
      audioFormat: config.asr.audioFormat,
      audioCodec: config.asr.audioCodec,
      audioBits: config.asr.audioBits,
      audioChannel: config.asr.audioChannel,
      modelName: config.asr.modelName,
      modelVersion: config.asr.modelVersion,
      operation: config.asr.operation,
      sequence: config.asr.sequence,
      enableItn: config.asr.enableItn,
      enablePunc: config.asr.enablePunc,
      enableNonstream: config.asr.enableNonstream,
      enableDdc: config.asr.enableDdc,
      showUtterances: config.asr.showUtterances,
      resultType: config.asr.resultType,
      endWindowSize: config.asr.endWindowSize,
      forceToSpeechTime: config.asr.forceToSpeechTime,
      boostingTableId: config.asr.boostingTableId,
      contextHotwords: config.asr.contextHotwords,
      onOpen: () => {
        setState("recording");
        sendOverlayMessage("recording:start");
      },
      onPartial: (text) => {
        updateTranscript({ partialText: text });
        sendOverlayMessage("transcript", latestTranscript);
      },
      onFinal: (text) => {
        updateTranscript({
          finalText: text,
          partialText: "",
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
    setState("error");
    sendOverlayMessage("hint", {
      level: "error",
      text: error.message,
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

async function finishRecordingFlow() {
  if (appState !== "recording") {
    return;
  }

  if (!asrSession?.isReady()) {
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
      await cleanupSession();
      resetTranscript();
      hideOverlay();
      setState("idle");
      return;
    }

    const pasteResult = await pasteTextToFocusedElement(textToPaste);

    if (!pasteResult.ok) {
      console.error("[Paste] failed", pasteResult.message);
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
    return;
  }

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
    return;
  }

  lastHotkeyAt = now;

  if (appState === "idle") {
    startRecordingFlow();
    return;
  }

  if (appState === "recording") {
    finishRecordingFlow();
  }
}

function registerShortcuts() {
  const mainRegistered = globalShortcut.register(HOTKEY, handleHotkeyToggle);

  if (!mainRegistered) {
    throw new Error(`无法注册全局热键 ${HOTKEY}`);
  }
}

app.whenReady().then(() => {
  overlayWindow = createOverlayWindow();
  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });

  registerShortcuts();

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
    hotkey: HOTKEY,
  }));

  ipcMain.on("renderer:diagnostic", (_event, payload) => {
    console.log("[Renderer]", payload);
  });

  ipcMain.on("renderer:audio-stopped", () => {
    if (pendingAudioStopResolve) {
      pendingAudioStopResolve();
    }
  });

  ipcMain.handle("overlay:resize", (_event, size) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      return { ok: false };
    }

    const nextBounds = getOverlayBounds(size);
    overlayWindow.setBounds(nextBounds, false);
    return { ok: true };
  });

  app.on("activate", () => {
    if (!overlayWindow) {
      overlayWindow = createOverlayWindow();
    }
  });
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

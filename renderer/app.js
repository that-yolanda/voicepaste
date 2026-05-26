// --- Sound system (preloaded at startup, async, non-blocking) ---
const soundPool = {};
const soundTasks = {};

function reportSoundIssue(type, payload = {}) {
  window.voiceOverlay.sendDiagnostic({
    type: `sound:${type}`,
    ...payload,
  });
}

function notifySoundPlayed(name) {
  if (name === "end") {
    window.voiceOverlay.notifySoundPlayed(name);
  }
}

async function loadSound(name, url) {
  return new Promise((resolve) => {
    const audio = new Audio(url);
    audio.preload = "auto";
    audio.volume = 0.72;
    audio.addEventListener(
      "canplaythrough",
      () => {
        soundPool[name] = audio;
        resolve(true);
      },
      { once: true },
    );
    audio.addEventListener(
      "error",
      () => {
        reportSoundIssue("load-failed", {
          name,
          message: audio.error?.message || `media-error-${audio.error?.code || "unknown"}`,
        });
        resolve(false);
      },
      { once: true },
    );
    audio.load();
  });
}

async function playSound(name) {
  try {
    if (soundTasks[name]) {
      await soundTasks[name];
    }
    const template = soundPool[name];
    if (!template) {
      reportSoundIssue("skip-not-ready", { name });
      return;
    }
    const audio = template.cloneNode(true);
    audio.volume = template.volume;
    audio.currentTime = 0;
    await audio.play();
    reportSoundIssue("play-started", { name });
    notifySoundPlayed(name);
  } catch (error) {
    reportSoundIssue("play-failed", {
      name,
      message: error.message || String(error),
    });
  }
}

function initSounds() {
  soundTasks.start = loadSound("start", "./assets/start.mp3");
  soundTasks.end = loadSound("end", "./assets/end.mp3");
  Promise.all(Object.values(soundTasks)).then((results) => {
    reportSoundIssue("preload-complete", {
      ready: Object.keys(soundPool),
      failed: results.filter((item) => !item).length,
    });
  });
}

initSounds();

// --- App state ---
const state = {
  finalText: "",
  partialText: "",
  hintText: "",
  hintLevel: "info",
  hintVariant: "text",
  appState: "idle",
  audioReady: false,
  mediaStream: null,
  audioContext: null,
  sourceNode: null,
  processorNode: null,
  analyserNode: null,
  pendingSamples: [],
  layoutWidth: 0,
  layoutWrap: false,
  renderedWidth: 0,
  waveHistory: [0.16, 0.22, 0.28, 0.22, 0.16],
  smoothedLevel: 0,
};

const elements = {
  card: document.getElementById("card"),
  finalText: document.getElementById("finalText"),
  partialText: document.getElementById("partialText"),
  hint: document.getElementById("hint"),
  hintLabel: document.getElementById("hintLabel"),
  transcript: document.getElementById("transcript"),
  measureText: document.getElementById("measureText"),
  statusBars: document.getElementById("statusBars"),
};

const statusBarItems = elements.statusBars
  ? Array.from(elements.statusBars.querySelectorAll(".status-bar"))
  : [];

// --- Waveform animation ---
let waveformRaf = 0;

function startWaveformAnimation() {
  const analyser = state.analyserNode;
  if (!analyser || statusBarItems.length === 0) return;

  const sampleCount = analyser.fftSize;
  const data = new Float32Array(sampleCount);
  const mirrorCenter = Math.ceil(statusBarItems.length / 2);

  function tick() {
    analyser.getFloatTimeDomainData(data);
    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < sampleCount; i += 1) {
      const sample = data[i];
      sumSquares += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const rms = Math.sqrt(sumSquares / sampleCount);
    const boostedLevel = Math.min(1, (rms * 6.2 + peak * 1.4) ** 0.88);
    state.smoothedLevel += (boostedLevel - state.smoothedLevel) * 0.22;
    state.waveHistory.push(state.smoothedLevel);
    while (state.waveHistory.length > mirrorCenter) {
      state.waveHistory.shift();
    }

    const leftHeights = state.waveHistory.slice(-mirrorCenter).reverse();
    const rightHeights = state.waveHistory
      .slice(-mirrorCenter + (statusBarItems.length % 2 === 0 ? 0 : 1))
      .slice();
    const mirrored = leftHeights.concat(rightHeights);

    statusBarItems.forEach((bar, index) => {
      const level = mirrored[index] ?? state.smoothedLevel;
      const distance = Math.abs(index - (statusBarItems.length - 1) / 2);
      const edgeWeight = 0.72 + (1 - distance / mirrorCenter) * 0.34;
      const height = Math.max(4, Math.min(16, 4 + level * edgeWeight * 15));
      bar.style.height = `${height}px`;
      bar.style.transform = `scaleY(${0.92 + level * 0.18})`;
    });
    elements.statusBars.dataset.active = "true";
    waveformRaf = requestAnimationFrame(tick);
  }

  waveformRaf = requestAnimationFrame(tick);
}

function stopWaveformAnimation() {
  if (waveformRaf) {
    cancelAnimationFrame(waveformRaf);
    waveformRaf = 0;
  }
  if (elements.statusBars) {
    elements.statusBars.dataset.active = "false";
  }
  statusBarItems.forEach((bar) => {
    bar.style.height = "";
    bar.style.transform = "";
  });
  state.waveHistory = [0.16, 0.22, 0.28, 0.22, 0.16];
  state.smoothedLevel = 0;
}

function getVisibleHintText() {
  if (!state.hintText) {
    return "";
  }
  return state.hintVariant === "progress" ? "Thinking" : state.hintText;
}

function shouldShowHint() {
  return Boolean(state.hintText);
}

function getHintMeasureWidth() {
  if (!shouldShowHint()) {
    return 0;
  }
  if (state.hintVariant === "progress") {
    return 148;
  }
  elements.measureText.textContent = getVisibleHintText();
  return Math.ceil(elements.measureText.getBoundingClientRect().width) + 12;
}

let resizeRaf = 0;

function scheduleResize() {
  if (resizeRaf) {
    cancelAnimationFrame(resizeRaf);
  }

  resizeRaf = requestAnimationFrame(() => {
    const hasText = Boolean(state.finalText || state.partialText);
    const hintWidth = getHintMeasureWidth();
    const hasHint = hintWidth > 0;

    if (!hasText && !hasHint) {
      elements.card.style.width = "";
      state.renderedWidth = 0;
      elements.card.dataset.wrap = "single";
      return;
    }

    let measuredWidth = 0;
    if (hasText) {
      const visibleText = `${state.finalText}${state.partialText}`.trim();
      elements.measureText.textContent = visibleText;
      measuredWidth = Math.ceil(elements.measureText.getBoundingClientRect().width);
    }
    const chromeWidth = 92;
    const singleLineLimit = 560;
    const lockLayout = state.appState === "recording" || state.appState === "finishing";
    const shouldWrap = state.layoutWrap || measuredWidth > singleLineLimit;
    const contentWidth = shouldWrap
      ? 420
      : Math.min(singleLineLimit, Math.max(120, Math.max(measuredWidth + 20, hintWidth)));
    const nextWidth = shouldWrap ? 560 : chromeWidth + contentWidth;

    if (!lockLayout) {
      state.layoutWidth = nextWidth;
      state.layoutWrap = shouldWrap;
    } else {
      state.layoutWidth = Math.max(state.layoutWidth || 0, nextWidth);
      state.layoutWrap = state.layoutWrap || shouldWrap;
    }

    elements.card.dataset.wrap = state.layoutWrap ? "multi" : "single";

    const width = state.layoutWidth || nextWidth;

    if (width === state.renderedWidth) {
      return;
    }

    state.renderedWidth = width;
    elements.card.style.width = `${width}px`;
  });
}

function updateView() {
  const visualState =
    state.appState === "recording" && !state.audioReady ? "connecting" : state.appState;
  const isThinking = visualState === "finishing" && state.hintVariant === "progress";
  const isWaveOnly =
    !isThinking &&
    !state.finalText &&
    !state.partialText &&
    !state.hintText &&
    (visualState === "recording" || visualState === "connecting");
  elements.card.dataset.state = visualState;
  elements.card.dataset.mode = isWaveOnly ? "wave-only" : "default";
  elements.finalText.textContent = isThinking ? "" : state.finalText;
  elements.partialText.textContent = isThinking ? "" : state.partialText;
  elements.hintLabel.textContent = getVisibleHintText();
  elements.hint.dataset.visible = shouldShowHint() ? "true" : "false";
  elements.hint.dataset.level = state.hintLevel;
  elements.hint.dataset.variant = state.hintVariant;
  if (elements.statusBars) {
    elements.statusBars.dataset.active =
      isThinking || visualState === "idle" || visualState === "connecting"
        ? "false"
        : elements.statusBars.dataset.active;
  }
  scheduleResize();
}

function resetState() {
  state.finalText = "";
  state.partialText = "";
  state.hintText = "";
  state.hintLevel = "info";
  state.hintVariant = "text";
  state.audioReady = false;
  state.layoutWidth = 0;
  state.layoutWrap = false;
  state.renderedWidth = 0;
  elements.card.style.width = "";
  updateView();
}

function floatTo16BitPCM(float32Array) {
  const buffer = new Int16Array(float32Array.length);

  for (let index = 0; index < float32Array.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, float32Array[index]));
    buffer[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return buffer;
}

function downsampleBuffer(buffer, inputSampleRate, outputSampleRate) {
  if (outputSampleRate === inputSampleRate) {
    return buffer;
  }

  const sampleRateRatio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accum = 0;
    let count = 0;

    for (let index = offsetBuffer; index < nextOffsetBuffer && index < buffer.length; index += 1) {
      accum += buffer[index];
      count += 1;
    }

    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

function int16ToBase64(int16Array) {
  const uint8Array = new Uint8Array(int16Array.buffer);
  let binary = "";

  for (let index = 0; index < uint8Array.length; index += 1) {
    binary += String.fromCharCode(uint8Array[index]);
  }

  return btoa(binary);
}

function flushPendingAudio(force = false) {
  const targetChunkSize = 1600;

  while (
    state.pendingSamples.length >= targetChunkSize ||
    (force && state.pendingSamples.length > 0)
  ) {
    const chunkSize = force
      ? Math.min(state.pendingSamples.length, targetChunkSize)
      : targetChunkSize;
    const chunk = state.pendingSamples.splice(0, chunkSize);
    const pcm16 = floatTo16BitPCM(new Float32Array(chunk));
    const base64Chunk = int16ToBase64(pcm16);

    if (!state.audioReady) {
      state.audioReady = true;
      updateView();
    }

    window.voiceOverlay.sendAudioChunk(base64Chunk).catch(() => {
      state.hintText = "音频发送失败";
      state.hintLevel = "error";
      state.hintVariant = "text";
      updateView();
    });

    if (force) {
      break;
    }
  }
}

async function startAudioCapture() {
  if (state.mediaStream) {
    return;
  }

  window.voiceOverlay.sendDiagnostic({
    type: "audio:capture-starting",
  });

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      noiseSuppression: true,
      echoCancellation: true,
    },
    video: false,
  });

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioContextCtor();
  const sourceNode = audioContext.createMediaStreamSource(stream);
  const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
  state.pendingSamples = [];
  state.audioReady = false;

  processorNode.onaudioprocess = (event) => {
    if (state.appState !== "recording") {
      return;
    }

    const inputData = event.inputBuffer.getChannelData(0);
    const downsampled = downsampleBuffer(inputData, audioContext.sampleRate, 16000);

    for (let index = 0; index < downsampled.length; index += 1) {
      state.pendingSamples.push(downsampled[index]);
    }

    flushPendingAudio(false);
  };

  const analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = 256;
  analyserNode.smoothingTimeConstant = 0.55;

  sourceNode.connect(analyserNode);
  analyserNode.connect(processorNode);
  processorNode.connect(audioContext.destination);

  state.mediaStream = stream;
  state.audioContext = audioContext;
  state.sourceNode = sourceNode;
  state.processorNode = processorNode;
  state.analyserNode = analyserNode;

  window.voiceOverlay.sendDiagnostic({
    type: "audio:capture-started",
    sampleRate: audioContext.sampleRate,
  });
}

async function stopAudioCapture() {
  stopWaveformAnimation();
  flushPendingAudio(true);

  if (state.analyserNode) {
    state.analyserNode.disconnect();
    state.analyserNode = null;
  }

  if (state.processorNode) {
    state.processorNode.disconnect();
    state.processorNode.onaudioprocess = null;
    state.processorNode = null;
  }

  if (state.sourceNode) {
    state.sourceNode.disconnect();
    state.sourceNode = null;
  }

  if (state.mediaStream) {
    for (const track of state.mediaStream.getTracks()) {
      track.stop();
    }
    state.mediaStream = null;
  }

  if (state.audioContext) {
    await state.audioContext.close();
    state.audioContext = null;
  }

  state.pendingSamples = [];
}

window.voiceOverlay.onEvent(async ({ type, payload }) => {
  switch (type) {
    case "reset":
      resetState();
      break;
    case "state":
      state.appState = payload.state;
      if (payload.state === "idle" || payload.state === "connecting") {
        state.audioReady = false;
      }
      if (payload.state === "recording") {
        void playSound("start");
        startWaveformAnimation();
      }
      if (
        payload.state === "idle" ||
        payload.state === "connecting" ||
        payload.state === "recording" ||
        payload.state === "finishing"
      ) {
        if (state.hintLevel === "info") {
          state.hintText = "";
          state.hintVariant = "text";
        }
      }
      updateView();
      break;
    case "audio:warmup":
      try {
        state.audioReady = false;
        await startAudioCapture();
        window.voiceOverlay.sendAudioWarmupReady();
      } catch (error) {
        window.voiceOverlay.sendAudioWarmupFailed({
          message: error.message || String(error),
        });
        state.hintText = error.message || "无法获取麦克风权限";
        state.hintLevel = "error";
        state.hintVariant = "text";
        updateView();
      }
      break;
    case "recording:start":
      try {
        state.audioReady = false;
        await startAudioCapture();
        startWaveformAnimation();
        state.hintText = "";
        state.hintLevel = "info";
        state.hintVariant = "text";
      } catch (error) {
        window.voiceOverlay.sendDiagnostic({
          type: "audio:capture-failed",
          message: error.message || String(error),
        });
        state.hintText = error.message || "无法获取麦克风权限";
        state.hintLevel = "error";
        state.hintVariant = "text";
      }
      updateView();
      break;
    case "recording:stop":
      await stopAudioCapture();
      window.voiceOverlay.notifyAudioStopped();
      break;
    case "transcript":
      state.finalText = payload.finalText || "";
      state.partialText = payload.partialText || "";
      updateView();
      break;
    case "hint":
      state.hintText = payload.text || "";
      state.hintLevel = payload.level || "info";
      state.hintVariant = payload.variant || "text";
      updateView();
      break;
    case "paste:done":
      void playSound("end");
      break;
    default:
      break;
  }
});

window.addEventListener("beforeunload", () => {
  stopAudioCapture();
});

window.voiceOverlay.getConfig().then(() => {
  updateView();
});

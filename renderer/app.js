// --- Sound system (preloaded at startup, async, non-blocking) ---
const soundPool = {};
const soundTasks = {};
const activeSounds = new Set();
const soundUrls = {
  start: "./assets/start.mp3",
  end: "./assets/end.mp3",
};

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

function getSoundFallbackMs(audio) {
  const durationMs = Number.isFinite(audio.duration) ? audio.duration * 1000 : 1200;
  return Math.max(1600, durationMs + 450);
}

async function loadSound(name, url) {
  return new Promise((resolve) => {
    const audio = new Audio(url);
    let settled = false;

    const finish = (ready) => {
      if (settled) {
        return;
      }
      settled = true;
      if (ready) {
        soundPool[name] = audio;
      }
      resolve(ready);
    };

    audio.preload = "auto";
    audio.volume = 0.72;
    audio.addEventListener(
      "canplaythrough",
      () => {
        finish(true);
      },
      { once: true },
    );
    audio.addEventListener(
      "canplay",
      () => {
        finish(true);
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
        finish(false);
      },
      { once: true },
    );
    audio.load();
    setTimeout(() => {
      finish(audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA);
    }, 1500);
  });
}

async function playSound(name) {
  if (state.playSound === false) {
    if (name === "end") {
      notifySoundPlayed(name);
    }
    return;
  }
  let fallbackTimer = 0;
  let didNotify = false;
  let audio = null;

  const finishEndSound = () => {
    if (didNotify) {
      return;
    }
    didNotify = true;
    clearTimeout(fallbackTimer);
    if (audio) {
      activeSounds.delete(audio);
    }
    notifySoundPlayed(name);
  };

  try {
    if (soundTasks[name]) {
      await soundTasks[name];
    }
    const template = soundPool[name] || new Audio(soundUrls[name]);
    if (!template) {
      reportSoundIssue("skip-not-ready", { name });
      finishEndSound();
      return;
    }
    audio = template.cloneNode(true);
    audio.volume = template.volume;
    audio.currentTime = 0;
    activeSounds.add(audio);
    audio.addEventListener(
      "ended",
      () => {
        activeSounds.delete(audio);
      },
      { once: true },
    );
    audio.addEventListener(
      "error",
      () => {
        activeSounds.delete(audio);
      },
      { once: true },
    );
    if (name === "end") {
      audio.addEventListener(
        "ended",
        () => {
          finishEndSound();
        },
        { once: true },
      );
      audio.addEventListener(
        "error",
        () => {
          finishEndSound();
        },
        { once: true },
      );
    }
    await audio.play();
    reportSoundIssue("play-started", { name });
    if (name !== "end") {
      notifySoundPlayed(name);
    } else {
      fallbackTimer = setTimeout(finishEndSound, getSoundFallbackMs(audio));
    }
  } catch (error) {
    if (audio) {
      activeSounds.delete(audio);
    }
    reportSoundIssue("play-failed", {
      name,
      message: error.message || String(error),
    });
    finishEndSound();
  }
}

function initSounds() {
  soundTasks.start = loadSound("start", soundUrls.start);
  soundTasks.end = loadSound("end", soundUrls.end);
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
  playSound: true,
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
  waveBarHeights: [],
  smoothedLevel: 0,
};

const elements = {
  stage: document.getElementById("stage"),
  bubble: document.getElementById("bubble"),
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
  const centerIndex = (statusBarItems.length - 1) / 2;
  const maxDistance = Math.max(1, centerIndex);

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
    const boostedLevel = Math.min(1, (rms * 13 + peak * 2.8) ** 0.82);
    const targetLevel = boostedLevel < 0.035 ? 0 : boostedLevel;
    state.smoothedLevel += (targetLevel - state.smoothedLevel) * 0.14;

    statusBarItems.forEach((bar, index) => {
      const distance = Math.abs(index - centerIndex);
      const centerWeight = 0.22 + (1 - distance / maxDistance) ** 1.7 * 0.78;
      const targetHeight = 3 + state.smoothedLevel * centerWeight * 20;
      const currentHeight = state.waveBarHeights[index] ?? targetHeight;
      const height = currentHeight + (targetHeight - currentHeight) * 0.18;
      state.waveBarHeights[index] = height;
      bar.style.height = `${Math.round(Math.max(3, Math.min(18, height)))}px`;
      bar.style.transform = "scaleY(1)";
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
  state.waveBarHeights = [];
  state.smoothedLevel = 0;
}

function getVisibleHintText() {
  const visualState =
    state.appState === "recording" && !state.audioReady ? "connecting" : state.appState;

  if (visualState === "connecting") {
    return "Preparing";
  }

  if (visualState === "finishing" && state.hintVariant === "progress") {
    return "Thinking";
  }

  return state.hintText || "";
}

function shouldShowHint() {
  return Boolean(getVisibleHintText());
}

let resizeRaf = 0;

function scheduleResize() {
  if (resizeRaf) {
    cancelAnimationFrame(resizeRaf);
  }

  resizeRaf = requestAnimationFrame(() => {
    const hasText = Boolean(state.finalText || state.partialText);
    const hintText = getVisibleHintText();
    const hasHint = Boolean(hintText);
    const shouldMeasureHintOnly = hasHint;

    if (!hasText && !hasHint) {
      elements.bubble.style.width = "";
      state.renderedWidth = 0;
      elements.bubble.dataset.wrap = "single";
      return;
    }

    let measuredWidth = 0;
    if (hasText && !shouldMeasureHintOnly) {
      const visibleText = `${state.finalText}${state.partialText}`.trim();
      elements.measureText.textContent = visibleText;
      measuredWidth = Math.ceil(elements.measureText.getBoundingClientRect().width);
    }

    let hintWidth = 0;
    if (hasHint) {
      elements.measureText.textContent = hintText;
      hintWidth = Math.ceil(elements.measureText.getBoundingClientRect().width);
    }

    const horizontalPadding = 16;
    const borderWidth = 2;
    const singleLineLimit = 520;
    const multiLineWidth = 520;
    const lockLayout =
      !shouldMeasureHintOnly && (state.appState === "recording" || state.appState === "finishing");
    const shouldWrap =
      !shouldMeasureHintOnly && (state.layoutWrap || measuredWidth > singleLineLimit);
    const textWidth = Math.max(measuredWidth, hintWidth);
    const nextWidth = shouldWrap
      ? multiLineWidth + horizontalPadding + borderWidth
      : Math.min(
          singleLineLimit + horizontalPadding + borderWidth,
          Math.max(116, textWidth + horizontalPadding + borderWidth),
        );

    if (!lockLayout) {
      state.layoutWidth = nextWidth;
      state.layoutWrap = shouldWrap;
    } else {
      state.layoutWidth = Math.max(state.layoutWidth || 0, nextWidth);
      state.layoutWrap = state.layoutWrap || shouldWrap;
    }

    elements.bubble.dataset.wrap = state.layoutWrap ? "multi" : "single";

    const width = state.layoutWidth || nextWidth;

    if (width === state.renderedWidth) {
      return;
    }

    state.renderedWidth = width;
    elements.bubble.style.width = `${width}px`;
  });
}

function scrollTranscriptToBottom() {
  requestAnimationFrame(() => {
    elements.transcript.scrollTop = elements.transcript.scrollHeight;
  });
}

function updateView() {
  const visualState =
    state.appState === "recording" && !state.audioReady ? "connecting" : state.appState;
  const hintText = getVisibleHintText();
  const hasHint = Boolean(hintText);
  const showTranscript = !hasHint;
  const showWaveform = visualState === "recording" && !hasHint;

  elements.stage.dataset.state = visualState;
  elements.stage.dataset.mode = hasHint ? "hint" : "transcript";
  elements.finalText.textContent = showTranscript ? state.finalText : "";
  elements.partialText.textContent = showTranscript ? state.partialText : "";
  if (showTranscript) {
    scrollTranscriptToBottom();
  }
  elements.hintLabel.textContent = getVisibleHintText();
  elements.hint.dataset.visible = shouldShowHint() ? "true" : "false";
  elements.hint.dataset.level = state.hintLevel;
  elements.hint.dataset.variant =
    visualState === "connecting" ||
    (visualState === "finishing" && state.hintVariant === "progress")
      ? "progress"
      : state.hintVariant;
  if (elements.statusBars) {
    elements.statusBars.dataset.active = showWaveform
      ? elements.statusBars.dataset.active
      : "false";
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
  elements.bubble.style.width = "";
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
    case "config_update":
      state.playSound = payload.playSound;
      break;
    default:
      break;
  }
});

window.addEventListener("beforeunload", () => {
  stopAudioCapture();
});

window.voiceOverlay.getConfig().then((config) => {
  state.playSound = config?.playSound !== false;
  updateView();
});

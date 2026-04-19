const state = {
  finalText: "",
  partialText: "",
  hintText: "",
  hintLevel: "info",
  appState: "idle",
  mediaStream: null,
  audioContext: null,
  sourceNode: null,
  processorNode: null,
  pendingSamples: [],
  layoutWidth: 0,
  layoutWrap: false,
  renderedWidth: 0,
};

const elements = {
  card: document.getElementById("card"),
  finalText: document.getElementById("finalText"),
  partialText: document.getElementById("partialText"),
  hint: document.getElementById("hint"),
  transcript: document.getElementById("transcript"),
  measureText: document.getElementById("measureText"),
};

let resizeRaf = 0;

function scheduleResize() {
  if (resizeRaf) {
    cancelAnimationFrame(resizeRaf);
  }

  resizeRaf = requestAnimationFrame(() => {
    const hasText = Boolean(state.finalText || state.partialText);

    if (!hasText) {
      elements.card.style.width = "";
      state.renderedWidth = 0;
      elements.card.dataset.wrap = "single";
      return;
    }

    const visibleText = `${state.finalText}${state.partialText}`.trim();
    elements.measureText.textContent = visibleText;

    const measuredWidth = Math.ceil(elements.measureText.getBoundingClientRect().width);
    const chromeWidth = 92;
    const singleLineLimit = 560;
    const lockLayout = state.appState === "recording" || state.appState === "finishing";
    const shouldWrap = state.layoutWrap || measuredWidth > singleLineLimit;
    const contentWidth = shouldWrap
      ? 420
      : Math.min(singleLineLimit, Math.max(120, measuredWidth + 20));
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
  elements.card.dataset.state = state.appState;
  elements.finalText.textContent = state.finalText;
  elements.partialText.textContent = state.partialText;
  elements.hint.textContent = state.hintText;
  elements.hint.dataset.level = state.hintLevel;
  scheduleResize();
}

function resetState() {
  state.finalText = "";
  state.partialText = "";
  state.hintText = "";
  state.hintLevel = "info";
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
  const targetChunkSize = 3200;

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

    window.voiceOverlay.sendAudioChunk(base64Chunk).catch(() => {
      state.hintText = "音频发送失败";
      state.hintLevel = "error";
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

  sourceNode.connect(processorNode);
  processorNode.connect(audioContext.destination);

  state.mediaStream = stream;
  state.audioContext = audioContext;
  state.sourceNode = sourceNode;
  state.processorNode = processorNode;

  window.voiceOverlay.sendDiagnostic({
    type: "audio:capture-started",
    sampleRate: audioContext.sampleRate,
  });
}

async function stopAudioCapture() {
  flushPendingAudio(true);

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
      if (
        payload.state === "idle" ||
        payload.state === "connecting" ||
        payload.state === "recording" ||
        payload.state === "finishing"
      ) {
        if (state.hintLevel === "info") {
          state.hintText = "";
        }
      }
      updateView();
      break;
    case "recording:start":
      try {
        await startAudioCapture();
        state.hintText = "";
        state.hintLevel = "info";
      } catch (error) {
        window.voiceOverlay.sendDiagnostic({
          type: "audio:capture-failed",
          message: error.message || String(error),
        });
        state.hintText = error.message || "无法获取麦克风权限";
        state.hintLevel = "error";
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
      updateView();
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

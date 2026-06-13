/**
 * Overlay entry point — vanilla TypeScript (no React).
 * Preserves the exact audio pipeline, waveform animation, and state machine
 * from the original app.js, using typed bridge + lib imports.
 */

import type { OverlayEvent } from "@/bridge/overlay";
import {
  getConfig,
  notifyAudioStopped,
  onOverlayEvent,
  sendAudioChunk,
  sendAudioWarmupFailed,
  sendAudioWarmupReady,
  sendDiagnostic,
} from "@/bridge/overlay";
import { downsampleBuffer, floatTo16BitPCM, int16ToBase64 } from "@/lib/audio";
import "../styles/app.css";

// ---- Types ----

type AppState = "idle" | "connecting" | "recording" | "finishing";
type HintLevel = "info" | "error" | "warn";

interface OverlayState {
  finalText: string;
  partialText: string;
  hintText: string;
  hintLevel: HintLevel;
  hintVariant: string;
  appState: AppState;
  audioReady: boolean;
  mediaStream: MediaStream | null;
  audioContext: AudioContext | null;
  sourceNode: MediaStreamAudioSourceNode | null;
  processorNode: ScriptProcessorNode | null;
  analyserNode: AnalyserNode | null;
  pendingSamples: number[];
  layoutWidth: number;
  layoutWrap: boolean;
  renderedWidth: number;
  waveBarHeights: number[];
  smoothedLevel: number;
}

interface AppearanceConfig {
  platform?: string;
  overlayStyle?: string;
  theme?: string;
}

// ---- State ----

const state: OverlayState = {
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

// ---- DOM elements ----

function getEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: #${id}`);
  return el;
}

const elements = {
  stage: getEl("stage"),
  bubble: getEl("bubble"),
  finalText: getEl("finalText"),
  partialText: getEl("partialText"),
  hint: getEl("hint"),
  hintLabel: getEl("hintLabel"),
  transcript: getEl("transcript"),
  measureText: getEl("measureText"),
  statusBars: getEl("statusBars"),
};

const statusBarItems = Array.from(elements.statusBars.querySelectorAll(".status-bar"));

// ---- Appearance ----

const currentAppearance: AppearanceConfig = {
  platform: "",
  overlayStyle: "liquid",
  theme: "system",
};

function resolvedGlassVariant(): "light" | "dark" {
  const t = currentAppearance.theme;
  if (t === "light" || t === "dark") return t;
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

function applyAppearance(cfg: AppearanceConfig = {}): void {
  currentAppearance.platform = cfg.platform || "";
  currentAppearance.overlayStyle = cfg.overlayStyle || "liquid";
  currentAppearance.theme = cfg.theme || "system";
  const isMac = cfg.platform === "macos";
  if (elements.stage) {
    elements.stage.style.display = isMac ? "none" : "";
  }
  const isVibrancy = isMac && cfg.overlayStyle === "vibrancy";
  elements.bubble.classList.toggle("platform-mac", isMac);
  elements.bubble.classList.toggle("platform-win", !isMac);
  elements.bubble.classList.toggle("is-vibrancy", isVibrancy);
  elements.bubble.classList.toggle(
    "is-light",
    isMac && !isVibrancy && resolvedGlassVariant() === "light",
  );
}

// ---- Waveform ----

let waveformRaf = 0;

function startWaveformAnimation(): void {
  const analyser = state.analyserNode;
  if (!analyser || statusBarItems.length === 0) return;

  const sampleCount = analyser.fftSize;
  const data = new Float32Array(sampleCount);
  const centerIndex = (statusBarItems.length - 1) / 2;
  const maxDistance = Math.max(1, centerIndex);

  function tick(): void {
    // analyser is non-null here (checked before starting waveform animation)
    const a = analyser as AnalyserNode;
    a.getFloatTimeDomainData(data);
    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < sampleCount; i++) {
      const s = data[i];
      sumSquares += s * s;
      peak = Math.max(peak, Math.abs(s));
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
      const el = bar as HTMLElement;
      el.style.height = `${Math.round(Math.max(3, Math.min(18, height)))}px`;
      el.style.transform = "scaleY(1)";
    });
    elements.statusBars.dataset.active = "true";
    waveformRaf = requestAnimationFrame(tick);
  }

  waveformRaf = requestAnimationFrame(tick);
}

function stopWaveformAnimation(): void {
  if (waveformRaf) {
    cancelAnimationFrame(waveformRaf);
    waveformRaf = 0;
  }
  if (elements.statusBars) {
    elements.statusBars.dataset.active = "false";
  }
  statusBarItems.forEach((bar) => {
    const el = bar as HTMLElement;
    el.style.height = "";
    el.style.transform = "";
  });
  state.waveBarHeights = [];
  state.smoothedLevel = 0;
}

// ---- Hints ----

const isZhLocale = (navigator.language || "").toLowerCase().startsWith("zh");

function getVisibleHintText(): string {
  const visualState: string =
    state.appState === "recording" && !state.audioReady ? "connecting" : state.appState;
  if (visualState === "connecting") return isZhLocale ? "准备中…" : "Preparing…";
  if (visualState === "finishing" && state.hintVariant === "progress") {
    return isZhLocale ? "思考中…" : "Thinking…";
  }
  return state.hintText || "";
}

function shouldShowHint(): boolean {
  return Boolean(getVisibleHintText());
}

// ---- Layout ----

let resizeRaf = 0;

function scheduleResize(): void {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
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
      elements.measureText.textContent = `${state.finalText}${state.partialText}`.trim();
      measuredWidth = Math.ceil(elements.measureText.getBoundingClientRect().width);
    }
    let hintWidth = 0;
    if (hasHint) {
      elements.measureText.textContent = hintText;
      hintWidth = Math.ceil(elements.measureText.getBoundingClientRect().width);
    }

    const indicatorWidth = 22 + 12;
    const waveformWidth = state.appState === "recording" ? 18 + 12 : 0;
    const chrome = 14 + 16 + 2 + indicatorWidth + waveformWidth;
    const textSlack = 10;
    const singleLineLimit = 520;
    const multiLineWidth = 520;
    const lockLayout =
      !shouldMeasureHintOnly && (state.appState === "recording" || state.appState === "finishing");
    const shouldWrap =
      !shouldMeasureHintOnly && (state.layoutWrap || measuredWidth > singleLineLimit);
    const textWidth = Math.max(measuredWidth, hintWidth) + textSlack;
    const nextWidth = shouldWrap
      ? multiLineWidth + chrome
      : Math.min(singleLineLimit + chrome, Math.max(116, textWidth + chrome));

    if (!lockLayout) {
      state.layoutWidth = nextWidth;
      state.layoutWrap = shouldWrap;
    } else {
      state.layoutWidth = Math.max(state.layoutWidth || 0, nextWidth);
      state.layoutWrap = state.layoutWrap || shouldWrap;
    }
    elements.bubble.dataset.wrap = state.layoutWrap ? "multi" : "single";

    let width = state.layoutWidth || nextWidth;
    if (width !== state.renderedWidth) {
      state.renderedWidth = width;
      elements.bubble.style.width = `${width}px`;
    }

    if (!state.layoutWrap && !shouldMeasureHintOnly && elements.transcript) {
      const overflow = elements.transcript.scrollWidth - elements.transcript.clientWidth;
      if (overflow > 0) {
        width += overflow + 6;
        state.layoutWidth = Math.max(state.layoutWidth || 0, width);
        state.renderedWidth = width;
        elements.bubble.style.width = `${width}px`;
      }
    }
  });
}

function scrollTranscriptToBottom(): void {
  requestAnimationFrame(() => {
    elements.transcript.scrollTop = elements.transcript.scrollHeight;
  });
}

// ---- View ----

function updateView(): void {
  const visualState: string =
    state.appState === "recording" && !state.audioReady ? "connecting" : state.appState;
  const hintText = getVisibleHintText();
  const hasHint = Boolean(hintText);
  const showTranscript = !hasHint;
  const showWaveform = visualState === "recording";

  elements.stage.dataset.state = visualState;
  elements.stage.dataset.mode = hasHint ? "hint" : "transcript";
  elements.finalText.textContent = showTranscript ? state.finalText : "";
  elements.partialText.textContent = showTranscript ? state.partialText : "";
  if (showTranscript) scrollTranscriptToBottom();
  elements.hintLabel.textContent = getVisibleHintText();
  elements.hint.dataset.visible = shouldShowHint() ? "true" : "false";
  elements.hint.dataset.level = state.hintLevel;
  elements.stage.dataset.level = hasHint ? state.hintLevel : "info";
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

function resetState(): void {
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

// ---- Audio pipeline ----

function flushPendingAudio(force = false): void {
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
    sendAudioChunk(base64Chunk).catch(() => {
      state.hintText = "音频发送失败";
      state.hintLevel = "error";
      state.hintVariant = "text";
      updateView();
    });
    if (force) break;
  }
}

async function startAudioCapture(): Promise<void> {
  if (state.mediaStream) return;

  sendDiagnostic({ type: "audio:capture-starting" });

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, noiseSuppression: true, echoCancellation: true },
    video: false,
  });

  const AudioContextCtor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) throw new Error("AudioContext not available");
  const audioContext = new AudioContextCtor();
  if (audioContext.state === "suspended") await audioContext.resume();

  const sourceNode = audioContext.createMediaStreamSource(stream);
  const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
  state.pendingSamples = [];
  state.audioReady = false;

  processorNode.onaudioprocess = (event) => {
    if (state.appState !== "recording") return;
    const inputData = (event as AudioProcessingEvent).inputBuffer.getChannelData(0);
    const downsampled = downsampleBuffer(inputData, audioContext.sampleRate, 16000);
    for (let i = 0; i < downsampled.length; i++) state.pendingSamples.push(downsampled[i]);
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

  sendDiagnostic({ type: "audio:capture-started", sampleRate: audioContext.sampleRate });
}

async function stopAudioCapture(): Promise<void> {
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
    for (const track of state.mediaStream.getTracks()) track.stop();
    state.mediaStream = null;
  }
  if (state.audioContext) {
    await state.audioContext.close();
    state.audioContext = null;
  }
  state.pendingSamples = [];
}

// ---- Event handling ----

onOverlayEvent(async (event: OverlayEvent) => {
  const { type, payload = {} } = event;
  switch (type) {
    case "reset":
      resetState();
      break;
    case "state":
      state.appState = (payload as { state: AppState }).state;
      if (state.appState === "idle" || state.appState === "connecting") state.audioReady = false;
      if (state.appState === "recording") startWaveformAnimation();
      if (
        state.appState === "idle" ||
        state.appState === "connecting" ||
        state.appState === "recording" ||
        state.appState === "finishing"
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
        sendAudioWarmupReady();
      } catch (error) {
        const msg = (error as Error).message || String(error);
        sendAudioWarmupFailed({ message: msg });
        state.hintText = msg || "无法获取麦克风权限";
        state.hintLevel = "error";
        state.hintVariant = "text";
        updateView();
      }
      break;
    case "recording:start":
      try {
        state.appState = "recording";
        state.audioReady = false;
        await startAudioCapture();
        startWaveformAnimation();
        state.hintText = "";
        state.hintLevel = "info";
        state.hintVariant = "text";
      } catch (error) {
        const msg = (error as Error).message || String(error);
        sendDiagnostic({ type: "audio:capture-failed", message: msg });
        state.hintText = msg || "无法获取麦克风权限";
        state.hintLevel = "error";
        state.hintVariant = "text";
      }
      updateView();
      break;
    case "recording:stop":
      await stopAudioCapture();
      notifyAudioStopped();
      break;
    case "transcript": {
      const p = payload as { finalText?: string; partialText?: string };
      state.finalText = p.finalText || "";
      state.partialText = p.partialText || "";
      updateView();
      break;
    }
    case "hint": {
      const p = payload as { text?: string; level?: HintLevel; variant?: string };
      state.hintText = p.text || "";
      state.hintLevel = p.level || "info";
      state.hintVariant = p.variant || "text";
      updateView();
      break;
    }
    case "paste:done":
    case "sound:config":
      break;
    case "appearance":
      applyAppearance((payload || {}) as AppearanceConfig);
      break;
    default:
      break;
  }
});

window.addEventListener("beforeunload", () => {
  stopAudioCapture();
});

getConfig().then((config) => {
  applyAppearance(config || {});
  updateView();
});

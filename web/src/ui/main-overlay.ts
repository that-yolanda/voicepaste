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
  waveBarLevels: number[];
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
  waveBarLevels: [],
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

/** Slice the analyser's low-mid range into one frequency band per waveform bar.
 * Returns barCount + 1 bin indices. Voice energy lives in the low-mid range, so
 * bands start at bin 1 (skip DC) and cap where speech fades (~6 kHz). */
function computeBandEdges(barCount: number, binCount: number): number[] {
  const minBin = 1;
  const maxBin = Math.min(binCount, 32);
  const edges: number[] = [];
  for (let b = 0; b <= barCount; b++) {
    edges.push(Math.round(minBin + ((maxBin - minBin) * b) / barCount));
  }
  return edges;
}

function startWaveformAnimation(): void {
  const analyser = state.analyserNode;
  if (!analyser || statusBarItems.length === 0) return;

  // Drive each bar from its own frequency band instead of a single loudness
  // scalar, so bars move independently and look alive while speaking rather
  // than all peaking together.
  const barCount = statusBarItems.length;
  const freqData = new Uint8Array(analyser.frequencyBinCount);
  const bandEdges = computeBandEdges(barCount, analyser.frequencyBinCount);

  function tick(): void {
    // analyser is non-null here (checked before starting waveform animation)
    const a = analyser as AnalyserNode;
    a.getByteFrequencyData(freqData);

    for (let b = 0; b < barCount; b++) {
      const start = bandEdges[b];
      const end = bandEdges[b + 1];
      let sum = 0;
      for (let i = start; i < end; i++) sum += freqData[i];
      const avg = sum / Math.max(1, end - start) / 255;
      // Lift + compress so quiet speech still reads on the bars.
      const target = Math.min(1, (avg * 2.6) ** 0.75);
      // Asymmetric envelope: fast attack (snap up with the voice), slow
      // release (ease back down instead of dropping flat between syllables).
      const prev = state.waveBarLevels[b] ?? 0;
      const rate = target > prev ? 0.4 : 0.08;
      const level = prev + (target - prev) * rate;
      state.waveBarLevels[b] = level;

      const el = statusBarItems[b] as HTMLElement;
      // scaleY relative to the 20px CSS baseline — compositor-only, no reflow.
      // level 0–1 maps to 3–18 px ⇒ scale 0.15–0.9.
      const clamped = Math.max(3, Math.min(18, 3 + level * 15));
      el.style.transform = `scaleY(${(clamped / 20).toFixed(3)})`;
    }
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
    el.style.transform = "";
  });
  state.waveBarLevels = [];
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

// Returns a promise that resolves once every chunk dispatched in this call has
// been acked by the backend. The final flush (force=true) is awaited by
// stopAudioCapture so the last audio reaches the backend *before* audio_stopped
// fires, guaranteeing the commit's last packet is sent after all audio.
function flushPendingAudio(force = false): Promise<unknown[]> {
  const targetChunkSize = 1600;
  const sends: Promise<unknown>[] = [];
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
    sends.push(
      sendAudioChunk(base64Chunk).catch(() => {
        state.hintText = "音频发送失败";
        state.hintLevel = "error";
        state.hintVariant = "text";
        updateView();
      }),
    );
    if (force) break;
  }
  return Promise.all(sends);
}

// Dedicated AudioContext used to play both the start and end cues. It is kept
// separate from the capture context on purpose: the capture context is driven by
// a main-thread ScriptProcessorNode doing heavy per-chunk work (downsample +
// base64 + IPC), and that congestion underruns the shared output, making a cue
// rendered there stutter. A capture-free context renders cues on its own audio
// thread, unaffected by capture load.
//
// Lifecycle (warm during the session, suspended while idle so it draws no power
// and does not hold the output device):
//   - warmup            → resume the context and start the keep-alive
//   - start cue         → plays; context stays running (decoded buffer cached)
//   - recording / stop  → stays running through the finishing flow
//   - end cue           → plays on the still-warm context
//   - back to idle      → stop the keep-alive and suspend
let cueAudioContext: AudioContext | null = null;
let cuePlaying = false;
let cueKeepAlive: AudioBufferSourceNode | null = null;

// Decoded cue AudioBuffers cached by kind ("start" / "end"), so decodeAudioData
// runs once per sound instead of on every play — eliminating decode-time jank.
// Re-decoded only if the underlying bytes change (custom sound swapped in).
const cueBufferCache = new Map<string, { data: string; buffer: AudioBuffer }>();

// Amplitude of the keep-alive priming signal — kept inaudibly low. NOTE: raising
// this (tried up to ~ -60 dBFS / 0.001) did NOT stop the cue stutter and was
// audible as hiss, so do not raise it. The cue stutter is instead addressed by
// pre-decoding the cue into a cached AudioBuffer (eliminating decode-time jank).
const CUE_KEEPALIVE_AMPLITUDE = 0.00012;

// A looping low-amplitude noise source that keeps the output device actively
// rendering for the whole session. Without it (or with pure silence), a resumed
// context lets the OS power the output device back down, so the next cue plays
// into a cold device and glitches mid-playback (notably the start cue after even
// a few seconds idle). The continuous inaudible priming keeps the device hot.
function startCueKeepAlive(): void {
  if (cueKeepAlive || !cueAudioContext || cueAudioContext.state !== "running") {
    return;
  }
  const frames = Math.max(1, Math.floor(cueAudioContext.sampleRate * 0.5));
  const buffer = cueAudioContext.createBuffer(1, frames, cueAudioContext.sampleRate);
  // Fill with tiny noise (not zeros) so the device stays powered. Inaudible.
  const channel = buffer.getChannelData(0);
  for (let index = 0; index < channel.length; index += 1) {
    channel[index] = (Math.random() * 2 - 1) * CUE_KEEPALIVE_AMPLITUDE;
  }
  const source = cueAudioContext.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.connect(cueAudioContext.destination);
  source.start();
  cueKeepAlive = source;
}

function stopCueKeepAlive(): void {
  if (cueKeepAlive) {
    try {
      cueKeepAlive.stop();
    } catch {
      // already stopped
    }
    cueKeepAlive.disconnect();
    cueKeepAlive = null;
  }
}

function usesNativeAudioCapture(): boolean {
  return currentAppearance.platform === "macos";
}

// Create the cue context if needed, resume it, and start the keep-alive so the
// output device is warm and settled by the time a cue plays. Idempotent; called
// during warmup.
function ensureCueContextWarm(): void {
  try {
    if (!cueAudioContext) {
      const AudioContextCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) return;
      cueAudioContext = new AudioContextCtor();
    }
    if (cueAudioContext.state === "suspended") {
      cueAudioContext
        .resume()
        .then(() => startCueKeepAlive())
        .catch(() => {});
    } else {
      startCueKeepAlive();
    }
  } catch (error) {
    sendDiagnostic({
      type: "cue:warm-failed",
      message: (error as Error).message || String(error),
    });
  }
}

// Release the cue context once the session is fully over. Suspends (and stops the
// keep-alive) only when back to idle and no cue is mid-playback, so the end cue —
// which plays during the finishing flow — is never cut off.
function maybeSuspendCue(): void {
  if (state.appState !== "idle" || cuePlaying) {
    return;
  }
  stopCueKeepAlive();
  if (cueAudioContext && cueAudioContext.state === "running") {
    cueAudioContext.suspend().catch(() => {});
  }
}

// Decode the cue bytes to an AudioBuffer, caching by kind so decodeAudioData runs
// once per sound. Re-decodes only when the bytes change (custom sound swapped in).
async function getCueBuffer(kind: string, base64Data: string): Promise<AudioBuffer> {
  const cached = cueBufferCache.get(kind);
  if (cached && cached.data === base64Data) {
    return cached.buffer;
  }
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (!cueAudioContext) throw new Error("cue context unavailable");
  const buffer = await cueAudioContext.decodeAudioData(bytes.buffer);
  cueBufferCache.set(kind, { data: base64Data, buffer });
  return buffer;
}

// Play a cue (start or end). Backend sends the raw audio file bytes (e.g. mp3) as
// base64; we decode (cached) and play it through the cue context, then try to
// suspend once it ends (only takes effect when the session is idle).
async function playCue(payload: { kind?: string; data?: string }): Promise<void> {
  const kind = payload?.kind || "start";
  const base64Data = payload?.data;
  if (!base64Data) return;

  // Mark the cue in-flight before any await. The end cue and the idle-state event
  // arrive back-to-back; their async handlers interleave at await points. If
  // maybeSuspendCue (from the idle handler) ran while this was still false it
  // would suspend the context mid-decode, so the cue would start on a suspended
  // context and only sound on the next resume (next session). Setting the flag up
  // front makes that suspend a no-op until this cue's onended fires.
  cuePlaying = true;

  try {
    ensureCueContextWarm();
    if (!cueAudioContext) {
      cuePlaying = false;
      return;
    }
    if (cueAudioContext.state === "suspended") {
      await cueAudioContext.resume();
      startCueKeepAlive();
    }

    const audioBuffer = await getCueBuffer(kind, base64Data);
    const source = cueAudioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(cueAudioContext.destination);
    source.onended = () => {
      cuePlaying = false;
      maybeSuspendCue();
    };
    source.start();
  } catch (error) {
    cuePlaying = false;
    maybeSuspendCue();
    sendDiagnostic({
      type: "cue:play-failed",
      message: (error as Error).message || String(error),
    });
  }
}

async function startAudioCapture(): Promise<void> {
  // Create/resume the cue context early (during warmup) so the start cue has no
  // cold-start. The keep-alive started here is restarted after getUserMedia below,
  // because opening the mic reconfigures the shared output device. Suspended when idle.
  ensureCueContextWarm();

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
  analyserNode.smoothingTimeConstant = 0.7;
  sourceNode.connect(analyserNode);
  analyserNode.connect(processorNode);
  processorNode.connect(audioContext.destination);

  state.mediaStream = stream;
  state.audioContext = audioContext;
  state.sourceNode = sourceNode;
  state.processorNode = processorNode;
  state.analyserNode = analyserNode;

  // getUserMedia just reconfigured the shared output device, which can silence the
  // cue keep-alive started above (the device is re-routed without firing onended).
  // Restart it now, after capture is fully set up, so it actively holds the output
  // device warm through the backend's pre-cue settle delay — otherwise the device
  // cools during that wait and the start cue plays back stuttering.
  stopCueKeepAlive();
  ensureCueContextWarm();

  sendDiagnostic({ type: "audio:capture-started", sampleRate: audioContext.sampleRate });
}

async function stopAudioCapture(): Promise<void> {
  stopWaveformAnimation();
  // Await so the final chunk reaches the backend before we signal audio_stopped.
  await flushPendingAudio(true);

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

  // Note: the cue context is intentionally left running here. The end cue plays
  // later in the finishing flow, so it is only suspended once the session is back
  // to idle (see maybeSuspendCue, called from the end cue and the idle handler).
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
      if (state.appState === "idle") {
        // Session over: suspend the cue context. No-op if the end cue is still
        // playing — its onended handler suspends once it finishes.
        maybeSuspendCue();
      }
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
        if (usesNativeAudioCapture()) {
          ensureCueContextWarm();
          state.audioReady = true;
        } else {
          await startAudioCapture();
        }
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
        if (usesNativeAudioCapture()) {
          state.audioReady = true;
        } else {
          await startAudioCapture();
        }
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
      if (usesNativeAudioCapture()) {
        stopWaveformAnimation();
        state.pendingSamples = [];
      } else {
        await stopAudioCapture();
      }
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
    case "cue:play":
      playCue(payload as { kind?: string; data?: string });
      break;
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

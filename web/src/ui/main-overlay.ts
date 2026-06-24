/**
 * Overlay entry point — vanilla TypeScript (no React).
 *
 * Audio capture and cue playback live entirely in the backend (cpal on macOS +
 * Windows, rodio for cues); the renderer only paints transcript/hint text, the
 * retry affordance, and a waveform driven by the backend `audio:level` event.
 */

import type { OverlayEvent } from "@/bridge/overlay";
import { getConfig, onOverlayEvent, retryLatestFailedTranscription } from "@/bridge/overlay";
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
  retryHotkey: string;
  appState: AppState;
  audioLevel: number; // 0..1 loudness from the backend `audio:level` event
  layoutWidth: number;
  layoutWrap: boolean;
  renderedWidth: number;
  waveBarLevels: number[];
  retryVisible: boolean;
  retrying: boolean;
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
  retryHotkey: "",
  appState: "idle",
  audioLevel: 0,
  layoutWidth: 0,
  layoutWrap: false,
  renderedWidth: 0,
  waveBarLevels: [],
  retryVisible: false,
  retrying: false,
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
  retryButton: getEl("retryButton") as HTMLButtonElement,
  retryLabel: getEl("retryLabel"),
};

const statusBarItems = Array.from(elements.statusBars.querySelectorAll(".status-bar"));
let retryHideTimer = 0;

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

function syncStageVisibility(): void {
  // macOS renders the pill natively (NSGlassEffectView); the WebView stage is
  // hidden there and only acts as a hidden worker for cue playback historically.
  const isMac = currentAppearance.platform === "macos";
  elements.stage.style.display = isMac ? "none" : "";
}

function applyAppearance(cfg: AppearanceConfig = {}): void {
  currentAppearance.platform = cfg.platform || "";
  currentAppearance.overlayStyle = cfg.overlayStyle || "liquid";
  currentAppearance.theme = cfg.theme || "system";
  const isMac = cfg.platform === "macos";
  syncStageVisibility();
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

// Per-bar multipliers so the 4 bars rise with a slight phase spread from a
// single loudness scalar — mirrors the macOS native renderer, which also drives
// 4 bars from one backend level instead of per-band FFT data.
const WAVE_BAR_MULTIPLIERS = [1.0, 0.82, 0.92, 0.7];

function startWaveformAnimation(): void {
  if (statusBarItems.length === 0) return;
  const barCount = statusBarItems.length;

  function tick(): void {
    const base = state.audioLevel;
    for (let b = 0; b < barCount; b++) {
      // Lift + compress so quiet speech still reads on the bars.
      const target = Math.min(1, (base * (WAVE_BAR_MULTIPLIERS[b] ?? 1) * 2.6) ** 0.75);
      // Asymmetric envelope: fast attack (snap up with the voice), slow release
      // (ease back down instead of dropping flat between syllables).
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
    elements.statusBars.dataset.active = base > 0.02 ? "true" : "false";
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
  const appState = state.appState;
  if (appState === "connecting") return isZhLocale ? "准备中…" : "Preparing…";
  if (appState === "finishing" && state.hintVariant === "retry") {
    // Placeholder until the replayed transcript starts streaming in.
    if (!state.finalText && !state.partialText) return isZhLocale ? "重试中…" : "Retrying…";
    return "";
  }
  if (appState === "finishing" && state.hintVariant === "progress") {
    return isZhLocale ? "思考中…" : "Thinking…";
  }
  // The retry label + hotkey live inside the retry button, not in the message.
  return state.hintText || "";
}

function shouldShowHint(): boolean {
  return Boolean(getVisibleHintText());
}

function clearRetryTimer(): void {
  if (retryHideTimer) {
    window.clearTimeout(retryHideTimer);
    retryHideTimer = 0;
  }
}

function showRetryAction(): void {
  clearRetryTimer();
  state.retryVisible = true;
  state.retrying = false;
  retryHideTimer = window.setTimeout(() => {
    state.retryVisible = false;
    state.retrying = false;
    updateView();
  }, 5000);
}

function hideRetryAction(): void {
  clearRetryTimer();
  state.retryVisible = false;
  state.retrying = false;
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
    const retryWidth = state.retryVisible ? 22 + 8 : 0;
    const chrome = 14 + 16 + 2 + indicatorWidth + waveformWidth + retryWidth;
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
  const appState = state.appState;
  const hintText = getVisibleHintText();
  const hasHint = Boolean(hintText);
  const showTranscript = !hasHint;
  const showWaveform = appState === "recording";

  elements.stage.dataset.state = appState;
  elements.stage.dataset.mode = hasHint ? "hint" : "transcript";
  elements.stage.dataset.retry =
    state.retryVisible && state.hintLevel === "error" ? "true" : "false";
  elements.stage.dataset.retrying = state.retrying ? "true" : "false";
  elements.retryButton.disabled = state.retrying || !state.retryVisible;
  // Label + hotkey live inside the button, e.g. "重试 (R ⌥)".
  elements.retryLabel.textContent = state.retryHotkey
    ? `${isZhLocale ? "重试" : "Retry"} (${state.retryHotkey})`
    : isZhLocale
      ? "重试"
      : "Retry";
  syncStageVisibility();
  elements.finalText.textContent = showTranscript ? state.finalText : "";
  elements.partialText.textContent = showTranscript ? state.partialText : "";
  if (showTranscript) scrollTranscriptToBottom();
  elements.hintLabel.textContent = getVisibleHintText();
  elements.hint.dataset.visible = shouldShowHint() ? "true" : "false";
  elements.hint.dataset.level = state.hintLevel;
  elements.stage.dataset.level = hasHint ? state.hintLevel : "info";
  elements.hint.dataset.variant =
    appState === "connecting" || (appState === "finishing" && state.hintVariant === "progress")
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
  state.retryHotkey = "";
  state.audioLevel = 0;
  hideRetryAction();
  state.layoutWidth = 0;
  state.layoutWrap = false;
  state.renderedWidth = 0;
  elements.bubble.style.width = "";
  updateView();
}

// ---- Event handling ----

onOverlayEvent((event: OverlayEvent) => {
  const { type, payload = {} } = event;
  switch (type) {
    case "reset":
      resetState();
      break;
    case "state":
      state.appState = (payload as { state: AppState }).state;
      if (state.appState !== "idle") hideRetryAction();
      if (state.appState === "idle" || state.appState === "connecting") state.audioLevel = 0;
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
      if (state.appState === "recording") startWaveformAnimation();
      else stopWaveformAnimation();
      updateView();
      break;
    case "transcript": {
      const p = payload as { finalText?: string; partialText?: string };
      state.finalText = p.finalText || "";
      state.partialText = p.partialText || "";
      updateView();
      break;
    }
    case "audio:level": {
      const p = payload as { level?: number };
      state.audioLevel = typeof p.level === "number" ? Math.max(0, Math.min(1, p.level)) : 0;
      break;
    }
    case "hint": {
      const p = payload as {
        text?: string;
        level?: HintLevel;
        variant?: string;
        retryable?: boolean;
        hotkey?: string;
      };
      state.hintText = p.text || "";
      state.hintLevel = p.level || "info";
      state.hintVariant = p.variant || "text";
      state.retryHotkey = p.hotkey || "";
      if (p.retryable === true && state.hintLevel === "error" && state.hintText) {
        showRetryAction();
      } else {
        hideRetryAction();
      }
      updateView();
      break;
    }
    case "appearance":
      applyAppearance((payload || {}) as AppearanceConfig);
      break;
    default:
      break;
  }
});

elements.retryButton.addEventListener("click", async (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (!state.retryVisible || state.retrying) return;
  clearRetryTimer();
  state.retrying = true;
  updateView();
  try {
    await retryLatestFailedTranscription();
    hideRetryAction();
  } catch (error) {
    state.hintText = (error as Error).message || String(error) || "重试失败";
    state.hintLevel = "error";
    state.hintVariant = "text";
    showRetryAction();
  }
  updateView();
});

window.addEventListener("beforeunload", () => {
  stopWaveformAnimation();
});

getConfig().then((config) => {
  applyAppearance(config || {});
  updateView();
});

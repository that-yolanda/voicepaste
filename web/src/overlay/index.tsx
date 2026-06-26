import { type CSSProperties, StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles/app.css";
import "./overlay.css";
import { getOverlayLayoutMetrics, type OverlayLayoutMetrics } from "./bridge";
import type { OverlayState } from "./types";
import { useOverlayLayout } from "./useOverlayLayout";
import { useOverlayState } from "./useOverlayState";

// Fallback layout metrics used before the backend fetch resolves. Mirrors
// src-tauri/src/overlay/shared.rs (the single source of truth); the overlay is
// normally hidden during this brief window.
const FALLBACK_METRICS: OverlayLayoutMetrics = {
  pad_left: 14,
  pad_right: 16,
  indicator_w: 22,
  gap: 12,
  pill_h_single: 40,
  single_line_limit: 520,
  multi_line_width: 520,
  min_pill_w: 116,
  text_slack: 10,
  wave_area_w: 18,
  wave_gap_left: 12,
  retry_size: 22,
  retry_gap_left: 8,
};

// Visible hint text — aligned 1:1 with src-tauri/src/overlay/shared.rs::visible_hint.
function visibleHintText(state: OverlayState): string {
  if (state.appState === "connecting") return "准备中…";
  if (state.appState === "finishing") {
    if (state.hintVariant === "retry") {
      if (!state.finalText && !state.partialText) return "重试中…";
      return "";
    }
    if (state.hintVariant === "progress") return "润色中…";
  }
  return state.hintText;
}

// "重试 (R ⌥)" — aligned with overlay/macos.rs::retry_title_attr.
function retryLabel(hotkey: string): string {
  return hotkey ? `重试 (${hotkey})` : "重试";
}

// Waveform bar visuals — 4 fixed bars (shared::WAVE_N), heights from the backend.
const BAR_CLASS =
  "w-[2.5px] rounded-full bg-[linear-gradient(180deg,var(--color-overlay-accent),#3aa874)] transition-transform duration-75 ease-out will-change-transform";
const barStyle = (h: number): CSSProperties => ({
  height: "20px",
  transform: `scaleY(${(h / 20).toFixed(3)})`,
  transformOrigin: "center",
});

function OverlayApp() {
  const { state, waveHeights, onRetry } = useOverlayState();

  const [metrics, setMetrics] = useState<OverlayLayoutMetrics>(FALLBACK_METRICS);
  useEffect(() => {
    getOverlayLayoutMetrics()
      .then(setMetrics)
      .catch(() => {});
  }, []);

  const visibleHint = visibleHintText(state);
  const hasHint = Boolean(visibleHint);
  const isError = state.hintLevel === "error";
  const showSpinner =
    !isError &&
    (state.appState === "connecting" ||
      state.appState === "finishing" ||
      (state.appState === "recording" && state.hintLevel === "warn"));
  const showWave = state.appState === "recording" && state.hintLevel !== "warn";
  const showDot = isError && !showSpinner;
  const shouldPulse = hasHint && !isError && state.appState !== "idle";
  const showRetry = state.retryVisible && isError;

  const { measureRef, pillRef, transcriptRef, wrap } = useOverlayLayout({
    finalText: state.finalText,
    partialText: state.partialText,
    visibleHintText: visibleHint,
    appState: state.appState,
    retryVisible: showRetry,
    hintLevel: state.hintLevel,
    metrics,
  });

  // Auto-scroll the transcript to the latest line as it grows. transcriptRef is
  // a stable ref (intentionally omitted); the effect re-runs on content change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: transcriptRef is a stable ref; finalText/partialText drive the scroll timing
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [hasHint, state.finalText, state.partialText]);

  return (
    <main className="flex h-full w-full items-end justify-center overflow-hidden p-[28px_32px_40px] [font-family:var(--font-family-ui)]">
      <section className="flex max-h-full w-full max-w-[680px] items-end justify-center overflow-visible">
        <div
          ref={pillRef}
          data-wrap={wrap ? "multi" : "single"}
          className={`pill relative inline-flex min-w-[116px] max-w-full items-center gap-3 overflow-hidden px-4 pl-[14px] ${
            wrap
              ? "rounded-2xl min-h-[56px] py-1.5 [max-height:calc(100vh-68px)]"
              : "h-[40px] rounded-full"
          }`}
        >
          {/* Indicator slot: spinner while connecting/finishing/reconnecting, a
              red dot on error; recording shows the waveform here instead. */}
          {(showSpinner || showDot) && (
            <span
              className="relative grid h-[22px] w-[22px] shrink-0 place-items-center"
              aria-hidden="true"
            >
              {showSpinner && (
                <svg
                  className="h-4 w-4 animate-[vp-spin_1.1s_linear_infinite]"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                  focusable="false"
                >
                  <circle
                    className="stroke-white/[0.14]"
                    cx="8"
                    cy="8"
                    r="6.5"
                    fill="none"
                    strokeWidth="2"
                  />
                  <circle
                    className="stroke-[var(--color-overlay-accent)]"
                    cx="8"
                    cy="8"
                    r="6.5"
                    fill="none"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeDasharray="12 38"
                  />
                </svg>
              )}
              {showDot && (
                <span
                  className={`relative block h-[14px] w-[14px] rounded-full ${showWave ? "animate-[vp-ring_1.6s_ease-out_infinite]" : ""}`}
                  style={{
                    background: isError
                      ? "var(--color-overlay-err)"
                      : showWave
                        ? "var(--color-overlay-accent)"
                        : "rgba(250, 249, 245, 0.35)",
                    boxShadow: isError ? "0 0 10px rgba(255, 107, 107, 0.45)" : undefined,
                  }}
                >
                  {showWave && !isError && (
                    <span className="absolute inset-[3px] rounded-full bg-black/45" />
                  )}
                </span>
              )}
            </span>
          )}

          {/* Waveform: 4 bars driven by backend-computed heights. Sits right of
              the indicator (mirrors the macOS native pill) so layout — not text
              length — fixes its position; the pill can grow without it drifting. */}
          {showWave && (
            <span className="flex h-5 shrink-0 items-center" aria-hidden="true">
              <span className="flex h-5 items-center gap-[2.5px]">
                <span className={BAR_CLASS} style={barStyle(waveHeights[0] ?? 3)} />
                <span className={BAR_CLASS} style={barStyle(waveHeights[1] ?? 3)} />
                <span className={BAR_CLASS} style={barStyle(waveHeights[2] ?? 3)} />
                <span className={BAR_CLASS} style={barStyle(waveHeights[3] ?? 3)} />
              </span>
            </span>
          )}

          {/* Body: transcript or hint (mutually exclusive). */}
          <div className="min-w-0 flex-1 text-[14px] font-medium leading-[1.3]">
            {hasHint ? (
              <span
                className={`block truncate ${shouldPulse ? "pulse-text" : ""}`}
                style={{ color: isError ? "#ff9b9b" : undefined }}
              >
                {visibleHint}
              </span>
            ) : (
              <div
                ref={transcriptRef}
                className={
                  wrap
                    ? "block overflow-hidden whitespace-normal break-words leading-[1.32] [max-height:calc(1.32em*3+1px)] [mask-image:linear-gradient(180deg,transparent_0%,#000_30%)]"
                    : "truncate"
                }
              >
                <span className="text-inherit">{state.finalText}</span>
                <span className="opacity-55">{state.partialText}</span>
              </div>
            )}
          </div>

          {/* Retry affordance (error + retryable only). */}
          {showRetry && (
            <button
              type="button"
              aria-label="重试转写"
              disabled={state.retrying}
              onClick={onRetry}
              className="inline-flex h-[22px] shrink-0 cursor-pointer items-center gap-1 rounded-full border-0 bg-white/[0.11] px-2.5 text-white whitespace-nowrap shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.24),0_4px_12px_rgba(0,0,0,0.18)] transition-colors hover:bg-white/[0.17] active:scale-[0.96]"
            >
              <svg
                className={`h-3 w-3 fill-none stroke-white stroke-[2.2] [stroke-linecap:round] [stroke-linejoin:round] ${state.retrying ? "animate-[vp-spin_0.85s_linear_infinite]" : ""}`}
                viewBox="0 0 24 24"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M20 12a8 8 0 1 1-2.34-5.66" />
                <path d="M20 4v6h-6" />
              </svg>
              <span className="text-[12px] font-normal leading-none">
                {retryLabel(state.retryHotkey)}
              </span>
            </button>
          )}
        </div>
      </section>
      <div
        ref={measureRef}
        className="measure-text pointer-events-none fixed left-[-9999px] top-[-9999px] max-w-none whitespace-nowrap font-medium text-[14px] leading-[1.3] [font-family:var(--font-family-ui)] invisible"
      />
    </main>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <OverlayApp />
    </StrictMode>,
  );
}

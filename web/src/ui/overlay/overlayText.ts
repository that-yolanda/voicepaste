import type { OverlayState } from "./types";

const IS_ZH = (navigator.language || "").toLowerCase().startsWith("zh");

/**
 * The text shown in the pill body. State-driven placeholders take precedence
 * over the backend-supplied hint message — mirrors main-overlay.ts
 * getVisibleHintText.
 */
export function visibleHintText(state: OverlayState): string {
  const { appState, hintVariant, finalText, partialText, hintText } = state;
  if (appState === "connecting") return IS_ZH ? "准备中…" : "Preparing…";
  if (appState === "finishing" && hintVariant === "retry") {
    // Placeholder until the replayed transcript starts streaming in.
    if (!finalText && !partialText) return IS_ZH ? "重试中…" : "Retrying…";
    return "";
  }
  if (appState === "finishing" && hintVariant === "progress") {
    return IS_ZH ? "思考中…" : "Thinking…";
  }
  // The retry label + hotkey live inside the retry button, not in the message.
  return hintText || "";
}

/** "重试" / "Retry", suffixed with the hotkey when configured, e.g. "重试 (R ⌥)". */
export function retryLabel(hotkey: string): string {
  if (hotkey) return `${IS_ZH ? "重试" : "Retry"} (${hotkey})`;
  return IS_ZH ? "重试" : "Retry";
}

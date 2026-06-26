import { useCallback, useEffect, useReducer, useState } from "react";
import { onOverlayEvent, retryLatestFailedTranscription } from "@/overlay/bridge";
import { type AppState, type HintLevel, INITIAL_OVERLAY_STATE, type OverlayState } from "./types";

/** Resting bar heights before the first audio chunk (matches shared::WAVE_MIN_H). */
const REST_WAVE = [3, 3, 3, 3];

type Action =
  | { type: "reset" }
  | { type: "state"; state: AppState }
  | { type: "transcript"; finalText?: string; partialText?: string }
  | {
      type: "hint";
      text?: string;
      level?: HintLevel;
      variant?: string;
      retryable?: boolean;
      hotkey?: string;
    }
  | { type: "retry-hide" }
  | { type: "retrying"; value: boolean }
  | { type: "retry-error"; message: string };

function reducer(state: OverlayState, action: Action): OverlayState {
  switch (action.type) {
    case "reset":
      return { ...INITIAL_OVERLAY_STATE };
    case "state": {
      // Entering any non-idle state hides the retry affordance; entering any
      // state clears a lingering info-level hint (mirrors main-overlay.ts).
      const retryVisible = action.state === "idle" ? state.retryVisible : false;
      let hintText = state.hintText;
      let hintVariant = state.hintVariant;
      let retryHotkey = state.retryHotkey;
      if (state.hintLevel === "info") {
        hintText = "";
        hintVariant = "text";
        retryHotkey = "";
      }
      return {
        ...state,
        appState: action.state,
        retryVisible,
        retrying: false,
        hintText,
        hintVariant,
        retryHotkey,
      };
    }
    case "transcript":
      return {
        ...state,
        finalText: action.finalText || "",
        partialText: action.partialText || "",
      };
    case "hint": {
      const hintText = action.text || "";
      const hintLevel = action.level || "info";
      const hintVariant = action.variant || "text";
      const retryHotkey = action.hotkey || "";
      const showRetry = action.retryable === true && hintLevel === "error" && hintText.length > 0;
      return {
        ...state,
        hintText,
        hintLevel,
        hintVariant,
        retryHotkey,
        retryVisible: showRetry,
        retrying: false,
      };
    }
    case "retry-hide":
      return { ...state, retryVisible: false, retrying: false };
    case "retrying":
      return { ...state, retrying: action.value };
    case "retry-error":
      return {
        ...state,
        hintText: action.message,
        hintLevel: "error",
        hintVariant: "text",
        retryVisible: true,
        retrying: false,
      };
    default:
      return state;
  }
}

export interface UseOverlayState {
  state: OverlayState;
  /** Latest 4-bar waveform heights (logical px), carried in the backend
   * `audio:level` payload and computed there via `shared::wave_heights`. Updated
   * ~10×/s; the bars render directly from this with a CSS transition for smoothing. */
  waveHeights: number[];
  onRetry: () => void;
}

export function useOverlayState(): UseOverlayState {
  const [state, dispatch] = useReducer(reducer, INITIAL_OVERLAY_STATE);
  const [waveHeights, setWaveHeights] = useState<number[]>(REST_WAVE);

  useEffect(() => {
    const unlisten = onOverlayEvent((event) => {
      const { type, payload = {} } = event;
      switch (type) {
        case "reset":
          dispatch({ type: "reset" });
          setWaveHeights(REST_WAVE);
          break;
        case "state": {
          const next = (payload as { state?: AppState }).state;
          if (next) {
            dispatch({ type: "state", state: next });
            if (next === "idle" || next === "connecting") setWaveHeights(REST_WAVE);
          }
          break;
        }
        case "transcript": {
          const p = payload as { finalText?: string; partialText?: string };
          dispatch({ type: "transcript", finalText: p.finalText, partialText: p.partialText });
          break;
        }
        case "audio:level": {
          // The backend derives the per-bar heights (shared::wave_heights) and
          // ships them here; the renderer no longer smooths/derives locally.
          const h = (payload as { waveHeights?: number[] }).waveHeights;
          if (Array.isArray(h) && h.length > 0) setWaveHeights(h);
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
          dispatch({
            type: "hint",
            text: p.text,
            level: p.level,
            variant: p.variant,
            retryable: p.retryable,
            hotkey: p.hotkey,
          });
          break;
        }
        // "appearance" only concerns the macOS native renderer; ignored here.
        default:
          break;
      }
    });
    return unlisten;
  }, []);

  // Retry affordance auto-hides after 5s (mirrors main-overlay.ts retryHideTimer).
  useEffect(() => {
    if (!state.retryVisible) return;
    const timer = window.setTimeout(() => dispatch({ type: "retry-hide" }), 5000);
    return () => window.clearTimeout(timer);
  }, [state.retryVisible]);

  const onRetry = useCallback(() => {
    if (!state.retryVisible || state.retrying) return;
    dispatch({ type: "retrying", value: true });
    retryLatestFailedTranscription()
      .then(() => dispatch({ type: "retry-hide" }))
      .catch((error: unknown) => {
        const message =
          (error instanceof Error && error.message) ||
          (typeof error === "string" && error) ||
          "重试失败";
        dispatch({ type: "retry-error", message });
      });
  }, [state.retryVisible, state.retrying]);

  return { state, waveHeights, onRetry };
}

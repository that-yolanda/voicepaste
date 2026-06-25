import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { getConfig, onOverlayEvent, retryLatestFailedTranscription } from "@/bridge/overlay";
import {
  type AppearanceConfig,
  type AppState,
  type HintLevel,
  INITIAL_OVERLAY_STATE,
  type OverlayState,
} from "./types";

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
  appearance: AppearanceConfig;
  /** Latest backend audio level (0..1). Mutated on every `audio:level` event
   * without triggering a re-render; the waveform RAF reads it each frame. */
  audioLevelRef: React.RefObject<number>;
  onRetry: () => void;
}

export function useOverlayState(): UseOverlayState {
  const [state, dispatch] = useReducer(reducer, INITIAL_OVERLAY_STATE);
  const [appearance, setAppearance] = useState<AppearanceConfig>({});
  const audioLevelRef = useRef(0);

  useEffect(() => {
    const unlisten = onOverlayEvent((event) => {
      const { type, payload = {} } = event;
      switch (type) {
        case "reset":
          dispatch({ type: "reset" });
          audioLevelRef.current = 0;
          break;
        case "state": {
          const next = (payload as { state?: AppState }).state;
          if (next) {
            dispatch({ type: "state", state: next });
            if (next === "idle" || next === "connecting") audioLevelRef.current = 0;
          }
          break;
        }
        case "transcript": {
          const p = payload as { finalText?: string; partialText?: string };
          dispatch({ type: "transcript", finalText: p.finalText, partialText: p.partialText });
          break;
        }
        case "audio:level": {
          const lvl = (payload as { level?: number }).level;
          audioLevelRef.current = typeof lvl === "number" ? Math.max(0, Math.min(1, lvl)) : 0;
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
        case "appearance":
          setAppearance(payload as AppearanceConfig);
          break;
        default:
          break;
      }
    });
    getConfig()
      .then((cfg) => setAppearance(cfg || {}))
      .catch(() => {});
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

  return { state, appearance, audioLevelRef, onRetry };
}

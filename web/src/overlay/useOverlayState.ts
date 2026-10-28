import i18next from "i18next";
import { useEffect, useReducer, useRef, useState } from "react";
import { onOverlayEvent } from "@/overlay/bridge";
import {
  type AppState,
  type HintLevel,
  INITIAL_OVERLAY_STATE,
  type OverlayState,
  type Shortcut,
} from "./types";

type Action =
  | { type: "reset" }
  | { type: "state"; state: AppState }
  | { type: "transcript"; finalText?: string; partialText?: string }
  | { type: "hint"; text?: string; level?: HintLevel; variant?: string }
  | { type: "shortcuts"; shortcuts: Shortcut[] }
  | { type: "appearance"; theme: OverlayState["theme"] };

export function reducer(state: OverlayState, action: Action): OverlayState {
  switch (action.type) {
    case "reset":
      return { ...INITIAL_OVERLAY_STATE, theme: state.theme };
    case "shortcuts":
      return { ...state, shortcuts: action.shortcuts };
    case "appearance":
      return { ...state, theme: action.theme };
    case "state": {
      const clearHint =
        action.state !== "idle" || (state.hintLevel === "info" && state.hintVariant !== "success");
      return {
        ...state,
        appState: action.state,
        shortcuts: action.state === "idle" ? state.shortcuts : [],
        ...(clearHint ? { hintText: "", hintLevel: "info" as const, hintVariant: "text" } : {}),
      };
    }
    case "transcript":
      return { ...state, finalText: action.finalText || "", partialText: action.partialText || "" };
    case "hint":
      return {
        ...state,
        hintText: action.text || "",
        hintLevel: action.level || "info",
        hintVariant: action.variant || "text",
      };
  }
}

export function useOverlayState() {
  const [state, dispatch] = useReducer(reducer, INITIAL_OVERLAY_STATE);
  const [waveActive, setWaveActive] = useState(false);
  const appState = useRef<AppState>(INITIAL_OVERLAY_STATE.appState);
  useEffect(() => {
    return onOverlayEvent(({ type, payload = {} }) => {
      switch (type) {
        case "reset":
          appState.current = "idle";
          dispatch({ type: "reset" });
          setWaveActive(false);
          break;
        case "state": {
          const next = payload.state as AppState | undefined;
          if (next) {
            appState.current = next;
            dispatch({ type: "state", state: next });
            setWaveActive(false);
          }
          break;
        }
        case "transcript":
          dispatch({
            type: "transcript",
            finalText: payload.finalText as string,
            partialText: payload.partialText as string,
          });
          break;
        case "audio:level":
          if (appState.current === "recording") setWaveActive(payload.active === true);
          break;
        case "hint":
          dispatch({
            type: "hint",
            text: payload.text as string,
            level: payload.level as HintLevel,
            variant: payload.variant as string,
          });
          break;
        case "shortcuts":
          dispatch({ type: "shortcuts", shortcuts: (payload.shortcuts as Shortcut[]) || [] });
          break;
        case "appearance": {
          dispatch({
            type: "appearance",
            theme: (payload.theme as OverlayState["theme"]) || "system",
          });
          // Language rides on the same event (set on save); switching here
          // re-renders the translated state placeholders immediately.
          const language = payload.language;
          if (typeof language === "string" && language) {
            void i18next.changeLanguage(language);
          }
          break;
        }
      }
    });
  }, []);
  return { state, waveActive };
}

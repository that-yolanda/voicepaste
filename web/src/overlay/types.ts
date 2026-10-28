export type AppState = "idle" | "connecting" | "recording" | "finishing";
export type HintLevel = "info" | "error" | "warn";
export interface Shortcut {
  key: string;
  label: string;
  /** Optional i18n key suffix ("retry"/"cancel"/"done"/"raw"); when present
   * the renderer localizes the action name instead of using `label`. */
  label_key?: string;
}
export interface OverlayState {
  finalText: string;
  partialText: string;
  hintText: string;
  hintLevel: HintLevel;
  hintVariant: string;
  /** Structured error carried by the hint event; rendered locally so it
   * follows the UI language. Absent for plain hints. */
  hintCode?: string;
  hintParams?: Record<string, string>;
  hintDetail?: string | null;
  /** Optional i18n key appended (localized) to a structured hint, e.g. the
   * "raw text in 5 s" countdown under a polish decision. */
  hintSuffixKey?: string;
  appState: AppState;
  shortcuts: Shortcut[];
  theme: "system" | "light" | "dark";
}
export const INITIAL_OVERLAY_STATE: OverlayState = {
  finalText: "",
  partialText: "",
  hintText: "",
  hintLevel: "info",
  hintVariant: "text",
  appState: "idle",
  shortcuts: [],
  theme: "system",
};

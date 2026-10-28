import { X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { HotkeyRecordResult } from "@/settings/bridge";
import { recordHotkey } from "@/settings/bridge";
import { normalizeHotkeyToken } from "@/settings/lib/hotkey";

interface HotkeyInputProps {
  /** `+`-joined physical key names, e.g. "ControlLeft+ShiftLeft" or "F13". Empty = unbound. */
  value: string;
  isMac: boolean;
  /** Fired with the recorded accelerator + its display string once capture completes. */
  onCommit?: (hotkey: string, displayString: string) => void;
  /** Whether this field records the global main key: the first-pressed-key
   *  rule applies (function row / Tab / modifier first) and a rejection
   *  flashes, reverts, and reports via `onInvalid`. Prompt stop keys pass
   *  `false` — they only act mid-recording and are never restricted. */
  validateFirstKey?: boolean;
  /** Fired when the recording is rejected (only main-key callers pass this):
   *  the first key pressed was a typing key. The recorded combination flashes
   *  in the field and then reverts to `value`; the parent toasts the reason. */
  onInvalid?: (reason: string) => void;
  /** Fired when the clear (×) button is clicked. */
  onClear?: () => void;
  /** Permanently disabled display-only field (e.g. the global main key shown as the
   *  hands-free "start" reference). Greyed out, cannot record, no × button. */
  locked?: boolean;
  /** Another field is currently recording — temporarily disable this recorder. */
  busy?: boolean;
  /** Notify parent: recording started (so it can set `busy` on siblings). */
  onStart?: () => void;
  /** Notify parent: recording ended (committed or cancelled). */
  onDone?: () => void;
}

/** How long a rejected recording flashes before reverting to the bound value. */
const INVALID_PREVIEW_MS = 1500;

/** A hotkey field that doubles as a recorder: clicking it triggers the backend
 *  keytap capture, the result is shown inline, and a × button clears it. The
 *  field is a native `<button>` (so it is keyboard-focusable and a11y-correct);
 *  the × is a sibling button, never nested. */
export function HotkeyInput({
  value,
  isMac,
  onCommit,
  validateFirstKey = false,
  onInvalid,
  onClear,
  locked = false,
  busy = false,
  onStart,
  onDone,
}: HotkeyInputProps) {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);
  const [invalidPreview, setInvalidPreview] = useState<string | null>(null);

  // Revert the rejected-recording preview on a timer; cleared early if a new
  // recording starts or the component goes away.
  useEffect(() => {
    if (!invalidPreview) return;
    const timer = window.setTimeout(() => setInvalidPreview(null), INVALID_PREVIEW_MS);
    return () => window.clearTimeout(timer);
  }, [invalidPreview]);

  const handleClick = useCallback(async () => {
    if (busy || recording) {
      return;
    }
    onStart?.();
    setRecording(true);
    setInvalidPreview(null);
    // Backend captures the combination via keytap (including keys the WebView
    // never sees, e.g. macOS Fn/Globe). Empty keys = cancelled (Esc) or timeout.
    try {
      const result: HotkeyRecordResult = await recordHotkey(validateFirstKey ? "main" : "prompt");
      if (result.invalidReason) {
        // Rejected as a main hotkey: show what was recorded, then revert to
        // the bound value and let the parent explain why via toast.
        setInvalidPreview(result.displayString);
        onInvalid?.(result.invalidReason);
        return;
      }
      if (result.keys.length > 0 && result.hotkey) {
        onCommit?.(result.hotkey, result.displayString);
      }
    } finally {
      setRecording(false);
      onDone?.();
    }
  }, [busy, recording, onStart, onDone, onCommit, onInvalid, validateFirstKey]);

  const canClear = !locked && !recording && value.length > 0 && onClear !== undefined;

  const containerClass = locked
    ? "bg-fill-interactive/30 border-border text-text-muted"
    : recording
      ? "bg-input-bg border-accent ring-1 ring-accent-dim text-text"
      : "bg-input-bg border-border text-text focus-within:ring-1 focus-within:ring-accent-dim";

  return (
    <div
      className={`relative group flex items-center h-8.5 min-w-20 px-2 rounded-lg border text-xs whitespace-nowrap transition-colors ${containerClass}`}
    >
      <button
        type="button"
        aria-label={t("ui.hotkey.aria_label")}
        disabled={locked || busy || recording}
        onClick={handleClick}
        className={`flex flex-1 items-center gap-0.5 min-h-0 overflow-hidden bg-transparent text-left focus:outline-none ${locked || busy || recording ? "cursor-not-allowed" : "cursor-pointer"}`}
      >
        {recording ? (
          <span className="text-text-muted">{t("ui.hotkey.press_hint")}</span>
        ) : invalidPreview ? (
          renderHotkeyTokens(invalidPreview, isMac)
        ) : value ? (
          renderHotkeyTokens(value, isMac)
        ) : (
          <span className="text-text-muted">
            {locked ? t("ui.hotkey.unconfigured") : t("ui.hotkey.press_hotkey")}
          </span>
        )}
      </button>
      {canClear ? (
        <button
          type="button"
          aria-label={t("ui.hotkey.aria_clear")}
          onClick={onClear}
          className="absolute right-0.5 top-0.5 ml-0.5 shrink-0 p-0.5 text-text-muted hover:text-text opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity"
        >
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}

/** Render a `+`-joined accelerator as per-platform key tokens, mirroring `KeyCap`
 *  but inline (main label + optional L/R superscript) so it fits an input box. */
function renderHotkeyTokens(value: string, isMac: boolean): ReactNode {
  const tokens = value.split("+");
  return tokens.map((raw, i) => {
    const token = normalizeHotkeyToken(raw, isMac);
    return (
      // Keys within one hotkey are distinct physical keys, so the token text
      // itself is a stable key (no index needed).
      <span key={raw.trim()} className="inline-flex items-baseline">
        {i > 0 ? <span className="mx-0.5">+</span> : null}
        <span>{token.main}</span>
        {token.side ? <sup className="ml-0.5 text-[9px]">{token.side}</sup> : null}
      </span>
    );
  });
}

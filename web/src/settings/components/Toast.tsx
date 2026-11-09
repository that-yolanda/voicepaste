import { useCallback, useEffect, useRef, useState } from "react";

/** How long a toast stays on screen before it dismisses itself. */
const TOAST_DURATION_MS = 5000;

export interface ToastState {
  /** Bumped on every show so a repeat of the same message replays the animation. */
  id: number;
  message: string;
  tone: "success" | "error";
}

/**
 * Transient confirmation for actions whose effect is otherwise invisible —
 * copying to the clipboard, deleting a row, finishing a re-polish. Filled with
 * the app accent (error tone aside) so it reads at a glance against the card
 * surfaces behind it. A new toast replaces the one on screen rather than
 * queueing, so rapid clicks always show the latest outcome.
 */
export function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<number | null>(null);

  const showToast = useCallback((message: string, tone: ToastState["tone"] = "success") => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setToast({ id: Date.now(), message, tone });
    timer.current = window.setTimeout(() => setToast(null), TOAST_DURATION_MS);
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return { toast, showToast };
}

export function Toast({ toast }: { toast: ToastState | null }) {
  if (!toast) return null;
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 w-max max-w-[min(480px,calc(100vw-32px))] -translate-x-1/2">
      <div
        key={toast.id}
        className={`animate-toast-in whitespace-pre-wrap rounded-lg px-3 py-2 text-left text-xs leading-relaxed font-medium text-text-on-accent [overflow-wrap:anywhere] ${
          toast.tone === "error"
            ? "bg-error shadow-[0_4px_16px_var(--color-glow-error)]"
            : "bg-accent shadow-[0_4px_16px_var(--color-accent-glow)]"
        }`}
      >
        {toast.message}
      </div>
    </div>
  );
}

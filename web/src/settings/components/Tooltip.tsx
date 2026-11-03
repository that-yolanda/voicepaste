import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function Tooltip({
  content,
  label,
  children,
  className = "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-text-muted hover:text-text hover:bg-fill-hover",
}: {
  content: ReactNode;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const cancelClose = () => clearTimeout(closeTimer.current);
  const show = () => {
    cancelClose();
    setOpen(true);
  };
  const hide = () => {
    cancelClose();
    setOpen(false);
    setPosition(null);
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (document.activeElement !== triggerRef.current) hide();
    }, 150);
  };

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !tooltipRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const tooltip = tooltipRef.current.getBoundingClientRect();
    const margin = 8;
    const below = trigger.bottom + margin;
    const top =
      below + tooltip.height <= window.innerHeight - margin
        ? below
        : trigger.top - tooltip.height - margin;
    setPosition({
      left: Math.max(margin, Math.min(trigger.left, window.innerWidth - tooltip.width - margin)),
      top: Math.max(margin, top),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = () => {
      clearTimeout(closeTimer.current);
      setOpen(false);
      setPosition(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        className={`${className} focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-dim`}
        onMouseEnter={show}
        onMouseLeave={scheduleClose}
        onFocus={show}
        onBlur={hide}
      >
        {children}
      </button>
      {open &&
        createPortal(
          <div
            ref={tooltipRef}
            id={id}
            role="tooltip"
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            className="fixed z-50 w-max max-w-[min(320px,calc(100vw-16px))] max-h-[calc(100vh-32px)] overflow-y-auto whitespace-pre-line break-words rounded-lg border border-border bg-surface-card px-3 py-2 text-xs leading-relaxed text-text shadow-lg"
            style={{
              left: position?.left ?? 0,
              top: position?.top ?? 0,
              visibility: position ? "visible" : "hidden",
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}

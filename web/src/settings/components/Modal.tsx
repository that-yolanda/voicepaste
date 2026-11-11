import { type ReactNode, useEffect } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  closeLabel?: string;
  children: ReactNode;
  footer?: ReactNode;
  headerAction?: ReactNode;
}

export function Modal({
  open,
  onClose,
  title,
  closeLabel = "Close modal",
  children,
  footer,
  headerAction,
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div data-settings-dialog className="fixed inset-0 z-50 flex items-center justify-center h-svh">
      <button
        type="button"
        className="absolute inset-0 settings-modal-scrim bg-black/50 backdrop-blur-sm border-0 cursor-pointer w-full"
        onClick={onClose}
        aria-label={closeLabel}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="settings-modal-panel relative bg-surface-solid border border-border rounded-xl shadow-lg max-w-lg w-full mx-4"
      >
        {title && (
          <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
            <h2 className="text-base font-semibold text-text">{title}</h2>
            {headerAction}
          </div>
        )}
        <div className="p-4 text-sm text-text-dim max-h-[70vh] overflow-auto">{children}</div>
        {footer && (
          <div className="flex items-center gap-2 border-t border-border-subtle px-4 py-2.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

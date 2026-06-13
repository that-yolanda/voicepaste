import { X } from "lucide-react";
import { type ReactNode, useEffect } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}

export function Modal({ open, onClose, title, children }: ModalProps) {
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
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        type="button"
        className="absolute inset-0 bg-black/50 backdrop-blur-sm border-0 cursor-pointer w-full"
        onClick={onClose}
        aria-label="Close modal"
      />
      <div className="relative bg-surface-card border border-border rounded-xl shadow-lg max-w-lg w-full mx-4 max-h-[80vh] overflow-auto">
        {title && (
          <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
            <h2 className="text-lg font-semibold text-text">{title}</h2>
            <button type="button" className="text-text-muted hover:text-text p-1" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        )}
        <div className="p-5 text-sm text-text-dim">{children}</div>
      </div>
    </div>
  );
}

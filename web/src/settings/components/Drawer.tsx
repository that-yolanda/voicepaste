import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  ariaLabel?: string;
  /** Fixed footer actions (e.g. 移除/恢复默认/完成). */
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * Right-side sheet over the settings main area: scrim + Esc close + focus
 * trap. Used for per-model configuration (ModelConfigDrawer).
 */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  ariaLabel,
  footer,
  children,
}: DrawerProps) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && panelRef.current) {
        // Minimal focus trap: keep Tab cycling inside the panel.
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    // Focus the panel so keyboard users land inside the sheet.
    panelRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-40 flex justify-end" data-settings-dialog>
      <button
        type="button"
        aria-label={t("ui.common.close")}
        className="absolute inset-0 h-full w-full cursor-pointer border-0 bg-black/45"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? title}
        tabIndex={-1}
        className="relative flex h-full w-[420px] max-w-[90%] flex-col border-l border-border bg-surface-card shadow-[-18px_0_50px_rgba(0,0,0,0.35)] outline-none"
      >
        <header className="flex items-start gap-3 border-b border-border-subtle px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-text">{title}</h2>
            {subtitle && <p className="mt-1 text-xs text-text-muted">{subtitle}</p>}
          </div>
          <button
            type="button"
            aria-label={t("ui.common.close")}
            className="rounded-lg p-1.5 text-text-muted hover:bg-fill-hover hover:text-text"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="settings-drawer-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {children}
        </div>
        {footer && (
          <footer className="flex min-h-13 items-center gap-2 border-t border-border-subtle bg-surface-main px-5 py-2.5">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

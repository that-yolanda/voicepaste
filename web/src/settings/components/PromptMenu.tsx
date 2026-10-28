import { Check } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { PromptItem } from "@/settings/types/prompts";

interface PromptMenuProps {
  /** Element the menu hangs off; its viewport rect positions the menu. */
  anchor: HTMLElement;
  prompts: PromptItem[];
  /** Template the entry was last polished with, marked in the list. */
  currentId?: string;
  onSelect: (prompt: PromptItem) => void;
  onClose: () => void;
}

const GAP = 4;

/**
 * Popover listing prompt templates to polish with. Portaled to `document.body`:
 * the history row's action bar is transformed and faded, which would otherwise
 * become the containing block for `position: fixed` (misplacing the menu) and
 * leak its opacity into it. Fixed-positioned against the anchor so the list's
 * overflow never clips it; flips above the anchor when there is no room below.
 * Closes on outside click, Escape, or scroll — scrolling would detach it from
 * its row.
 */
export function PromptMenu({ anchor, prompts, currentId, onSelect, onClose }: PromptMenuProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const height = ref.current?.offsetHeight ?? 0;
    const below = rect.bottom + GAP;
    const top =
      below + height > window.innerHeight ? Math.max(GAP, rect.top - GAP - height) : below;
    setPos({ top, right: window.innerWidth - rect.right });
  }, [anchor]);

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-40 max-w-64 max-h-72 overflow-y-auto py-1 bg-accent text-text-on-accent rounded-lg shadow-lg"
      style={pos ? { top: pos.top, right: pos.right } : { visibility: "hidden" }}
    >
      <div className="px-3 py-1.5 text-xs opacity-75">{t("ui.prompt.select")}</div>
      {prompts.length === 0 ? (
        <div className="px-3 py-2 text-xs opacity-75">{t("ui.prompt.empty")}</div>
      ) : (
        prompts.map((prompt) => (
          <button
            key={prompt.id}
            type="button"
            role="menuitem"
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm text-text-on-accent bg-transparent border-0 cursor-pointer hover:bg-accent-hover"
            onClick={() => onSelect(prompt)}
          >
            <span className="flex-1 truncate">{prompt.title || prompt.id}</span>
            {prompt.id === currentId && <Check size={14} className="shrink-0" />}
          </button>
        ))
      )}
    </div>,
    document.body,
  );
}

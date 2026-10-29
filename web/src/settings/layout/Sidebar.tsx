import {
  AudioLines,
  BookOpen,
  Bot,
  Home,
  Info,
  Keyboard,
  ListChecks,
  MessageSquare,
  NotebookText,
  Settings2,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { openHelpGuide } from "@/settings/bridge";
import { Toast, useToast } from "@/settings/components/Toast";
import { UpdateButton } from "@/settings/components/UpdateButton";
import { useSettings } from "@/settings/SettingsProvider";

export type SectionId =
  | "home"
  | "app"
  | "hotkey"
  | "service"
  | "llm"
  | "templates"
  | "hotwords"
  | "feedback"
  | "about";

const MODEL_ITEMS = [
  { id: "service", icon: AudioLines, label: "ui.nav.audio" },
  { id: "llm", icon: Bot, label: "ui.nav.llm" },
] as const;
const USAGE_ITEMS = [
  { id: "hotkey", icon: Keyboard, label: "ui.nav.hotkey" },
  { id: "hotwords", icon: NotebookText, label: "ui.nav.hotwords" },
  { id: "templates", icon: Sparkles, label: "ui.nav.templates" },
] as const;

interface SidebarProps {
  active: SectionId;
  onNavigate: (id: SectionId) => void;
  onStartOnboarding?: () => void;
}

export function Sidebar({ active, onNavigate, onStartOnboarding }: SidebarProps) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const version = settings?.runtime?.version as string | undefined;
  const { toast, showToast } = useToast();
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menu.current?.open) {
        menu.current.open = false;
        menu.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", onEscape);
    };
  }, []);
  const closeMenu = () => {
    if (menu.current) menu.current.open = false;
  };
  const utilityClass =
    "w-full flex items-center gap-2.5 px-3 py-[7px] rounded-lg text-sm text-text-dim hover:bg-fill-hover hover:text-text";

  const navBtn = (id: SectionId, Icon: typeof Home, label: string) => (
    <button
      key={id}
      type="button"
      aria-current={active === id ? "page" : undefined}
      onClick={() => {
        closeMenu();
        onNavigate(id);
      }}
      className={`w-full flex items-center gap-2.5 px-3 py-[7px] rounded-lg text-sm transition-colors ${
        active === id
          ? "bg-fill-hover text-text font-medium"
          : "text-text-dim hover:bg-fill-hover hover:text-text"
      }`}
    >
      <Icon size={18} />
      {t(label)}
    </button>
  );

  return (
    <aside className="w-50 shrink-0 flex flex-col">
      <nav aria-label={t("ui.nav.navigation")} className="flex-1 overflow-y-auto py-3 px-2">
        {navBtn("home", Home, "ui.nav.home")}
        {[
          { title: "ui.nav.models", items: MODEL_ITEMS },
          { title: "ui.nav.usage", items: USAGE_ITEMS },
        ].map((group) => (
          <div key={group.title} className="mt-5 space-y-1">
            <div className="px-3 mb-2 text-xs font-normal text-text-muted">{t(group.title)}</div>
            {group.items.map((item) => navBtn(item.id, item.icon, item.label))}
          </div>
        ))}
      </nav>
      <div className="p-2 border-t border-border-subtle space-y-1">
        <details ref={menu} className="relative">
          <summary
            className={`${utilityClass} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}
          >
            <Settings2 size={18} />
            {t("ui.nav.app")}
          </summary>
          <div className="absolute bottom-full left-0 mb-2 w-52 p-1 bg-[var(--boot-card)] border border-border rounded-lg shadow-lg z-50">
            {navBtn("app", Settings2, "ui.nav.general")}
            <button
              type="button"
              className={utilityClass}
              onClick={() => {
                closeMenu();
                onStartOnboarding?.();
              }}
            >
              <ListChecks size={18} />
              {t("ui.onboarding.title")}
            </button>
            <button
              type="button"
              className={utilityClass}
              onClick={() => {
                closeMenu();
                openHelpGuide().catch(() => showToast(t("ui.nav.help_error"), "error"));
              }}
            >
              <BookOpen size={18} />
              {t("ui.nav.help")}
            </button>
            {navBtn("feedback", MessageSquare, "ui.nav.feedback")}
            {navBtn("about", Info, "ui.nav.about")}
          </div>
        </details>
        <div className="flex h-8 items-center justify-between gap-2 px-3 py-1 text-xs text-text-muted">
          <span className="shrink-0 tabular-nums" title={t("ui.about.current_version")}>
            {version ? `v${version}` : "—"}
          </span>
          <UpdateButton compact />
        </div>
      </div>
      <Toast toast={toast} />
    </aside>
  );
}

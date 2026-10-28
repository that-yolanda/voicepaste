import {
  AudioLines,
  BookOpen,
  Bot,
  Home,
  Info,
  Keyboard,
  MessageSquare,
  NotebookText,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { openHelpGuide } from "@/settings/bridge";
import { ThemeSelector } from "@/settings/components/ThemeSelector";
import { Toast, useToast } from "@/settings/components/Toast";
import { UpdateButton } from "@/settings/components/UpdateButton";

export type SectionId =
  | "home"
  | "app"
  | "permissions"
  | "hotkey"
  | "service"
  | "llm"
  | "hotwords"
  | "feedback"
  | "about";

const NAV_ITEMS: { id: SectionId; icon: typeof Home; label: string }[] = [
  { id: "home", icon: Home, label: "ui.nav.home" },
  { id: "app", icon: Settings2, label: "ui.nav.app" },
  { id: "permissions", icon: ShieldCheck, label: "ui.nav.permissions" },
  { id: "hotkey", icon: Keyboard, label: "ui.nav.hotkey" },
  { id: "service", icon: AudioLines, label: "ui.nav.audio" },
  { id: "llm", icon: Bot, label: "ui.nav.llm" },
  { id: "hotwords", icon: NotebookText, label: "ui.nav.hotwords" },
];

interface SidebarProps {
  active: SectionId;
  onNavigate: (id: SectionId) => void;
}

export function Sidebar({ active, onNavigate }: SidebarProps) {
  const { t } = useTranslation();
  const { toast, showToast } = useToast();

  const navBtn = (id: SectionId, Icon: typeof Home, label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => onNavigate(id)}
      className={`w-full flex items-center gap-2.5 px-3 py-[7px] rounded-lg text-sm transition-colors ${
        active === id
          ? "bg-accent-soft text-accent font-medium"
          : "text-text-dim hover:bg-fill-hover hover:text-text"
      }`}
    >
      <Icon size={18} />
      {t(label)}
    </button>
  );

  return (
    <aside className="w-50 shrink-0 flex flex-col">
      {/* Header: icon + title + update button */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border-subtle">
        <img src="./icon.png" alt="VoicePaste" className="w-7 h-7 rounded-md shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text tracking-[-0.01em]">
          VoicePaste
        </span>
        <UpdateButton compact />
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-3 px-2 space-y-1">
        {NAV_ITEMS.map((item) => navBtn(item.id, item.icon, item.label))}
        <div className="my-2 border-t border-border-subtle" />
        {navBtn("feedback", MessageSquare, "ui.nav.feedback")}
        <button
          type="button"
          onClick={() => {
            openHelpGuide().catch(() => showToast(t("ui.nav.help_error"), "error"));
          }}
          className="w-full flex items-center gap-2.5 px-3 py-[7px] rounded-lg text-sm transition-colors text-text-dim hover:bg-fill-hover hover:text-text"
        >
          <BookOpen size={18} />
          {t("ui.nav.help")}
        </button>
        {navBtn("about", Info, "ui.nav.about")}
      </nav>

      <div className="p-3 border-t border-border-subtle">
        <ThemeSelector />
      </div>
      <Toast toast={toast} />
    </aside>
  );
}

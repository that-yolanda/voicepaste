import {
  AudioLines,
  BookOpen,
  Bot,
  Home,
  Info,
  Keyboard,
  NotebookText,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { ThemeSelector } from "@/settings/components/ThemeSelector";
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
  { id: "home", icon: Home, label: "首页" },
  { id: "app", icon: Settings2, label: "应用设置" },
  { id: "permissions", icon: ShieldCheck, label: "系统权限" },
  { id: "hotkey", icon: Keyboard, label: "快捷键" },
  { id: "service", icon: AudioLines, label: "音频模型" },
  { id: "llm", icon: Bot, label: "大语言模型" },
  { id: "hotwords", icon: NotebookText, label: "热词库" },
];

const BOTTOM_ITEMS: { id: SectionId; icon: typeof Home; label: string }[] = [
  { id: "feedback", icon: BookOpen, label: "帮助说明" },
  { id: "about", icon: Info, label: "关于" },
];

interface SidebarProps {
  active: SectionId;
  onNavigate: (id: SectionId) => void;
}

export function Sidebar({ active, onNavigate }: SidebarProps) {
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
      {label}
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
        {BOTTOM_ITEMS.map((item) => navBtn(item.id, item.icon, item.label))}
      </nav>

      <div className="p-3 border-t border-border-subtle">
        <ThemeSelector />
      </div>
    </aside>
  );
}

import {
  BookOpen,
  Home,
  Info,
  Key,
  Keyboard,
  ListChecks,
  MessageSquare,
  NotebookText,
  Settings2,
  Sparkles,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openHelpGuide } from "@/settings/bridge";
import { Collapse } from "@/settings/components/Collapse";
import { Toast, useToast } from "@/settings/components/Toast";
import { UpdateButton } from "@/settings/components/UpdateButton";
import { useSettings } from "@/settings/SettingsProvider";

export type SectionId =
  | "home"
  | "app"
  | "hotkey"
  | "models"
  | "templates"
  | "hotwords"
  | "feedback"
  | "about";

const MODEL_ITEMS = [{ id: "models", icon: Key, label: "ui.nav.models_service" }] as const;
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
  const sidebar = useRef<HTMLElement>(null);
  const nav = useRef<HTMLElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [indicator, setIndicator] = useState({ top: 0, height: 0, visible: false });
  useLayoutEffect(() => {
    const element = sidebar.current;
    if (!element) return;
    const settingsSection = active === "app" || active === "feedback" || active === "about";
    const hideIndicator = () => {
      setIndicator((current) => (current.visible ? { ...current, visible: false } : current));
    };
    const update = () => {
      if (settingsSection && !menuOpen) {
        hideIndicator();
        return;
      }
      const selected = element.querySelector<HTMLElement>(`[data-nav-id="${active}"]`);
      if (!selected) {
        hideIndicator();
        return;
      }
      const sidebarBounds = element.getBoundingClientRect();
      const selectedBounds = selected.getBoundingClientRect();
      let top = selectedBounds.top - sidebarBounds.top;
      let height = selectedBounds.height;
      if (!settingsSection && nav.current) {
        const navBounds = nav.current.getBoundingClientRect();
        const visibleTop = Math.max(selectedBounds.top, navBounds.top);
        const visibleBottom = Math.min(selectedBounds.bottom, navBounds.bottom);
        if (visibleBottom <= visibleTop) {
          hideIndicator();
          return;
        }
        top = visibleTop - sidebarBounds.top;
        height = visibleBottom - visibleTop;
      }
      setIndicator((current) =>
        current.visible && current.top === top && current.height === height
          ? current
          : { top, height, visible: true },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (nav.current) observer.observe(nav.current);
    if (menu.current) observer.observe(menu.current);
    const selected = element.querySelector<HTMLElement>(`[data-nav-id="${active}"]`);
    if (selected) observer.observe(selected);
    nav.current?.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      nav.current?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [active, menuOpen]);
  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menuOpen) {
        setMenuOpen(false);
        menuTrigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", onEscape);
    };
  }, [menuOpen]);
  const closeMenu = () => {
    setMenuOpen(false);
  };
  const utilityClass =
    "w-full flex items-center gap-2.5 px-3 py-[7px] rounded-lg text-sm text-text-dim hover:text-text";

  const navBtn = (id: SectionId, Icon: typeof Home, label: string, closeOnNavigate = true) => (
    <button
      key={id}
      type="button"
      data-nav-id={id}
      aria-current={active === id ? "page" : undefined}
      onClick={() => {
        if (closeOnNavigate) closeMenu();
        onNavigate(id);
      }}
      className={`relative w-full flex items-center gap-2.5 px-3 py-[7px] rounded-lg text-sm transition-colors ${
        active === id ? "text-text font-medium" : "text-text-dim hover:text-text"
      }`}
    >
      <Icon size={18} />
      {t(label)}
    </button>
  );

  return (
    <aside ref={sidebar} className="relative w-50 shrink-0 flex flex-col">
      <div
        aria-hidden="true"
        className="settings-sidebar-indicator"
        style={{
          top: 0,
          transform: `translateY(${indicator.top}px)`,
          height: indicator.height,
          opacity: indicator.visible ? 1 : 0,
        }}
      />
      <nav
        ref={nav}
        aria-label={t("ui.nav.navigation")}
        className="relative flex-1 overflow-y-auto py-3 px-2"
      >
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
        <div ref={menu}>
          <Collapse open={menuOpen} id="settings-menu">
            <div className="mb-1 w-full">
              {navBtn("app", Settings2, "ui.nav.general", false)}
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
              {navBtn("feedback", MessageSquare, "ui.nav.feedback", false)}
              {navBtn("about", Info, "ui.nav.about", false)}
            </div>
          </Collapse>
          <button
            ref={menuTrigger}
            type="button"
            aria-expanded={menuOpen}
            aria-controls="settings-menu"
            onClick={() => setMenuOpen((open) => !open)}
            className={`${utilityClass} cursor-pointer`}
          >
            <Settings2 size={18} />
            {t("ui.nav.app")}
          </button>
        </div>
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

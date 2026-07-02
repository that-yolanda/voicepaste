import { useEffect, useState } from "react";
import { type SectionId, Sidebar } from "@/settings/layout/Sidebar";
import { AboutPage } from "@/settings/pages/AboutPage";
import { AppSettingsPage } from "@/settings/pages/AppSettingsPage";
import { AudioModelPage } from "@/settings/pages/AudioModelPage";
import { FeedbackPage } from "@/settings/pages/FeedbackPage";
import { HomePage } from "@/settings/pages/HomePage";
import { HotkeyPage } from "@/settings/pages/HotkeyPage";
import { HotwordsPage } from "@/settings/pages/HotwordsPage";
import { LLMPage } from "@/settings/pages/LLMPage";
import { PermissionsPage } from "@/settings/pages/PermissionsPage";
import { SettingsProvider } from "@/settings/SettingsProvider";

export function SettingsApp() {
  const [section, setSection] = useState<SectionId>("home");

  // Prevent Alt and F10 from activating the WebView2 menu bar, which
  // would pause JavaScript execution and block IPC promise resolution
  // (e.g. `await recordHotkey()` never resolves after an Alt-only press).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Alt" || e.key === "F10") {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return (
    <SettingsProvider>
      <div className="flex h-screen overflow-hidden font-ui text-text text-sm leading-relaxed antialiased">
        <Sidebar active={section} onNavigate={setSection} />
        <main className="flex-1 overflow-y-auto relative rounded-tl-xl border-l border-border bg-surface-main ">
          <div className="max-w-[640px] mx-auto py-7 px-9">
            {section === "home" && <HomePage />}
            {section === "app" && <AppSettingsPage />}
            {section === "permissions" && <PermissionsPage />}
            {section === "hotkey" && <HotkeyPage />}
            {section === "service" && <AudioModelPage />}
            {section === "llm" && <LLMPage />}
            {section === "hotwords" && <HotwordsPage />}
            {section === "feedback" && <FeedbackPage />}
            {section === "about" && <AboutPage />}
          </div>
        </main>
      </div>
    </SettingsProvider>
  );
}

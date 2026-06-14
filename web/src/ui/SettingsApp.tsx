import { useCallback, useEffect, useState } from "react";
import { checkForUpdates } from "@/bridge/settings";
import { type SectionId, Sidebar } from "@/ui/layout/Sidebar";
import { AboutPage } from "@/ui/pages/AboutPage";
import { AppSettingsPage } from "@/ui/pages/AppSettingsPage";
import { AudioModelPage } from "@/ui/pages/AudioModelPage";
import { FeedbackPage } from "@/ui/pages/FeedbackPage";
import { HomePage } from "@/ui/pages/HomePage";
import { HotkeyPage } from "@/ui/pages/HotkeyPage";
import { HotwordsPage } from "@/ui/pages/HotwordsPage";
import { LLMPage } from "@/ui/pages/LLMPage";
import { PermissionsPage } from "@/ui/pages/PermissionsPage";
import { SettingsProvider } from "@/ui/SettingsProvider";

export function SettingsApp() {
  const [section, setSection] = useState<SectionId>("home");
  const [updateAvailable, setUpdateAvailable] = useState(false);

  // Check for updates on mount (for sidebar badge)
  useEffect(() => {
    checkForUpdates()
      .then((result) => {
        if (result.available) setUpdateAvailable(true);
      })
      .catch(() => {});
  }, []);

  const handleCheckUpdate = useCallback(() => {
    setSection("about");
  }, []);

  return (
    <SettingsProvider>
      <div className="flex h-screen overflow-hidden font-ui text-text text-sm leading-relaxed antialiased">
        <Sidebar
          active={section}
          onNavigate={setSection}
          updateAvailable={updateAvailable}
          onCheckUpdate={handleCheckUpdate}
        />
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

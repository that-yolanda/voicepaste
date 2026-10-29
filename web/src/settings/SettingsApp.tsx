import { useEffect, useState } from "react";
import { Toast } from "@/settings/components/Toast";
import { useFeedback } from "@/settings/hooks/useFeedback";
import { type SectionId, Sidebar } from "@/settings/layout/Sidebar";
import { useOnboarding } from "@/settings/onboarding/useOnboarding";
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
  return (
    <SettingsProvider>
      <SettingsShell />
    </SettingsProvider>
  );
}

function SettingsShell() {
  const [section, setSection] = useState<SectionId>("home");
  const feedback = useFeedback(section === "feedback");
  const onboarding = useOnboarding(setSection);

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
    <>
      <div className="flex h-screen overflow-hidden font-ui text-text text-sm leading-relaxed antialiased">
        <Sidebar
          active={section}
          onNavigate={(next) => {
            onboarding.cancelTour();
            setSection(next);
          }}
          onStartOnboarding={() => void onboarding.start()}
        />
        <div className="relative min-w-0 flex-1">
          <main className="h-full overflow-y-auto relative rounded-tl-xl border-l border-border bg-surface-main ">
            <div className="max-w-[640px] mx-auto py-7 px-9">
              {section === "home" && <HomePage />}
              {section === "app" && <AppSettingsPage />}
              {section === "permissions" && <PermissionsPage />}
              {section === "hotkey" && <HotkeyPage />}
              {section === "service" && <AudioModelPage />}
              {section === "llm" && <LLMPage />}
              {section === "hotwords" && <HotwordsPage />}
              {section === "about" && <AboutPage />}
              {section === "feedback" && <FeedbackPage feedback={feedback} />}
            </div>
          </main>
          {onboarding.guide}
        </div>
        <div role="status" aria-live="polite">
          <Toast toast={feedback.toast} />
        </div>
      </div>
      {onboarding.overlay}
    </>
  );
}

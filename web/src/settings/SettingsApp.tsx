import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/settings/components/Button";
import { HomeSkeleton } from "@/settings/components/Skeleton";
import { Toast } from "@/settings/components/Toast";
import { useFeedback } from "@/settings/hooks/useFeedback";
import { type SectionId, Sidebar } from "@/settings/layout/Sidebar";
import { applyTheme, initialTheme, isThemePref } from "@/settings/lib/theme";
import { useOnboarding } from "@/settings/onboarding/useOnboarding";
import { AboutPage } from "@/settings/pages/AboutPage";
import { AppSettingsPage } from "@/settings/pages/AppSettingsPage";
import { AudioModelPage } from "@/settings/pages/AudioModelPage";
import { FeedbackPage } from "@/settings/pages/FeedbackPage";
import { HomePage } from "@/settings/pages/HomePage";
import { HotkeyPage } from "@/settings/pages/HotkeyPage";
import { HotwordsPage } from "@/settings/pages/HotwordsPage";
import { LLMPage } from "@/settings/pages/LLMPage";
import { TemplatesPage } from "@/settings/pages/TemplatesPage";
import { SettingsProvider, useSettings } from "@/settings/SettingsProvider";

export function SettingsApp() {
  return (
    <SettingsProvider>
      <SettingsShell />
    </SettingsProvider>
  );
}

function SettingsShell() {
  const { t } = useTranslation();
  const { config, loading, error, refresh } = useSettings();
  const theme = config?.app?.theme;
  useEffect(() => {
    const preference = isThemePref(theme) ? theme : initialTheme();
    applyTheme(preference);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      if (preference === "system") applyTheme("system");
    };
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [theme]);
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
          <main className="settings-page-scroll h-full relative rounded-tl-xl border-l border-border bg-surface-main ">
            <div className="max-w-[640px] mx-auto py-7 px-9">
              {loading ? (
                <HomeSkeleton />
              ) : error && !config ? (
                <div role="alert" className="space-y-4">
                  <p>{t("ui.load_failed")}</p>
                  <Button onClick={() => void refresh()}>{t("ui.retry")}</Button>
                </div>
              ) : (
                <>
                  {section === "home" && <HomePage onOpenSettings={() => setSection("app")} />}
                  {section === "app" && <AppSettingsPage />}
                  {section === "templates" && <TemplatesPage />}
                  {section === "hotkey" && <HotkeyPage />}
                  {section === "service" && <AudioModelPage />}
                  {section === "llm" && <LLMPage />}
                  {section === "hotwords" && <HotwordsPage />}
                  {section === "about" && <AboutPage />}
                  {section === "feedback" && <FeedbackPage feedback={feedback} />}
                </>
              )}
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

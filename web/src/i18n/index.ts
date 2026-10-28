import { invoke } from "@tauri-apps/api/core";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "@/locales/en.json";
import zhCN from "@/locales/zh-CN.json";

export const LANGUAGE_STORAGE_KEY = "voicepaste.language";
export type AppLanguage = "zh-CN" | "en";

let initPromise: Promise<string> | null = null;

function applyLanguage(language: AppLanguage) {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  document.documentElement.lang = language;
}

/**
 * Initialize i18next for this window. The cached language makes the first
 * paint instant; the backend value (resolved from `app.language`, so `auto`
 * already reflects the OS locale) then corrects it if the preference changed
 * since the last run. Callers await this before rendering so no wrong-language
 * frame is ever shown.
 */
export function initI18n(): Promise<string> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const cached = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    await i18next.use(initReactI18next).init({
      lng: cached === "en" ? "en" : "zh-CN",
      fallbackLng: "en",
      resources: {
        "zh-CN": { translation: zhCN },
        en: { translation: en },
      },
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    });
    try {
      const backend = (await invoke("get_app_language")) as AppLanguage;
      await i18next.changeLanguage(backend);
      applyLanguage(backend);
    } catch {
      // Not running under Tauri (vitest, plain dev) or the command failed:
      // keep the cached language.
    }
    return i18next.language ?? "zh-CN";
  })();
  return initPromise;
}

/**
 * Re-read the language from the backend and switch this window to it. Used by
 * the settings UI right after saving a new preference — the saving window
 * knows the new value, so no broadcast subscription is needed.
 */
export async function syncLanguageFromBackend(): Promise<void> {
  try {
    const backend = (await invoke("get_app_language")) as AppLanguage;
    await i18next.changeLanguage(backend);
    applyLanguage(backend);
  } catch {
    // Ignore: keep the current language.
  }
}

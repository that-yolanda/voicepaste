import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { beforeEach, vi } from "vitest";
import zhCN from "../src/locales/zh-CN.json";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

// The suite asserts against rendered Chinese strings (~250 locators), so the
// i18n instance is initialized statically with zh-CN resources only.
// `initI18n` is deliberately not used here: it talks to the Tauri IPC.
await i18next.use(initReactI18next).init({
  lng: "zh-CN",
  fallbackLng: "zh-CN",
  resources: { "zh-CN": { translation: zhCN } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

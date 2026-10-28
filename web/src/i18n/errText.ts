import i18next from "i18next";

/** Shape of the Rust `AppError` serialized across the IPC boundary. */
export interface AppErrorShape {
  code?: string;
  params?: Record<string, string>;
  detail?: string | null;
}

/**
 * Render any thrown value into user-facing text. Structured `AppError`
 * objects resolve through the locale files (`errors.<code>`); plain strings
 * pass through unchanged so not-yet-migrated domains and legacy history
 * entries keep displaying their original text.
 */
export function errText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const { code, params, detail } = error as AppErrorShape;
    if (typeof code === "string") {
      const key = `errors.${code}`;
      // Missing locale entries degrade to the raw code, never the raw key.
      const headline = i18next.exists(key) ? i18next.t(key, params ?? {}) : code;
      return detail ? i18next.t("errors.common.with_detail", { headline, detail }) : headline;
    }
  }
  return String(error);
}

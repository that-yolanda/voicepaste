export type ThemePref = "light" | "dark" | "system";

export function isThemePref(value: unknown): value is ThemePref {
  return value === "light" || value === "dark" || value === "system";
}

export function initialTheme(): ThemePref {
  const preference = document.documentElement.dataset.themePreference;
  return isThemePref(preference) ? preference : "system";
}

export function applyTheme(preference: ThemePref) {
  const dark =
    preference === "dark" ||
    (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.themePreference = preference;
  try {
    localStorage.setItem("voicepaste.theme", preference);
  } catch {
    // Native configuration remains the source of truth if storage is unavailable.
  }
}

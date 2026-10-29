// Runs before the first paint; native startup supplies the saved preference.
(() => {
  let preference = window.__VOICEPASTE_THEME__;
  try {
    preference ??= localStorage.getItem("voicepaste.theme");
  } catch {
    // Storage may be unavailable; follow the system instead.
  }
  if (!["light", "dark", "system"].includes(preference)) preference = "system";
  const dark =
    preference === "dark" ||
    (preference === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();

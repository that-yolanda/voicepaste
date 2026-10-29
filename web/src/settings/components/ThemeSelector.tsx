import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { applyTheme, initialTheme, isThemePref, type ThemePref } from "@/settings/lib/theme";
import { useSettings } from "@/settings/SettingsProvider";

export function ThemeSelector() {
  const { t } = useTranslation();
  const { settings, scheduleSave } = useSettings();
  const [pref, setPref] = useState<ThemePref>(initialTheme);
  useEffect(() => {
    const preference = (settings?.parsedConfig?.app as Record<string, unknown> | undefined)?.theme;
    if (isThemePref(preference)) setPref(preference);
  }, [settings]);

  const options: { key: ThemePref; icon: typeof Sun; label: string }[] = [
    { key: "light", icon: Sun, label: "ui.theme.light" },
    { key: "dark", icon: Moon, label: "ui.theme.dark" },
    { key: "system", icon: Monitor, label: "ui.theme.system" },
  ];

  return (
    <div className="flex gap-1">
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          title={t(opt.label)}
          aria-label={t(opt.label)}
          aria-pressed={pref === opt.key}
          onClick={() => {
            setPref(opt.key);
            applyTheme(opt.key);
            scheduleSave({ app: { theme: opt.key } });
          }}
          className={`flex-1 flex items-center justify-center p-1.5 rounded-md text-text-muted hover:text-text transition-colors ${
            pref === opt.key ? "bg-fill-interactive text-accent" : ""
          }`}
        >
          <opt.icon size={16} />
        </button>
      ))}
    </div>
  );
}

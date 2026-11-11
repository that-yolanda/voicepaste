import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/settings/components/SegmentedControl";
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
    <SegmentedControl
      value={pref}
      options={options.map((opt) => ({
        value: opt.key,
        label: <opt.icon size={16} />,
        ariaLabel: t(opt.label),
      }))}
      onChange={(value) => {
        if (!isThemePref(value)) return;
        setPref(value);
        applyTheme(value);
        scheduleSave({ app: { theme: value } });
      }}
    />
  );
}

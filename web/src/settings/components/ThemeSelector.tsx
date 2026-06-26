import { Monitor, Moon, Sun } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useSettings } from "@/settings/SettingsProvider";

type ThemePref = "light" | "dark" | "system";

function isThemePref(value: unknown): value is ThemePref {
  return value === "light" || value === "dark" || value === "system";
}

export function ThemeSelector() {
  const { settings, scheduleSave } = useSettings();
  const [pref, setPref] = useState<ThemePref>("system");

  const apply = useCallback((resolved: "light" | "dark") => {
    if (resolved === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }, []);

  const resolve = useCallback((p: ThemePref): "light" | "dark" => {
    if (p === "system") {
      return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
    }
    return p === "light" ? "light" : "dark";
  }, []);

  useEffect(() => {
    const theme = settings?.runtime?.theme as Record<string, unknown> | undefined;
    const next = theme?.preference;
    if (isThemePref(next)) setPref(next);
  }, [settings?.runtime?.theme]);

  useEffect(() => {
    apply(resolve(pref));
  }, [pref, apply, resolve]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => {
      if (pref === "system") apply(mq.matches ? "dark" : "light");
    };
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, [pref, apply]);

  const options: { key: ThemePref; icon: typeof Sun; label: string }[] = [
    { key: "light", icon: Sun, label: "浅色" },
    { key: "dark", icon: Moon, label: "深色" },
    { key: "system", icon: Monitor, label: "系统" },
  ];

  return (
    <div className="flex gap-1">
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          title={opt.label}
          onClick={() => {
            setPref(opt.key);
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

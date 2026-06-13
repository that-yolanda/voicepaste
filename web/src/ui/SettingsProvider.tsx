import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ConfigPayload, SettingsData } from "@/bridge/settings";
import { getData, saveConfigObject } from "@/bridge/settings";
import { clonePlain } from "@/lib/clone";
import type { ParsedConfig } from "@/types/config";

interface SettingsContextValue {
  settings: SettingsData | null;
  config: ParsedConfig | null;
  loading: boolean;
  scheduleSave: (updates: Partial<ConfigPayload>) => void;
  saveNow: () => void;
  refresh: () => Promise<void>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneConfigValue<T>(value: T): T {
  if (isPlainObject(value) || Array.isArray(value)) return clonePlain(value);
  return value;
}

function mergeConfig<T extends Record<string, unknown>>(base: T, patch: Partial<T>): T {
  const next = clonePlain(base || ({} as T)) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(next[key])) {
      next[key] = mergeConfig(next[key] as Record<string, unknown>, value);
    } else {
      next[key] = cloneConfigValue(value);
    }
  }
  return next as T;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [config, setConfig] = useState<ParsedConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const pendingRef = useRef<Partial<ConfigPayload>>({});
  const configRef = useRef<ConfigPayload>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    const data = await getData();
    const parsed = (data.parsedConfig || {}) as ConfigPayload;
    setSettings(data);
    setConfig(parsed as ParsedConfig);
    configRef.current = parsed;
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const scheduleSave = useCallback(
    (updates: Partial<ConfigPayload>) => {
      pendingRef.current = mergeConfig(pendingRef.current, updates);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(async () => {
        const payload = { ...pendingRef.current };
        pendingRef.current = {};
        const nextConfig = mergeConfig(configRef.current, payload);
        await saveConfigObject(nextConfig);
        await load();
      }, 500);
    },
    [load],
  );

  const saveNow = useCallback(async () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const payload = { ...pendingRef.current };
    pendingRef.current = {};
    if (Object.keys(payload).length > 0) {
      const nextConfig = mergeConfig(configRef.current, payload);
      await saveConfigObject(nextConfig);
      await load();
    }
  }, [load]);

  return (
    <SettingsContext value={{ settings, config, loading, scheduleSave, saveNow, refresh: load }}>
      {children}
    </SettingsContext>
  );
}

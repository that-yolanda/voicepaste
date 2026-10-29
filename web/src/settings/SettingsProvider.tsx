import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ConfigPayload, SettingsData } from "@/settings/bridge";
import { getData, saveConfigObject } from "@/settings/bridge";
import { clonePlain } from "@/settings/lib/clone";
import type { ParsedConfig } from "@/settings/types/config";

interface SettingsContextValue {
  settings: SettingsData | null;
  config: ParsedConfig | null;
  loading: boolean;
  error: boolean;
  scheduleSave: (updates: Partial<ConfigPayload>) => Promise<void>;
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
  const [error, setError] = useState(false);
  const configRef = useRef<ConfigPayload | null>(null);
  // Serialize saves so rapid successive edits (e.g. toggling several options)
  // never drop an update: each save waits for the previous load to refresh
  // configRef before merging the next patch.
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());

  const load = useCallback(async () => {
    try {
      setError(false);
      const data = await getData();
      const parsed = (data.parsedConfig || {}) as ConfigPayload;
      setSettings(data);
      setConfig(parsed as ParsedConfig);
      configRef.current = parsed;
    } catch (cause) {
      setError(true);
      throw cause;
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    // Only the initial read needs a full-page skeleton; refresh in place afterward.
    if (configRef.current === null) setLoading(true);
    await load().catch(() => {});
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const scheduleSave = useCallback(
    (updates: Partial<ConfigPayload>) => {
      const pending = saveChainRef.current.then(async () => {
        const nextConfig = mergeConfig(configRef.current ?? {}, updates);
        await saveConfigObject(nextConfig);
        await load();
      });
      saveChainRef.current = pending.catch(() => {});
      return pending;
    },
    [load],
  );

  return (
    <SettingsContext value={{ settings, config, loading, error, scheduleSave, refresh }}>
      {children}
    </SettingsContext>
  );
}

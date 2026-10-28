import type { TFunction } from "i18next";
import { CircleArrowUp, LoaderCircle, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  onUpdateProgress,
} from "@/settings/bridge";
import { Button } from "@/settings/components/Button";
import type { UpdateState } from "@/settings/types/update";

type UpdateButtonVariant = "default" | "accent" | "danger" | "ghost";

interface UpdateSnapshot {
  state: UpdateState;
  version: string;
  notes: string;
  progress: number | null;
}

const initialSnapshot: UpdateSnapshot = {
  state: "idle",
  version: "",
  notes: "",
  progress: null,
};

let snapshot = initialSnapshot;
let hasChecked = false;
let checkPromise: Promise<void> | null = null;
let downloadPromise: Promise<void> | null = null;
const listeners = new Set<(next: UpdateSnapshot) => void>();

function setSnapshot(patch: Partial<UpdateSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((listener) => {
    listener(snapshot);
  });
}

function subscribe(listener: (next: UpdateSnapshot) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function checkUpdate(force = false) {
  if (!force && hasChecked) return Promise.resolve();
  if (!force && checkPromise) return checkPromise;
  checkPromise = (async () => {
    setSnapshot({ state: "checking", progress: null });
    try {
      const result = await checkForUpdates();
      if (result.available) {
        const version = result.version || "";
        setSnapshot({
          state: "available",
          version,
          notes: result.notes || "",
          progress: null,
        });
      } else {
        setSnapshot({
          state: "not-available",
          version: "",
          notes: "",
          progress: null,
        });
      }
    } catch {
      setSnapshot({ state: "error", progress: null });
    } finally {
      hasChecked = true;
      checkPromise = null;
    }
  })();
  return checkPromise;
}

async function downloadAndInstallUpdate() {
  if (downloadPromise) return downloadPromise;
  downloadPromise = (async () => {
    setSnapshot({
      state: "downloading",
      progress: null,
    });
    let finished = false;
    const cleanup = onUpdateProgress((p) => {
      if (p.finished) {
        finished = true;
        setSnapshot({
          state: "downloaded",
          progress: 100,
        });
      } else if (p.downloaded !== undefined && p.contentLength) {
        const progress = Math.max(
          0,
          Math.min(100, Math.round((p.downloaded / p.contentLength) * 100)),
        );
        setSnapshot({
          state: "downloading",
          progress,
        });
      }
    });
    try {
      await downloadUpdate();
      if (!finished) {
        setSnapshot({
          state: "downloaded",
          progress: 100,
        });
      }
    } catch {
      setSnapshot({ state: "error", progress: null });
    } finally {
      cleanup();
      downloadPromise = null;
    }
  })();
  return downloadPromise;
}

async function relaunchToInstall() {
  setSnapshot({ state: "installing", progress: null });
  try {
    await installUpdate();
  } catch {
    setSnapshot({ state: "error", progress: null });
  }
}

export function useUpdateSnapshot() {
  const [current, setCurrent] = useState(snapshot);

  useEffect(() => {
    const unsubscribe = subscribe(setCurrent);
    checkUpdate();
    return unsubscribe;
  }, []);

  return current;
}

/** Human-readable status line for the current update state. */
function updateStatusText(current: UpdateSnapshot, t: TFunction): string {
  switch (current.state) {
    case "checking":
      return t("ui.update.status.checking");
    case "available":
      return current.version
        ? t("ui.update.status.available", { version: current.version })
        : t("ui.update.status.available_generic");
    case "not-available":
      return t("ui.update.status.not_available");
    case "downloading":
      return typeof current.progress === "number"
        ? t("ui.update.status.downloading_progress", { progress: current.progress })
        : t("ui.update.status.downloading");
    case "downloaded":
      return t("ui.update.status.downloaded");
    case "installing":
      return t("ui.update.status.installing");
    case "error":
      return t("ui.update.status.failed");
    default:
      return "";
  }
}

function updateAction(
  current: UpdateSnapshot,
  t: TFunction,
): {
  label: string;
  variant: UpdateButtonVariant;
  disabled: boolean;
  onClick: () => void;
} {
  switch (current.state) {
    case "checking":
      return {
        label: t("ui.update.action.checking"),
        variant: "default",
        disabled: true,
        onClick: () => {},
      };
    case "available":
      return {
        label: t("ui.update.action.available"),
        variant: "accent",
        disabled: false,
        onClick: downloadAndInstallUpdate,
      };
    case "downloading":
      return {
        label:
          current.progress === null ? t("ui.update.action.downloading") : `${current.progress}%`,
        variant: "default",
        disabled: true,
        onClick: () => {},
      };
    case "downloaded":
      return {
        label: t("ui.update.action.restart"),
        variant: "accent",
        disabled: false,
        onClick: relaunchToInstall,
      };
    case "installing":
      return {
        label: t("ui.update.action.installing"),
        variant: "default",
        disabled: true,
        onClick: () => {},
      };
    case "error":
      return {
        label: t("ui.update.action.retry"),
        variant: "danger",
        disabled: false,
        onClick: () => checkUpdate(true),
      };
    case "idle":
    case "not-available":
    case "disabled":
      return {
        label: t("ui.update.action.check"),
        variant: "default",
        disabled: false,
        onClick: () => checkUpdate(true),
      };
  }
}

function UpdateIcon({ state }: { state: UpdateState }) {
  switch (state) {
    case "checking":
    case "downloading":
    case "installing":
      return <LoaderCircle size={14} className="shrink-0 animate-spin" />;
    case "error":
      return <RotateCcw size={14} className="shrink-0" />;
    default:
      return <CircleArrowUp size={14} className="shrink-0" />;
  }
}

const compactVisibleStates = new Set<UpdateState>([
  "available",
  "downloading",
  "downloaded",
  "installing",
  "error",
]);

export function UpdateButton({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const current = useUpdateSnapshot();
  const action = updateAction(current, t);
  const statusText = updateStatusText(current, t);

  if (compact) {
    if (!compactVisibleStates.has(current.state)) return null;
    return (
      <Button
        type="button"
        size="sm"
        variant={action.variant}
        onClick={action.onClick}
        disabled={action.disabled}
      >
        <span className="min-w-0 truncate">{action.label}</span>
      </Button>
    );
  }

  return (
    <div className="flex flex-row items-center gap-2">
      <span className="text-xs text-text-muted">{statusText}</span>
      <Button variant={action.variant} onClick={action.onClick} disabled={action.disabled}>
        <UpdateIcon state={current.state} />
        <span>{action.label}</span>
      </Button>
    </div>
  );
}

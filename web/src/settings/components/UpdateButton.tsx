import type { TFunction } from "i18next";
import { ArrowUp, LoaderCircle, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  onUpdateProgress,
} from "@/settings/bridge";
import { Badge } from "@/settings/components/Badge";
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
    case "available":
      return <ArrowUp size={14} className="shrink-0" />;
    case "idle":
    case "not-available":
    case "disabled":
      return <RefreshCw size={14} className="shrink-0" />;
    case "error":
      return <RotateCcw size={14} className="shrink-0" />;
    default:
      return <ArrowUp size={14} className="shrink-0" />;
  }
}

export function UpdateButton({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const current = useUpdateSnapshot();
  const action = updateAction(current, t);
  const statusText = updateStatusText(current, t);
  if (!compact) {
    const statusVariant =
      current.state === "error"
        ? "danger"
        : current.state === "not-available" || current.state === "downloaded"
          ? "success"
          : current.state === "checking"
            ? "muted"
            : "accent";
    return (
      <div className="flex flex-row items-center gap-2">
        {statusText && (
          <Badge variant={statusVariant} size="xs">
            {statusText}
          </Badge>
        )}
        <Button variant={action.variant} onClick={action.onClick} disabled={action.disabled}>
          <UpdateIcon state={current.state} />
          <span>{action.label}</span>
        </Button>
      </div>
    );
  }

  if (
    !["available", "downloading", "downloaded", "installing"].includes(current.state) &&
    !(current.state === "error" && current.version)
  )
    return null;

  const color =
    action.variant === "danger"
      ? "bg-error/10 text-error hover:bg-error/20"
      : action.variant === "accent"
        ? "bg-accent-soft text-accent hover:bg-accent/20"
        : "bg-fill-hover text-text-muted";

  return (
    <button
      type="button"
      title={statusText || action.label}
      aria-label={action.label}
      onClick={action.onClick}
      disabled={action.disabled}
      className={`inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-full px-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-dim disabled:cursor-default ${color}`}
    >
      <UpdateIcon state={current.state} />
      <span aria-live="polite">{action.label}</span>
    </button>
  );
}

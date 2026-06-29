import { CircleArrowUp, LoaderCircle, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
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
  statusText: string;
  progress: number | null;
}

const initialSnapshot: UpdateSnapshot = {
  state: "idle",
  version: "",
  statusText: "-",
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
    setSnapshot({ state: "checking", statusText: "正在检查…", progress: null });
    try {
      const result = await checkForUpdates();
      if (result.available) {
        const version = result.version || "";
        setSnapshot({
          state: "available",
          version,
          statusText: version ? `新版本 ${version} 可用` : "新版本可用",
        });
      } else {
        setSnapshot({
          state: "not-available",
          version: "",
          statusText: "已是最新版本",
        });
      }
    } catch {
      setSnapshot({ state: "error", statusText: "检查失败" });
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
      statusText: "下载中…",
      progress: null,
    });
    let finished = false;
    const cleanup = onUpdateProgress((p) => {
      if (p.finished) {
        finished = true;
        setSnapshot({
          state: "downloaded",
          statusText: "下载完成",
          progress: 100,
        });
      } else if (p.downloaded !== undefined && p.contentLength) {
        const progress = Math.max(
          0,
          Math.min(100, Math.round((p.downloaded / p.contentLength) * 100)),
        );
        setSnapshot({
          state: "downloading",
          statusText: `下载中 ${progress}%`,
          progress,
        });
      }
    });
    try {
      await downloadUpdate();
      if (!finished) {
        setSnapshot({
          state: "downloaded",
          statusText: "下载完成",
          progress: 100,
        });
      }
    } catch {
      setSnapshot({ state: "error", statusText: "下载失败" });
    } finally {
      cleanup();
      downloadPromise = null;
    }
  })();
  return downloadPromise;
}

async function relaunchToInstall() {
  setSnapshot({ state: "installing", statusText: "安装中…" });
  try {
    await installUpdate();
  } catch {
    setSnapshot({ state: "error", statusText: "安装失败" });
  }
}

function useUpdateSnapshot() {
  const [current, setCurrent] = useState(snapshot);

  useEffect(() => {
    const unsubscribe = subscribe(setCurrent);
    checkUpdate();
    return unsubscribe;
  }, []);

  return current;
}

function updateAction(current: UpdateSnapshot): {
  label: string;
  variant: UpdateButtonVariant;
  disabled: boolean;
  onClick: () => void;
} {
  switch (current.state) {
    case "checking":
      return {
        label: "正在检查",
        variant: "default",
        disabled: true,
        onClick: () => {},
      };
    case "available":
      return {
        label: "更新",
        variant: "accent",
        disabled: false,
        onClick: downloadAndInstallUpdate,
      };
    case "downloading":
      return {
        label: current.progress === null ? "下载中…" : `${current.progress}%`,
        variant: "default",
        disabled: true,
        onClick: () => {},
      };
    case "downloaded":
      return {
        label: "重启安装",
        variant: "accent",
        disabled: false,
        onClick: relaunchToInstall,
      };
    case "installing":
      return {
        label: "安装中…",
        variant: "default",
        disabled: true,
        onClick: () => {},
      };
    case "error":
      return {
        label: "重试",
        variant: "danger",
        disabled: false,
        onClick: () => checkUpdate(true),
      };
    case "idle":
    case "not-available":
    case "disabled":
      return {
        label: "检查更新",
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
  const current = useUpdateSnapshot();
  const action = updateAction(current);

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
      <span className="text-xs text-text-muted">{current.statusText}</span>
      <Button variant={action.variant} onClick={action.onClick} disabled={action.disabled}>
        <UpdateIcon state={current.state} />
        <span>{action.label}</span>
      </Button>
    </div>
  );
}

import { Mic, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SettingsEvent } from "@/bridge/settings";
import {
  getAccessibilityStatus,
  getMicrophoneStatus,
  onEvent,
  openAccessibilitySettings,
  reinitHotkey,
  requestMicrophoneAccess,
} from "@/bridge/settings";
import { Button } from "@/ui/components/Button";
import { PageHeader, PageLayout, Section, SectionContent } from "@/ui/layout/PageLayout";
import { useSettings } from "@/ui/SettingsProvider";

export function PermissionsPage() {
  const { settings } = useSettings();
  const [micStatus, setMicStatus] = useState<string>("unknown");
  const [accStatus, setAccStatus] = useState<string>("unknown");

  useEffect(() => {
    const cleanup = onEvent((event: SettingsEvent) => {
      if (event.type === "microphone-status") {
        setMicStatus((event.payload?.status as string) || "unknown");
      }
    });
    return cleanup;
  }, []);

  const check = useCallback(async () => {
    try {
      const mic = await getMicrophoneStatus();
      setMicStatus((mic as { status: string }).status || "unknown");
    } catch {
      /* ignore */
    }
    try {
      const acc = await getAccessibilityStatus();
      setAccStatus((acc as { status: string }).status || "unknown");
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    check();
    const onFocus = () => {
      getAccessibilityStatus().then((acc) => {
        const next = (acc as { status: string }).status || "unknown";
        if (next === "granted" && accStatus !== "granted") {
          reinitHotkey();
        }
        setAccStatus(next);
      });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [check, accStatus]);

  const isMac = settings?.runtime?.platform === "macos";

  return (
    <PageLayout>
      <PageHeader title="系统权限" />
      <Section>
        <SectionContent className="!py-0">
          <div className="flex items-center justify-between py-4 border-b border-border-subtle">
            <div className="flex items-center gap-3">
              <Mic size={20} className="text-text-dim" />
              <div>
                <p className="text-sm font-medium text-text">麦克风</p>
                <p className="text-xs text-text-muted">用于录制语音输入</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`w-2 h-2 rounded-full ${
                  micStatus === "granted"
                    ? "bg-success"
                    : micStatus === "denied"
                      ? "bg-error"
                      : "bg-warning"
                }`}
              />
              <span className="text-xs text-text-muted">
                {micStatus === "granted" ? "已授权" : micStatus === "denied" ? "已拒绝" : "未授权"}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  await requestMicrophoneAccess();
                  check();
                }}
              >
                检测
              </Button>
            </div>
          </div>

          {isMac && (
            <div className="flex items-center justify-between py-4 border-b border-border-subtle">
              <div className="flex items-center gap-3">
                <ShieldCheck size={20} className="text-text-dim" />
                <div>
                  <p className="text-sm font-medium text-text">辅助功能</p>
                  <p className="text-xs text-text-muted">用于将文字输入到其他应用</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`w-2 h-2 rounded-full ${accStatus === "granted" ? "bg-success" : "bg-error"}`}
                />
                <span className="text-xs text-text-muted">
                  {accStatus === "granted" ? "已授权" : "未授权"}
                </span>
                <Button size="sm" onClick={openAccessibilitySettings}>
                  前往授权
                </Button>
              </div>
            </div>
          )}
        </SectionContent>
      </Section>

      <div className="text-xs text-text-muted">
        {isMac
          ? "macOS 需要麦克风权限和辅助功能权限，可前往：系统设置 > 隐私与安全 > 麦克风 / 辅助功能"
          : "当前系统无需额外权限配置。"}
      </div>
    </PageLayout>
  );
}

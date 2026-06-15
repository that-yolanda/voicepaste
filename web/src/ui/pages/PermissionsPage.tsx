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
import {
  PageHeader,
  PageLayout,
  Section,
  SectionContent,
  SectionItem,
  SectionItemList,
} from "@/ui/layout/PageLayout";
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
        <SectionContent>
          <SectionItemList>
            {isMac && (
              <SectionItem
                title="辅助功能"
                description="用于将文字输入到其他应用"
                action={
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-2 h-2 rounded-full ${accStatus === "granted" ? "bg-success" : "bg-error"}`}
                    />
                    <span className="text-xs text-text-muted">
                      {accStatus === "granted" ? "已授权" : "未授权"}
                    </span>
                    <Button onClick={openAccessibilitySettings}>前往授权</Button>
                  </div>
                }
              />
            )}
            <SectionItem
              title="麦克风"
              description="用于录制语音输入"
              last
              action={
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
                    {micStatus === "granted"
                      ? "已授权"
                      : micStatus === "denied"
                        ? "已拒绝"
                        : "未授权"}
                  </span>
                  <Button
                    onClick={async () => {
                      await requestMicrophoneAccess();
                      check();
                    }}
                  >
                    检测
                  </Button>
                </div>
              }
            />
          </SectionItemList>
        </SectionContent>
      </Section>

      <p className="text-xs text-text-muted">
        {isMac &&
          "macOS 需要麦克风权限和辅助功能权限，可前往：系统设置 > 隐私与安全 > 麦克风 / 辅助功能"}
      </p>
    </PageLayout>
  );
}

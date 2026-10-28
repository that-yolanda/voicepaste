import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SettingsEvent } from "@/settings/bridge";
import {
  getAccessibilityStatus,
  getMicrophoneStatus,
  onEvent,
  openAccessibilitySettings,
  reinitHotkey,
  requestMicrophoneAccess,
} from "@/settings/bridge";
import { Button } from "@/settings/components/Button";
import {
  PageHeader,
  PageLayout,
  Section,
  SectionContent,
  SectionItem,
  SectionItemList,
} from "@/settings/layout/PageLayout";
import { useSettings } from "@/settings/SettingsProvider";

export function PermissionsPage() {
  const { t } = useTranslation();
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
      <PageHeader title={t("ui.permissions.title")} />
      <Section>
        <SectionContent>
          <SectionItemList>
            {isMac && (
              <SectionItem
                title={t("ui.permissions.accessibility")}
                tooltip={t("ui.permissions.accessibility_tooltip")}
                action={
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-2 h-2 rounded-full ${accStatus === "granted" ? "bg-success" : "bg-error"}`}
                    />
                    <span className="text-xs text-text-muted">
                      {accStatus === "granted"
                        ? t("ui.permissions.granted")
                        : t("ui.permissions.not_granted")}
                    </span>
                    <Button onClick={openAccessibilitySettings}>{t("ui.permissions.grant")}</Button>
                  </div>
                }
              />
            )}
            <SectionItem
              title={t("ui.permissions.microphone")}
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
                      ? t("ui.permissions.granted")
                      : micStatus === "denied"
                        ? t("ui.permissions.denied")
                        : t("ui.permissions.not_granted")}
                  </span>
                  <Button
                    onClick={async () => {
                      await requestMicrophoneAccess();
                      check();
                    }}
                  >
                    {t("ui.permissions.check")}
                  </Button>
                </div>
              }
            />
          </SectionItemList>
        </SectionContent>
      </Section>

      <p className="text-xs text-text-muted">{isMac && t("ui.permissions.macos_hint")}</p>
    </PageLayout>
  );
}

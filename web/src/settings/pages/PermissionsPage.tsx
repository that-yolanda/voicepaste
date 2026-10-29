import { LoaderCircle } from "lucide-react";
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
  const [micCheck, setMicCheck] = useState<"idle" | "checking" | "done" | "error">("idle");

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
  const micStatusLabel = t(
    micStatus === "granted"
      ? "ui.permissions.granted"
      : micStatus === "denied"
        ? "ui.permissions.denied"
        : "ui.permissions.not_granted",
  );

  const checkMicrophone = async () => {
    if (micCheck === "checking") return;
    setMicCheck("checking");
    try {
      const result = await requestMicrophoneAccess();
      setMicStatus(result.status);
      setMicCheck("done");
    } catch {
      setMicCheck("error");
    }
  };

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
                  <div data-tour="accessibility" className="flex items-center gap-2">
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
                <div data-tour="microphone" className="flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      micStatus === "granted"
                        ? "bg-success"
                        : micStatus === "denied"
                          ? "bg-error"
                          : "bg-warning"
                    }`}
                  />
                  <span role="status" aria-live="polite" className="text-xs text-text-muted">
                    {micCheck === "done"
                      ? t("ui.permissions.check_result", { status: micStatusLabel })
                      : micCheck === "error"
                        ? t("ui.permissions.check_failed")
                        : micStatusLabel}
                  </span>
                  <Button disabled={micCheck === "checking"} onClick={() => void checkMicrophone()}>
                    {micCheck === "checking" && (
                      <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
                    )}
                    {t(
                      micCheck === "checking" ? "ui.permissions.checking" : "ui.permissions.check",
                    )}
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

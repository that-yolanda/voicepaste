import { CircleCheck, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getAccessibilityStatus,
  getMicrophoneStatus,
  openAccessibilitySettings,
  openMicrophoneSettings,
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

function PermissionActions({ microphone }: { microphone: boolean }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState("unknown");
  const [busy, setBusy] = useState<"check" | "settings" | null>("check");
  const [settingsError, setSettingsError] = useState(false);
  const running = useRef(false);
  const mounted = useRef(false);
  const previous = useRef("unknown");

  const check = useCallback(
    async (request = false) => {
      if (running.current) return;
      running.current = true;
      setBusy("check");
      setSettingsError(false);
      try {
        const result = microphone
          ? await (request ? requestMicrophoneAccess() : getMicrophoneStatus())
          : await getAccessibilityStatus();
        if (!mounted.current) return;
        setStatus(result.status);
        if (!microphone && result.status === "granted" && previous.current !== "granted") {
          // Failure to restart a listener does not revoke an OS permission.
          void reinitHotkey().catch(() => {});
        }
        previous.current = result.status;
      } catch {
        if (mounted.current) setStatus("unknown");
      } finally {
        running.current = false;
        if (mounted.current) setBusy(null);
      }
    },
    [microphone],
  );

  useEffect(() => {
    mounted.current = true;
    void check();
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      mounted.current = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [check]);

  const openSettings = async () => {
    if (running.current) return;
    running.current = true;
    setBusy("settings");
    setSettingsError(false);
    try {
      await (microphone ? openMicrophoneSettings() : openAccessibilitySettings());
    } catch {
      if (mounted.current) setSettingsError(true);
    } finally {
      running.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  const hint = settingsError
    ? "settings_failed"
    : status === "denied"
      ? "enable_in_settings"
      : status === "restricted"
        ? "contact_admin"
        : status === "no_device"
          ? "no_device"
          : status === "unavailable"
            ? "unavailable"
            : status === "unknown"
              ? "unknown"
              : null;
  const allow = microphone && status === "prompt";

  return (
    <div
      data-tour={microphone ? "microphone" : "accessibility"}
      className="flex flex-wrap items-center justify-end gap-2"
    >
      <span role="status" aria-live="polite" className="text-xs text-text-muted">
        {!busy &&
          (hint ? (
            t(`ui.permissions.${hint}`)
          ) : status === "granted" ? (
            <span title={t("ui.permissions.granted")}>
              <CircleCheck size={16} className="fill-success text-surface" aria-hidden="true" />
              <span className="sr-only">{t("ui.permissions.granted")}</span>
            </span>
          ) : null)}
      </span>
      <Button
        disabled={busy !== null}
        onClick={() => void check(true)}
        className="whitespace-nowrap"
      >
        {busy === "check" && <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />}
        {t(`ui.permissions.${allow ? "allow" : "check"}`)}
      </Button>
      <Button
        disabled={busy !== null}
        onClick={() => void openSettings()}
        className="whitespace-nowrap"
      >
        {busy === "settings" && (
          <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
        )}
        {t("ui.permissions.settings")}
      </Button>
    </div>
  );
}

export function PermissionsPage() {
  const { t } = useTranslation();
  const { settings } = useSettings();
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
                action={<PermissionActions microphone={false} />}
              />
            )}
            <SectionItem
              title={t("ui.permissions.microphone")}
              last
              action={<PermissionActions microphone />}
            />
          </SectionItemList>
        </SectionContent>
      </Section>
    </PageLayout>
  );
}

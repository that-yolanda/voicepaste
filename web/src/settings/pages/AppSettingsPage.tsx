import { useState } from "react";
import { useTranslation } from "react-i18next";
import { syncLanguageFromBackend } from "@/i18n";
import { selectSoundFile } from "@/settings/bridge";
import { Button } from "@/settings/components/Button";
import { PermissionActions } from "@/settings/components/PermissionActions";
import { SegmentedControl } from "@/settings/components/SegmentedControl";
import { Select } from "@/settings/components/Select";
import { ThemeSelector } from "@/settings/components/ThemeSelector";
import { Toggle } from "@/settings/components/Toggle";
import {
  PageLayout,
  Section,
  SectionContent,
  SectionHeader,
  SectionItem,
  SectionItemList,
} from "@/settings/layout/PageLayout";
import { soundFileName } from "@/settings/lib/sound";
import { useSettings } from "@/settings/SettingsProvider";

export function AppSettingsPage() {
  const { t } = useTranslation();
  const { settings, scheduleSave } = useSettings();
  const cfg = settings?.parsedConfig || ({} as Record<string, unknown>);
  const app = (cfg.app || {}) as Record<string, unknown>;
  const sound = (app.sound || {}) as Record<string, boolean | string>;
  const runtime = settings?.runtime || ({} as Record<string, unknown>);
  const platform = (runtime.platform as string) || "";
  const configPath = settings?.configPath || "-";
  const isMac = platform === "macos";

  const [startSound, setStartSound] = useState<string>((sound.start_sound as string) || "");
  const [endSound, setEndSound] = useState<string>((sound.end_sound as string) || "");

  const setAppBool = (key: string, val: boolean) => scheduleSave({ app: { [key]: val } });
  const setSound = (upd: Record<string, unknown>) => scheduleSave({ app: { sound: upd } });

  return (
    <PageLayout>
      <Section>
        <SectionHeader title={t("ui.app_settings.general")} />
        <SectionContent>
          <SectionItemList>
            <SectionItem
              title={t("ui.app_settings.auto_launch")}
              action={
                <Toggle checked={!!app.autoLaunch} onChange={(v) => setAppBool("autoLaunch", v)} />
              }
            />

            {isMac && (
              <SectionItem
                title={t("ui.app_settings.overlay_style")}
                tooltip={t("ui.app_settings.overlay_style_tooltip")}
                action={
                  <SegmentedControl
                    options={[
                      { value: "liquid", label: t("ui.app_settings.overlay_liquid") },
                      { value: "liquid-standard", label: t("ui.app_settings.overlay_standard") },
                      { value: "vibrancy", label: t("ui.app_settings.overlay_follow_theme") },
                    ]}
                    value={(app.overlay_style as string) || "liquid"}
                    onChange={(v) => scheduleSave({ app: { overlay_style: v } })}
                  />
                }
                className="shrink-0"
              />
            )}

            <SectionItem
              title={t("ui.settings.language")}
              htmlFor="app-language"
              action={
                <Select
                  id="app-language"
                  className="max-w-40"
                  value={(app.language as string) || "auto"}
                  onChange={(v) => {
                    void scheduleSave({ app: { language: v } }).then(() =>
                      syncLanguageFromBackend(),
                    );
                  }}
                  options={[
                    { value: "auto", label: t("ui.settings.language_auto") },
                    { value: "zh-CN", label: t("ui.settings.language_zh") },
                    { value: "en", label: t("ui.settings.language_en") },
                  ]}
                />
              }
            />

            <SectionItem
              last
              title={t("ui.app_settings.theme")}
              action={
                <div className="w-48">
                  <ThemeSelector />
                </div>
              }
            />
          </SectionItemList>
        </SectionContent>
      </Section>

      <Section>
        <SectionHeader title={t("ui.app_settings.preferences")} />
        <SectionContent>
          <SectionItemList>
            <SectionItem
              title={t("ui.app_settings.sound")}
              action={
                <Toggle
                  checked={sound.enabled !== false}
                  onChange={(v) => setSound({ enabled: v })}
                />
              }
            />

            {sound.enabled !== false && (
              <>
                <SectionItem
                  title={t("ui.app_settings.ready_sound")}
                  action={
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-muted max-w-40 truncate">
                        {soundFileName(startSound)}
                      </span>
                      <Button
                        onClick={async () => {
                          const path = await selectSoundFile();
                          if (path) {
                            setStartSound(path);
                            setSound({ start_sound: path });
                          }
                        }}
                      >
                        {t("ui.app_settings.choose_file")}
                      </Button>
                      {startSound && (
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setStartSound("");
                            setSound({ start_sound: "" });
                          }}
                        >
                          {t("ui.app_settings.reset")}
                        </Button>
                      )}
                    </div>
                  }
                />

                <SectionItem
                  title={t("ui.app_settings.finish_sound")}
                  action={
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-muted max-w-40 truncate">
                        {soundFileName(endSound)}
                      </span>
                      <Button
                        onClick={async () => {
                          const path = await selectSoundFile();
                          if (path) {
                            setEndSound(path);
                            setSound({ end_sound: path });
                          }
                        }}
                      >
                        {t("ui.app_settings.choose_file")}
                      </Button>
                      {endSound && (
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setEndSound("");
                            setSound({ end_sound: "" });
                          }}
                        >
                          {t("ui.app_settings.reset")}
                        </Button>
                      )}
                    </div>
                  }
                />
              </>
            )}
            <SectionItem
              title={t("ui.app_settings.remove_period")}
              tooltip={t("ui.app_settings.remove_period_tooltip")}
              action={
                <Toggle
                  checked={app.remove_trailing_period !== false}
                  onChange={(v) => setAppBool("remove_trailing_period", v)}
                />
              }
            />
            <SectionItem
              title={t("ui.app_settings.keep_clipboard")}
              tooltip={t("ui.app_settings.keep_clipboard_tooltip")}
              action={
                <Toggle
                  checked={app.keep_clipboard !== false}
                  onChange={(v) => setAppBool("keep_clipboard", v)}
                />
              }
            />
            <SectionItem
              title={t("ui.app_settings.keep_recordings")}
              tooltip={t("ui.app_settings.keep_recordings_tooltip")}
              last
              action={
                <Toggle
                  checked={app.keep_recordings === true}
                  onChange={(v) => setAppBool("keep_recordings", v)}
                />
              }
            />
          </SectionItemList>
        </SectionContent>
      </Section>
      <Section>
        <SectionHeader title={t("ui.app_settings.permissions_config")} />
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
              action={<PermissionActions microphone />}
            />
            <SectionItem last title={t("ui.app_settings.config_path")} description={configPath} />
          </SectionItemList>
        </SectionContent>
      </Section>
    </PageLayout>
  );
}

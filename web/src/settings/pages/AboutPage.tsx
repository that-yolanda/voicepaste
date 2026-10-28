import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ReleaseNotes } from "@/settings/components/ReleaseNotes";
import { Toggle } from "@/settings/components/Toggle";
import { UpdateButton } from "@/settings/components/UpdateButton";
import {
  PageHeader,
  PageLayout,
  Section,
  SectionContent,
  SectionItem,
  SectionItemList,
} from "@/settings/layout/PageLayout";
import { useSettings } from "@/settings/SettingsProvider";

export function AboutPage() {
  const { t } = useTranslation();
  const { settings, scheduleSave } = useSettings();
  const cfg = settings?.parsedConfig || ({} as Record<string, unknown>);
  const app = (cfg.app || {}) as Record<string, unknown>;

  const [betaUpdates, setBetaUpdates] = useState(!!app.beta_updates);

  const version = (settings?.runtime?.version as string) || "2.0.0";

  return (
    <PageLayout>
      <PageHeader title={t("ui.about.title")} />
      {/* App info */}
      <div className="flex flex-col items-center space-y-2">
        <img className="w-16 h-16 rounded-lg" src="./icon.png" alt="VoicePaste" />

        <p className="text-sm font-semibold text-text">VoicePaste</p>
        <p className="text-xs text-text-muted">{t("ui.about.description")}</p>
      </div>

      <Section>
        <SectionContent>
          <SectionItemList>
            <SectionItem
              title={t("ui.about.current_version")}
              action={<span className="text-sm text-text-muted">{version}</span>}
            />
            <SectionItem title={t("ui.about.check_update")} action={<UpdateButton />} />
            <SectionItem
              title={t("ui.about.beta")}
              last
              action={
                <Toggle
                  checked={betaUpdates}
                  onChange={(v) => {
                    setBetaUpdates(v);
                    scheduleSave({ app: { beta_updates: v } });
                  }}
                />
              }
            />
          </SectionItemList>
        </SectionContent>
      </Section>

      <ReleaseNotes />
    </PageLayout>
  );
}

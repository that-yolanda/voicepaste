import { useState } from "react";
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
  const { settings, scheduleSave } = useSettings();
  const cfg = settings?.parsedConfig || ({} as Record<string, unknown>);
  const app = (cfg.app || {}) as Record<string, unknown>;

  const [betaUpdates, setBetaUpdates] = useState(!!app.beta_updates);

  const version = (settings?.runtime?.version as string) || "2.0.0";

  return (
    <PageLayout>
      <PageHeader title="关于" />
      {/* App info */}
      <div className="flex flex-col items-center space-y-2">
        <img className="w-16 h-16 rounded-lg" src="./icon.png" alt="VoicePaste" />

        <p className="text-sm font-semibold text-text">VoicePaste</p>
        <p className="text-xs text-text-muted">语音输入工具，将语音实时转为文字并输入到任意应用</p>
      </div>

      <Section>
        <SectionContent>
          <SectionItemList>
            <SectionItem
              title="当前版本"
              action={<span className="text-sm text-text-muted">{version}</span>}
            />
            <SectionItem title="检查更新" action={<UpdateButton />} />
            <SectionItem
              title="体验 Beta 版本"
              description="接收测试版本以体验新功能"
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
    </PageLayout>
  );
}

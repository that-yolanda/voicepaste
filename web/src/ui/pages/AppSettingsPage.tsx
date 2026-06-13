import { useState } from "react";
import { selectSoundFile } from "@/bridge/settings";
import { soundFileName } from "@/lib/sound";
import { Button } from "@/ui/components/Button";
import { SegmentedControl } from "@/ui/components/SegmentedControl";
import { Toggle } from "@/ui/components/Toggle";
import {
  PageHeader,
  PageLayout,
  Section,
  SectionContent,
  SectionItem,
  SectionItemList,
} from "@/ui/layout/PageLayout";
import { useSettings } from "@/ui/SettingsProvider";

export function AppSettingsPage() {
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
      <PageHeader title="应用设置" description="启动行为与配置文件" />

      <Section>
        <SectionContent>
          <SectionItemList>
            <SectionItem
              title="开机自动启动"
              description="登录时自动在后台运行 VoicePaste"
              action={
                <Toggle checked={!!app.autoLaunch} onChange={(v) => setAppBool("autoLaunch", v)} />
              }
            />

            {isMac && (
              <SectionItem
                title="悬浮窗外观"
                description="通透：背景透出更多、液态感更强；磨砂：磨砂感更明显；跟随主题：传统毛玻璃、明暗跟随外观主题"
                action={
                  <SegmentedControl
                    options={[
                      { value: "liquid", label: "通透" },
                      { value: "liquid-standard", label: "磨砂" },
                      { value: "vibrancy", label: "跟随主题" },
                    ]}
                    value={(app.overlay_style as string) || "liquid"}
                    onChange={(v) => scheduleSave({ app: { overlay_style: v } })}
                  />
                }
              />
            )}

            <SectionItem last title="配置文件路径" description={configPath} />
          </SectionItemList>
        </SectionContent>
      </Section>

      <Section>
        <SectionContent>
          <SectionItemList>
            <SectionItem
              title="提示音"
              description="录音开始和粘贴完成时播放音效提醒"
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
                  title="就绪提示音"
                  description="按下快捷键开始录音时播放"
                  action={
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-muted max-w-[160px] truncate">
                        {soundFileName(startSound)}
                      </span>
                      <Button
                        size="sm"
                        onClick={async () => {
                          const path = await selectSoundFile();
                          if (path) {
                            setStartSound(path);
                            setSound({ start_sound: path });
                          }
                        }}
                      >
                        选择文件
                      </Button>
                      {startSound && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setStartSound("");
                            setSound({ start_sound: "" });
                          }}
                        >
                          重置
                        </Button>
                      )}
                    </div>
                  }
                />

                <SectionItem
                  title="完成提示音"
                  description="语音识别完成并粘贴后播放"
                  last
                  action={
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-muted max-w-[160px] truncate">
                        {soundFileName(endSound)}
                      </span>
                      <Button
                        size="sm"
                        onClick={async () => {
                          const path = await selectSoundFile();
                          if (path) {
                            setEndSound(path);
                            setSound({ end_sound: path });
                          }
                        }}
                      >
                        选择文件
                      </Button>
                      {endSound && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEndSound("");
                            setSound({ end_sound: "" });
                          }}
                        >
                          重置
                        </Button>
                      )}
                    </div>
                  }
                />
              </>
            )}
          </SectionItemList>
        </SectionContent>
      </Section>

      <Section>
        <SectionContent>
          <SectionItemList>
            <SectionItem
              title={
                <>
                  移除末尾句号{" "}
                  <span className="text-[10px] font-mono text-text-muted bg-accent-soft px-[5px] py-px rounded-[3px] cursor-help opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                    app.remove_trailing_period
                  </span>
                </>
              }
              description="粘贴前自动移除识别结果末尾的句号"
              action={
                <Toggle
                  checked={app.remove_trailing_period !== false}
                  onChange={(v) => setAppBool("remove_trailing_period", v)}
                />
              }
            />
            <SectionItem
              title={
                <>
                  保留剪贴板{" "}
                  <span className="text-[10px] font-mono text-text-muted bg-accent-soft px-[5px] py-px rounded-[3px] cursor-help opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                    app.keep_clipboard
                  </span>
                </>
              }
              description="输入完成后恢复原剪贴板内容"
              action={
                <Toggle
                  checked={app.keep_clipboard !== false}
                  onChange={(v) => setAppBool("keep_clipboard", v)}
                />
              }
            />
            <SectionItem
              title={
                <>
                  模拟流式输出{" "}
                  <span className="text-[10px] font-mono text-text-muted bg-accent-soft px-[5px] py-px rounded-[3px] cursor-help opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                    audio.stream_simulate
                  </span>
                </>
              }
              description="针对不支持流式输出的模型，模拟流式输出的效果"
              last
              action={
                <Toggle
                  checked={(cfg.audio as Record<string, boolean>)?.stream_simulate !== false}
                  onChange={(v) => scheduleSave({ audio: { stream_simulate: v } })}
                />
              }
            />
          </SectionItemList>
        </SectionContent>
      </Section>
    </PageLayout>
  );
}

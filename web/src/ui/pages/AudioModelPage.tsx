import { Cog } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteModel,
  downloadModel,
  getDownloadedModels,
  getModelRegistry,
  onModelDownloadProgress,
  saveConfigObject,
} from "@/bridge/settings";
import { clonePlain } from "@/lib/clone";
import {
  DOUBAO_MODEL_ID,
  DOUBAO_VISIBLE_PARAMS,
  type RegistryModel,
  renderModelConfigRows,
} from "@/lib/model";
import { Button } from "@/ui/components/Button";
import { Toggle } from "@/ui/components/Toggle";
import {
  PageHeader,
  PageLayout,
  Section,
  SectionContent,
  SectionHeader,
} from "@/ui/layout/PageLayout";
import { useSettings } from "@/ui/SettingsProvider";

const VAD_ID = "silero-vad";

export function AudioModelPage() {
  const { settings, refresh } = useSettings();
  const cfg = settings?.parsedConfig || ({} as Record<string, unknown>);
  const audio = (cfg.audio || {}) as Record<string, unknown>;
  const provider = (audio.provider as string) || DOUBAO_MODEL_ID;

  const [tab, setTab] = useState<"online" | "offline">("online");
  const [registry, setRegistry] = useState<RegistryModel[]>([]);
  const [downloaded, setDownloaded] = useState<string[]>([]);

  // Doubao config
  const doubaoCfg = (audio[DOUBAO_MODEL_ID] || {}) as Record<string, unknown>;

  const [doubaoExpanded, setDoubaoExpanded] = useState(false);
  const [configExpanded, setConfigExpanded] = useState<Set<string>>(new Set());

  const doubaoValues = useRef<Record<string, unknown>>(clonePlain(doubaoCfg));

  useEffect(() => {
    doubaoValues.current = clonePlain(doubaoCfg || {});
  }, [doubaoCfg]);

  // Save helpers
  const saveDoubao = useCallback(
    async (updates: Record<string, unknown>) => {
      const merged = { ...clonePlain(doubaoCfg || {}), ...updates };
      doubaoValues.current = merged;
      await saveConfigObject({
        ...clonePlain(cfg),
        audio: { ...audio, [DOUBAO_MODEL_ID]: merged },
      });
      refresh();
    },
    [audio, cfg, doubaoCfg, refresh],
  );

  const need = useCallback(async () => {
    try {
      const reg = ((await getModelRegistry()) || []) as unknown as RegistryModel[];
      setRegistry(Array.isArray(reg) ? reg : []);
    } catch {
      /* ignore */
    }
    try {
      const ids = (await getDownloadedModels()) as string[];
      setDownloaded(Array.isArray(ids) ? ids : []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    need();
  }, [need]);

  // Model enable toggle
  const selectProvider = useCallback(
    async (id: string) => {
      const config = clonePlain(cfg);
      config.audio = config.audio || {};
      (config.audio as Record<string, unknown>).provider = id;
      await saveConfigObject(config);
      refresh();
    },
    [cfg, refresh],
  );

  // Download with VAD safety net
  const doDownload = useCallback(
    async (modelId: string) => {
      // VAD safety net
      if (modelId !== VAD_ID && !downloaded.includes(VAD_ID)) {
        try {
          await downloadModel(VAD_ID);
          setDownloaded((prev) => [...prev, VAD_ID]);
        } catch {
          return;
        }
      }
      const cleanup = onModelDownloadProgress((p) => {
        if (p.status === "completed" || p.status === "failed") {
          need();
        }
      });
      try {
        await downloadModel(modelId);
        need();
      } catch {
        /* ignore */
      }
      cleanup();
    },
    [downloaded, need],
  );

  const doDelete = useCallback(
    async (id: string) => {
      await deleteModel(id);
      need();
    },
    [need],
  );

  const offlineModels = registry
    .filter((m) => m.type === "offline")
    .sort((a, b) => {
      if (a.category !== b.category) {
        if (a.category === "vad") return -1;
        if (b.category === "vad") return 1;
      }
      return 0;
    });

  const doubaoFromRegistry = registry.find((m) => m.id === DOUBAO_MODEL_ID);

  // Doubao toggle grid
  const doubaoToggles = [
    { key: "enable_ddc", label: "语义顺滑", defaultVal: true },
    { key: "enable_itn", label: "数字格式化", defaultVal: true },
    { key: "enable_nonstream", label: "二遍识别", defaultVal: false },
    { key: "enable_punc", label: "自动标点", defaultVal: true },
  ];

  const doubaoAdvanced = Object.entries(doubaoCfg || {}).filter(
    ([key]) => !DOUBAO_VISIBLE_PARAMS.has(key),
  );

  return (
    <PageLayout>
      <PageHeader title="音频模型" description={`当前：${doubaoFromRegistry?.name || provider}`} />

      {/* Tab switcher */}
      <div className="inline-flex border border-border rounded-lg overflow-hidden">
        <button
          type="button"
          className={`px-4 py-[6px] text-sm font-medium transition-colors ${tab === "online" ? "bg-accent-soft text-accent" : "text-text-dim hover:bg-fill-hover"}`}
          onClick={() => setTab("online")}
        >
          在线模型
        </button>
        <button
          type="button"
          className={`px-4 py-[6px] text-sm font-medium transition-colors ${tab === "offline" ? "bg-accent-soft text-accent" : "text-text-dim hover:bg-fill-hover"}`}
          onClick={() => {
            setTab("offline");
            need();
          }}
        >
          本地模型
        </button>
      </div>

      {tab === "online" && (
        <Section>
          <SectionHeader
            title={doubaoFromRegistry?.name || "火山引擎 - 豆包流式输出大模型"}
            subtitle="基于豆包大模型的流式语音识别服务"
            action={
              <div className="flex items-center gap-3">
                <a
                  className="text-xs text-accent hover:underline"
                  href="https://console.volcengine.com/speech/app"
                  target="_blank"
                  rel="noreferrer"
                >
                  如何获取 API 凭据？
                </a>
                <Toggle
                  checked={provider === DOUBAO_MODEL_ID}
                  onChange={async (v) => {
                    if (v) await selectProvider(DOUBAO_MODEL_ID);
                  }}
                />
              </div>
            }
          />
          <SectionContent>
            {/* Features */}
            <div className="flex flex-wrap items-center gap-3 text-xs mb-3">
              <span className="text-success">✓ 流式输出</span>
              <span className="text-success">✓ 热词库</span>
              <span className="text-success">✓ 自动标点</span>
              <span className="text-success">✓ 数字格式化</span>
              <span className="text-success">✓ zh, en</span>
              <span className="ml-auto">
                <button
                  type="button"
                  className="text-xs text-text-dim hover:text-text flex items-center gap-1"
                  onClick={() => setDoubaoExpanded(!doubaoExpanded)}
                >
                  <Cog size={16} />
                  参数配置
                </button>
              </span>
            </div>

            {/* Doubao config panel */}
            {doubaoExpanded && (
              <div className="border-t border-border-subtle pt-4 space-y-4">
                {/* Credentials */}
                <div className="space-y-3">
                  {[
                    {
                      label: "WebSocket 地址",
                      key: "url",
                      placeholder: "wss://...",
                      type: "text" as const,
                    },
                    {
                      label: "App ID",
                      key: "app_id",
                      placeholder: "输入 App ID",
                      type: "text" as const,
                    },
                    {
                      label: "Access Token",
                      key: "access_token",
                      placeholder: "输入 Access Token",
                      type: "password" as const,
                    },
                    {
                      label: "Secret Key",
                      key: "secret_key",
                      placeholder: "输入 Secret Key",
                      type: "password" as const,
                    },
                  ].map((f) => (
                    <div key={f.key} className="flex items-center gap-3">
                      <span className="text-xs text-text-dim w-[100px] shrink-0">{f.label}</span>
                      <input
                        type={f.type}
                        className="flex-1 h-[34px] px-3 rounded-lg bg-input-bg border border-border text-text text-sm focus:outline-none focus:ring-1 focus:ring-accent-dim"
                        value={(doubaoCfg[f.key] as string) || ""}
                        onChange={(e) => saveDoubao({ [f.key]: e.target.value })}
                        placeholder={f.placeholder}
                      />
                    </div>
                  ))}
                </div>

                <div className="border-t border-border-subtle" />

                {/* Settings */}
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-text-dim w-[100px] shrink-0">Resource ID</span>
                    <input
                      type="text"
                      className="flex-1 h-[34px] px-3 rounded-lg bg-input-bg border border-border text-text text-sm focus:outline-none focus:ring-1 focus:ring-accent-dim"
                      value={(doubaoCfg.resource_id as string) || ""}
                      onChange={(e) => saveDoubao({ resource_id: e.target.value })}
                      placeholder="输入 Resource ID"
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-text-dim w-[100px] shrink-0">语言</span>
                    <input
                      type="text"
                      className="flex-1 h-[34px] px-3 rounded-lg bg-input-bg border border-border text-text text-sm focus:outline-none focus:ring-1 focus:ring-accent-dim"
                      value={(doubaoCfg.language as string) || ""}
                      onChange={(e) => saveDoubao({ language: e.target.value })}
                      placeholder="留空则自动检测"
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-text-dim w-[100px] shrink-0">热词表 ID</span>
                    <input
                      type="text"
                      className="flex-1 h-[34px] px-3 rounded-lg bg-input-bg border border-border text-text text-sm focus:outline-none focus:ring-1 focus:ring-accent-dim"
                      value={(doubaoCfg.corpus as Record<string, string>)?.boosting_table_id || ""}
                      onChange={(e) =>
                        saveDoubao({ corpus: { boosting_table_id: e.target.value } })
                      }
                      placeholder="输入热词表 ID"
                    />
                  </div>
                </div>

                <div className="border-t border-border-subtle" />

                {/* Toggle grid */}
                <div className="space-y-3">
                  {doubaoToggles.map((t) => (
                    <div key={t.key} className="flex items-center justify-between">
                      <span className="text-sm text-text">{t.label}</span>
                      <Toggle
                        checked={doubaoCfg[t.key] !== undefined ? !!doubaoCfg[t.key] : t.defaultVal}
                        onChange={(v) => saveDoubao({ [t.key]: v })}
                      />
                    </div>
                  ))}
                </div>

                {/* Advanced params */}
                {doubaoAdvanced.length > 0 && (
                  <>
                    <div className="border-t border-border-subtle" />
                    <div
                      dangerouslySetInnerHTML={{
                        __html: renderModelConfigRows(
                          DOUBAO_MODEL_ID,
                          Object.fromEntries(doubaoAdvanced),
                        ),
                      }}
                    />
                  </>
                )}
              </div>
            )}
          </SectionContent>
        </Section>
      )}

      {tab === "offline" && (
        <>
          {offlineModels.length === 0 && (
            <p className="text-sm text-text-muted">暂无可用本地模型</p>
          )}
          {offlineModels.map((model) => {
            const isDownloaded = downloaded.includes(model.id);
            const isActive = provider === model.id;
            const isBaseModel = model.category === "vad" || model.category === "punctuation";
            const memStr = model.mem_size ? `${model.mem_size}MB` : "";
            const audioCfg = (cfg.audio as Record<string, unknown>) || {};
            const modelCfg: Record<string, unknown> = {
              ...(model.default_config || {}),
              ...((audioCfg[model.id] || {}) as Record<string, unknown>),
            };
            const hasConfig = model.default_config && Object.keys(model.default_config).length > 0;

            return (
              <Section key={model.id}>
                <SectionHeader
                  title={model.name}
                  subtitle={`${model.description}${memStr ? ` · 预计内存占用峰值：${memStr}` : ""}`}
                  action={
                    <div className="flex items-center gap-2">
                      {isDownloaded ? (
                        <>
                          {!isBaseModel && (
                            <Toggle
                              checked={isActive}
                              onChange={async (v) => {
                                if (v) await selectProvider(model.id);
                              }}
                            />
                          )}
                          <Button size="sm" variant="danger" onClick={() => doDelete(model.id)}>
                            删除
                          </Button>
                        </>
                      ) : (
                        <div className="flex items-center gap-2">
                          {model.file_size ? (
                            <span className="text-xs text-text-muted">{model.file_size}MB</span>
                          ) : null}
                          <Button size="sm" variant="accent" onClick={() => doDownload(model.id)}>
                            下载
                          </Button>
                        </div>
                      )}
                    </div>
                  }
                />
                <SectionContent>
                  {/* Features */}
                  {model.capabilities && (
                    <div className="flex flex-wrap gap-3 text-xs mb-3">
                      {Object.entries({
                        streaming: "流式输出",
                        hotwords: "热词库",
                        punctuation: "自动标点",
                        itn: "数字格式化",
                      }).map(([k, label]) => (
                        <span
                          key={k}
                          className={model.capabilities?.[k] ? "text-success" : "text-text-muted"}
                        >
                          {model.capabilities?.[k] ? "✓" : "✗"} {label}
                        </span>
                      ))}
                      {model.languages?.length ? (
                        <span className="text-success max-w-[120px] truncate inline-block align-bottom">
                          ✓ {model.languages.join(", ")}
                        </span>
                      ) : null}
                      {hasConfig && (
                        <span className="ml-auto">
                          <button
                            type="button"
                            className="text-xs text-text-dim hover:text-text flex items-center gap-1"
                            onClick={() => {
                              setConfigExpanded((prev) => {
                                const next = new Set(prev);
                                if (next.has(model.id)) next.delete(model.id);
                                else next.add(model.id);
                                return next;
                              });
                            }}
                          >
                            <Cog size={16} />
                            参数配置
                          </button>
                        </span>
                      )}
                    </div>
                  )}

                  {/* Expandable config */}
                  {configExpanded.has(model.id) && hasConfig && (
                    <div
                      className="border-t border-border-subtle pt-3"
                      dangerouslySetInnerHTML={{
                        __html: renderModelConfigRows(
                          model.id,
                          modelCfg as Record<string, unknown>,
                        ),
                      }}
                    />
                  )}
                </SectionContent>
              </Section>
            );
          })}
        </>
      )}
    </PageLayout>
  );
}

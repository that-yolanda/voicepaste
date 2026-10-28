import type { TFunction } from "i18next";
import { Copy, Loader2, Pause, Play, RefreshCw, RotateCw, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { errText } from "@/i18n/errText";
import {
  deleteHistory,
  getHistory,
  getStats,
  loadPrompts,
  onPreviewEnded,
  playRecordingPreview,
  regenerateHistoryTranscription,
  repolishHistoryEntry,
  retryHistoryTranscription,
  stopRecordingPreview,
} from "@/settings/bridge";
import { Button } from "@/settings/components/Button";
import { Heatmap } from "@/settings/components/Heatmap";
import { PromptMenu } from "@/settings/components/PromptMenu";
import { Toast, useToast } from "@/settings/components/Toast";
import {
  PageHeader,
  PageLayout,
  Section,
  SectionContent,
  SectionHeader,
  SectionItemList,
} from "@/settings/layout/PageLayout";
import { formatCompact } from "@/settings/lib/format";
import type { PromptItem } from "@/settings/types/prompts";

/* ---------- pure helpers ---------- */

function formatDurationParts(s: number, t: TFunction): { value: string; unit: string } {
  const r = Math.round(s);
  if (r < 60) return { value: String(r), unit: t("ui.home.duration.seconds") };
  const m = Math.floor(r / 60);
  if (m < 60) return { value: String(m), unit: t("ui.home.duration.minutes") };
  const h = r / 3600;
  return {
    value: h < 10 ? h.toFixed(1) : String(Math.round(h)),
    unit: t("ui.home.duration.hours"),
  };
}

/** Locale key for the greeting that matches the current hour. */
function greetingKey(): string {
  const h = new Date().getHours();
  if (h < 6) return "ui.home.greeting.night";
  if (h < 11) return "ui.home.greeting.morning";
  if (h < 13) return "ui.home.greeting.noon";
  if (h < 18) return "ui.home.greeting.afternoon";
  return "ui.home.greeting.evening";
}

function dateLabel(
  key: string,
  today: string,
  yesterday: string,
  t: TFunction,
  locale: string,
): string {
  if (key === today) return t("ui.home.date.today");
  if (key === yesterday) return t("ui.home.date.yesterday");
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    weekday: "short",
  }).format(new Date(key));
}

/* ---------- types ---------- */

interface Stats {
  dailyCounts?: Record<string, number>;
  totalSessions?: number;
  totalCharacters?: number;
}
interface HistoryItem {
  ts: string;
  text: string;
  status?: "success" | "failed";
  audioPath?: string;
  error?: string;
  /** Structured error code (plus params) for failures from migrated domains;
   * rendered through the locale files. Absent on legacy entries. */
  code?: string;
  params?: Record<string, string>;
  retryOf?: string;
  /** Prompt template this entry was polished with; absent when never polished. */
  promptId?: string;
}

/* ---------- component ---------- */

export function HomePage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language ?? "zh-CN";
  const [stats, setStats] = useState<Stats | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [days, setDays] = useState(1);
  const [retryingTs, setRetryingTs] = useState<string | null>(null);
  const [regeneratingTs, setRegeneratingTs] = useState<string | null>(null);
  const [repolishingTs, setRepolishingTs] = useState<string | null>(null);
  // The entry whose recording is playing. Only one plays at a time, so this
  // doubles as the play/pause state for every row's button.
  const [playingTs, setPlayingTs] = useState<string | null>(null);
  const { toast, showToast } = useToast();
  // Why the last re-polish failed, keyed by entry. Shown inline under the row:
  // the message names what to fix (model, key, quota), so it has to be readable
  // rather than a transient toast.
  const [repolishErrors, setRepolishErrors] = useState<Record<string, string>>({});
  // Template picker for polishing: which row it is open on, and its button.
  const [polishMenu, setPolishMenu] = useState<{ ts: string; anchor: HTMLElement } | null>(null);
  const [prompts, setPrompts] = useState<PromptItem[]>([]);
  const closePolishMenu = useCallback(() => setPolishMenu(null), []);

  // Playback ends on its own, or because another row replaced it; either way the
  // backend reports it, so the button never stays stuck on pause.
  useEffect(() => onPreviewEnded(() => setPlayingTs(null)), []);

  const load = useCallback(async () => {
    try {
      setStats((await getStats()) as unknown as Stats);
    } catch {
      /* */
    }
  }, []);

  const loadHist = useCallback(async (d: number) => {
    try {
      setHistory(((await getHistory(d)) || []) as HistoryItem[]);
    } catch {
      /* */
    }
  }, []);

  useEffect(() => {
    load();
    loadHist(1);
  }, [load, loadHist]);

  // Reloaded each time the picker opens so templates edited on the LLM page show up.
  const openPolishMenu = useCallback(async (ts: string, anchor: HTMLElement) => {
    try {
      setPrompts(((await loadPrompts()) || []) as PromptItem[]);
    } catch {
      setPrompts([]);
    }
    setPolishMenu({ ts, anchor });
  }, []);

  const repolish = useCallback(
    async (ts: string, promptId: string) => {
      setPolishMenu(null);
      setRepolishingTs(ts);
      setRepolishErrors((prev) => {
        const { [ts]: _dropped, ...rest } = prev;
        return rest;
      });
      try {
        const result = (await repolishHistoryEntry(ts, promptId)) as { text?: string };
        if (result.text) {
          const text = result.text;
          setHistory((prev) =>
            prev.map((entry) => (entry.ts === ts ? { ...entry, text, promptId } : entry)),
          );
        }
        showToast(t("ui.home.toast_polish_done"));
      } catch (error) {
        setRepolishErrors((prev) => ({ ...prev, [ts]: errText(error) }));
        showToast(t("ui.home.toast_polish_failed"), "error");
      } finally {
        setRepolishingTs(null);
      }
    },
    [showToast, t],
  );

  /* —— achievements —— */
  const charTotal = stats?.totalCharacters || 0;
  const saved = formatDurationParts(Math.round(charTotal * 0.67), t);
  const cards = [
    {
      v: formatCompact(Object.keys(stats?.dailyCounts || {}).length),
      u: t("ui.home.unit_days"),
      label: t("ui.home.card_used"),
    },
    {
      v: formatCompact(stats?.totalSessions || 0),
      u: t("ui.home.unit_sessions"),
      label: t("ui.home.card_sessions"),
    },
    { v: formatCompact(charTotal), u: t("ui.home.unit_chars"), label: t("ui.home.card_chars") },
    { v: saved.value, u: saved.unit, label: t("ui.home.card_saved") },
  ];

  /* —— history —— */
  const today = new Date();
  const tKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const y = new Date(today);
  y.setDate(y.getDate() - 1);
  const yKey = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;

  /* ====== render ====== */
  return (
    <PageLayout>
      <PageHeader title={t(greetingKey())} />

      {/* Achievements */}
      <div className="grid grid-cols-4 gap-4">
        {cards.map((c) => (
          <div
            key={c.label}
            className="flex min-h-40 py-4 px-4 pb-5 bg-surface-card border border-border rounded-xl"
          >
            <div className="flex flex-1 flex-col justify-between min-w-0">
              <div className="flex items-baseline gap-1 min-w-0">
                <span className="text-xl font-bold leading-[1.05] text-text tracking-normal whitespace-nowrap">
                  {c.v}
                </span>
                <span className="text-sm font-medium text-text whitespace-nowrap">{c.u}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold text-text whitespace-nowrap leading-none">
                  {c.label}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Heatmap */}
      <Heatmap dailyCounts={stats?.dailyCounts || {}} />

      {/* History */}
      <Section>
        <SectionHeader title={t("ui.home.history_title")} />
        <SectionContent className="p-0!">
          <SectionItemList className="space-y-0">
            {history.length === 0 ? (
              <div className="flex justify-center items-center gap-3 p-4 min-h-10 text-xs text-text-muted">
                {t("ui.home.empty_history")}
              </div>
            ) : (
              <>
                {(() => {
                  let last = "";
                  return history.map((item) => {
                    const d = new Date(item.ts);
                    const dk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
                    const show = dk !== last;
                    last = dk;
                    const time = new Intl.DateTimeFormat(locale, {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    }).format(d);
                    const failed = item.status === "failed";
                    const retrying = retryingTs === item.ts;
                    const regenerating = regeneratingTs === item.ts;
                    const repolishing = repolishingTs === item.ts;
                    const repolishError = repolishErrors[item.ts];
                    const menuOpen = polishMenu?.ts === item.ts;
                    const playing = playingTs === item.ts;
                    // Structured failures localize through the locale files;
                    // legacy entries keep their stored Chinese text.
                    const failedText = item.code
                      ? errText({ code: item.code, params: item.params })
                      : item.error || item.text || t("ui.home.check_network");
                    const displayText = failed
                      ? t("ui.home.transcribe_failed", { message: failedText })
                      : item.text;
                    return (
                      <div key={item.ts} className="text-sm">
                        {show && (
                          <div className="flex items-center gap-2 p-2">
                            <div className="flex-1 h-px bg-border-subtle" />
                            <span className="text-text-muted">
                              {dateLabel(dk, tKey, yKey, t, locale)}
                            </span>
                            <div className="flex-1 h-px bg-border-subtle" />
                          </div>
                        )}
                        <div
                          className={`group min-h-8 transition-colors hover:bg-fill-hover relative ${failed ? "bg-warning/10" : ""}`}
                        >
                          <div className="px-4 flex items-center gap-2 min-h-8 ">
                            <span className="text-xs text-text-muted shrink-0">{time}</span>
                            <div className="flex-1 min-w-0">
                              <p
                                className={`truncate leading-[1.4] ${failed ? "text-warning" : "text-text-dim"}`}
                              >
                                {displayText}
                              </p>
                              {repolishError && (
                                <p className="pb-1 text-xs leading-[1.4] text-warning">
                                  {t("ui.home.repolish_failed", { message: repolishError })}
                                </p>
                              )}
                            </div>
                          </div>
                          <div
                            className={`flex items-center gap-2 transition-opacity duration-200 absolute top-1/2 right-2 -translate-y-1/2 h-full ${
                              retrying || regenerating || repolishing || menuOpen
                                ? "opacity-100"
                                : "opacity-0 group-hover:opacity-100"
                            }`}
                          >
                            {item.audioPath && (
                              <Button
                                size="icon"
                                variant="accent"
                                title={playing ? t("ui.home.pause") : t("ui.home.play")}
                                onClick={async () => {
                                  try {
                                    if (playing) {
                                      await stopRecordingPreview();
                                      setPlayingTs(null);
                                      return;
                                    }
                                    // Starting a preview stops whatever else was
                                    // playing, so claim the state right away.
                                    setPlayingTs(item.ts);
                                    await playRecordingPreview(item.audioPath || "");
                                  } catch {
                                    setPlayingTs(null);
                                  }
                                }}
                              >
                                {playing ? <Pause size={14} /> : <Play size={14} />}
                              </Button>
                            )}
                            {failed ? (
                              <Button
                                size="icon"
                                variant="accent"
                                disabled={retrying}
                                onClick={async () => {
                                  setRetryingTs(item.ts);
                                  try {
                                    const result = (await retryHistoryTranscription(item.ts)) as {
                                      text?: string;
                                    };
                                    if (result.text) {
                                      setHistory((prev) =>
                                        prev.map((entry) =>
                                          entry.ts === item.ts
                                            ? {
                                                ...entry,
                                                text: result.text || "",
                                                status: "success",
                                                error: undefined,
                                                retryOf: undefined,
                                              }
                                            : entry,
                                        ),
                                      );
                                    }
                                    await load();
                                    showToast(t("ui.home.toast_retranscribe_done"));
                                  } catch (error) {
                                    showToast(
                                      t("ui.home.toast_retranscribe_failed", {
                                        message: String(error),
                                      }),
                                      "error",
                                    );
                                  } finally {
                                    setRetryingTs(null);
                                  }
                                }}
                              >
                                <RefreshCw size={14} className={retrying ? "animate-spin" : ""} />
                              </Button>
                            ) : (
                              <>
                                {/* Regenerate: only available when this session kept
                                    its recording (keep-recording was on), so there is
                                    audio to re-transcribe. Updates the record in place
                                    without pasting. */}
                                {item.audioPath && (
                                  <Button
                                    size="icon"
                                    variant="accent"
                                    title={t("ui.home.regenerate")}
                                    disabled={regenerating}
                                    onClick={async () => {
                                      setRegeneratingTs(item.ts);
                                      try {
                                        const result = (await regenerateHistoryTranscription(
                                          item.ts,
                                        )) as { text?: string };
                                        if (result.text) {
                                          setHistory((prev) =>
                                            prev.map((entry) =>
                                              entry.ts === item.ts
                                                ? { ...entry, text: result.text || "" }
                                                : entry,
                                            ),
                                          );
                                        }
                                        showToast(t("ui.home.toast_regenerate_done"));
                                      } catch (error) {
                                        showToast(
                                          t("ui.home.toast_regenerate_failed", {
                                            message: String(error),
                                          }),
                                          "error",
                                        );
                                      } finally {
                                        setRegeneratingTs(null);
                                      }
                                    }}
                                  >
                                    <RotateCw
                                      size={14}
                                      className={regenerating ? "animate-spin" : ""}
                                    />
                                  </Button>
                                )}
                                {/* Polish: on every successful entry, so text
                                    delivered without polishing (or polished
                                    badly) gets a second chance. Opens a template
                                    picker; rewrites the record in place. */}
                                <Button
                                  size="icon"
                                  variant="accent"
                                  title={
                                    item.promptId ? t("ui.home.repolish") : t("ui.home.polish")
                                  }
                                  disabled={repolishing}
                                  onClick={(event) => {
                                    if (menuOpen) {
                                      setPolishMenu(null);
                                      return;
                                    }
                                    openPolishMenu(item.ts, event.currentTarget);
                                  }}
                                >
                                  {repolishing ? (
                                    <Loader2 size={14} className="animate-spin" />
                                  ) : (
                                    <Sparkles size={14} />
                                  )}
                                </Button>
                                {menuOpen && polishMenu && (
                                  <PromptMenu
                                    anchor={polishMenu.anchor}
                                    prompts={prompts}
                                    currentId={item.promptId}
                                    onSelect={(prompt) => repolish(item.ts, prompt.id)}
                                    onClose={closePolishMenu}
                                  />
                                )}
                                <Button
                                  size="icon"
                                  variant="accent"
                                  title={t("ui.home.copy")}
                                  onClick={async () => {
                                    try {
                                      await navigator.clipboard.writeText(item.text);
                                      showToast(t("ui.home.toast_copied"));
                                    } catch {
                                      showToast(t("ui.home.toast_copy_failed"), "error");
                                    }
                                  }}
                                >
                                  <Copy size={14} />
                                </Button>
                              </>
                            )}
                            <Button
                              size="icon"
                              variant="accent"
                              title={t("ui.home.delete")}
                              onClick={async () => {
                                try {
                                  await deleteHistory(item.ts);
                                  setHistory((p) => p.filter((h) => h.ts !== item.ts));
                                  showToast(t("ui.home.toast_deleted"));
                                } catch {
                                  showToast(t("ui.home.toast_delete_failed"), "error");
                                }
                              }}
                            >
                              <Trash2 size={14} />
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  });
                })()}
                <button
                  type="button"
                  className="w-full flex items-center justify-center gap-1 py-3 text-sm text-text-muted hover:text-text-dim cursor-pointer bg-transparent border-0 font-inherit transition-colors"
                  onClick={() => {
                    const n = days + 3;
                    setDays(n);
                    loadHist(n);
                  }}
                >
                  {t("ui.home.load_more")}
                </button>
              </>
            )}
          </SectionItemList>
        </SectionContent>
      </Section>
      <Toast toast={toast} />
    </PageLayout>
  );
}

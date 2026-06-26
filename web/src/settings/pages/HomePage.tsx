import { Copy, Play, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  deleteHistory,
  getHistory,
  getStats,
  playSoundFile,
  retryHistoryTranscription,
} from "@/settings/bridge";
import { Button } from "@/settings/components/Button";
import { Heatmap } from "@/settings/components/Heatmap";
import {
  PageHeader,
  PageLayout,
  Section,
  SectionContent,
  SectionHeader,
  SectionItemList,
} from "@/settings/layout/PageLayout";
import { formatCompact } from "@/settings/lib/format";

/* ---------- pure helpers ---------- */

function formatDurationParts(s: number): { value: string; unit: string } {
  const r = Math.round(s);
  if (r < 60) return { value: String(r), unit: "秒" };
  const m = Math.floor(r / 60);
  if (m < 60) return { value: String(m), unit: "分钟" };
  const h = r / 3600;
  return { value: h < 10 ? h.toFixed(1) : String(Math.round(h)), unit: "小时" };
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return "夜深了";
  if (h < 11) return "早上好";
  if (h < 13) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

function dateLabel(key: string, today: string, yesterday: string): string {
  if (key === today) return "今天";
  if (key === yesterday) return "昨天";
  const d = new Date(key);
  const w = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `${d.getMonth() + 1}月${d.getDate()}日 ${w[d.getDay()]}`;
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
  retryOf?: string;
}

/* ---------- component ---------- */

export function HomePage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [days, setDays] = useState(1);
  const [retryingTs, setRetryingTs] = useState<string | null>(null);

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

  /* —— achievements —— */
  const charTotal = stats?.totalCharacters || 0;
  const saved = formatDurationParts(Math.round(charTotal * 0.67));
  const cards = [
    {
      v: formatCompact(Object.keys(stats?.dailyCounts || {}).length),
      u: "天",
      label: "已经使用",
    },
    { v: formatCompact(stats?.totalSessions || 0), u: "次", label: "发起会话" },
    { v: formatCompact(charTotal), u: "字", label: "总输入字数" },
    { v: saved.value, u: saved.unit, label: "节省时间" },
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
      <PageHeader title={greeting()} />

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
        <SectionHeader title="输入记录" />
        <SectionContent className="p-0!">
          <SectionItemList className="space-y-0">
            {history.length === 0 ? (
              <div className="flex justify-center items-center gap-3 p-4 min-h-10 text-xs text-text-muted">
                暂无输入记录
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
                    const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
                    const failed = item.status === "failed";
                    const retrying = retryingTs === item.ts;
                    const displayText = failed
                      ? `转写失败：${item.error || item.text || "请检查网络连接"}`
                      : item.text;
                    return (
                      <div key={item.ts} className="text-sm">
                        {show && (
                          <div className="flex items-center gap-2 p-2">
                            <div className="flex-1 h-px bg-border-subtle" />
                            <span className="text-text-muted">{dateLabel(dk, tKey, yKey)}</span>
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
                            </div>
                          </div>
                          <div
                            className={`flex items-center gap-2 transition-opacity duration-200 absolute top-1/2 right-2 -translate-y-1/2 h-full ${
                              retrying ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                            }`}
                          >
                            {item.audioPath && (
                              <Button
                                size="icon"
                                variant="accent"
                                onClick={async () => {
                                  try {
                                    await playSoundFile(item.audioPath || "");
                                  } catch {
                                    /* */
                                  }
                                }}
                              >
                                <Play size={14} />
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
                                  } catch {
                                    /* */
                                  } finally {
                                    setRetryingTs(null);
                                  }
                                }}
                              >
                                <RefreshCw size={14} className={retrying ? "animate-spin" : ""} />
                              </Button>
                            ) : (
                              <Button
                                size="icon"
                                variant="accent"
                                onClick={async () => {
                                  try {
                                    await navigator.clipboard.writeText(item.text);
                                  } catch {
                                    /* */
                                  }
                                }}
                              >
                                <Copy size={14} />
                              </Button>
                            )}
                            <Button
                              size="icon"
                              variant="accent"
                              onClick={async () => {
                                try {
                                  await deleteHistory(item.ts);
                                  setHistory((p) => p.filter((h) => h.ts !== item.ts));
                                } catch {
                                  /* */
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
                  加载更多
                </button>
              </>
            )}
          </SectionItemList>
        </SectionContent>
      </Section>
    </PageLayout>
  );
}

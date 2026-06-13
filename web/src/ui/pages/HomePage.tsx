import { Copy, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { deleteHistory, getHistory, getStats } from "@/bridge/settings";
import { formatCompact } from "@/lib/format";
import { Heatmap } from "@/ui/components/Heatmap";
import {
  PageHeader,
  PageLayout,
  Section,
  SectionContent,
  SectionHeader,
  SectionItemList,
} from "@/ui/layout/PageLayout";

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
  ts: number;
  text: string;
}

/* ---------- component ---------- */

export function HomePage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [days, setDays] = useState(3);

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
    loadHist(3);
  }, [load, loadHist]);

  /* —— achievements —— */
  const charTotal = stats?.totalCharacters || 0;
  const saved = formatDurationParts(Math.round(charTotal * 0.67));
  const cards = [
    { v: formatCompact(Object.keys(stats?.dailyCounts || {}).length), u: "天", label: "已经使用" },
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
      <div className="grid grid-cols-4 gap-[14px]">
        {cards.map((c) => (
          <div
            key={c.label}
            className="flex min-h-[156px] py-[18px] px-4 pb-5 bg-surface-card border border-border rounded-xl"
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
          <SectionItemList>
            {history.length === 0 ? (
              <div className="flex items-center gap-3 p-4 min-h-10 text-xs text-text-muted">
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
                    return (
                      <div key={item.ts}>
                        {show && (
                          <div className="flex items-center gap-2 px-2 mt-[-1px] first:mt-0">
                            <div className="flex-1 h-px bg-border-subtle" />
                            <span className="text-[10px] text-text-muted font-medium whitespace-nowrap py-[10px] pb-[6px]">
                              {dateLabel(dk, tKey, yKey)}
                            </span>
                            <div className="flex-1 h-px bg-border-subtle" />
                          </div>
                        )}
                        <div className="group flex items-center gap-3 px-4 min-h-10 transition-colors hover:bg-fill-hover">
                          <span className="text-xs text-text-muted font-mono shrink-0 w-[38px]">
                            {time}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-text-dim truncate leading-[1.4]">
                              {item.text}
                            </p>
                          </div>
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                            <button
                              type="button"
                              className="w-[26px] h-[26px] flex items-center justify-center bg-transparent border-0 rounded-md text-text-muted hover:bg-fill-subtle hover:text-text cursor-pointer transition-colors"
                              title="复制"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(item.text);
                                } catch {
                                  /* */
                                }
                              }}
                            >
                              <Copy size={14} />
                            </button>
                            <button
                              type="button"
                              className="w-[26px] h-[26px] flex items-center justify-center bg-transparent border-0 rounded-md text-text-muted hover:text-error cursor-pointer transition-colors"
                              title="删除"
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
                            </button>
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

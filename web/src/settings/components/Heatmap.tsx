import { Section, SectionContent, SectionHeader } from "@/settings/layout/PageLayout";

/* ---------- constants ---------- */

const WEEKS = 26;
const MONTHS = [
  "1月",
  "2月",
  "3月",
  "4月",
  "5月",
  "6月",
  "7月",
  "8月",
  "9月",
  "10月",
  "11月",
  "12月",
];

/* ---------- helpers ---------- */

function heatLevel(count: number, sorted: number[]): number {
  if (!count) return 0;
  if (!sorted.length) return 1;
  const p25 = sorted[Math.floor(sorted.length * 0.25)];
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p75 = sorted[Math.floor(sorted.length * 0.75)];
  if (count <= p25) return 1;
  if (count <= p50) return 2;
  if (count <= p75) return 3;
  return 4;
}

const HEAT_BG: Record<number, string> = {
  0: "bg-heatmap-0",
  1: "bg-heatmap-1",
  2: "bg-heatmap-2",
  3: "bg-heatmap-3",
  4: "bg-heatmap-4",
};

const DAY_LABELS = [
  { key: "sun", label: "" },
  { key: "mon", label: "一" },
  { key: "tue", label: "" },
  { key: "wed", label: "三" },
  { key: "thu", label: "" },
  { key: "fri", label: "五" },
  { key: "sat", label: "" },
];

/* ---------- component ---------- */

interface HeatmapProps {
  dailyCounts: Record<string, number>;
}

export function Heatmap({ dailyCounts }: HeatmapProps) {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - start.getDay());
  start.setDate(start.getDate() - (WEEKS - 1) * 7);

  const counts = Object.values(dailyCounts)
    .filter((c) => c > 0)
    .sort((a, b) => a - b);

  let total = 0;

  const cells: { key: string; count: number; date: Date; future: boolean }[] = [];
  for (let w = 0; w < WEEKS; w++) {
    for (let d = 0; d < 7; d++) {
      const dt = new Date(start);
      dt.setDate(dt.getDate() + w * 7 + d);
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
      const c = dailyCounts[key] || 0;
      total += c;
      cells.push({ key, count: c, date: dt, future: dt > now });
    }
  }

  // Month label positions
  const mPos: Record<number, number> = {};
  let cm = -1;
  for (let w = 0; w < WEEKS; w++) {
    const dt = new Date(start);
    dt.setDate(dt.getDate() + w * 7);
    const m = dt.getMonth();
    if (m !== cm) {
      mPos[m] = w;
      cm = m;
    }
  }

  return (
    <Section>
      <SectionHeader title="使用统计" />
      <SectionContent className="px-4 flex gap-4 items-end">
        {/* Grid area */}
        <div className="flex-1 min-w-0">
          {/* Month labels */}
          <div className="relative h-3.5 ml-5.5 mb-1">
            {Object.entries(mPos).map(([m, w]) => (
              <span
                key={m}
                className="absolute text-[10px] text-text-muted"
                style={{ left: `${w * 14}px` }}
              >
                {MONTHS[+m]}
              </span>
            ))}
          </div>

          {/* Grid + day labels */}
          <div className="flex gap-2">
            {/* Day-of-week labels */}
            <div
              className="grid gap-0.75 text-[10px] text-text-muted w-3.5 shrink-0"
              style={{ gridTemplateRows: "repeat(7, 11px)" }}
            >
              {DAY_LABELS.map((day) => (
                <span key={day.key} className="h-2.75 flex items-center justify-end leading-none">
                  {day.label}
                </span>
              ))}
            </div>

            {/* The 7×26 grid */}
            <div
              className="grid gap-0.75"
              style={{
                gridTemplateRows: "repeat(7, 11px)",
                gridAutoFlow: "column",
                gridAutoColumns: "11px",
              }}
            >
              {cells.map((c) => (
                <div
                  key={c.key}
                  className={`w-2.75 h-2.75 rounded-xs ${c.future ? "invisible" : HEAT_BG[heatLevel(c.count, counts)] || "bg-heatmap-0"}`}
                  title={
                    c.future ? "" : `${c.date.getMonth() + 1}月${c.date.getDate()}日: ${c.count} 字`
                  }
                />
              ))}
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="flex flex-col items-end gap-0.5 pb-0.5 shrink-0 whitespace-nowrap">
          <span className="text-sm text-text-muted">过去 26 周</span>
          <span className="text-sm text-text-dim">
            共输入 <strong>{total.toLocaleString()}</strong> 字
          </span>
        </div>
      </SectionContent>
    </Section>
  );
}

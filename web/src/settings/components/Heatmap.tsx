import { useTranslation } from "react-i18next";
import { Section, SectionContent, SectionHeader } from "@/settings/layout/PageLayout";

/* ---------- constants ---------- */

const WEEKS = 26;

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

// Day-of-week rows are fixed (Sun..Sat); a label is shown only on alternate
// days to keep the column narrow, mirroring the GitHub contribution heatmap.
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const DAY_SHOWN = [false, true, false, true, false, true, false];

/* ---------- component ---------- */

interface HeatmapProps {
  dailyCounts: Record<string, number>;
  loading?: boolean;
}

export function Heatmap({ dailyCounts, loading = false }: HeatmapProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language ?? "zh-CN";
  const monthFormat = new Intl.DateTimeFormat(locale, { month: "short" });
  const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: "narrow" });

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

  // Month label spans: each label starts at its month's first week and runs
  // until the next month begins, expressed on the same 26-column grid as the
  // cells so labels stay aligned whatever the column width.
  const monthEntries = Object.entries(mPos).sort((a, b) => a[1] - b[1]);
  const monthSpans = monthEntries.map(([m, w], i) => ({
    month: Number(m),
    from: w,
    span: (monthEntries[i + 1]?.[1] ?? WEEKS) - w,
  }));

  return (
    <Section aria-busy={loading}>
      <SectionHeader title={t("ui.heatmap.title")} />
      <SectionContent className="px-4 flex flex-col gap-1">
        {/* Square cells scale with the available section width. */}
        <div className="w-full">
          {/* Month labels */}
          <div
            className="grid gap-0.75 ml-5.5 mb-1 h-3.5 text-[10px] text-text-muted"
            style={{ gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))` }}
          >
            {monthSpans.map((m) => (
              <span key={m.month} style={{ gridColumn: `${m.from + 1} / span ${m.span}` }}>
                {monthFormat.format(new Date(2024, m.month, 1))}
              </span>
            ))}
          </div>

          {/* Grid + day labels */}
          <div className="flex gap-2">
            {/* Day-of-week labels */}
            <div
              className="grid gap-0.75 text-[10px] text-text-muted w-3.5 shrink-0"
              style={{ gridTemplateRows: "repeat(7, 1fr)" }}
            >
              {DAY_KEYS.map((day, index) => (
                <span key={day} className="flex items-center justify-end leading-none">
                  {DAY_SHOWN[index] ? weekdayFormat.format(new Date(2024, 0, 1 + (index - 1))) : ""}
                </span>
              ))}
            </div>

            {/* Day labels stretch to match the seven square-cell rows. */}
            <div
              className="grid gap-0.75 w-full"
              style={{
                gridTemplateRows: "repeat(7, 1fr)",
                gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))`,
                gridAutoFlow: "column",
              }}
            >
              {cells.map((c) => (
                <div
                  key={c.key}
                  className={`aspect-square rounded-xs transition-colors duration-250 motion-reduce:transition-none ${!loading ? "heatmap-reveal" : ""} ${c.future ? "invisible" : HEAT_BG[heatLevel(c.count, counts)] || "bg-heatmap-0"}`}
                  title={
                    c.future
                      ? ""
                      : t("ui.heatmap.cell_title", {
                          month: c.date.getMonth() + 1,
                          day: c.date.getDate(),
                          count: c.count,
                        })
                  }
                />
              ))}
            </div>
          </div>
        </div>

        <div className="flex justify-end text-xs font-normal text-text-muted">
          <span>
            {loading ? t("ui.loading") : t("ui.heatmap.summary", { count: total.toLocaleString() })}
          </span>
        </div>
      </SectionContent>
    </Section>
  );
}

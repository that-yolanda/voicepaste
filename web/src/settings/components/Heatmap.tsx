import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Section, SectionContent, SectionHeader } from "@/settings/layout/PageLayout";

/* ---------- constants ---------- */

const WEEKS = 53;

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
  const monthFormat = new Intl.DateTimeFormat("en-US", { month: "short" });
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "long" });
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<{ text: string; rect: DOMRect } | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!hovered || !tooltipRef.current) return;
    const tooltip = tooltipRef.current.getBoundingClientRect();
    const margin = 8;
    const below = hovered.rect.bottom + margin;
    setPosition({
      left: Math.max(
        margin,
        Math.min(hovered.rect.left, window.innerWidth - tooltip.width - margin),
      ),
      top: Math.max(
        margin,
        below + tooltip.height <= window.innerHeight - margin
          ? below
          : hovered.rect.top - tooltip.height - margin,
      ),
    });
  }, [hovered]);

  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - start.getDay());
  start.setDate(start.getDate() - (WEEKS - 1) * 7);

  const counts = Object.values(dailyCounts)
    .filter((c) => c > 0)
    .sort((a, b) => a - b);

  const cells: { key: string; count: number; date: Date; future: boolean }[] = [];
  for (let w = 0; w < WEEKS; w++) {
    for (let d = 0; d < 7; d++) {
      const dt = new Date(start);
      dt.setDate(dt.getDate() + w * 7 + d);
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
      const c = dailyCounts[key] || 0;
      cells.push({ key, count: c, date: dt, future: dt > now });
    }
  }

  // Month label positions
  const mPos: { month: number; week: number }[] = [];
  let cm = -1;
  for (let w = 0; w < WEEKS; w++) {
    const dt = new Date(start);
    dt.setDate(dt.getDate() + w * 7);
    const m = dt.getMonth();
    if (m !== cm) {
      mPos.push({ month: m, week: w });
      cm = m;
    }
  }

  // Month label spans: each label starts at its month's first week and runs
  // until the next month begins, expressed on the same grid as the
  // cells so labels stay aligned whatever the column width.
  const monthSpans = mPos.map(({ month, week }, i) => ({
    month,
    from: week,
    span: (mPos[i + 1]?.week ?? WEEKS) - week,
  }));

  return (
    <Section aria-busy={loading}>
      <SectionHeader title={t("ui.heatmap.title")} />
      <SectionContent className="px-4 flex flex-col gap-1">
        {/* Square cells scale with the available section width. */}
        <div className="w-full">
          {/* Month labels */}
          <div
            className="grid gap-px ml-9 mb-1 h-3.5 text-[10px] text-text-muted"
            style={{ gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))` }}
          >
            {monthSpans.map((m) => (
              <span
                key={m.from}
                className="overflow-hidden whitespace-nowrap"
                style={{ gridColumn: `${m.from + 1} / span ${m.span}` }}
              >
                {m.span >= 2 ? monthFormat.format(new Date(2024, m.month, 1)) : ""}
              </span>
            ))}
          </div>

          {/* Grid + day labels */}
          <div className="flex items-start gap-1.5">
            {/* Day-of-week labels */}
            <div
              className="grid gap-px text-[10px] text-text-muted w-3 shrink-0"
              style={{ gridTemplateRows: "repeat(7, 1fr)" }}
            >
              {DAY_KEYS.map((day, index) => (
                <span key={day} className="flex items-center justify-end leading-none">
                  {DAY_SHOWN[index] ? String(index) : ""}
                </span>
              ))}
            </div>

            {/* Day labels stretch to match the seven square-cell rows. */}
            <div
              className="grid gap-px w-full min-w-0"
              style={{
                gridTemplateRows: "repeat(7, 1fr)",
                gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))`,
                gridAutoFlow: "column",
              }}
            >
              {cells.map((c) => {
                const text = t("ui.heatmap.cell_title", {
                  date: dateFormat.format(c.date),
                  count: c.count.toLocaleString(locale),
                });
                const show = (element: HTMLElement) => {
                  setPosition(null);
                  setHovered({ text, rect: element.getBoundingClientRect() });
                };
                return (
                  <button
                    key={c.key}
                    type="button"
                    aria-label={text}
                    tabIndex={c.future ? -1 : 0}
                    className={`aspect-square min-w-0 border-0 p-0 rounded-xs focus-visible:outline focus-visible:outline-1 focus-visible:outline-text transition-colors duration-250 motion-reduce:transition-none ${!loading ? "heatmap-reveal" : ""} ${c.future ? "invisible" : HEAT_BG[heatLevel(c.count, counts)] || "bg-heatmap-0"}`}
                    onMouseEnter={(event) => show(event.currentTarget)}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={(event) => show(event.currentTarget)}
                    onBlur={() => setHovered(null)}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </SectionContent>
      {hovered &&
        createPortal(
          <div
            ref={tooltipRef}
            role="tooltip"
            className="pointer-events-none fixed z-50 whitespace-pre rounded-lg border border-border bg-surface-card px-3 py-2 text-xs text-text shadow-lg"
            style={{
              left: position?.left ?? 0,
              top: position?.top ?? 0,
              visibility: position ? "visible" : "hidden",
            }}
          >
            {hovered.text}
          </div>,
          document.body,
        )}
    </Section>
  );
}

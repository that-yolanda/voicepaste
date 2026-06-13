/** Usage statistics types. */

export interface HeatmapDay {
  date: string; // "YYYY-MM-DD"
  count: number;
}

export interface StatsResult {
  daysUsed?: number;
  sessionCount?: number;
  totalCharacters?: number;
  totalDuration?: number; // seconds
  heatmap?: HeatmapDay[];
}

export interface HistoryEntry {
  timestamp: number;
  text: string;
  charCount: number;
}

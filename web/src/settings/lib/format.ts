/**
 * Formatting helpers extracted from settings.js.
 */

/** Format a number compactly (e.g. 1500 → "1.5K", 2_000_000 → "2.0M"). */
export function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/** Format a duration in seconds to a human-readable string. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = s / 3600;
  return h < 10 ? `${h.toFixed(1)}h` : `${Math.round(h)}h`;
}

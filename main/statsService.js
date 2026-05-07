const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

const FLUSH_INTERVAL_MS = 500;
const MAX_DAILY_COUNTS_DAYS = 182;

let dataDir = null;
let historyDir = null;
let stats = null;
let historyBuffer = [];
let flushTimer = null;

function resolveDataDir() {
  if (dataDir) return dataDir;
  dataDir = app.getPath("userData");
  historyDir = path.join(dataDir, "history");
  return dataDir;
}

function statsPath() {
  return path.join(resolveDataDir(), "stats.json");
}

function defaultStats() {
  return { firstUsedAt: null, totalSessions: 0, totalCharacters: 0, dailyCounts: {} };
}

function loadStats() {
  if (stats) return stats;
  try {
    const raw = fs.readFileSync(statsPath(), "utf8");
    stats = JSON.parse(raw);
  } catch {
    stats = defaultStats();
  }
  return stats;
}

function ensureHistoryDir() {
  resolveDataDir();
  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true });
  }
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function pruneDailyCounts() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_DAILY_COUNTS_DAYS);
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
  const keys = Object.keys(stats.dailyCounts);
  for (const k of keys) {
    if (k < cutoffKey) {
      delete stats.dailyCounts[k];
    }
  }
}

function flushStats() {
  try {
    pruneDailyCounts();
    fs.writeFileSync(statsPath(), JSON.stringify(stats, null, 2), "utf8");
  } catch (err) {
    console.error("[StatsService] failed to write stats.json", err);
  }
}

function flushHistory() {
  if (historyBuffer.length === 0) return;

  ensureHistoryDir();

  const byDate = {};
  for (const entry of historyBuffer) {
    const d = new Date(entry.ts);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!byDate[key]) byDate[key] = [];
    byDate[key].push(JSON.stringify(entry));
  }

  for (const [dateKey, lines] of Object.entries(byDate)) {
    const filePath = path.join(historyDir, `${dateKey}.jsonl`);
    try {
      fs.appendFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
    } catch (err) {
      console.error(`[StatsService] failed to append history for ${dateKey}`, err);
    }
  }

  historyBuffer = [];
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushHistory();
    flushStats();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();
}

function initStatsService() {
  resolveDataDir();
  loadStats();
}

function recordSession(text) {
  if (!text) return;

  const s = loadStats();
  const now = new Date();
  const charCount = text.length;

  if (!s.firstUsedAt) {
    s.firstUsedAt = now.toISOString();
  }
  s.totalSessions += 1;
  s.totalCharacters += charCount;

  const key = todayKey();
  s.dailyCounts[key] = (s.dailyCounts[key] || 0) + charCount;

  historyBuffer.push({ ts: now.toISOString(), text, chars: charCount });

  scheduleFlush();
}

function getStats() {
  return loadStats();
}

function getHistory(daysBack) {
  ensureHistoryDir();

  const days = Math.min(daysBack || 3, 365);
  const allItems = [];

  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const filePath = path.join(historyDir, `${key}.jsonl`);

    try {
      const raw = fs.readFileSync(filePath, "utf8").trim();
      if (!raw) continue;
      const lines = raw.split("\n");
      for (const line of lines) {
        try {
          allItems.push(JSON.parse(line));
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // file doesn't exist, skip
    }
  }

  allItems.sort((a, b) => (a.ts > b.ts ? -1 : 1));
  return allItems;
}

function closeStatsService() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushHistory();
  flushStats();
}

module.exports = {
  initStatsService,
  recordSession,
  getStats,
  getHistory,
  closeStatsService,
};

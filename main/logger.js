const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

const MAX_LOG_SIZE = 1024 * 1024; // 1MB
const FLUSH_INTERVAL_MS = 1000;

let logPath = null;
let writeStream = null;
let buffer = [];
let flushTimer = null;

function resolveLogPath() {
  if (logPath) return logPath;
  const userDataPath = app.getPath("userData");
  logPath = path.join(userDataPath, "voicepaste.log");
  return logPath;
}

function ensureStream() {
  if (writeStream && !writeStream.destroyed) return;

  const filePath = resolveLogPath();

  try {
    const stat = fs.statSync(filePath);
    if (stat.size >= MAX_LOG_SIZE) {
      const truncated = fs.readFileSync(filePath, "utf8");
      const keep = truncated.slice(-Math.floor(MAX_LOG_SIZE / 2));
      const cutIndex = keep.indexOf("\n");
      const content = cutIndex >= 0 ? keep.slice(cutIndex + 1) : keep;
      fs.writeFileSync(filePath, content, "utf8");
    }
  } catch {
    // file doesn't exist yet, that's fine
  }

  writeStream = fs.createWriteStream(filePath, { flags: "a", encoding: "utf8" });
  writeStream.on("error", (err) => {
    console.error("[Logger] write stream error", err);
  });
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();
}

function flush() {
  if (buffer.length === 0) return;
  const lines = `${buffer.join("\n")}\n`;
  buffer = [];

  ensureStream();
  writeStream.write(lines);
}

function writeLog(level, message, meta) {
  try {
    const line = [new Date().toISOString(), level, message, meta ? JSON.stringify(meta) : ""]
      .filter(Boolean)
      .join(" ");

    buffer.push(line);
    scheduleFlush();
  } catch (error) {
    console.error("[Logger] write failed", error);
  }
}

function logInfo(message, meta) {
  writeLog("INFO", message, meta);
}

function logError(message, meta) {
  writeLog("ERROR", message, meta);
}

function closeLogger() {
  flush();
  if (writeStream && !writeStream.destroyed) {
    writeStream.end();
  }
}

module.exports = {
  logError,
  logInfo,
  resolveLogPath,
  closeLogger,
};

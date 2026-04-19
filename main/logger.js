const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

function resolveLogPath() {
  const userDataPath = app.getPath("userData");
  return path.join(userDataPath, "voicepaste.log");
}

function writeLog(level, message, meta) {
  try {
    const logPath = resolveLogPath();
    const line = [new Date().toISOString(), level, message, meta ? JSON.stringify(meta) : ""]
      .filter(Boolean)
      .join(" ");

    fs.appendFileSync(logPath, `${line}\n`, "utf8");
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

module.exports = {
  logError,
  logInfo,
  resolveLogPath,
};

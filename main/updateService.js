const { autoUpdater } = require("electron-updater");
const { logInfo, logError } = require("./logger");

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

let onUpdateEvent = null;

function initUpdateService(onEvent) {
  onUpdateEvent = onEvent;

  autoUpdater.on("checking-for-update", () => {
    emit("checking");
  });

  autoUpdater.on("update-available", (info) => {
    logInfo("update available", { version: info.version });
    emit("available", {
      version: info.version,
      releaseNotes: info.releaseNotes || "",
      releaseDate: info.releaseDate || "",
    });
  });

  autoUpdater.on("update-not-available", () => {
    emit("not-available");
  });

  autoUpdater.on("error", (err) => {
    logError("update error", { message: err.message || String(err) });
    emit("error", { message: err.message || "检查更新失败" });
  });

  autoUpdater.on("download-progress", (progress) => {
    emit("progress", {
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    logInfo("update downloaded", { version: info.version });
    emit("downloaded", { version: info.version });
  });
}

function emit(type, payload) {
  if (onUpdateEvent) {
    onUpdateEvent(type, payload);
  }
}

async function checkForUpdates() {
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    logError("check for updates failed", { message: err.message || String(err) });
    emit("error", { message: err.message || "检查更新失败" });
  }
}

async function downloadUpdate() {
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    logError("download update failed", { message: err.message || String(err) });
    emit("error", { message: err.message || "下载更新失败" });
  }
}

function quitAndInstall() {
  autoUpdater.quitAndInstall();
}

module.exports = {
  initUpdateService,
  checkForUpdates,
  downloadUpdate,
  quitAndInstall,
};

const path = require("node:path");
const { BrowserWindow, screen } = require("electron");

const OVERLAY_WIDTH = 720;
const OVERLAY_HEIGHT = 300;

function getOverlayBounds() {
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const height = Math.min(OVERLAY_HEIGHT, workArea.height - 32);

  return {
    width: OVERLAY_WIDTH,
    height,
    x: Math.round(workArea.x + (workArea.width - OVERLAY_WIDTH) / 2),
    y: Math.round(workArea.y + workArea.height - height - 48),
  };
}

function positionOverlayWindow(win) {
  win.setBounds(getOverlayBounds(), false);
}

function createOverlayWindow() {
  const win = new BrowserWindow({
    ...getOverlayBounds(),
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.setIgnoreMouseEvents(true);
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
  });

  if (process.platform === "darwin") {
    win.setAlwaysOnTop(true, "screen-saver");
  } else {
    win.setAlwaysOnTop(true, "floating");
  }
  win.setContentProtection(false);
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  return win;
}

function createSettingsWindow() {
  const win = new BrowserWindow({
    width: 860,
    height: 760,
    minWidth: 760,
    minHeight: 680,
    show: false,
    frame: true,
    title: "VoicePaste 配置",
    backgroundColor: "#0f1115",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.loadFile(path.join(__dirname, "..", "renderer", "settings.html"));
  return win;
}

module.exports = {
  createOverlayWindow,
  createSettingsWindow,
  getOverlayBounds,
  positionOverlayWindow,
};

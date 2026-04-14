const path = require("node:path");
const { BrowserWindow, screen } = require("electron");

function clampOverlaySize(windowSize = { width: 360, height: 72 }) {
  return {
    width: Math.max(260, Math.min(820, Math.round(windowSize.width))),
    height: Math.max(64, Math.round(windowSize.height)),
  };
}

function getOverlayBounds(windowSize = { width: 360, height: 72 }) {
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const size = clampOverlaySize(windowSize);
  const safeHeight = Math.min(size.height, Math.max(64, workArea.height - 32));

  return {
    width: size.width,
    height: safeHeight,
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + workArea.height - safeHeight - 48),
  };
}

function positionOverlayWindow(win) {
  const bounds = getOverlayBounds(win.getBounds());
  win.setBounds(bounds, false);
}

function createOverlayWindow() {
  const bounds = getOverlayBounds();

  const win = new BrowserWindow({
    ...bounds,
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

  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setContentProtection(false);
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  return win;
}

module.exports = {
  clampOverlaySize,
  createOverlayWindow,
  getOverlayBounds,
  positionOverlayWindow,
};

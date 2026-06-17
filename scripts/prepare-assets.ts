// Icon generation — run manually via `pnpm icon` (NOT wired into beforeBuildCommand).
//
// Dual-source strategy: macOS and Windows want opposite icon padding.
//   assets/icon.png      — no padding, primary source (Windows .ico + Linux png)
//   assets/icon-mac.png  — ~10% padding, macOS source (.icns for Dock/Finder)
// The primary source renders the full set via `tauri icon`; the macOS source is
// rendered to a temp dir and only its icon.icns is copied back, so macOS gets the
// padded build while Windows stays full-bleed.

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.join(__dirname, "..");
const assetsDir = path.join(root, "assets");
const iconsDir = path.join(root, "src-tauri", "icons");
const webPublicDir = path.join(root, "web", "public");

const sourceIcon = path.join(assetsDir, "icon.png"); // no padding — win + linux + general
const sourceIconMac = path.join(assetsDir, "icon-mac.png"); // ~10% padding — mac dock

if (!fs.existsSync(sourceIcon) || !fs.existsSync(sourceIconMac)) {
  console.error("Missing assets/icon.png and/or assets/icon-mac.png — aborting");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. App bundle icons (dual-source tauri icon)
// ---------------------------------------------------------------------------
// Primary source → full set (ico/png without padding; icns is also unpadded here).
execSync(`npx tauri icon "${sourceIcon}" -o "${iconsDir}"`, {
  cwd: root,
  stdio: "inherit",
});

// macOS source → temp dir → take only icon.icns (padded) and overwrite.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voicepaste-icon-mac-"));
try {
  const tmpIconsDir = path.join(tmpDir, "icons");
  execSync(`npx tauri icon "${sourceIconMac}" -o "${tmpIconsDir}"`, {
    cwd: root,
    stdio: "inherit",
  });
  fs.copyFileSync(path.join(tmpIconsDir, "icon.icns"), path.join(iconsDir, "icon.icns"));
  console.log("Replaced icon.icns with the padded macOS build");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 2. Web icon (served from vite publicDir in both dev and build)
// ---------------------------------------------------------------------------
fs.mkdirSync(webPublicDir, { recursive: true });
fs.copyFileSync(sourceIcon, path.join(webPublicDir, "icon.png"));
console.log("Copied web icon → web/public/icon.png");

// ---------------------------------------------------------------------------
// 3. Tray icon (single high-res image; from_bytes does not auto-pick @2x)
// ---------------------------------------------------------------------------
fs.copyFileSync(path.join(assetsDir, "trayTemplate.png"), path.join(iconsDir, "trayTemplate.png"));
console.log("Copied tray icon");

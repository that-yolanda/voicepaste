// Pre-build asset preparation — single entry point for all auto-generated resources.
// Run automatically via beforeBuildCommand or manually: tsx scripts/prepare-assets.ts

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.join(__dirname, "..");
const assetsDir = path.join(root, "assets");
const iconsDir = path.join(root, "src-tauri", "icons");
const webDir = path.join(root, "web");

// ---------------------------------------------------------------------------
// 1. App bundle icons (tauri icon)
// ---------------------------------------------------------------------------
const sourceIcon = path.join(assetsDir, "icon.png");
const destIcon = path.join(iconsDir, "icon.png");

if (!fs.existsSync(sourceIcon)) {
  console.error("assets/icon.png not found — skipping icon generation");
} else if (
  !fs.existsSync(destIcon) ||
  fs.statSync(sourceIcon).mtime > fs.statSync(destIcon).mtime
) {
  console.log("Generating platform icons from assets/icon.png …");
  execSync(`npx tauri icon "${sourceIcon}" -o "${iconsDir}"`, {
    cwd: root,
    stdio: "inherit",
  });
  console.log("Platform icons generated");
}

// ---------------------------------------------------------------------------
// 2. Web icon (displayed in settings.html)
// ---------------------------------------------------------------------------
const webIcon = path.join(webDir, "icon.png");
copyIfChanged(sourceIcon, webIcon, "web icon");

// ---------------------------------------------------------------------------
// 3. Tray icons
// ---------------------------------------------------------------------------
for (const name of ["trayTemplate.png", "trayTemplate@2x.png", "trayIcon.ico"]) {
  const src = path.join(assetsDir, name);
  const dest = path.join(iconsDir, name);
  if (fs.existsSync(src)) {
    copyIfChanged(src, dest, name);
  }
}

// ===========================================================================
// Helpers
// ===========================================================================

function copyIfChanged(src: string, dest: string, label: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!fs.existsSync(dest) || fs.statSync(src).mtime > fs.statSync(dest).mtime) {
    fs.copyFileSync(src, dest);
    console.log(`Copied ${label}: ${src} → ${dest}`);
  }
}

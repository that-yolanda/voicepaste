// Clean intermediate build artifacts and caches.
// Usage: tsx scripts/clean.ts

import fs from "node:fs";
import path from "node:path";

const rootDir = path.join(__dirname, "..");

const dirsToClean = [
  path.join(rootDir, "build"),
  path.join(rootDir, "dist"),
  path.join(rootDir, "src-tauri", "target"),
  path.join(rootDir, "node_modules"),
];

for (const dir of dirsToClean) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`Cleaned: ${path.relative(rootDir, dir)}`);
  }
}

console.log("Clean complete.");

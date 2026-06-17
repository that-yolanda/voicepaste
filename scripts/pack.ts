// VoicePaste build & packaging script for Tauri v2.
//
// Usage:
//   pnpm run pack                           # All platforms, unsigned
//   pnpm run pack -s                        # All platforms, signed (macOS)
//   pnpm run pack -p apple_aarch64          # macOS ARM64 only
//   pnpm run pack -s -p apple_aarch64,win_x64  # Signed, specific platforms
//
// Platform keys: apple_aarch64, apple_x64, win_x64

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Platform definitions
// ---------------------------------------------------------------------------
interface PlatformConfig {
  target: string;
  bundles: string[];
  group: string;
}

const PLATFORM_MAP: Record<string, PlatformConfig> = {
  apple_aarch64: {
    target: "aarch64-apple-darwin",
    bundles: ["app", "dmg"],
    group: "mac",
  },
  apple_x64: {
    target: "x86_64-apple-darwin",
    bundles: ["app", "dmg"],
    group: "mac",
  },
  win_x64: {
    target: "x86_64-pc-windows-msvc",
    bundles: ["nsis", "msi"],
    group: "win",
  },
};

const ALL_PLATFORMS = Object.keys(PLATFORM_MAP);

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs(): { sign: boolean; beta: boolean; genJson: boolean; platforms: string[] } {
  const args = process.argv.slice(2);
  let sign = false;
  let beta = false;
  let genJson = false;
  let platforms: string[] | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-s" || args[i] === "--sign") {
      sign = true;
    } else if (args[i] === "-b" || args[i] === "--beta") {
      beta = true;
    } else if (args[i] === "-g" || args[i] === "--gen-json") {
      genJson = true;
    } else if (args[i] === "-p" || args[i] === "--platform") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: -p requires a comma-separated platform list");
        process.exit(1);
      }
      platforms = next.split(",").map((p) => p.trim());
      i++;
    }
  }

  return { sign, beta, genJson, platforms: platforms || ALL_PLATFORMS };
}

// ---------------------------------------------------------------------------
// Tauri CLI binary
// ---------------------------------------------------------------------------
function getTauriBin(): string {
  return path.join(
    __dirname,
    "..",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tauri.cmd" : "tauri",
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function validatePlatforms(platforms: string[]): void {
  for (const p of platforms) {
    if (!PLATFORM_MAP[p]) {
      console.error(`Error: Unknown platform "${p}". Available: ${ALL_PLATFORMS.join(", ")}`);
      process.exit(1);
    }
  }
}

function validateSigningEnv(platforms: string[]): void {
  const hasMac = platforms.some((p) => PLATFORM_MAP[p].group === "mac");

  const required = ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"];
  const missing = required.filter((k) => !process.env[k]);

  // Signing identity: prefer APPLE_SIGNING_IDENTITY, fall back to CSC_NAME
  if (!process.env.APPLE_SIGNING_IDENTITY && process.env.CSC_NAME) {
    process.env.APPLE_SIGNING_IDENTITY = process.env.CSC_NAME;
  }

  if (hasMac && missing.length > 0) {
    console.error(`Error: macOS signing requires env vars: ${missing.join(", ")}`);
    console.error("Set them in .env or pass them as environment variables.");
    process.exit(1);
  }

  if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
    console.error("Error: TAURI_SIGNING_PRIVATE_KEY is required for updater artifact signing.");
    console.error("Generate with: pnpm tauri signer generate -w ../doc/tauri/voicepaste.key");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Build runner
// ---------------------------------------------------------------------------
function runTauri(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const bin = getTauriBin();
    console.log(`\n> ${bin} ${args.join(" ")}\n`);

    // Windows cannot directly spawn a `.cmd` shim (EINVAL); route through cmd.exe.
    const child = spawn(bin, args, { stdio: "inherit", env, shell: process.platform === "win32" });

    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tauri build exited with code ${code}`));
      }
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to start tauri CLI: ${error.message}`));
    });
  });
}

async function buildPlatform(platformKey: string, includeUpdater: boolean): Promise<void> {
  const cfg = PLATFORM_MAP[platformKey];
  const bundles = includeUpdater ? cfg.bundles : cfg.bundles.filter((b) => b !== "app");
  const bundleFlag = bundles.join(",");

  const args = ["build", "--target", cfg.target, "--bundles", bundleFlag];

  console.log(`\n=== Building ${platformKey} (${cfg.target}) [${bundles.join("+")}] ===`);
  await runTauri(args, { ...process.env });
}

// ---------------------------------------------------------------------------
// Artifact collection
// ---------------------------------------------------------------------------
function collectArtifacts(platformKey: string, version: string): string[] {
  const cfg = PLATFORM_MAP[platformKey];
  const updaterCfg = UPDATER_PLATFORMS[platformKey];
  const rootDir = path.join(__dirname, "..");
  const distDir = path.join(rootDir, "dist");
  const bundleDir = path.join(rootDir, "src-tauri", "target", cfg.target, "release", "bundle");

  if (!fs.existsSync(bundleDir)) {
    console.warn(`  Warning: bundle dir not found: ${bundleDir}`);
    return [];
  }

  const collected: string[] = [];

  function copyToDist(srcPath: string, destName: string): void {
    fs.copyFileSync(srcPath, path.join(distDir, destName));
    collected.push(destName);
  }

  function walk(dir: string): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // .app is a directory bundle; recursing into it would copy its internal
        // Resources (hotwords.json, prompts.json, registry.json, …) as if they were
        // release artifacts. Skip it — the real macOS artifacts are .dmg / .app.tar.gz.
        if (entry.name.endsWith(".app")) continue;
        walk(fullPath);
        continue;
      }

      // Updater artifact: copy under its canonical arch-scoped name so multiple
      // macOS targets (aarch64 + x64) no longer collide as VoicePaste.app.tar.gz,
      // and pair it with its .sig.
      if (updaterCfg?.srcPattern.test(entry.name)) {
        const destName = updaterCfg.dest(version);
        copyToDist(fullPath, destName);
        const sigSrc = `${fullPath}.sig`;
        if (fs.existsSync(sigSrc)) {
          copyToDist(sigSrc, `${destName}.sig`);
        }
        continue;
      }

      // Plain installers (.dmg / .msi) already carry version + arch in their names.
      if (entry.name.endsWith(".dmg") || entry.name.endsWith(".msi")) {
        copyToDist(fullPath, entry.name);
      }
      // Everything else (.json, .yml, stray .sig, intermediate files) is skipped.
    }
  }

  walk(bundleDir);
  return collected;
}

// ---------------------------------------------------------------------------
// Updater metadata generation
// ---------------------------------------------------------------------------
interface UpdaterPlatformConfig {
  /** Key used in the `platforms` map of latest.json. */
  id: string;
  /** Matches the updater artifact exactly as Tauri emits it under target/.../bundle/. */
  srcPattern: RegExp;
  /** Canonical dist filename (version + arch) for the updater artifact. */
  dest: (version: string) => string;
}

const UPDATER_PLATFORMS: Record<string, UpdaterPlatformConfig> = {
  apple_aarch64: {
    id: "darwin-aarch64",
    srcPattern: /\.app\.tar\.gz$/,
    dest: (v) => `VoicePaste_${v}_aarch64.app.tar.gz`,
  },
  apple_x64: {
    id: "darwin-x86_64",
    srcPattern: /\.app\.tar\.gz$/,
    dest: (v) => `VoicePaste_${v}_x64.app.tar.gz`,
  },
  win_x64: {
    id: "windows-x86_64",
    srcPattern: /-setup\.exe$/,
    dest: (v) => `VoicePaste_${v}_x64-setup.exe`,
  },
};

function generateUpdaterArtifacts(version: string, beta: boolean): void {
  const distDir = path.join(__dirname, "..", "dist");
  const repoUrl = "https://github.com/that-yolanda/voicepaste/releases/download";
  const suffix = beta ? "-beta" : "";
  const jsonName = `latest${suffix}.json`;
  const jsonPath = path.join(distDir, jsonName);

  console.log("\n=== Generating updater metadata ===");

  // Only `notes` is carried over; the platform map is rebuilt from dist/ so the
  // manifest always reflects the artifacts that actually exist (no stale entries).
  let notes = "";
  if (fs.existsSync(jsonPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as { notes?: string };
      notes = typeof existing.notes === "string" ? existing.notes : "";
      console.log(`  Preserving notes from existing ${jsonName}`);
    } catch {
      // Ignore malformed manifests; start fresh.
    }
  }

  const platforms: Record<string, { url: string; signature: string }> = {};

  for (const p of ALL_PLATFORMS) {
    const cfg = UPDATER_PLATFORMS[p];
    if (!cfg) continue;

    const destName = cfg.dest(version);
    const bundlePath = path.join(distDir, destName);
    const sigPath = `${bundlePath}.sig`;

    if (!fs.existsSync(bundlePath) || !fs.existsSync(sigPath)) {
      console.log(`  Skipping ${cfg.id}: ${destName} (or its .sig) not in dist/`);
      continue;
    }

    platforms[cfg.id] = {
      url: `${repoUrl}/v${version}/${destName}`,
      signature: fs.readFileSync(sigPath, "utf8").trim(),
    };
    console.log(`  Added ${cfg.id} → ${destName}`);
  }

  const output = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms,
  };

  fs.writeFileSync(jsonPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`  Generated ${jsonName} (${Object.keys(platforms).length} platform(s))`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const { sign, beta, genJson, platforms } = parseArgs();

  const rootDir = path.join(__dirname, "..");
  const distDir = path.join(rootDir, "dist");
  const version = (
    JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")) as { version: string }
  ).version;

  // --gen-json: skip the build entirely and just rebuild latest.json from whatever
  // is currently in dist/. Use it after merging cross-machine artifacts into one dist/.
  if (genJson) {
    fs.mkdirSync(distDir, { recursive: true });
    generateUpdaterArtifacts(version, beta);
    return;
  }

  validatePlatforms(platforms);

  const hostOS = process.platform;
  const compatible = platforms.filter((p) => {
    const group = PLATFORM_MAP[p].group;
    if ((hostOS === "darwin" && group !== "mac") || (hostOS === "win32" && group === "mac")) {
      console.log(`Skipping ${p}: cannot build ${group} target on ${hostOS}`);
      return false;
    }
    return true;
  });

  if (compatible.length === 0) {
    console.error("Error: no platforms compatible with this host OS.");
    process.exit(1);
  }

  // Filter non-system xattr from PATH
  {
    const dirs = (process.env.PATH || "").split(":");
    const filtered = dirs.filter((dir) => {
      const xp = path.join(dir, "xattr");
      if (
        fs.existsSync(xp) &&
        !dir.startsWith("/usr/") &&
        !dir.startsWith("/bin/") &&
        !dir.startsWith("/sbin/")
      ) {
        return false;
      }
      return true;
    });
    if (filtered.length < dirs.length) {
      process.env.PATH = filtered.join(":");
    }
  }

  // Sync version from package.json → Cargo.toml
  const cargoTomlPath = path.join(rootDir, "src-tauri", "Cargo.toml");
  const cargoToml = fs.readFileSync(cargoTomlPath, "utf8");
  const updatedToml = cargoToml.replace(/^version\s*=\s*"[^"]*"/m, `version = "${version}"`);
  if (cargoToml !== updatedToml) {
    fs.writeFileSync(cargoTomlPath, updatedToml);
    console.log(`Synced version → Cargo.toml: ${version}`);
  }

  // Environment setup
  if (sign) {
    validateSigningEnv(compatible);
    console.log("Building with code signing enabled.");
  } else {
    process.env.APPLE_SIGNING_IDENTITY = "-";
    console.log("Building without code signing.");

    if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
      console.log("Warning: TAURI_SIGNING_PRIVATE_KEY not set. Skipping updater artifacts.");
      console.log(
        "  For full builds with auto-update, use -s flag or set TAURI_SIGNING_PRIVATE_KEY.",
      );
    }
  }

  fs.mkdirSync(distDir, { recursive: true });

  const hasSigningKey = !!process.env.TAURI_SIGNING_PRIVATE_KEY;

  try {
    for (const p of compatible) {
      await buildPlatform(p, hasSigningKey);
    }
  } catch (error) {
    console.error(`\nBuild failed: ${(error as Error).message}`);
    process.exit(1);
  }

  console.log("\n=== Collecting artifacts ===");
  const allArtifacts: string[] = [];
  for (const p of compatible) {
    const artifacts = collectArtifacts(p, version);
    for (const a of artifacts) {
      if (!allArtifacts.includes(a)) allArtifacts.push(a);
    }
  }

  if (hasSigningKey) {
    generateUpdaterArtifacts(version, beta);
  }

  console.log("\nArtifacts in ./dist/:");
  const finalArtifacts = fs.readdirSync(distDir).sort();
  for (const a of finalArtifacts) {
    const stat = fs.statSync(path.join(distDir, a));
    const size =
      stat.size > 1024 * 1024
        ? `${(stat.size / 1024 / 1024).toFixed(1)} MB`
        : `${(stat.size / 1024).toFixed(0)} KB`;
    console.log(`  ${a} (${size})`);
  }

  console.log(`\nDone! ${finalArtifacts.length} artifacts in ${path.relative(rootDir, distDir)}/`);
}

main();

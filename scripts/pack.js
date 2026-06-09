// VoicePaste build & packaging script for Tauri v2.
//
// Usage:
//   pnpm run pack                           # All platforms, unsigned
//   pnpm run pack -s                        # All platforms, signed (macOS)
//   pnpm run pack -p apple_aarch64          # macOS ARM64 only
//   pnpm run pack -s -p apple_aarch64,win_x64  # Signed, specific platforms
//
// Platform keys: apple_aarch64, apple_x64, win_x64

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Platform definitions
// ---------------------------------------------------------------------------
const PLATFORM_MAP = {
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
function parseArgs() {
  const args = process.argv.slice(2);
  let sign = false;
  let platforms = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-s" || args[i] === "--sign") {
      sign = true;
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

  return { sign, platforms: platforms || ALL_PLATFORMS };
}

// ---------------------------------------------------------------------------
// Tauri CLI binary
// ---------------------------------------------------------------------------
function getTauriBin() {
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
function validatePlatforms(platforms) {
  for (const p of platforms) {
    if (!PLATFORM_MAP[p]) {
      console.error(
        `Error: Unknown platform "${p}". Available: ${ALL_PLATFORMS.join(", ")}`,
      );
      process.exit(1);
    }
  }
}

function validateSigningEnv(platforms) {
  const hasMac = platforms.some((p) => PLATFORM_MAP[p].group === "mac");

  const required = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];
  const missing = required.filter((k) => !process.env[k]);

  // Signing identity: prefer APPLE_SIGNING_IDENTITY, fall back to CSC_NAME
  if (!process.env.APPLE_SIGNING_IDENTITY && process.env.CSC_NAME) {
    process.env.APPLE_SIGNING_IDENTITY = process.env.CSC_NAME;
  }

  if (hasMac && missing.length > 0) {
    console.error(
      `Error: macOS signing requires env vars: ${missing.join(", ")}`,
    );
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
// Build runner — spawns the Tauri CLI binary directly (no shell intermediary)
// to avoid environment / hdiutil issues on macOS.
// ---------------------------------------------------------------------------
function runTauri(args, env) {
  return new Promise((resolve, reject) => {
    const bin = getTauriBin();
    console.log(`\n> ${bin} ${args.join(" ")}\n`);

    const child = spawn(bin, args, { stdio: "inherit", env });

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

async function buildPlatform(platformKey, includeUpdater) {
  const cfg = PLATFORM_MAP[platformKey];
  // When updater signing key is not available, skip the "app" bundle target
  // to avoid the "public key found but no private key" error.
  const bundles = includeUpdater
    ? cfg.bundles
    : cfg.bundles.filter((b) => b !== "app");
  const bundleFlag = bundles.join(",");
  const rootDir = path.join(__dirname, "..");
  const configPath = path.join(rootDir, "tauri", "tauri.conf.json");

  const args = [
    "build",
    "--config", configPath,
    "--target", cfg.target,
    "--bundles", bundleFlag,
  ];

  console.log(`\n=== Building ${platformKey} (${cfg.target}) [${bundles.join("+")}] ===`);
  await runTauri(args, { ...process.env });
}

// ---------------------------------------------------------------------------
// Artifact collection
// ---------------------------------------------------------------------------
function collectArtifacts(platformKey) {
  const cfg = PLATFORM_MAP[platformKey];
  const rootDir = path.join(__dirname, "..");
  const distDir = path.join(rootDir, "dist");
  const bundleDir = path.join(
    rootDir,
    "tauri",
    "target",
    cfg.target,
    "release",
    "bundle",
  );

  if (!fs.existsSync(bundleDir)) {
    console.warn(`  Warning: bundle dir not found: ${bundleDir}`);
    return [];
  }

  const collected = [];

  // Walk bundle directory for artifacts
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        const isArtifact = [
          ".dmg",
          ".exe",
          ".msi",
          ".tar.gz",
          ".zip",
          ".sig",
          ".json",
        ].some((e) => entry.name.endsWith(e));

        if (isArtifact || ext === ".yml") {
          const dest = path.join(distDir, entry.name);
          fs.copyFileSync(fullPath, dest);
          collected.push(entry.name);
        }
      }
    }
  }

  walk(bundleDir);
  return collected;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const { sign, platforms } = parseArgs();
  validatePlatforms(platforms);

  const rootDir = path.join(__dirname, "..");
  const distDir = path.join(rootDir, "dist");

  // Python's xattr shadows macOS /usr/bin/xattr but doesn't support -cr flags.
  // Remove non-system xattr dirs from PATH so Tauri's bundler finds the real one.
  {
    const dirs = process.env.PATH.split(":");
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

  // Environment setup
  if (sign) {
    validateSigningEnv(platforms);
    console.log("Building with code signing enabled.");
  } else {
    // Disable macOS code signing when -s is not passed
    process.env.APPLE_SIGNING_IDENTITY = "-";
    console.log("Building without code signing.");

    // Updater artifacts require signing key from .env;
    // if unavailable, warn and disable updater artifacts for this build.
    if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
      console.log(
        "Warning: TAURI_SIGNING_PRIVATE_KEY not set. Skipping updater artifacts.",
      );
      console.log(
        "  For full builds with auto-update, use -s flag or set TAURI_SIGNING_PRIVATE_KEY.",
      );
    }
  }

  // Ensure dist directory exists
  fs.mkdirSync(distDir, { recursive: true });

  const hasSigningKey = !!process.env.TAURI_SIGNING_PRIVATE_KEY;

  try {
    // Build each platform
    for (const p of platforms) {
      await buildPlatform(p, hasSigningKey);
    }
  } catch (error) {
    console.error(`\nBuild failed: ${error.message}`);
    process.exit(1);
  }

  // Collect artifacts
  console.log("\n=== Collecting artifacts ===");
  const allArtifacts = [];
  for (const p of platforms) {
    const artifacts = collectArtifacts(p);
    for (const a of artifacts) {
      if (!allArtifacts.includes(a)) allArtifacts.push(a);
    }
  }

  console.log(`\nArtifacts in ./dist/:`);
  for (const a of allArtifacts.sort()) {
    const stat = fs.statSync(path.join(distDir, a));
    const size =
      stat.size > 1024 * 1024
        ? `${(stat.size / 1024 / 1024).toFixed(1)} MB`
        : `${(stat.size / 1024).toFixed(0)} KB`;
    console.log(`  ${a} (${size})`);
  }

  console.log(`\nDone! ${allArtifacts.length} artifacts in ${path.relative(rootDir, distDir)}/`);
}

main();

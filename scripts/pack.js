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
  let beta = false;
  let platforms = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-s" || args[i] === "--sign") {
      sign = true;
    } else if (args[i] === "-b" || args[i] === "--beta") {
      beta = true;
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

  return { sign, beta, platforms: platforms || ALL_PLATFORMS };
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

  const required = ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"];
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

  const args = [
    "build",
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
    "src-tauri",
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
// Updater metadata generation
// ---------------------------------------------------------------------------
const UPDATER_PLATFORMS = {
  apple_aarch64: { id: "darwin-aarch64", arch: "aarch64", ext: ".app.tar.gz" },
  apple_x64: { id: "darwin-x86_64", arch: "x64", ext: ".app.tar.gz" },
  win_x64: { id: "windows-x86_64", arch: "x64", ext: ".nsis.zip" },
};

/**
 * After artifact collection, generates updater metadata JSON files.
 * Also renames updater bundles to include version + arch for uniqueness.
 *
 * - dist/VoicePaste.app.tar.gz → VoicePaste_1.3.0-beta.1_aarch64.app.tar.gz
 * - Generates latest-beta-darwin-aarch64.json (or latest-darwin-aarch64.json)
 */
function generateUpdaterArtifacts(platforms, version, beta) {
  const distDir = path.join(__dirname, "..", "dist");
  const repoUrl = "https://github.com/that-yolanda/voicepaste/releases/download";
  const suffix = beta ? "-beta" : "";

  console.log("\n=== Generating updater metadata ===");

  for (const p of platforms) {
    const cfg = UPDATER_PLATFORMS[p];
    if (!cfg) continue;

    // Find updater bundle in dist (e.g. VoicePaste.app.tar.gz)
    const files = fs.readdirSync(distDir);
    const bundleFile = files.find((f) => f.endsWith(cfg.ext));
    if (!bundleFile) {
      console.log(`  Skipping ${p}: no ${cfg.ext} bundle found`);
      continue;
    }

    const sigFile = bundleFile + ".sig";
    if (!files.includes(sigFile)) {
      console.log(`  Skipping ${p}: no signature file (${sigFile}) found`);
      continue;
    }

    // Rename bundle + sig to include version and arch
    const baseName = `VoicePaste_${version}_${cfg.arch}`;
    const newBundle = `${baseName}${cfg.ext}`;
    const newSig = `${newBundle}.sig`;

    if (bundleFile !== newBundle) {
      fs.renameSync(path.join(distDir, bundleFile), path.join(distDir, newBundle));
    }
    if (sigFile !== newSig) {
      fs.renameSync(path.join(distDir, sigFile), path.join(distDir, newSig));
    }

    // Read signature
    const signature = fs
      .readFileSync(path.join(distDir, newSig), "utf8")
      .trim();

    // Generate updater JSON
    const jsonName = `latest${suffix}-${cfg.id}.json`;
    const json = {
      version,
      date: new Date().toISOString(),
      url: `${repoUrl}/v${version}/${newBundle}`,
      signature,
    };

    fs.writeFileSync(
      path.join(distDir, jsonName),
      JSON.stringify(json, null, 2) + "\n",
    );

    console.log(`  ${bundleFile} → ${newBundle}`);
    console.log(`  Generated ${jsonName}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const { sign, beta, platforms } = parseArgs();
  validatePlatforms(platforms);

  // Skip platforms that cannot be built on this host OS.
  // macOS Tauri CLI only supports dmg/app; Windows CLI only supports nsis/msi.
  const hostOS = process.platform; // "darwin" | "win32"
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

  // Sync version from package.json → Cargo.toml
  // (tauri.conf.json omits "version" so Tauri reads from Cargo.toml at build time)
  const version = require(path.join(rootDir, "package.json")).version;
  const cargoTomlPath = path.join(rootDir, "src-tauri", "Cargo.toml");
  const cargoToml = fs.readFileSync(cargoTomlPath, "utf8");
  const updatedToml = cargoToml.replace(
    /^version\s*=\s*"[^"]*"/m,
    `version = "${version}"`,
  );
  if (cargoToml !== updatedToml) {
    fs.writeFileSync(cargoTomlPath, updatedToml);
    console.log(`Synced version → Cargo.toml: ${version}`);
  }

  // Environment setup
  if (sign) {
    validateSigningEnv(compatible);
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
    // Build each compatible platform
    for (const p of compatible) {
      await buildPlatform(p, hasSigningKey);
    }
  } catch (error) {
    console.error(`\nBuild failed: ${error.message}`);
    process.exit(1);
  }

  // Collect artifacts
  console.log("\n=== Collecting artifacts ===");
  const allArtifacts = [];
  for (const p of compatible) {
    const artifacts = collectArtifacts(p);
    for (const a of artifacts) {
      if (!allArtifacts.includes(a)) allArtifacts.push(a);
    }
  }

  // Generate updater metadata (renames bundles + creates latest-*.json)
  if (hasSigningKey) {
    generateUpdaterArtifacts(compatible, version, beta);
  }

  console.log(`\nArtifacts in ./dist/:`);
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

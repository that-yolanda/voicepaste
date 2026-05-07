const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { loadDotEnv } = require("./env");

const PLATFORM_MAP = {
  "mac-arm64": { builder: ["--mac", "zip", "--arm64"], group: "mac" },
  "mac-x64": { builder: ["--mac", "zip", "--x64"], group: "mac" },
  "win-x64": { builder: ["--win", "nsis", "--x64"], group: "win" },
};

const ALL_PLATFORMS = ["mac-arm64", "mac-x64", "win-x64"];

const SIGN_ENV_VARS = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];

function parseArgs(argv) {
  const args = argv.slice(2);
  let sign = false;
  let platforms = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-s" || arg === "--sign") {
      sign = true;
    } else if (arg === "-p" || arg === "--platform") {
      const value = args[++i];
      if (!value || value.startsWith("-")) {
        console.error("Error: -p/--platform requires a value");
        process.exit(1);
      }
      platforms = value.split(",").map((p) => p.trim());
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Error: Unknown argument: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }

  if (!platforms) {
    platforms = [...ALL_PLATFORMS];
  }

  for (const p of platforms) {
    if (!PLATFORM_MAP[p]) {
      console.error(`Error: Unknown platform "${p}". Valid: ${ALL_PLATFORMS.join(", ")}`);
      process.exit(1);
    }
  }

  return { sign, platforms };
}

function printHelp() {
  console.log(`Usage: pnpm pack [options]

Options:
  -p, --platform <list>   Target platforms (comma-separated)
                          mac-arm64, mac-x64, win-x64
                          Default: all platforms
  -s, --sign              Enable code signing and notarization
  -h, --help              Show this help

Examples:
  pnpm pack                           # Build all platforms without signing
  pnpm pack -p mac-arm64              # macOS Apple Silicon only
  pnpm pack -p mac-arm64,mac-x64      # macOS dual architecture
  pnpm pack -s                        # Build all + sign
  pnpm pack -s -p mac-arm64           # Sign + single platform`);
}

function getElectronBuilderBin() {
  return path.join(
    __dirname,
    "..",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electron-builder.cmd" : "electron-builder",
  );
}

function runBuilder(args, env) {
  return new Promise((resolve, reject) => {
    const bin = getElectronBuilderBin();
    const child = spawn(bin, args, { stdio: "inherit", env });

    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`electron-builder exited with code ${code}`));
      }
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to start electron-builder: ${error.message}`));
    });
  });
}

function cleanUiohookBuild() {
  const buildDir = path.join(__dirname, "..", "node_modules", "uiohook-napi", "build");
  if (fs.existsSync(buildDir)) {
    console.log("Cleaning uiohook-napi native build...");
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
}

async function main() {
  const { sign, platforms } = parseArgs(process.argv);

  if (sign) {
    loadDotEnv();
    const missing = SIGN_ENV_VARS.filter((key) => !process.env[key]);
    if (missing.length > 0) {
      console.error(`Error: Signing requested but missing env vars: ${missing.join(", ")}`);
      process.exit(1);
    }
    console.log("Code signing and notarization enabled");
  } else {
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  }

  const env = { ...process.env };

  // Group platforms: merge mac archs into one builder call for correct latest-mac.yml
  const macPlatforms = platforms.filter((p) => PLATFORM_MAP[p].group === "mac");
  const winPlatforms = platforms.filter((p) => PLATFORM_MAP[p].group === "win");

  try {
    if (macPlatforms.length > 0) {
      const macArgs = ["--mac", "zip"];
      for (const p of macPlatforms) {
        const entry = PLATFORM_MAP[p];
        const archArg = entry.builder.find((a) => a === "--arm64" || a === "--x64");
        if (archArg && !macArgs.includes(archArg)) {
          macArgs.push(archArg);
        }
      }

      console.log(`\nBuilding macOS: ${macPlatforms.join(", ")}...`);
      await runBuilder(macArgs, env);
    }

    if (winPlatforms.length > 0) {
      cleanUiohookBuild();

      console.log(`\nBuilding Windows: ${winPlatforms.join(", ")}...`);
      for (const p of winPlatforms) {
        await runBuilder(PLATFORM_MAP[p].builder, env);
      }
    }

    console.log("\nBuild complete!");
  } catch (error) {
    console.error(`\nBuild failed: ${error.message}`);
    process.exit(1);
  }
}

main();

const { spawn } = require("node:child_process");
const path = require("node:path");
const { loadDotEnv } = require("./env");

loadDotEnv();

const electronBuilderBin = path.join(
  __dirname,
  "..",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron-builder.cmd" : "electron-builder",
);

const child = spawn(electronBuilderBin, process.argv.slice(2), {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error("Failed to start electron-builder:", error.message || String(error));
  process.exit(1);
});

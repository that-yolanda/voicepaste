const { clipboard } = require("electron");
const { execFile } = require("node:child_process");

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function runAppleScript(scriptLines) {
  return new Promise((resolve, reject) => {
    const args = scriptLines.flatMap((line) => ["-e", line]);

    execFile("osascript", args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message));
        return;
      }

      resolve(stdout.trim());
    });
  });
}

function runPowerShell(scriptContent) {
  return new Promise((resolve, reject) => {
    execFile("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      scriptContent,
    ], (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message));
        return;
      }

      resolve(stdout.trim());
    });
  });
}

async function pasteTextToFocusedElement(text, keepClipboard = true) {
  const previousText = clipboard.readText();

  clipboard.writeText(text);

  try {
    if (process.platform === "darwin") {
      await runAppleScript([
        'tell application "System Events"',
        'keystroke "v" using command down',
        "end tell",
      ]);
    } else {
      await runPowerShell(
        "(New-Object -ComObject WScript.Shell).SendKeys('^v')"
      );
    }

    // Give the target app a brief moment to read the clipboard before restoring it.
    await sleep(120);

    if (!keepClipboard) {
      clipboard.writeText(previousText);
    }

    return {
      ok: true,
    };
  } catch (error) {
    const msg = error.message || "";
    const isAccessibilityError = process.platform === "darwin" && (
      /not allowed/i.test(msg) ||
      /not authorized/i.test(msg) ||
      /keystroke/i.test(msg) ||
      /apple event/i.test(msg)
    );

    if (!keepClipboard) {
      clipboard.writeText(previousText);
    }
    return {
      ok: false,
      message: msg || "模拟粘贴失败，请检查当前焦点位置",
      permissionError: isAccessibilityError ? "accessibility" : null,
    };
  }
}

module.exports = {
  pasteTextToFocusedElement,
};

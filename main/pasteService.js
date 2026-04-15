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

async function pasteTextToFocusedElement(text, keepClipboard = true) {
  const previousText = clipboard.readText();

  clipboard.writeText(text);

  try {
    await runAppleScript([
      'tell application "System Events"',
      'keystroke "v" using command down',
      "end tell",
    ]);

    // Give the target app a brief moment to read the clipboard before restoring it.
    await sleep(120);

    if (!keepClipboard) {
      clipboard.writeText(previousText);
    }

    return {
      ok: true,
    };
  } catch (error) {
    if (!keepClipboard) {
      clipboard.writeText(previousText);
    }
    return {
      ok: false,
      message: error.message || "模拟粘贴失败，请检查辅助功能权限或当前焦点位置",
    };
  }
}

module.exports = {
  pasteTextToFocusedElement,
};

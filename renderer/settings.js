const elements = {
  configEditor: document.getElementById("configEditor"),
  saveBtn: document.getElementById("saveBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  checkMicBtn: document.getElementById("checkMicBtn"),
  requestMicBtn: document.getElementById("requestMicBtn"),
  micStatusText: document.getElementById("micStatusText"),
  hotkeyChip: document.getElementById("hotkeyChip"),
  configPathChip: document.getElementById("configPathChip"),
  saveStatus: document.getElementById("saveStatus"),
};

function setSaveStatus(text, level = "") {
  elements.saveStatus.textContent = text;
  elements.saveStatus.dataset.level = level;
}

function formatMicStatus(status) {
  const labels = {
    granted: "麦克风权限已授权",
    denied: "麦克风权限已拒绝",
    "not-determined": "麦克风权限未决定",
    restricted: "麦克风权限受系统限制",
    unknown: "麦克风权限未知",
  };

  return labels[status] || `麦克风状态: ${status}`;
}

function applyPayload(payload) {
  elements.configEditor.value = payload.configText || "";
  elements.hotkeyChip.textContent = `热键: ${payload.runtime?.hotkey || "-"}`;
  elements.configPathChip.textContent = `配置文件: ${payload.configPath || "-"}`;
  elements.micStatusText.textContent = formatMicStatus(payload.runtime?.microphoneStatus || "unknown");
  setSaveStatus("已加载", "success");
}

async function loadSettings() {
  const payload = await window.voiceSettings.getData();
  applyPayload(payload);
}

async function saveSettings() {
  setSaveStatus("保存中", "warning");

  try {
    const payload = await window.voiceSettings.saveConfig({
      configText: elements.configEditor.value,
    });
    elements.hotkeyChip.textContent = `热键: ${payload.runtime?.hotkey || "-"}`;
    setSaveStatus("保存成功", "success");
  } catch (error) {
    setSaveStatus(error.message || "保存失败", "error");
  }
}

async function refreshMicStatus() {
  const result = await window.voiceSettings.getMicrophoneStatus();
  elements.micStatusText.textContent = formatMicStatus(result.status || "unknown");
}

async function requestMicAccess() {
  const result = await window.voiceSettings.requestMicrophoneAccess();
  elements.micStatusText.textContent = formatMicStatus(result.status || "unknown");

  if (result.granted) {
    setSaveStatus("麦克风已授权", "success");
    return;
  }

  setSaveStatus("麦克风未授权", "warning");
}

elements.saveBtn.addEventListener("click", saveSettings);
elements.refreshBtn.addEventListener("click", loadSettings);
elements.checkMicBtn.addEventListener("click", refreshMicStatus);
elements.requestMicBtn.addEventListener("click", requestMicAccess);
elements.configEditor.addEventListener("input", () => {
  setSaveStatus("未保存", "warning");
});

window.voiceSettings.onEvent((event) => {
  if (event.type === "microphone-status") {
    elements.micStatusText.textContent = formatMicStatus(event.payload?.status || "unknown");
  }
});

loadSettings();

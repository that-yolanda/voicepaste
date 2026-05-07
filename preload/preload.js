const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("voiceOverlay", {
  onEvent(listener) {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("overlay:event", wrapped);

    return () => {
      ipcRenderer.removeListener("overlay:event", wrapped);
    };
  },
  sendAudioChunk(base64Chunk) {
    return ipcRenderer.invoke("asr:audio-chunk", base64Chunk);
  },
  getConfig() {
    return ipcRenderer.invoke("app:get-config");
  },
  sendDiagnostic(payload) {
    ipcRenderer.send("renderer:diagnostic", payload);
  },
  notifyAudioStopped() {
    ipcRenderer.send("renderer:audio-stopped");
  },
  sendAudioWarmupReady() {
    ipcRenderer.send("renderer:audio-warmup-ready");
  },
  sendAudioWarmupFailed(payload) {
    ipcRenderer.send("renderer:audio-warmup-failed", payload);
  },
});

contextBridge.exposeInMainWorld("voiceSettings", {
  getData() {
    return ipcRenderer.invoke("settings:get-data");
  },
  saveConfig(payload) {
    return ipcRenderer.invoke("settings:save-config", payload);
  },
  saveConfigObject(config) {
    return ipcRenderer.invoke("settings:save-config-object", config);
  },
  getMicrophoneStatus() {
    return ipcRenderer.invoke("settings:get-microphone-status");
  },
  getAccessibilityStatus() {
    return ipcRenderer.invoke("settings:get-accessibility-status");
  },
  requestMicrophoneAccess() {
    return ipcRenderer.invoke("settings:request-microphone-access");
  },
  resetConfig() {
    return ipcRenderer.invoke("settings:reset-config");
  },
  openAccessibilitySettings() {
    return ipcRenderer.invoke("settings:open-accessibility-settings");
  },
  getLoginItemSettings() {
    return ipcRenderer.invoke("settings:get-login-item");
  },
  setLoginItemSettings(enabled) {
    return ipcRenderer.invoke("settings:set-login-item", enabled);
  },
  recordHotkey() {
    return ipcRenderer.invoke("settings:record-hotkey");
  },
  setTheme(preference) {
    return ipcRenderer.invoke("settings:set-theme", preference);
  },
  onEvent(listener) {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("settings:event", wrapped);

    return () => {
      ipcRenderer.removeListener("settings:event", wrapped);
    };
  },
  checkForUpdates() {
    return ipcRenderer.invoke("update:check");
  },
  downloadUpdate() {
    return ipcRenderer.invoke("update:download");
  },
  installUpdate() {
    return ipcRenderer.invoke("update:install");
  },
  getStats() {
    return ipcRenderer.invoke("stats:get");
  },
  getHistory(daysBack) {
    return ipcRenderer.invoke("stats:get-history", daysBack);
  },
});

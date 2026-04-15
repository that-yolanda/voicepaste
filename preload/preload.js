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
  requestMicrophoneAccess() {
    return ipcRenderer.invoke("settings:request-microphone-access");
  },
  resetConfig() {
    return ipcRenderer.invoke("settings:reset-config");
  },
  openAccessibilitySettings() {
    return ipcRenderer.invoke("settings:open-accessibility-settings");
  },
  startHotkeyRecording() {
    return ipcRenderer.invoke("settings:start-hotkey-recording");
  },
  stopHotkeyRecording() {
    return ipcRenderer.invoke("settings:stop-hotkey-recording");
  },
  onEvent(listener) {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("settings:event", wrapped);

    return () => {
      ipcRenderer.removeListener("settings:event", wrapped);
    };
  },
});

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
  resizeOverlay(size) {
    return ipcRenderer.invoke("overlay:resize", size);
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
  getMicrophoneStatus() {
    return ipcRenderer.invoke("settings:get-microphone-status");
  },
  requestMicrophoneAccess() {
    return ipcRenderer.invoke("settings:request-microphone-access");
  },
  onEvent(listener) {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("settings:event", wrapped);

    return () => {
      ipcRenderer.removeListener("settings:event", wrapped);
    };
  },
});

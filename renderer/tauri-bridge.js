/**
 * Tauri IPC Bridge — provides the same API surface as Electron's preload.js
 * but routes all calls through Tauri's invoke/emit mechanism.
 *
 * Drop this <script> into both index.html and settings.html before app.js/settings.js.
 * It creates window.voiceOverlay and window.voiceSettings matching the Electron preload API.
 */
(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  // ---------------------------------------------------------------------------
  // Overlay API (window.voiceOverlay)
  // ---------------------------------------------------------------------------
  window.voiceOverlay = {
    /**
     * Listen for overlay events from the backend.
     * @param {function} listener - callback(event: { type, payload })
     * @returns {function} cleanup function
     */
    onEvent(listener) {
      let active = true;

      const unlisten = listen("overlay:event", (event) => {
        if (active && listener) {
          listener(event.payload);
        }
      });

      return () => {
        active = false;
        unlisten.then((fn) => fn());
      };
    },

    /**
     * Send a base64-encoded audio chunk to the backend ASR session.
     */
    async sendAudioChunk(base64Chunk) {
      return invoke("send_audio_chunk", { base64Chunk });
    },

    /**
     * Send a diagnostic message from the renderer.
     */
    async sendDiagnostic(payload) {
      return invoke("send_diagnostic", { payload });
    },

    /**
     * Notify the backend that audio capture has stopped.
     */
    async notifyAudioStopped() {
      return invoke("audio_stopped");
    },

    /**
     * Notify the backend that audio warmup is ready.
     */
    async sendAudioWarmupReady() {
      return invoke("audio_warmup_ready");
    },

    /**
     * Notify the backend that audio warmup failed.
     */
    async sendAudioWarmupFailed(payload) {
      return invoke("audio_warmup_failed", { message: payload?.message || "" });
    },

    /**
     * Get the current app configuration.
     */
    async getConfig() {
      return invoke("get_app_config");
    },
  };

  // ---------------------------------------------------------------------------
  // Settings API (window.voiceSettings)
  // ---------------------------------------------------------------------------
  window.voiceSettings = {
    /**
     * Get all settings data.
     */
    async getData() {
      return invoke("get_settings_data");
    },

    /**
     * Save config as raw YAML text.
     */
    async saveConfig(payload) {
      return invoke("save_config", { configText: payload?.configText || "" });
    },

    /**
     * Save config as a parsed object.
     */
    async saveConfigObject(config) {
      return invoke("save_config_object", { configObject: config });
    },

    /**
     * Reset config to default.
     */
    async resetConfig() {
      return invoke("reset_config");
    },

    /**
     * Get microphone permission status.
     */
    async getMicrophoneStatus() {
      return invoke("get_microphone_status");
    },

    /**
     * Request microphone access.
     */
    async requestMicrophoneAccess() {
      return invoke("request_microphone_access");
    },

    /**
     * Get accessibility permission status.
     */
    async getAccessibilityStatus() {
      return invoke("get_accessibility_status");
    },

    /**
     * Open system accessibility settings.
     */
    async openAccessibilitySettings() {
      return invoke("open_accessibility_settings");
    },

    /**
     * Get login item (auto-start) settings.
     * Uses Tauri autostart plugin.
     */
    async getLoginItemSettings() {
      const { isEnabled } = window.__TAURI__.autostart;
      try {
        const enabled = await isEnabled();
        return { openAtLogin: enabled };
      } catch {
        return { openAtLogin: false };
      }
    },

    /**
     * Set login item (auto-start) setting.
     */
    async setLoginItemSettings(enabled) {
      const { enable, disable, isEnabled } = window.__TAURI__.autostart;
      if (enabled) {
        await enable();
      } else {
        await disable();
      }
      const result = await isEnabled();
      return { openAtLogin: result };
    },

    /**
     * Record a custom hotkey.
     * Uses DOM keyboard events (window capture phase) since rdev is not
     * compatible with macOS 26+.  Window capture fires before the document
     * capture handler in settings.js (suppressKeyboardDuringHotkeyRecording),
     * so we see the events first.
     * Returns { hotkey, displayString, keys }.
     */
    async recordHotkey() {
      const pressed = new Set();

      const keyNameMap = {
        ControlLeft: "Control",
        ControlRight: "Control",
        ShiftLeft: "Shift",
        ShiftRight: "Shift",
        AltLeft: "Alt",
        AltRight: "Alt",
        MetaLeft: "Command",
        MetaRight: "Command",
        ArrowUp: "Up",
        ArrowDown: "Down",
        ArrowLeft: "Left",
        ArrowRight: "Right",
        Backspace: "Backspace",
        Tab: "Tab",
        Space: "Space",
        Escape: "Escape",
        Enter: "Enter",
        Delete: "Delete",
        Insert: "Insert",
        Home: "Home",
        End: "End",
        PageUp: "PageUp",
        PageDown: "PageDown",
        CapsLock: "CapsLock",
      };

      return new Promise((resolve) => {
        let settled = false;

        const finish = (result) => {
          if (settled) return;
          settled = true;
          window.removeEventListener("keydown", onKeyDown, true);
          window.removeEventListener("keyup", onKeyUp, true);
          resolve(result);
        };

        const onKeyDown = (e) => {
          // Record the pressed key code
          pressed.add(e.code);

          // Escape cancels recording
          if (e.code === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            finish({ keys: [], displayString: "" });
            return;
          }

          // Stop propagation only (NOT preventDefault!) to avoid suppressing keyup
          // on macOS WKWebView, where preventDefault on keydown kills the keyup event.
          e.stopPropagation();
        };

        const onKeyUp = (e) => {
          if (settled) return;
          // Only stop propagation — preventDefault here can suppress subsequent events
          e.stopPropagation();

          // Wait until the last modifier key is released to finalize
          if (
            e.code.startsWith("Control") ||
            e.code.startsWith("Shift") ||
            e.code.startsWith("Alt") ||
            e.code.startsWith("Meta")
          ) {
            return;
          }

          // Build the hotkey string: modifiers first, then the main key
          const mods = [];
          let mainKey = "";
          for (const code of pressed) {
            if (code.startsWith("Control")) {
              mods.push("Control");
            } else if (code.startsWith("Shift")) {
              mods.push("Shift");
            } else if (code.startsWith("Alt")) {
              mods.push("Alt");
            } else if (code.startsWith("Meta")) {
              mods.push("Command");
            } else {
              mainKey = keyNameMap[code] || code.replace(/^(Key|Digit)/, "");
            }
          }

          // De-duplicate modifiers and sort canonically
          const uniqueMods = [...new Set(mods)];
          const modOrder = ["Control", "Alt", "Shift", "Command"];
          const sortedMods = modOrder.filter((m) => uniqueMods.includes(m));

          if (!mainKey) {
            // Only modifiers released — wait for the real key
            return;
          }

          const hotkey = [...sortedMods, mainKey].join("+");
          finish({ keys: [hotkey], displayString: hotkey, hotkey });
        };

        window.addEventListener("keydown", onKeyDown, true);
        window.addEventListener("keyup", onKeyUp, true);
      });
    },

    /**
     * Set theme preference.
     */
    async setTheme(preference) {
      // Save theme to config
      const data = await invoke("get_settings_data");
      const config = data.parsedConfig;
      if (!config.app) config.app = {};
      config.app.theme = preference;
      await invoke("save_config_object", { configObject: config });
      return { preference, resolved: preference };
    },

    /**
     * Get usage statistics.
     */
    async getStats() {
      return invoke("get_stats");
    },

    /**
     * Get usage history.
     */
    async getHistory(daysBack) {
      return invoke("get_history", { daysBack: daysBack || 3 });
    },

    /**
     * Delete a history entry.
     */
    async deleteHistory(ts) {
      return invoke("delete_history", { ts });
    },

    /**
     * Load prompt templates.
     */
    async loadPrompts() {
      return invoke("load_prompts");
    },

    /**
     * Save prompt templates.
     */
    async savePrompts(prompts) {
      return invoke("save_prompts", { prompts });
    },

    /**
     * Select a sound file.
     */
    async selectSoundFile() {
      return invoke("select_sound_file");
    },

    /**
     * Check for updates.
     * TODO: Implement with tauri-plugin-updater
     */
    async checkForUpdates() {
      return { status: "not-available" };
    },

    /**
     * Download update.
     * TODO: Implement with tauri-plugin-updater
     */
    async downloadUpdate() {
      return { status: "error", message: "Updates not yet implemented in Tauri" };
    },

    /**
     * Install update.
     * TODO: Implement with tauri-plugin-updater
     */
    async installUpdate() {
      return { status: "error", message: "Updates not yet implemented in Tauri" };
    },

    /**
     * Listen for settings events from the backend.
     */
    onEvent(listener) {
      let active = true;

      const unlisten = listen("settings:event", (event) => {
        if (active && listener) {
          listener(event.payload);
        }
      });

      return () => {
        active = false;
        unlisten.then((fn) => fn());
      };
    },
  };

  console.log("[TauriBridge] voiceOverlay and voiceSettings APIs initialized");
})();

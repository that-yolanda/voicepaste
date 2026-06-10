/**
 * Tauri IPC Bridge — provides the frontend API surface
 * but routes all calls through Tauri's invoke/emit mechanism.
 *
 * Drop this <script> into both index.html and settings.html before app.js/settings.js.
 * It creates window.voiceOverlay and window.voiceSettings APIs.
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
     *
     * Queries the real macOS TCC status via AVFoundation (or WebView on
     * other platforms).  Returns "granted", "denied", "prompt" (never asked),
     * or "restricted".
     */
    async getMicrophoneStatus() {
      return invoke("get_microphone_status");
    },

    /**
     * Request microphone access.
     *
     * Opens the system permission dialog via getUserMedia.  The stream is
     * closed immediately — we only need the permission grant, not an active
     * recording.
     */
    async requestMicrophoneAccess() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => {
          t.stop();
        });
        return { status: "granted", granted: true };
      } catch (e) {
        // Permission denied, device not found, or user cancelled
        const message = e instanceof Error ? e.message : String(e);
        return { status: "denied", granted: false, error: message };
      }
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
     * Retry starting the keytap hotkey listener.
     *
     * Call after the user grants accessibility permission in System
     * Settings and returns to the app.  Returns { active: true } when
     * the listener is now running.
     */
    async reinitHotkey() {
      return invoke("reinit_hotkey");
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
     * Uses DOM keyboard events (window capture phase).
     * Supports left/right modifier distinction and modifier-only hotkeys.
     * Returns { hotkey, displayString, keys }.
     */
    async recordHotkey() {
      const pressed = new Set();
      const isMacLikePlatform = /\b(Mac|iPhone|iPad|iPod)\b/.test(
        `${navigator.platform || ""} ${navigator.userAgent || ""}`,
      );

      // Map DOM code names to hotkey config names.
      // Left/right modifiers keep their side-specific names for keytap.
      const keyNameMap = {
        ControlLeft: "ControlLeft",
        ControlRight: "ControlRight",
        ShiftLeft: "ShiftLeft",
        ShiftRight: "ShiftRight",
        AltLeft: "AltLeft",
        AltRight: "AltRight",
        MetaLeft: "MetaLeft",
        MetaRight: "MetaRight",
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
        let modifierTimer = null;

        const finish = (result) => {
          if (settled) return;
          settled = true;
          if (modifierTimer) clearTimeout(modifierTimer);
          window.removeEventListener("keydown", onKeyDown, true);
          window.removeEventListener("keyup", onKeyUp, true);
          resolve(result);
        };

        const isModifier = (code) =>
          code.startsWith("Control") ||
          code.startsWith("Shift") ||
          code.startsWith("Alt") ||
          code.startsWith("Meta");

        // Build the hotkey string from the current pressed set.
        // Sorts modifiers canonically: Control, Alt, Shift, Meta (left variants before right).
        const buildHotkey = (includeMainKey) => {
          const mods = [];
          let mainKey = "";
          for (const code of pressed) {
            if (code.startsWith("Control")) {
              mods.push(keyNameMap[code] || "ControlLeft");
            } else if (code.startsWith("Shift")) {
              mods.push(keyNameMap[code] || "ShiftLeft");
            } else if (code.startsWith("Alt")) {
              mods.push(keyNameMap[code] || "AltLeft");
            } else if (code.startsWith("Meta")) {
              mods.push(keyNameMap[code] || "MetaLeft");
            } else {
              mainKey = keyNameMap[code] || code.replace(/^(Key|Digit)/, "");
            }
          }

          // De-duplicate and sort canonically
          const uniqueMods = [...new Set(mods)];
          const modOrder = [
            "ControlLeft",
            "ControlRight",
            "Control",
            "AltLeft",
            "AltRight",
            "Alt",
            "ShiftLeft",
            "ShiftRight",
            "Shift",
            "MetaLeft",
            "MetaRight",
            "Command",
          ];
          const sortedMods = modOrder.filter((m) => uniqueMods.includes(m));

          if (!includeMainKey && mainKey) return null;
          if (!includeMainKey && sortedMods.length === 0) return null;

          const parts = includeMainKey && mainKey ? [...sortedMods, mainKey] : sortedMods;
          return parts.join("+");
        };

        // Schedule modifier-only finalization after a debounce period.
        // If the user holds only modifier keys for 300ms without pressing
        // another key, finalize as a modifier-only hotkey.
        const scheduleModifierFinalize = () => {
          if (modifierTimer) clearTimeout(modifierTimer);
          const allModifiers = [...pressed].every(isModifier);
          if (allModifiers && pressed.size > 0) {
            modifierTimer = setTimeout(() => {
              if (settled) return;
              const hotkey = buildHotkey(false);
              if (hotkey) {
                finish({ keys: [hotkey], displayString: hotkey, hotkey });
              }
            }, 300);
          }
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

          // Windows WebView scrolls on Space unless keydown default is blocked.
          // Keep macOS WKWebView behavior unchanged because preventDefault on
          // keydown can suppress the keyup event needed to finish recording.
          if (!isMacLikePlatform) {
            e.preventDefault();
          }
          e.stopPropagation();

          // If a non-modifier key was pressed, cancel modifier-only timer
          if (!isModifier(e.code)) {
            if (modifierTimer) clearTimeout(modifierTimer);
          }
        };

        const onKeyUp = (e) => {
          if (settled) return;
          // Only stop propagation — preventDefault here can suppress subsequent events
          e.stopPropagation();

          // If a non-modifier key was released, finalize with modifiers + main key
          if (!isModifier(e.code)) {
            const hotkey = buildHotkey(true);
            if (hotkey) {
              finish({ keys: [hotkey], displayString: hotkey, hotkey });
            }
            return;
          }

          // Modifier released: check if we should finalize modifier-only
          // Schedule a check — if no new key comes within 50ms, try to finalize
          if (modifierTimer) clearTimeout(modifierTimer);
          const allModifiers = [...pressed].every(isModifier);
          if (allModifiers && pressed.size > 0) {
            // Still holding some modifiers — start debounce
            scheduleModifierFinalize();
          } else if (pressed.size === 0) {
            // All keys released without a main key — don't finalize (empty binding)
          }
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
      // Re-read to get the properly resolved theme from the backend.
      const updated = await invoke("get_settings_data");
      return {
        preference,
        resolved: updated.runtime?.theme?.resolved || preference,
      };
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
     * Check for updates via Tauri updater plugin.
     * Returns { available: boolean, version?: string, date?: string, notes?: string }
     */
    async checkForUpdates() {
      return invoke("check_for_update");
    },

    /**
     * Download and install the pending update.
     * Progress is broadcast via update:progress / update:finished events.
     */
    async downloadUpdate() {
      return invoke("download_and_install_update");
    },

    /**
     * Restart the app to apply the installed update.
     */
    async installUpdate() {
      const { relaunch } = window.__TAURI__.process;
      await relaunch();
    },

    /**
     * Listen for update download progress events.
     * @param {function} listener - callback({ downloaded, contentLength } | { finished: true })
     * @returns {function} cleanup function
     */
    onUpdateProgress(listener) {
      let active = true;
      const p = listen("update:progress", (event) => {
        if (active && listener) listener(event.payload);
      });
      const f = listen("update:finished", () => {
        if (active && listener) listener({ finished: true });
      });
      return () => {
        active = false;
        p.then((fn) => fn());
        f.then((fn) => fn());
      };
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

    // ===== Model Management =====

    getModelRegistry() {
      return invoke("get_model_registry");
    },

    getDownloadedModels() {
      return invoke("get_downloaded_models");
    },

    downloadModel(modelId) {
      return invoke("download_model", { modelId });
    },

    /**
     * Listen for model download progress events.
     * @param {function} listener - callback({ model_id, status, progress })
     * @returns {function} cleanup function
     */
    onModelDownloadProgress(listener) {
      let active = true;
      const unlisten = listen("model:download:progress", (event) => {
        if (active && listener) {
          listener(event.payload);
        }
      });
      return () => {
        active = false;
        unlisten.then((fn) => fn());
      };
    },

    deleteModel(modelId) {
      return invoke("delete_model", { modelId });
    },

    // ===== Hotword Management =====

    loadHotwords() {
      return invoke("load_hotwords");
    },

    saveHotwords(data) {
      return invoke("save_hotwords", { data });
    },
  };

  console.log("[TauriBridge] voiceOverlay and voiceSettings APIs initialized");
})();

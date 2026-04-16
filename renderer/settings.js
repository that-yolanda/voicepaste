(() => {
  let parsedConfig = {};
  let originalConfigText = "";
  let hotwords = [];
  let isDirty = false;

  const $ = (id) => document.getElementById(id);

  const el = {
    saveBtn: $("saveBtn"),
    reloadBtn: $("reloadBtn"),
    saveStatus: $("saveStatus"),
    hotkey: $("hotkey"),
    recordHotkeyBtn: $("recordHotkeyBtn"),
    configPath: $("configPath"),
    micDot: $("micDot"),
    micText: $("micText"),
    checkMicBtn: $("checkMicBtn"),
    requestMicBtn: $("requestMicBtn"),
    wsUrl: $("wsUrl"),
    resourceId: $("resourceId"),
    language: $("language"),
    enableDdc: $("enableDdc"),
    enableNonstream: $("enableNonstream"),
    enableItn: $("enableItn"),
    enablePunc: $("enablePunc"),
    boostingTableId: $("boostingTableId"),
    hotwordTags: $("hotwordTags"),
    newHotword: $("newHotword"),
    newWeight: $("newWeight"),
    addHotwordBtn: $("addHotwordBtn"),
    appId: $("appId"),
    accessToken: $("accessToken"),
    secretKey: $("secretKey"),
    toggleAccessToken: $("toggleAccessToken"),
    toggleSecretKey: $("toggleSecretKey"),
    yamlEditor: $("yamlEditor"),
    reloadYamlBtn: $("reloadYamlBtn"),
    saveYamlBtn: $("saveYamlBtn"),
  };

  function setSaveStatus(text, level) {
    el.saveStatus.textContent = text;
    el.saveStatus.dataset.level = level || "";
  }

  function markDirty() {
    if (!isDirty) {
      isDirty = true;
      setSaveStatus("未保存", "dirty");
    }
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function loadSettings() {
    try {
      const data = await window.voiceSettings.getData();
      originalConfigText = data.configText || "";
      parsedConfig = data.parsedConfig || {};
      populateForm(data);
      el.yamlEditor.value = data.configText || "";
      updateMicStatus(data.runtime?.microphoneStatus || "unknown");
      isDirty = false;
      setSaveStatus("已加载", "success");
    } catch (err) {
      setSaveStatus("加载失败", "error");
    }
  }

  function populateForm(data) {
    const c = parsedConfig;

    el.hotkey.value = data.runtime?.hotkeyDisplay || (Array.isArray(c.app?.hotkey) ? "自定义快捷键" : c.app?.hotkey || "F13");
    el.configPath.textContent = data.configPath || "-";

    el.wsUrl.value = c.connection?.url || "";
    el.resourceId.value = c.connection?.resource_id || "";
    el.language.value = c.audio?.language || "";

    el.enableDdc.checked = c.request?.enable_ddc !== false;
    el.enableNonstream.checked = Boolean(c.request?.enable_nonstream);
    el.enableItn.checked = c.request?.enable_itn !== false;
    el.enablePunc.checked = c.request?.enable_punc !== false;

    el.boostingTableId.value = c.request?.corpus?.boosting_table_id || "";

    hotwords = Array.isArray(c.request?.corpus?.context_hotwords)
      ? c.request.corpus.context_hotwords
          .map((h) => {
            if (typeof h === "string") return { word: h, weight: 8 };
            return { word: h.word || "", weight: h.weight || 8 };
          })
          .filter((h) => h.word.trim())
      : [];
    renderHotwords();

    el.appId.value = c.connection?.app_id || "";
    el.accessToken.value = c.connection?.access_token || "";
    el.secretKey.value = c.connection?.secret_key || "";
  }

  function collectConfig() {
    const config = JSON.parse(JSON.stringify(parsedConfig));

    config.app = config.app || {};
    // config.app.hotkey is maintained directly in parsedConfig when recording or loaded

    config.connection = config.connection || {};
    config.connection.url = el.wsUrl.value.trim();
    config.connection.resource_id = el.resourceId.value.trim();
    config.connection.app_id = el.appId.value.trim();
    config.connection.access_token = el.accessToken.value.trim();
    config.connection.secret_key = el.secretKey.value.trim();

    config.audio = config.audio || {};
    const lang = el.language.value.trim();
    if (lang) {
      config.audio.language = lang;
    } else {
      delete config.audio.language;
    }

    config.request = config.request || {};
    config.request.enable_ddc = el.enableDdc.checked;
    config.request.enable_nonstream = el.enableNonstream.checked;
    config.request.enable_itn = el.enableItn.checked;
    config.request.enable_punc = el.enablePunc.checked;

    config.request.corpus = config.request.corpus || {};
    config.request.corpus.boosting_table_id = el.boostingTableId.value.trim();
    config.request.corpus.context_hotwords = hotwords.map((h) => ({
      word: h.word,
      weight: h.weight,
    }));

    return config;
  }

  async function saveFromForm() {
    setSaveStatus("保存中...", "saving");
    try {
      const config = collectConfig();
      await window.voiceSettings.saveConfigObject(config);
      await loadSettings();
    } catch (err) {
      setSaveStatus(err.message || "保存失败", "error");
    }
  }

  async function saveFromYaml() {
    setSaveStatus("保存中...", "saving");
    try {
      await window.voiceSettings.saveConfig({
        configText: el.yamlEditor.value,
      });
      await loadSettings();
    } catch (err) {
      setSaveStatus(err.message || "保存失败", "error");
    }
  }

  function updateMicStatus(status) {
    const labels = {
      granted: "已授权",
      denied: "已拒绝",
      "not-determined": "未决定",
      restricted: "受限制",
      unknown: "未知",
    };
    el.micText.textContent = labels[status] || status;
    el.micDot.dataset.status = status;
  }

  async function checkMic() {
    const result = await window.voiceSettings.getMicrophoneStatus();
    updateMicStatus(result.status || "unknown");
  }

  async function requestMic() {
    const result = await window.voiceSettings.requestMicrophoneAccess();
    updateMicStatus(result.status || "unknown");
  }

  function renderHotwords() {
    el.hotwordTags.innerHTML = hotwords
      .map(
        (h, i) =>
          `<span class="tag">` +
          `<span class="tag-word">${escapeHtml(h.word)}</span>` +
          `<span class="tag-weight">${h.weight}</span>` +
          `<button type="button" class="tag-remove" data-index="${i}" title="移除">&times;</button>` +
          `</span>`
      )
      .join("");
  }

  function addHotword() {
    const word = el.newHotword.value.trim();
    const weight = Math.max(1, Math.min(20, parseInt(el.newWeight.value, 10) || 8));
    if (!word) return;
    hotwords.push({ word, weight });
    el.newHotword.value = "";
    renderHotwords();
    markDirty();
  }

  function removeHotword(index) {
    hotwords.splice(index, 1);
    renderHotwords();
    markDirty();
  }

  function toggleSecret(inputId, btn) {
    const input = $(inputId);
    if (input.type === "password") {
      input.type = "text";
      btn.textContent = "隐藏";
    } else {
      input.type = "password";
      btn.textContent = "显示";
    }
  }

  // ===== HOTKEY RECORDING =====

  async function recordHotkey() {
    if (el.recordHotkeyBtn.disabled) return;
    el.recordHotkeyBtn.disabled = true;
    const oldText = el.hotkey.value;
    const oldBtnText = el.recordHotkeyBtn.textContent;
    
    el.hotkey.value = "请按下快捷键组合并松开...";
    el.recordHotkeyBtn.textContent = "录制中...";
    
    try {
      const result = await window.voiceSettings.recordHotkey();
      const keys = Array.isArray(result) ? result : result?.keys;
      const displayString = result?.displayString || "自定义";

      if (keys && keys.length > 0) {
        parsedConfig.app = parsedConfig.app || {};
        parsedConfig.app.hotkey = keys;
        
        // Use placeholder text for immediate UI feedback.
        // True hotkey display format relies on main process logic and updates post-save.
        el.hotkey.value = `已录制（${displayString}），点击右上角“保存配置”生效`;
        markDirty();
      } else {
        el.hotkey.value = oldText;
      }
    } catch(err) {
      el.hotkey.value = oldText;
    } finally {
      el.recordHotkeyBtn.disabled = false;
      el.recordHotkeyBtn.textContent = oldBtnText;
    }
  }

  // ===== EVENT LISTENERS =====

  el.saveBtn.addEventListener("click", saveFromForm);
  el.reloadBtn.addEventListener("click", loadSettings);

  if (el.recordHotkeyBtn) {
    el.recordHotkeyBtn.addEventListener("click", recordHotkey);
  }

  el.checkMicBtn.addEventListener("click", checkMic);
  el.requestMicBtn.addEventListener("click", requestMic);

  el.addHotwordBtn.addEventListener("click", addHotword);
  el.newHotword.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addHotword();
  });
  el.hotwordTags.addEventListener("click", (e) => {
    const btn = e.target.closest(".tag-remove");
    if (btn) removeHotword(parseInt(btn.dataset.index, 10));
  });

  el.toggleAccessToken.addEventListener("click", () =>
    toggleSecret("accessToken", el.toggleAccessToken)
  );
  el.toggleSecretKey.addEventListener("click", () =>
    toggleSecret("secretKey", el.toggleSecretKey)
  );

  el.reloadYamlBtn.addEventListener("click", loadSettings);
  el.saveYamlBtn.addEventListener("click", saveFromYaml);

  // Track changes on all form inputs
  const inputs = [
    el.wsUrl,
    el.resourceId,
    el.language,
    el.boostingTableId,
    el.appId,
    el.accessToken,
    el.secretKey,
  ];
  inputs.forEach((input) => {
    if (input) input.addEventListener("input", markDirty);
  });

  const toggles = [
    el.enableDdc,
    el.enableNonstream,
    el.enableItn,
    el.enablePunc,
  ];
  toggles.forEach((toggle) => {
    if (toggle) toggle.addEventListener("change", markDirty);
  });

  el.yamlEditor.addEventListener("input", markDirty);

  // Collapsible sections
  document.querySelectorAll(".collapse-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const section = btn.closest(".section");
      section.classList.toggle("is-open");
      btn.setAttribute(
        "aria-expanded",
        section.classList.contains("is-open")
      );
    });
  });

  // Mic status events from main process
  window.voiceSettings.onEvent((event) => {
    if (event.type === "microphone-status") {
      updateMicStatus(event.payload?.status || "unknown");
    }
  });

  // Init
  loadSettings();
})();

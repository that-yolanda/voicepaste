(() => {
  let parsedConfig = {};
  let originalConfigText = "";
  let hotwords = [];
  let isDirty = false;

  const $ = (id) => document.getElementById(id);

  const el = {
    saveBtn: $("saveBtn"),
    resetBtn: $("resetBtn"),
    reloadBtn: $("reloadBtn"),
    saveStatus: $("saveStatus"),
    hotkey: $("hotkey"),
    hotkeyRecorder: $("hotkeyRecorder"),
    hotkeyRecordBtn: $("hotkeyRecordBtn"),
    hotkeyHint: $("hotkeyHint"),
    appVersion: $("appVersion"),
    configPath: $("configPath"),
    autoStart: $("autoStart"),
    micDot: $("micDot"),
    micText: $("micText"),
    checkMicBtn: $("checkMicBtn"),
    requestMicBtn: $("requestMicBtn"),
    accessibilityRow: $("accessibilityRow"),
    permHint: $("permHint"),
    openAccBtn: $("openAccBtn"),
    wsUrl: $("wsUrl"),
    resourceId: $("resourceId"),
    language: $("language"),
    enableDdc: $("enableDdc"),
    enableNonstream: $("enableNonstream"),
    enableItn: $("enableItn"),
    enablePunc: $("enablePunc"),
    removeTrailingPeriod: $("removeTrailingPeriod"),
    keepClipboard: $("keepClipboard"),
    boostingTableId: $("boostingTableId"),
    hotwordTags: $("hotwordTags"),
    hotwordHint: $("hotwordHint"),
    newHotword: $("newHotword"),
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

      // Load auto-start state from system login items
      try {
        const loginSettings = await window.voiceSettings.getLoginItemSettings();
        el.autoStart.checked = loginSettings.openAtLogin;
      } catch (_) { /* ignore */ }
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
    el.appVersion.textContent = "v" + (data.runtime?.version || "");

    if (data.runtime?.platform !== "darwin" && el.accessibilityRow) {
      el.accessibilityRow.style.display = "none";
    }

    if (el.permHint) {
      el.permHint.textContent = data.runtime?.platform === "darwin"
        ? "macOS 需要麦克风权限和辅助功能权限，可前往：系统设置 > 隐私与安全 > 麦克风 / 辅助功能"
        : "当前系统无需额外权限配置。";
    }

    el.wsUrl.value = c.connection?.url || "";
    el.resourceId.value = c.connection?.resource_id || "";
    el.language.value = c.audio?.language || "";

    el.enableDdc.checked = c.request?.enable_ddc !== false;
    el.enableNonstream.checked = Boolean(c.request?.enable_nonstream);
    el.enableItn.checked = c.request?.enable_itn !== false;
    el.enablePunc.checked = c.request?.enable_punc !== false;
    el.removeTrailingPeriod.checked = c.app?.remove_trailing_period !== false;
    el.keepClipboard.checked = c.app?.keep_clipboard !== false;

    el.boostingTableId.value = c.request?.corpus?.boosting_table_id || "";

    const raw = c.request?.corpus?.context_hotwords;
    if (typeof raw === "string") {
      hotwords = raw.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (Array.isArray(raw)) {
      hotwords = raw
        .map((h) => (typeof h === "string" ? h.trim() : (h?.word || "").trim()))
        .filter(Boolean);
    } else {
      hotwords = [];
    }
    renderHotwords();

    el.appId.value = c.connection?.app_id || "";
    el.accessToken.value = c.connection?.access_token || "";
    el.secretKey.value = c.connection?.secret_key || "";
  }

  function collectConfig() {
    const config = JSON.parse(JSON.stringify(parsedConfig));

    config.app = config.app || {};
    config.app.hotkey = config.app.hotkey || el.hotkey.value.trim() || "F13";
    config.app.remove_trailing_period = el.removeTrailingPeriod.checked;
    config.app.keep_clipboard = el.keepClipboard.checked;

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
    delete config.request.remove_trailing_period;

    config.request.corpus = config.request.corpus || {};
    config.request.corpus.boosting_table_id = el.boostingTableId.value.trim();
    config.request.corpus.context_hotwords = hotwords.join(", ");

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

  function renderHotwords(filter = "") {
    const query = filter.trim().toLowerCase();
    el.hotwordTags.innerHTML = hotwords
      .map((word, i) => {
        const isMatch = query && word.toLowerCase() === query;
        const isDimmed = query && !word.toLowerCase().includes(query);
        const cls = "tag" + (isMatch ? " is-match" : isDimmed ? " is-dimmed" : "");
        return (
          `<span class="${cls}">` +
          `<span class="tag-word">${escapeHtml(word)}</span>` +
          `<button type="button" class="tag-remove" data-index="${i}" title="移除">&times;</button>` +
          `</span>`
        );
      })
      .join("");
  }

  function setHotwordHint(text, level) {
    el.hotwordHint.textContent = text;
    el.hotwordHint.dataset.level = level || "";
  }

  function addHotword() {
    const word = el.newHotword.value.trim();
    if (!word) return;
    if (hotwords.includes(word)) {
      setHotwordHint(`「${word}」已存在`, "warn");
      return;
    }
    hotwords.push(word);
    el.newHotword.value = "";
    setHotwordHint("", "");
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

  let isRecordingHotkey = false;
  let hotkeyBackup = "";

  function setHotkeyHint(text, level) {
    el.hotkeyHint.textContent = text;
    el.hotkeyHint.dataset.level = level || "";
  }

  async function recordHotkey() {
    if (isRecordingHotkey) return;
    hotkeyBackup = el.hotkey.value;
    isRecordingHotkey = true;
    el.hotkeyRecorder.classList.add("is-recording");
    el.hotkey.value = "";
    el.hotkey.placeholder = "请按下快捷键组合并松开...";
    el.hotkeyRecordBtn.textContent = "录制中...";
    setHotkeyHint("按下快捷键组合并松开，Esc 取消", "");

    try {
      const result = await window.voiceSettings.recordHotkey();
      const keys = Array.isArray(result) ? result : result?.keys;
      const displayString = result?.displayString || "自定义快捷键";

      if (keys && keys.length > 0) {
        parsedConfig.app = parsedConfig.app || {};
        parsedConfig.app.hotkey = keys;
        el.hotkey.value = displayString;
        setHotkeyHint("已录制，点击右上角“保存配置”生效", "success");
        markDirty();
      } else {
        el.hotkey.value = hotkeyBackup;
        setHotkeyHint("", "");
      }
    } catch (err) {
      el.hotkey.value = hotkeyBackup;
      setHotkeyHint(err?.message || "", err?.message ? "error" : "");
    } finally {
      isRecordingHotkey = false;
      el.hotkeyRecorder.classList.remove("is-recording");
      el.hotkey.placeholder = "点击「录制」设置热键";
      el.hotkeyRecordBtn.textContent = "录制";
    }
  }

  // ===== EVENT LISTENERS =====

  el.saveBtn.addEventListener("click", saveFromForm);
  el.resetBtn.addEventListener("click", async () => {
    if (!confirm("确定要还原为默认配置吗？当前配置将被覆盖。")) return;
    setSaveStatus("还原中...", "saving");
    try {
      await window.voiceSettings.resetConfig();
      await loadSettings();
    } catch (err) {
      setSaveStatus(err.message || "还原失败", "error");
    }
  });
  el.reloadBtn.addEventListener("click", loadSettings);

  el.autoStart.addEventListener("change", async () => {
    await window.voiceSettings.setLoginItemSettings(el.autoStart.checked);
  });

  el.checkMicBtn.addEventListener("click", checkMic);
  el.requestMicBtn.addEventListener("click", requestMic);
  el.openAccBtn.addEventListener("click", () => {
    window.voiceSettings.openAccessibilitySettings();
  });

  el.hotkeyRecordBtn.addEventListener("click", recordHotkey);

  el.addHotwordBtn.addEventListener("click", addHotword);
  el.newHotword.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addHotword();
  });
  el.newHotword.addEventListener("input", () => {
    const val = el.newHotword.value.trim();
    renderHotwords(val);
    if (val && hotwords.includes(val)) {
      setHotwordHint(`「${val}」已存在`, "warn");
    } else {
      setHotwordHint("", "");
    }
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
    el.removeTrailingPeriod,
    el.keepClipboard,
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

  // Sidebar navigation
  const sidebarNav = $("sidebarNav");
  const contentEl = document.querySelector(".content");
  const sections = document.querySelectorAll(".content .section[data-nav]");

  sections.forEach((section) => {
    const label = section.dataset.nav;
    const link = document.createElement("a");
    link.className = "sidebar-link";
    link.textContent = label;
    link.href = "#" + section.id;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      section.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    sidebarNav.appendChild(link);
  });

  const sidebarLinks = sidebarNav.querySelectorAll(".sidebar-link");

  function updateActiveNav() {
    const scrollTop = contentEl.scrollTop;
    const offset = 80;
    let activeIndex = 0;

    sections.forEach((section, i) => {
      const top = section.offsetTop - contentEl.offsetTop - offset;
      if (scrollTop >= top) {
        activeIndex = i;
      }
    });

    sidebarLinks.forEach((link, i) => {
      link.classList.toggle("active", i === activeIndex);
    });
  }

  contentEl.addEventListener("scroll", updateActiveNav, { passive: true });
  updateActiveNav();

  // Mic status events from main process
  window.voiceSettings.onEvent((event) => {
    if (event.type === "microphone-status") {
      updateMicStatus(event.payload?.status || "unknown");
    }
  });

  // Init
  loadSettings();
})();

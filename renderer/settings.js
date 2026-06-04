(() => {
  let parsedConfig = {};
  let _originalConfigText = "";
  let hotwords = [];
  let isDirty = false;
  let currentThemePreference = "system";
  let currentHotkeyMode = "toggle";
  let currentOverlayStyle = "liquid";
  let currentOverlayGlassMode = "auto";
  let currentPlatform = "";
  let currentLlmProvider = "deepseek";
  let hasAutoCheckedUpdates = false;

  const LLM_PROVIDERS = {
    deepseek: {
      label: "DeepSeek",
      model: "deepseek-v4-flash",
      url: "",
      baseUrlPlaceholder: "内置 DeepSeek 地址，可留空",
      modelHint: "如 deepseek-v4-flash",
    },
    openai: {
      label: "OpenAI",
      model: "gpt-4.1-mini",
      url: "",
      baseUrlPlaceholder: "内置 OpenAI 地址，可留空",
      modelHint: "如 gpt-4.1-mini",
    },
    openrouter: {
      label: "OpenRouter",
      model: "openai/gpt-4o-mini",
      url: "https://openrouter.ai/api/v1",
      baseUrlPlaceholder: "https://openrouter.ai/api/v1",
      modelHint: "如 openai/gpt-4o-mini",
    },
    siliconflow: {
      label: "硅基流动",
      model: "deepseek-ai/DeepSeek-V3",
      url: "https://api.siliconflow.cn/v1",
      baseUrlPlaceholder: "https://api.siliconflow.cn/v1",
      modelHint: "如 deepseek-ai/DeepSeek-V3",
    },
    gemini: {
      label: "Gemini",
      model: "gemini-2.5-flash-lite",
      url: "",
      baseUrlPlaceholder: "内置 Gemini 地址，可留空",
      modelHint: "如 gemini-2.5-flash-lite",
    },
    anthropic: {
      label: "Anthropic",
      model: "claude-3-5-haiku-latest",
      url: "",
      baseUrlPlaceholder: "Anthropic 使用原生协议，可留空",
      modelHint: "如 claude-3-5-haiku-latest",
    },
    ollama: {
      label: "Ollama 本地",
      model: "llama3.1",
      url: "http://localhost:11434/api",
      baseUrlPlaceholder: "http://localhost:11434/api",
      modelHint: "如 llama3.1",
    },
    openai_compatible: {
      label: "自定义",
      model: "",
      url: "",
      baseUrlPlaceholder: "https://api.example.com/v1",
      modelHint: "输入兼容 OpenAI 的模型名称",
    },
  };

  const $ = (id) => document.getElementById(id);

  // ===== Icon helper =====

  function icon(name) {
    const svg = window.LucideIcons?.[name];
    if (!svg) return "";
    return svg;
  }

  function initIcons() {
    document.querySelectorAll("[data-icon]").forEach((el) => {
      const name = el.dataset.icon;
      const svg = icon(name);
      if (svg) {
        el.innerHTML = svg;
      }
    });
  }

  // ===== Element refs =====

  const el = {
    hotkeyDisplay: $("hotkeyDisplay"),
    hotkeyRecordBtn: $("hotkeyRecordBtn"),
    hotkeyHint: $("hotkeyHint"),
    hotkeyHintRow: $("hotkeyHintRow"),
    hotkeyModeSelector: $("hotkeyModeSelector"),
    promptHotkeyList: $("promptHotkeyList"),
    configPath: $("configPath"),
    autoStart: $("autoStart"),
    overlayStyleRow: $("overlayStyleRow"),
    overlayStyleSelector: $("overlayStyleSelector"),
    overlayGlassModeRow: $("overlayGlassModeRow"),
    overlayGlassModeSelector: $("overlayGlassModeSelector"),
    micDot: $("micDot"),
    micText: $("micText"),
    checkMicBtn: $("checkMicBtn"),
    accessibilityRow: $("accessibilityRow"),
    accDot: $("accDot"),
    accText: $("accText"),
    openAccBtn: $("openAccBtn"),
    permHint: $("permHint"),
    permBadge: $("permBadge"),
    wsUrl: $("wsUrl"),
    resourceId: $("resourceId"),
    language: $("language"),
    appId: $("appId"),
    accessToken: $("accessToken"),
    secretKey: $("secretKey"),
    toggleAccessToken: $("toggleAccessToken"),
    toggleSecretKey: $("toggleSecretKey"),
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
    yamlEditor: $("yamlEditor"),
    reloadYamlBtn: $("reloadYamlBtn"),
    resetBtn: $("resetBtn"),
    saveYamlBtn: $("saveYamlBtn"),
    versionText: $("versionText"),
    aboutUpdateBtn: $("aboutUpdateBtn"),
    aboutUpdateStatus: $("aboutUpdateStatus"),
    updateBadge: $("updateBadge"),
    licenseBtn: $("licenseBtn"),
    licenseOverlay: $("licenseOverlay"),
    licenseCloseBtn: $("licenseCloseBtn"),
    licenseText: $("licenseText"),
    llmEnabled: $("llmEnabled"),
    llmProviderGrid: $("llmProviderGrid"),
    llmBaseUrl: $("llmBaseUrl"),
    llmBaseUrlDesc: $("llmBaseUrlDesc"),
    llmApiKey: $("llmApiKey"),
    llmModel: $("llmModel"),
    llmModelDesc: $("llmModelDesc"),
    toggleLlmApiKey: $("toggleLlmApiKey"),
    promptsList: $("promptsList"),
    addPromptBtn: $("addPromptBtn"),
    soundEnabled: $("soundEnabled"),
    soundFilesRow: $("soundFilesRow"),
    endSoundFilesRow: $("endSoundFilesRow"),
    startSoundName: $("startSoundName"),
    startSoundSelect: $("startSoundSelect"),
    startSoundReset: $("startSoundReset"),
    endSoundName: $("endSoundName"),
    endSoundSelect: $("endSoundSelect"),
    endSoundReset: $("endSoundReset"),
  };

  // ===== Dirty state & auto-save =====

  let _saveTimer = null;

  function autoSaveForm() {
    isDirty = true;
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
      saveFromForm();
    }, 500);
  }

  function saveFormNow() {
    if (_saveTimer) {
      clearTimeout(_saveTimer);
      _saveTimer = null;
    }
    saveFromForm();
  }

  function clearDirty() {
    isDirty = false;
    if (_saveTimer) {
      clearTimeout(_saveTimer);
      _saveTimer = null;
    }
  }

  // ===== Theme =====

  function applyTheme(resolved) {
    if (resolved === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }

  function initThemeSelector(data) {
    const info = data.runtime?.theme || {};
    currentThemePreference = info.preference || "system";
    applyTheme(info.resolved || "dark");
    document.querySelectorAll(".theme-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.themeVal === currentThemePreference);
    });
  }

  // ===== Hotkey display =====

  function renderHotkeyDisplay(displayString) {
    el.hotkeyDisplay.innerHTML = "";
    renderHotkeyParts(el.hotkeyDisplay, displayString);
  }

  function renderHotkeyParts(container, displayString) {
    container.innerHTML = "";
    if (!displayString) {
      const kbd = document.createElement("kbd");
      kbd.textContent = "未设置";
      container.appendChild(kbd);
      return;
    }
    displayString
      .split("+")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((key) => {
        container.appendChild(createHotkeyKeycap(key));
      });
  }

  function createHotkeyKeycap(key) {
    const kbd = document.createElement("kbd");
    const normalizedKey = normalizeHotkeyLabel(key);
    const sideMatch = normalizedKey.match(/^([LR])\s+([⌃⇧⌥⌘])$/);

    if (sideMatch) {
      const side = document.createElement("span");
      side.className = "hotkey-side";
      side.textContent = sideMatch[1];
      const symbol = document.createElement("span");
      symbol.className = "hotkey-symbol";
      symbol.textContent = sideMatch[2];
      kbd.appendChild(side);
      kbd.appendChild(symbol);
      return kbd;
    }

    if (/^[⌃⇧⌥⌘␣]$/.test(normalizedKey)) {
      const symbol = document.createElement("span");
      symbol.className = "hotkey-symbol";
      symbol.textContent = normalizedKey;
      kbd.appendChild(symbol);
      return kbd;
    }

    kbd.textContent = normalizedKey;
    return kbd;
  }

  function normalizeHotkeyLabel(key) {
    const aliases = {
      CmdOrCtrl: "⌘",
      CommandOrControl: "⌘",
      Command: "⌘",
      Cmd: "⌘",
      Meta: "⌘",
      Control: "⌃",
      Ctrl: "⌃",
      Shift: "⇧",
      Alt: "⌥",
      Option: "⌥",
      Space: "␣",
    };
    return aliases[key] || key;
  }

  const keyDisplayNames = {
    1: "Esc",
    14: "Backspace",
    15: "Tab",
    28: "Enter",
    29: "L ⌃",
    42: "L ⇧",
    54: "R ⇧",
    56: "L ⌥",
    57: "␣",
    3613: "R ⌃",
    3640: "R ⌥",
    3675: "L ⌘",
    3676: "R ⌘",
  };

  Object.assign(keyDisplayNames, {
    16: "Q",
    17: "W",
    18: "E",
    19: "R",
    20: "T",
    21: "Y",
    22: "U",
    23: "I",
    24: "O",
    25: "P",
    30: "A",
    31: "S",
    32: "D",
    33: "F",
    34: "G",
    35: "H",
    36: "J",
    37: "K",
    38: "L",
    44: "Z",
    45: "X",
    46: "C",
    47: "V",
    48: "B",
    49: "N",
    50: "M",
    59: "F1",
    60: "F2",
    61: "F3",
    62: "F4",
    63: "F5",
    64: "F6",
    65: "F7",
    66: "F8",
    67: "F9",
    68: "F10",
    87: "F11",
    88: "F12",
    91: "F13",
    92: "F14",
    93: "F15",
    99: "F16",
    100: "F17",
    101: "F18",
    102: "F19",
    103: "F20",
    104: "F21",
    105: "F22",
    106: "F23",
    107: "F24",
    57416: "↑",
    57424: "↓",
    57419: "←",
    57421: "→",
  });

  function formatPromptHotkey(hotkey) {
    if (!Array.isArray(hotkey) || hotkey.length === 0) return "";
    return hotkey.map((key) => keyDisplayNames[key] || `Key(${key})`).join(" + ");
  }

  function setHotkeyMode(mode) {
    currentHotkeyMode = mode === "hold" ? "hold" : "toggle";
    el.hotkeyModeSelector.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.val === currentHotkeyMode);
    });
  }

  function updateOverlayGlassModeVisibility() {
    if (!el.overlayGlassModeRow) return;
    // The light/dark glass variant only applies to the macOS Liquid Glass UI,
    // so hide it on non-macOS and when the Vibrancy backup is selected.
    const show = currentPlatform === "darwin" && currentOverlayStyle === "liquid";
    el.overlayGlassModeRow.style.display = show ? "" : "none";
  }

  function setOverlayStyle(style) {
    currentOverlayStyle = style === "vibrancy" ? "vibrancy" : "liquid";
    if (el.overlayStyleSelector) {
      el.overlayStyleSelector.querySelectorAll(".seg-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.val === currentOverlayStyle);
      });
    }
    updateOverlayGlassModeVisibility();
  }

  function setOverlayGlassMode(mode) {
    currentOverlayGlassMode = ["light", "dark"].includes(mode) ? mode : "auto";
    if (!el.overlayGlassModeSelector) return;
    el.overlayGlassModeSelector.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.val === currentOverlayGlassMode);
    });
  }

  function setHotkeyHint(text, level) {
    el.hotkeyHint.textContent = text;
    el.hotkeyHintRow.style.display = text ? "" : "none";
    if (level) {
      el.hotkeyHint.style.color =
        level === "error" ? "var(--error)" : level === "warn" ? "var(--warning)" : "";
    } else {
      el.hotkeyHint.style.color = "";
    }
  }

  function setLlmProvider(provider, applyDefaults = false) {
    if (applyDefaults) {
      persistVisibleProviderFields();
    }

    currentLlmProvider = LLM_PROVIDERS[provider] ? provider : "deepseek";
    const providerConfig = LLM_PROVIDERS[currentLlmProvider];
    const savedProviderConfig = parsedConfig.llm?.[currentLlmProvider] || {};

    el.llmProviderGrid.querySelectorAll(".provider-chip").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.provider === currentLlmProvider);
    });

    el.llmBaseUrl.placeholder = providerConfig.baseUrlPlaceholder;
    el.llmBaseUrlDesc.textContent = providerConfig.baseUrlPlaceholder;
    el.llmModel.placeholder = providerConfig.model || "模型名称";
    el.llmModelDesc.textContent = providerConfig.modelHint;

    if (applyDefaults) {
      el.llmBaseUrl.value = savedProviderConfig.url || providerConfig.url;
      el.llmApiKey.value = savedProviderConfig.api_key || "";
      el.llmModel.value = savedProviderConfig.model || providerConfig.model;
      saveFormNow();
    }
  }

  function persistVisibleProviderFields() {
    parsedConfig.llm = parsedConfig.llm || {};
    parsedConfig.llm[currentLlmProvider] = {
      ...(parsedConfig.llm[currentLlmProvider] || {}),
      url: el.llmBaseUrl?.value?.trim() || "",
      api_key: el.llmApiKey?.value?.trim() || "",
      model: el.llmModel?.value?.trim() || "",
    };
  }

  // ===== Config load/save =====

  async function loadSettings() {
    try {
      const data = await window.voiceSettings.getData();
      _originalConfigText = data.configText || "";
      parsedConfig = data.parsedConfig || {};
      populateForm(data);
      initThemeSelector(data);
      el.yamlEditor.value = data.configText || "";
      autoResizeYamlEditor();
      updateMicStatus(data.runtime?.microphoneStatus || "unknown");
      updateAccessibilityStatus(data.runtime?.accessibilityStatus || "unknown");

      try {
        const loginSettings = await window.voiceSettings.getLoginItemSettings();
        el.autoStart.checked = loginSettings.openAtLogin;
      } catch (_) {
        /* ignore */
      }

      el.versionText.textContent = data.runtime?.version ? `v${data.runtime.version}` : "-";
      document.title = data.runtime?.version ? `VoicePaste v${data.runtime.version}` : "VoicePaste";

      clearDirty();
      autoCheckUpdatesOnce();
    } catch (_err) {
      /* ignore */
    }
  }

  function autoCheckUpdatesOnce() {
    if (hasAutoCheckedUpdates || _updateState !== "idle") return;

    hasAutoCheckedUpdates = true;
    setUpdateState("checking");
    window.voiceSettings
      .checkForUpdates()
      .catch((err) => setUpdateState("error", { message: err.message || "检查更新失败" }));
  }

  function populateForm(data) {
    const c = parsedConfig;

    const hotkeyDisplay =
      data.runtime?.hotkeyDisplay ||
      (Array.isArray(c.app?.hotkey) ? "自定义快捷键" : c.app?.hotkey || "F13");
    renderHotkeyDisplay(hotkeyDisplay);
    setHotkeyMode(c.app?.hotkey_mode);

    el.configPath.textContent = data.configPath || "-";

    currentPlatform = data.runtime?.platform || currentPlatform;
    setOverlayGlassMode(c.app?.overlay_glass_mode);
    setOverlayStyle(c.app?.overlay_style); // also refreshes glass-mode row visibility
    if (currentPlatform !== "darwin" && el.overlayStyleRow) {
      el.overlayStyleRow.style.display = "none";
    }

    if (data.runtime?.platform !== "darwin" && el.accessibilityRow) {
      el.accessibilityRow.style.display = "none";
    }

    if (el.permHint) {
      el.permHint.textContent =
        data.runtime?.platform === "darwin"
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
      hotwords = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
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

    el.llmEnabled.checked = Boolean(c.llm?.enabled);
    setLlmProvider(c.llm?.provider || (c.llm?.url ? "openai_compatible" : "deepseek"));
    const activeProviderConfig = c.llm?.[currentLlmProvider] || {};
    const activeProviderDefault = LLM_PROVIDERS[currentLlmProvider];
    el.llmBaseUrl.value = activeProviderConfig.url || c.llm?.base_url || c.llm?.url || "";
    el.llmApiKey.value = activeProviderConfig.api_key || c.llm?.api_key || "";

    // Sound settings
    const soundConfig = c.app?.sound || {};
    el.soundEnabled.checked = soundConfig.enabled !== false;
    updateSoundFileDisplay("start", soundConfig.start_sound || "");
    updateSoundFileDisplay("end", soundConfig.end_sound || "");
    updateSoundRowsVisibility();
    el.llmModel.value = activeProviderConfig.model || c.llm?.model || activeProviderDefault.model;

    loadAndRenderPrompts();
  }

  function collectConfig() {
    persistVisibleProviderFields();
    const config = JSON.parse(JSON.stringify(parsedConfig));

    config.app = config.app || {};
    config.app.hotkey = config.app.hotkey || "F13";
    config.app.hotkey_mode = currentHotkeyMode;
    config.app.remove_trailing_period = el.removeTrailingPeriod.checked;
    config.app.keep_clipboard = el.keepClipboard.checked;
    config.app.theme = currentThemePreference;
    config.app.overlay_style = currentOverlayStyle;
    config.app.overlay_glass_mode = currentOverlayGlassMode;
    config.app.sound = {
      enabled: el.soundEnabled.checked,
      start_sound: el.startSoundName.dataset.path || "",
      end_sound: el.endSoundName.dataset.path || "",
    };

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

    config.llm = config.llm || {};
    config.llm.enabled = el.llmEnabled.checked;
    config.llm.provider = currentLlmProvider;
    delete config.llm.base_url;
    delete config.llm.url;
    delete config.llm.api_key;
    delete config.llm.model;
    delete config.llm.prompt_id;

    return config;
  }

  async function saveFromForm() {
    try {
      const config = collectConfig();
      await window.voiceSettings.saveConfigObject(config);
      await loadSettings();
    } catch (_err) {
      /* ignore */
    }
  }

  async function saveFromYaml() {
    try {
      await window.voiceSettings.saveConfig({
        configText: el.yamlEditor.value,
      });
      await loadSettings();
    } catch (_err) {
      /* ignore */
    }
  }

  async function syncFormToYaml() {
    // If there are unsaved form changes, save them first so YAML reflects current state
    if (isDirty) {
      await saveFromForm();
    } else {
      await loadSettings();
    }
  }

  // ===== Microphone =====

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

    const isGranted = status === "granted";
    el.micDot.classList.toggle("green", isGranted);
    el.micDot.classList.toggle("yellow", status === "not-determined");
    el.micDot.classList.toggle("red", status === "denied");
    updatePermissionBadge();
  }

  async function checkMic() {
    let result = await window.voiceSettings.getMicrophoneStatus();
    if (result.status !== "granted") {
      result = await window.voiceSettings.requestMicrophoneAccess();
    }
    updateMicStatus(result.status || "unknown");
  }

  function updateAccessibilityStatus(status) {
    const labels = {
      granted: "已授权",
      denied: "未授权",
      unknown: "未知",
    };
    el.accText.textContent = labels[status] || status;
    el.accDot.dataset.status = status;
    el.accDot.classList.toggle("green", status === "granted");
    el.accDot.classList.toggle("yellow", false);
    el.accDot.classList.toggle("red", status !== "granted" && status !== "unknown");
    updatePermissionBadge();
  }

  function updatePermissionBadge() {
    if (!el.permBadge) {
      return;
    }

    let issues = 0;
    if (el.micDot.dataset.status !== "granted") {
      issues += 1;
    }
    if (el.accessibilityRow.style.display !== "none" && el.accDot.dataset.status !== "granted") {
      issues += 1;
    }

    if (issues > 0) {
      el.permBadge.textContent = String(issues);
      el.permBadge.style.display = "";
      return;
    }

    el.permBadge.style.display = "none";
  }

  async function refreshAccessibilityStatus() {
    const result = await window.voiceSettings.getAccessibilityStatus();
    updateAccessibilityStatus(result.status || "unknown");
  }

  // ===== Hotwords =====

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderHotwords(filter = "") {
    const query = filter.trim().toLowerCase();
    el.hotwordTags.innerHTML = hotwords
      .map((word, i) => {
        const isMatch = query && word.toLowerCase() === query;
        const isDimmed = query && !word.toLowerCase().includes(query);
        const cls = `tag${isMatch ? " is-match" : isDimmed ? " is-dimmed" : ""}`;
        return (
          `<span class="${cls}">` +
          `<span>${escapeHtml(word)}</span>` +
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
    saveFormNow();
  }

  function removeHotword(index) {
    hotwords.splice(index, 1);
    renderHotwords();
    saveFormNow();
  }

  // ===== Password toggle =====

  // ===== Sound settings =====

  function soundFileName(path) {
    if (!path) return "内置默认";
    try {
      return path.split(/[\\/]/).pop();
    } catch (_) {
      return path;
    }
  }

  function updateSoundFileDisplay(which, filePath) {
    const nameEl = which === "start" ? el.startSoundName : el.endSoundName;
    const resetBtn = which === "start" ? el.startSoundReset : el.endSoundReset;
    if (!nameEl) return;
    nameEl.textContent = soundFileName(filePath);
    nameEl.dataset.path = filePath || "";
    nameEl.title = filePath || "";
    if (resetBtn) {
      resetBtn.style.display = filePath ? "" : "none";
    }
  }

  function updateSoundRowsVisibility() {
    const show = el.soundEnabled.checked;
    if (el.soundFilesRow) el.soundFilesRow.style.display = show ? "" : "none";
    if (el.endSoundFilesRow) el.endSoundFilesRow.style.display = show ? "" : "none";
  }

  async function selectSoundFile(which) {
    try {
      const filePath = await window.voiceSettings.selectSoundFile();
      if (filePath) {
        updateSoundFileDisplay(which, filePath);
        saveFormNow();
      }
    } catch (_) {
      /* ignore */
    }
  }

  function resetSoundFile(which) {
    updateSoundFileDisplay(which, "");
    saveFormNow();
  }

  function toggleSecret(inputId, btn) {
    const input = $(inputId);
    const isPassword = input.type === "password";
    input.type = isPassword ? "text" : "password";
    const iconName = isPassword ? "eye-off" : "eye";
    btn.innerHTML = `<span class="nav-icon">${icon(iconName)}</span>`;
  }

  // ===== Hotkey recording =====

  let isRecordingHotkey = false;

  function suppressKeyboardDuringHotkeyRecording(event) {
    if (!isRecordingHotkey) return;
    event.preventDefault();
    event.stopPropagation();
  }

  async function recordHotkey() {
    if (isRecordingHotkey) return;
    isRecordingHotkey = true;

    if (document.activeElement && typeof document.activeElement.blur === "function") {
      document.activeElement.blur();
    }

    el.hotkeyDisplay.classList.add("is-recording");
    el.hotkeyRecordBtn.disabled = true;
    el.hotkeyRecordBtn.innerHTML = "录制中…";
    setHotkeyHint("按下快捷键组合并松开，Esc 取消", "");

    try {
      const result = await window.voiceSettings.recordHotkey();
      const keys = Array.isArray(result) ? result : result?.keys;
      const displayString = result?.displayString || "自定义快捷键";

      if (keys && keys.length > 0) {
        parsedConfig.app = parsedConfig.app || {};
        parsedConfig.app.hotkey = keys;
        renderHotkeyDisplay(displayString);
        setHotkeyHint("", "");
        saveFormNow();
      } else {
        parsedConfig.app = parsedConfig.app || {};
        parsedConfig.app.hotkey = "";
        renderHotkeyDisplay("");
        setHotkeyHint("快捷键已清除", "");
        saveFormNow();
      }
    } catch (err) {
      setHotkeyHint(err?.message || "", err?.message ? "error" : "");
    } finally {
      isRecordingHotkey = false;
      el.hotkeyDisplay.classList.remove("is-recording");
      el.hotkeyRecordBtn.disabled = false;
      el.hotkeyRecordBtn.innerHTML = `<span class="nav-icon">${icon("keyboard")}</span> 录制`;
    }
  }

  // ===== Update state machine =====

  let _updateState = "idle";
  let _errorTimer = null;

  function setUpdateState(state, data) {
    _updateState = state;

    if (_errorTimer) {
      clearTimeout(_errorTimer);
      _errorTimer = null;
    }

    switch (state) {
      case "checking":
        el.aboutUpdateBtn.textContent = "检查中…";
        el.aboutUpdateBtn.disabled = true;
        el.aboutUpdateStatus.textContent = "正在检查更新...";
        break;
      case "not-available":
        el.aboutUpdateBtn.textContent = "检查更新";
        el.aboutUpdateBtn.disabled = false;
        el.aboutUpdateStatus.textContent = "当前已是最新版本";
        _errorTimer = setTimeout(() => {
          setUpdateState("idle");
        }, 2000);
        break;
      case "available":
        el.aboutUpdateBtn.textContent = "立即更新";
        el.aboutUpdateBtn.disabled = false;
        el.aboutUpdateBtn.className = "btn btn-sm btn-accent";
        el.aboutUpdateStatus.textContent = `发现新版本`;
        if (el.updateBadge) el.updateBadge.style.display = "";
        break;
      case "downloading":
      case "progress":
        el.aboutUpdateBtn.textContent = `下载中 ${data?.percent ?? 0}%`;
        el.aboutUpdateBtn.disabled = true;
        el.aboutUpdateStatus.textContent = `下载中 ${data?.percent ?? 0}%`;
        break;
      case "downloaded":
        el.aboutUpdateBtn.textContent = "重启安装";
        el.aboutUpdateBtn.disabled = false;
        el.aboutUpdateBtn.className = "btn btn-sm btn-accent";
        el.aboutUpdateStatus.textContent = "更新已下载，点击重启安装";
        break;
      case "installing":
        el.aboutUpdateBtn.textContent = "正在安装…";
        el.aboutUpdateBtn.disabled = true;
        el.aboutUpdateStatus.textContent = "正在安装更新…";
        break;
      case "disabled":
        el.aboutUpdateBtn.textContent = "调试模式";
        el.aboutUpdateBtn.disabled = true;
        el.aboutUpdateStatus.textContent = "调试模式下不支持自动更新";
        break;
      case "error":
        el.aboutUpdateBtn.textContent = "检查更新";
        el.aboutUpdateBtn.disabled = false;
        el.aboutUpdateStatus.textContent = data?.message || "检查更新失败";
        _errorTimer = setTimeout(() => {
          setUpdateState("idle");
        }, 3000);
        break;
      default:
        el.aboutUpdateBtn.textContent = "检查更新";
        el.aboutUpdateBtn.disabled = false;
        el.aboutUpdateBtn.className = "btn btn-sm";
        el.aboutUpdateStatus.textContent = "-";
        break;
    }
  }

  function handleUpdateClick() {
    switch (_updateState) {
      case "idle":
      case "error":
        setUpdateState("checking");
        window.voiceSettings
          .checkForUpdates()
          .catch((err) => setUpdateState("error", { message: err.message || "检查更新失败" }));
        break;
      case "available":
        setUpdateState("downloading");
        window.voiceSettings
          .downloadUpdate()
          .catch((err) => setUpdateState("error", { message: err.message || "下载更新失败" }));
        break;
      case "downloaded":
        setUpdateState("installing");
        window.voiceSettings.installUpdate();
        break;
    }
  }

  // ===== Section navigation =====

  function switchSection(id) {
    document.querySelectorAll(".section").forEach((s) => {
      s.classList.toggle("hidden", s.id !== `section-${id}`);
    });
    document.querySelectorAll(".nav-item[data-section]").forEach((n) => {
      n.classList.toggle("active", n.dataset.section === id);
    });

    if (id === "home") {
      loadHomeData();
    }
    if (id === "yaml") {
      syncFormToYaml();
    }

    document.querySelector(".main").scrollTop = 0;
  }

  // ===== Home Module =====

  let _historyDaysBack = 3;

  function formatCompact(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return String(n);
  }

  function formatDuration(totalSeconds) {
    const s = Math.round(totalSeconds);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = s / 3600;
    return h < 10 ? `${h.toFixed(1)}h` : `${Math.round(h)}h`;
  }

  function renderGreeting() {
    const h = new Date().getHours();
    const g =
      h < 6 ? "夜深了" : h < 11 ? "早上好" : h < 13 ? "中午好" : h < 18 ? "下午好" : "晚上好";
    const el = $("greetingText");
    if (el) el.textContent = g;
  }

  function renderAchievements(stats) {
    const daysUsed = stats.dailyCounts ? Object.keys(stats.dailyCounts).length : 0;

    const daysEl = $("achDaysUsed");
    const sessionsEl = $("achSessions");
    const charsEl = $("achCharacters");
    const timeEl = $("achTimeSaved");

    if (daysEl) daysEl.textContent = formatCompact(daysUsed);
    if (sessionsEl) sessionsEl.textContent = formatCompact(stats.totalSessions || 0);
    if (charsEl) charsEl.textContent = formatCompact(stats.totalCharacters || 0);

    const secondsSaved = Math.round((stats.totalCharacters || 0) * 0.67);
    if (timeEl) timeEl.textContent = formatDuration(secondsSaved);
  }

  function renderHeatmap(dailyCounts) {
    const grid = $("heatmapGrid");
    const monthsEl = $("heatmapMonths");
    const totalEl = $("heatmapTotal");
    if (!grid) return;

    grid.innerHTML = "";
    if (monthsEl) monthsEl.innerHTML = "";

    const weeks = 26;
    const now = new Date();
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() - startDate.getDay());
    startDate.setDate(startDate.getDate() - (weeks - 1) * 7);

    const allCounts = Object.values(dailyCounts || {}).filter((c) => c > 0);
    allCounts.sort((a, b) => a - b);

    function getLevel(count) {
      if (!count || count === 0) return 0;
      if (allCounts.length === 0) return 1;
      const p25 = allCounts[Math.floor(allCounts.length * 0.25)];
      const p50 = allCounts[Math.floor(allCounts.length * 0.5)];
      const p75 = allCounts[Math.floor(allCounts.length * 0.75)];
      if (count <= p25) return 1;
      if (count <= p50) return 2;
      if (count <= p75) return 3;
      return 4;
    }

    let totalChars = 0;
    const monthPositions = {};
    let currentMonth = -1;

    for (let w = 0; w < weeks; w++) {
      for (let d = 0; d < 7; d++) {
        const date = new Date(startDate);
        date.setDate(date.getDate() + w * 7 + d);

        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        const count = dailyCounts[key] || 0;
        totalChars += count;

        const cell = document.createElement("div");
        if (date > now) {
          cell.className = "heatmap-cell";
          cell.style.visibility = "hidden";
        } else {
          cell.className = `heatmap-cell level-${getLevel(count)}`;
          cell.title = `${date.getMonth() + 1}月${date.getDate()}日: ${count} 字`;
        }
        grid.appendChild(cell);

        const m = date.getMonth();
        if (m !== currentMonth && d === 0) {
          monthPositions[m] = w;
          currentMonth = m;
        }
      }
    }

    const monthNames = [
      "1月",
      "2月",
      "3月",
      "4月",
      "5月",
      "6月",
      "7月",
      "8月",
      "9月",
      "10月",
      "11月",
      "12月",
    ];
    const cellSize = 14;
    const rendered = {};
    if (monthsEl) {
      for (let mw = 0; mw < weeks; mw++) {
        for (const mKey in monthPositions) {
          if (monthPositions[mKey] === mw && !rendered[mKey]) {
            const label = document.createElement("span");
            label.className = "heatmap-month-label";
            label.style.left = `${mw * cellSize}px`;
            label.textContent = monthNames[mKey];
            monthsEl.appendChild(label);
            rendered[mKey] = true;
          }
        }
      }
    }

    if (totalEl) {
      totalEl.innerHTML = `共输入 <strong>${totalChars.toLocaleString()}</strong> 字`;
    }
  }

  function renderHistory(items) {
    const container = $("historyContainer");
    if (!container) return;
    container.innerHTML = "";

    if (!items || items.length === 0) {
      container.innerHTML =
        '<div class="history-item"><span style="color:var(--text-muted);font-size:12px">暂无输入记录</span></div>';
      return;
    }

    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;

    function dateLabel(dateStr) {
      if (dateStr === todayKey) return "今天";
      if (dateStr === yesterdayKey) return "昨天";
      const d = new Date(dateStr);
      const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
      return `${d.getMonth() + 1}月${d.getDate()}日 ${weekdays[d.getDay()]}`;
    }

    let lastDate = "";
    for (const item of items) {
      const d = new Date(item.ts);
      const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

      if (dateKey !== lastDate) {
        const divider = document.createElement("div");
        divider.className = "history-date-divider";
        divider.innerHTML = `<span class="history-date-label">${dateLabel(dateKey)}</span>`;
        container.appendChild(divider);
        lastDate = dateKey;
      }

      const row = document.createElement("div");
      row.className = "history-item";
      const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      row.innerHTML = `
        <span class="history-time">${time}</span>
        <div class="history-content">
          <div class="history-text">${escapeHtml(item.text)}</div>
        </div>
        <div class="history-actions">
          <button type="button" class="history-btn copy-btn" title="复制">
            <span class="nav-icon" data-icon="copy"></span>
          </button>
          <button type="button" class="history-btn delete-btn" title="删除">
            <span class="nav-icon" data-icon="trash-2"></span>
          </button>
        </div>
      `;

      // Wait for elements to be inserted or query them directly from the unattached row
      const copyBtn = row.querySelector(".copy-btn");
      const deleteBtn = row.querySelector(".delete-btn");

      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(item.text);
          const iconSpan = copyBtn.querySelector(".nav-icon");
          const originalHTML = iconSpan.innerHTML;
          iconSpan.innerHTML = '<span style="font-size:12px;font-weight:bold;">✓</span>';
          setTimeout(() => {
            iconSpan.innerHTML = originalHTML;
          }, 1500);
        } catch (err) {
          console.error("Failed to copy", err);
        }
      });

      deleteBtn.addEventListener("click", async () => {
        try {
          await window.voiceSettings.deleteHistory(item.ts);
          row.style.opacity = "0";
          row.style.height = "0";
          row.style.padding = "0";
          row.style.minHeight = "0";
          row.style.overflow = "hidden";
          setTimeout(() => {
            row.remove();
          }, 200);
        } catch (err) {
          console.error("Failed to delete", err);
        }
      });

      // Must call initIcons on the row so Lucide SVG is injected
      const icons = row.querySelectorAll("[data-icon]");
      icons.forEach((el) => {
        const name = el.dataset.icon;
        const svg = icon(name);
        if (svg) el.innerHTML = svg;
      });

      container.appendChild(row);
    }

    const moreBtn = document.createElement("div");
    moreBtn.className = "history-more";
    moreBtn.innerHTML = "<span>加载更多</span>";
    moreBtn.addEventListener("click", () => {
      _historyDaysBack += 3;
      loadHistory(_historyDaysBack);
    });
    container.appendChild(moreBtn);
  }

  async function loadHistory(daysBack) {
    try {
      const items = await window.voiceSettings.getHistory(daysBack);
      renderHistory(items);
    } catch (_err) {
      /* ignore */
    }
  }

  async function loadHomeData() {
    renderGreeting();

    try {
      const stats = await window.voiceSettings.getStats();
      renderAchievements(stats);
      renderHeatmap(stats.dailyCounts || {});
    } catch (_err) {
      /* ignore */
    }

    _historyDaysBack = 3;
    await loadHistory(_historyDaysBack);
  }

  // ===== License =====

  const LICENSE_TEXT = `MIT License

Copyright (c) ${new Date().getFullYear()} that-yolanda

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

  // ===== Event Listeners =====

  // Navigation
  document.querySelectorAll(".nav-item[data-section]").forEach((item) => {
    item.addEventListener("click", () => switchSection(item.dataset.section));
  });

  // Theme buttons
  document.querySelectorAll(".theme-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const preference = btn.dataset.themeVal;
      document.querySelectorAll(".theme-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.themeVal === preference);
      });
      try {
        const result = await window.voiceSettings.setTheme(preference);
        applyTheme(result.resolved);
        currentThemePreference = preference;
      } catch (_err) {
        document.querySelectorAll(".theme-btn").forEach((b) => {
          b.classList.toggle("active", b.dataset.themeVal === currentThemePreference);
        });
      }
    });
  });

  // Hotkey recording
  el.hotkeyRecordBtn.addEventListener("click", recordHotkey);
  document.addEventListener("keydown", suppressKeyboardDuringHotkeyRecording, true);
  document.addEventListener("keyup", suppressKeyboardDuringHotkeyRecording, true);

  // Hotkey mode selector
  el.hotkeyModeSelector.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    setHotkeyMode(btn.dataset.val);
    saveFormNow();
  });

  // Overlay glass style (macOS only)
  if (el.overlayStyleSelector) {
    el.overlayStyleSelector.addEventListener("click", (e) => {
      const btn = e.target.closest(".seg-btn");
      if (!btn) return;
      setOverlayStyle(btn.dataset.val);
      saveFormNow();
    });
  }

  // Liquid Glass light/dark mode (macOS Liquid Glass only)
  if (el.overlayGlassModeSelector) {
    el.overlayGlassModeSelector.addEventListener("click", (e) => {
      const btn = e.target.closest(".seg-btn");
      if (!btn) return;
      setOverlayGlassMode(btn.dataset.val);
      saveFormNow();
    });
  }

  // Auto-start
  el.autoStart.addEventListener("change", async () => {
    await window.voiceSettings.setLoginItemSettings(el.autoStart.checked);
  });

  // Sound settings
  el.soundEnabled.addEventListener("change", () => {
    updateSoundRowsVisibility();
    saveFormNow();
  });
  el.startSoundSelect.addEventListener("click", () => selectSoundFile("start"));
  el.startSoundReset.addEventListener("click", () => resetSoundFile("start"));
  el.endSoundSelect.addEventListener("click", () => selectSoundFile("end"));
  el.endSoundReset.addEventListener("click", () => resetSoundFile("end"));

  // Permissions
  el.checkMicBtn.addEventListener("click", checkMic);
  el.openAccBtn.addEventListener("click", async () => {
    await refreshAccessibilityStatus();
    if (el.accDot.dataset.status === "granted") {
      return;
    }
    window.voiceSettings.openAccessibilitySettings();
  });

  // Save bar
  el.toggleAccessToken.addEventListener("click", () =>
    toggleSecret("accessToken", el.toggleAccessToken),
  );
  el.toggleSecretKey.addEventListener("click", () => toggleSecret("secretKey", el.toggleSecretKey));

  // LLM fields
  el.llmEnabled.addEventListener("change", saveFormNow);
  el.llmProviderGrid.addEventListener("click", (e) => {
    const btn = e.target.closest(".provider-chip");
    if (!btn) return;
    setLlmProvider(btn.dataset.provider, true);
  });
  el.llmBaseUrl.addEventListener("input", autoSaveForm);
  el.llmApiKey.addEventListener("input", autoSaveForm);
  el.llmModel.addEventListener("input", autoSaveForm);
  el.toggleLlmApiKey.addEventListener("click", () => toggleSecret("llmApiKey", el.toggleLlmApiKey));

  // Prompts
  let promptsData = [];
  let promptsSaveTimer = null;

  function createPromptId() {
    return `prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async function loadAndRenderPrompts() {
    try {
      promptsData = await window.voiceSettings.loadPrompts();
    } catch {
      promptsData = [];
    }
    promptsData = promptsData.map((item, index) => ({
      id: item.id || `prompt-${index + 1}`,
      title: item.title || "",
      hotkey: Array.isArray(item.hotkey) ? item.hotkey : [],
      hotkey_mode: item.hotkey_mode === "hold" ? "hold" : "toggle",
      prompt: item.prompt || "",
    }));
    renderPrompts();
    renderPromptHotkeys();
  }

  function renderPrompts() {
    if (!el.promptsList) return;
    el.promptsList.innerHTML = "";
    promptsData.forEach((item, index) => {
      const card = document.createElement("div");
      card.className = "prompt-item";

      const actionRow = document.createElement("div");
      actionRow.className = "prompt-item-head";

      const titleInput = document.createElement("input");
      titleInput.type = "text";
      titleInput.className = "input-field";
      titleInput.placeholder = "提示词标题";
      titleInput.value = item.title || "";
      titleInput.style.cssText = "flex: 1; min-width: 0; font-size: 12.5px";
      titleInput.addEventListener("input", () => {
        promptsData[index].title = titleInput.value;
        renderPromptHotkeys();
        scheduleSavePrompts();
      });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "seg-btn prompt-item-delete";
      delBtn.textContent = "删除";
      delBtn.style.cssText = "font-size: 11px; flex-shrink: 0";
      delBtn.addEventListener("click", async () => {
        promptsData.splice(index, 1);
        renderPrompts();
        renderPromptHotkeys();
        await savePromptsNow();
      });

      actionRow.appendChild(titleInput);
      actionRow.appendChild(delBtn);

      const promptArea = document.createElement("textarea");
      promptArea.className = "prompt-item-body";
      promptArea.placeholder = "输入系统提示词...";
      promptArea.value = item.prompt || "";
      promptArea.addEventListener("input", () => {
        promptsData[index].prompt = promptArea.value;
        scheduleSavePrompts();
      });

      card.appendChild(actionRow);
      card.appendChild(promptArea);
      el.promptsList.appendChild(card);
    });
  }

  function renderPromptHotkeys() {
    if (!el.promptHotkeyList) return;
    el.promptHotkeyList.innerHTML = "";

    promptsData.forEach((item, index) => {
      const group = document.createElement("div");
      group.className = "hotkey-section";

      const title = document.createElement("div");
      title.className = "hotkey-section-title";
      title.textContent = item.title ? `润色模板：${item.title}` : "润色模板：未命名模板";
      group.appendChild(title);

      const section = document.createElement("div");
      section.className = "section-card";

      const hotkeyRow = document.createElement("div");
      hotkeyRow.className = "row";
      const hotkeyLabel = document.createElement("div");
      hotkeyLabel.className = "row-label";
      hotkeyLabel.innerHTML = `<div class="title">触发快捷键</div><div class="desc">按下后使用「${escapeHtml(item.title || "未命名模板")}」润色</div>`;
      const hotkeyDisplay = document.createElement("div");
      hotkeyDisplay.className = "hotkey-display prompt-hotkey-display";
      const hotkeyText = formatPromptHotkey(item.hotkey);
      if (hotkeyText) {
        renderHotkeyParts(hotkeyDisplay, hotkeyText);
      } else {
        const empty = document.createElement("span");
        empty.className = "empty";
        empty.textContent = "未绑定";
        hotkeyDisplay.appendChild(empty);
      }
      const recordBtn = document.createElement("button");
      recordBtn.type = "button";
      recordBtn.className = "btn btn-sm";
      recordBtn.innerHTML = `<span class="nav-icon">${icon("keyboard")}</span> 录制`;
      recordBtn.addEventListener("click", async () => {
        await recordPromptHotkey(index, hotkeyDisplay, recordBtn);
      });
      hotkeyDisplay.addEventListener("click", async () => {
        await recordPromptHotkey(index, hotkeyDisplay, recordBtn);
      });
      hotkeyRow.appendChild(hotkeyLabel);
      hotkeyRow.appendChild(hotkeyDisplay);
      hotkeyRow.appendChild(recordBtn);

      const modeRow = document.createElement("div");
      modeRow.className = "row";
      const modeLabel = document.createElement("div");
      modeLabel.className = "row-label";
      modeLabel.innerHTML = `<div class="title">触发模式</div><div class="desc">选择该模板快捷键的触发行为</div>`;
      const modeSelector = document.createElement("div");
      modeSelector.className = "seg-control";
      [
        ["toggle", "点击切换"],
        ["hold", "按住说话"],
      ].forEach(([mode, text]) => {
        const modeBtn = document.createElement("button");
        modeBtn.type = "button";
        modeBtn.className = "seg-btn";
        modeBtn.textContent = text;
        modeBtn.classList.toggle("active", item.hotkey_mode === mode);
        modeBtn.addEventListener("click", async () => {
          promptsData[index].hotkey_mode = mode;
          renderPromptHotkeys();
          await savePromptsNow();
        });
        modeSelector.appendChild(modeBtn);
      });
      modeRow.appendChild(modeLabel);
      modeRow.appendChild(modeSelector);

      section.appendChild(hotkeyRow);
      section.appendChild(modeRow);
      group.appendChild(section);
      el.promptHotkeyList.appendChild(group);
    });
  }

  async function recordPromptHotkey(index, hotkeyDisplay, recordBtn) {
    if (isRecordingHotkey) return;
    isRecordingHotkey = true;

    if (document.activeElement && typeof document.activeElement.blur === "function") {
      document.activeElement.blur();
    }

    hotkeyDisplay.classList.add("is-recording");
    hotkeyDisplay.innerHTML = "";
    const placeholder = document.createElement("span");
    placeholder.className = "empty";
    placeholder.textContent = "正在录制，请按下快捷键组合并松开";
    hotkeyDisplay.appendChild(placeholder);
    recordBtn.disabled = true;
    recordBtn.textContent = "录制中…";

    try {
      const result = await window.voiceSettings.recordHotkey();
      const keys = Array.isArray(result) ? result : result?.keys;

      if (keys && keys.length > 0) {
        promptsData[index].hotkey = keys;
        await savePromptsNow();
        renderPromptHotkeys();
      } else {
        promptsData[index].hotkey = [];
        await savePromptsNow();
        renderPromptHotkeys();
      }
    } finally {
      isRecordingHotkey = false;
      hotkeyDisplay.classList.remove("is-recording");
      recordBtn.disabled = false;
      recordBtn.innerHTML = `<span class="nav-icon">${icon("keyboard")}</span> 录制`;
    }
  }

  function scheduleSavePrompts() {
    if (promptsSaveTimer) clearTimeout(promptsSaveTimer);
    promptsSaveTimer = setTimeout(() => {
      window.voiceSettings.savePrompts(promptsData).catch(() => {});
    }, 500);
  }

  async function savePromptsNow() {
    if (promptsSaveTimer) {
      clearTimeout(promptsSaveTimer);
      promptsSaveTimer = null;
    }
    await window.voiceSettings.savePrompts(promptsData);
  }

  el.addPromptBtn.addEventListener("click", async () => {
    promptsData.push({
      id: createPromptId(),
      title: "新建模板",
      hotkey: [],
      hotkey_mode: "toggle",
      prompt: "",
    });
    renderPrompts();
    renderPromptHotkeys();
    await savePromptsNow();
  });

  // Hotwords
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

  // YAML section
  el.reloadYamlBtn.addEventListener("click", loadSettings);
  el.saveYamlBtn.addEventListener("click", saveFromYaml);
  el.resetBtn.addEventListener("click", async () => {
    if (!confirm("确定要还原为默认配置吗？当前配置将被覆盖。")) return;
    try {
      await window.voiceSettings.resetConfig();
      await loadSettings();
    } catch (_err) {
      /* ignore */
    }
  });

  function autoResizeYamlEditor() {
    el.yamlEditor.style.height = "auto";
    const maxHeight = Math.round(window.innerHeight * 0.6);
    el.yamlEditor.style.height = `${Math.min(el.yamlEditor.scrollHeight, maxHeight)}px`;
  }

  el.yamlEditor.addEventListener("input", () => {
    isDirty = true;
    autoResizeYamlEditor();
  });

  // Update
  el.aboutUpdateBtn.addEventListener("click", handleUpdateClick);

  // License
  el.licenseBtn.addEventListener("click", () => {
    el.licenseText.textContent = LICENSE_TEXT;
    el.licenseOverlay.style.display = "";
  });
  el.licenseCloseBtn.addEventListener("click", () => {
    el.licenseOverlay.style.display = "none";
  });
  el.licenseOverlay.addEventListener("click", (e) => {
    if (e.target === el.licenseOverlay) {
      el.licenseOverlay.style.display = "none";
    }
  });

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
    if (input) input.addEventListener("input", autoSaveForm);
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
    if (toggle) toggle.addEventListener("change", saveFormNow);
  });

  // IPC events from main process
  window.voiceSettings.onEvent((event) => {
    if (event.type === "microphone-status") {
      updateMicStatus(event.payload?.status || "unknown");
    }
    if (event.type === "theme-changed") {
      applyTheme(event.payload.resolved);
    }
    if (event.type === "update-status") {
      setUpdateState(event.payload.type, event.payload);
    }
  });

  // ===== Init =====
  initIcons();
  loadSettings();
  loadHomeData();
})();

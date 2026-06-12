(() => {
  let parsedConfig = {};
  let currentThemePreference = "system";
  let currentHotkeyMode = "toggle";
  let currentOverlayStyle = "liquid"; // "liquid" | "liquid-standard" | "vibrancy"
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

  const DOUBAO_MODEL_ID = "doubao-streaming";
  const DOUBAO_VISIBLE_PARAMS = new Set([
    "url",
    "app_id",
    "access_token",
    "secret_key",
    "resource_id",
    "language",
    "enable_ddc",
    "enable_itn",
    "enable_nonstream",
    "enable_punc",
    "corpus",
  ]);
  const MODEL_PARAM_LABELS = {
    format: "音频格式",
    rate: "采样率",
    bits: "采样位数",
    channel: "声道数",
    model_name: "模型名称",
    model_version: "模型版本",
    operation: "操作类型",
    sequence: "请求序号",
    show_utterances: "显示分句",
    result_type: "结果类型",
    enable_accelerate_text: "启用文本加速",
    accelerate_score: "加速分数",
    vad_segment_duration: "VAD 分段时长",
    end_window_size: "结束窗口",
    force_to_speech_time: "强制语音时间",
    threshold: "灵敏度阈值",
    min_silence_duration: "最短静音时长",
    min_speech_duration: "最短语音时长",
    max_speech_duration: "最长语音时长",
    num_threads: "线程数",
    enable_endpoint: "启用端点检测",
    rule1_min_trailing_silence: "规则 1 静音时长",
    rule2_min_trailing_silence: "规则 2 静音时长",
    rule3_min_utterance_length: "规则 3 语句长度",
    use_itn: "数字格式化",
    language: "语言",
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
    versionText: $("versionText"),
    aboutUpdateBtn: $("aboutUpdateBtn"),
    aboutUpdateStatus: $("aboutUpdateStatus"),
    updateBadge: $("updateBadge"),
    licenseBtn: $("licenseBtn"),
    licenseOverlay: $("licenseOverlay"),
    licenseCloseBtn: $("licenseCloseBtn"),
    licenseText: $("licenseText"),
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
    betaUpdates: $("betaUpdates"),
    soundFilesRow: $("soundFilesRow"),
    endSoundFilesRow: $("endSoundFilesRow"),
    startSoundName: $("startSoundName"),
    startSoundSelect: $("startSoundSelect"),
    startSoundReset: $("startSoundReset"),
    endSoundName: $("endSoundName"),
    endSoundSelect: $("endSoundSelect"),
    endSoundReset: $("endSoundReset"),
    // Model page
    enableDoubao: $("enableDoubao"),
    doubaoExpandBtn: $("doubaoExpandBtn"),
    doubaoConfig: $("doubaoConfig"),
    doubaoAdvancedConfig: $("doubaoAdvancedConfig"),
    currentModelBadge: $("currentModelBadge"),
    offlineModelList: $("offlineModelList"),
    vadDownloadHint: $("vadDownloadHint"),
    // Hotword groups
    hotwordGroupsList: $("hotwordGroupsList"),
    addHotwordGroupBtn: $("addHotwordGroupBtn"),
  };

  // ===== Dirty state & auto-save =====

  let _saveTimer = null;

  function autoSaveForm() {
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

  // ===== Theme =====

  function applyTheme(resolved) {
    // Double-resolve is safe: "light" stays "light", "dark" stays "dark",
    // and any stray "system" gets resolved via matchMedia.
    if (resolveTheme(resolved) === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }

  // Resolve a theme preference ("system" / "light" / "dark") to an actual
  // light / dark value, using the browserʼs prefers-color-scheme media query
  // as a fallback when the backend hasnʼt resolved "system" yet.
  function resolveTheme(preference) {
    if (preference === "system") {
      return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
    }
    return preference || "dark";
  }

  function initThemeSelector(data) {
    const info = data.runtime?.theme || {};
    currentThemePreference = info.preference || "system";
    // resolved is now properly resolved by the Rust backend; resolveTheme
    // provides a client-side fallback for "system" in edge cases.
    applyTheme(resolveTheme(info.resolved || "dark"));
    document.querySelectorAll(".theme-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.themeVal === currentThemePreference);
    });
  }

  // Watch for system light/dark preference changes. When the user has chosen
  // "system" mode we update the theme live whenever the OS toggles.
  function watchSystemTheme() {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (!mq) return;
    mq.addEventListener("change", (e) => {
      if (currentThemePreference === "system") {
        applyTheme(e.matches ? "dark" : "light");
      }
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
      // Side-specific modifier names (from keytap)
      ControlLeft: "L ⌃",
      ControlRight: "R ⌃",
      ShiftLeft: "L ⇧",
      ShiftRight: "R ⇧",
      AltLeft: "L ⌥",
      AltRight: "R ⌥",
      MetaLeft: "L ⌘",
      MetaRight: "R ⌘",
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
    // Support both old uIOhook keycode format (numbers) and new string format ("Control+Shift+A")
    return hotkey
      .map((key) => {
        if (typeof key === "string") return key;
        return keyDisplayNames[key] || `Key(${key})`;
      })
      .join(" + ");
  }

  function setHotkeyMode(mode) {
    currentHotkeyMode = mode === "hold" ? "hold" : "toggle";
    el.hotkeyModeSelector.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.val === currentHotkeyMode);
    });
  }

  function setOverlayStyle(style) {
    if (style === "vibrancy") {
      currentOverlayStyle = "vibrancy";
    } else if (style === "liquid-standard") {
      currentOverlayStyle = "liquid-standard";
    } else {
      currentOverlayStyle = "liquid";
    }
    if (el.overlayStyleSelector) {
      el.overlayStyleSelector.querySelectorAll(".seg-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.val === currentOverlayStyle);
      });
    }
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

  // ===== App icon =====

  async function loadAppIcon() {
    // The icon is in web/ alongside settings.html. Tauri serves it directly
    // via the frontend protocol in both dev and production — no resolveResource
    // needed. The HTML <img src="./icon.png"> handles it.
  }

  // ===== Config load/save =====

  async function loadSettings() {
    try {
      const data = await window.voiceSettings.getData();
      parsedConfig = data.parsedConfig || {};
      try {
        const regResult = await window.voiceSettings.getModelRegistry();
        _modelRegistry = regResult?.models || [];
      } catch (_) {
        _modelRegistry = [];
      }
      populateForm(data);
      initThemeSelector(data);
      updateMicStatus(data.runtime?.microphoneStatus || "unknown");
      updateAccessibilityStatus(data.runtime?.accessibilityStatus || "unknown");

      // If accessibility is already granted but the hotkey listener was
      // never started (e.g. permission was granted after app launch),
      // try to start it now.
      if (data.runtime?.accessibilityStatus === "granted") {
        window.voiceSettings.reinitHotkey();
      }

      // Auto-request microphone permission if the user has never been asked.
      // On macOS this triggers the system TCC dialog via getUserMedia.
      if (data.runtime?.microphoneStatus === "prompt") {
        checkMic();
      }

      try {
        const loginSettings = await window.voiceSettings.getLoginItemSettings();
        el.autoStart.checked = loginSettings.openAtLogin;
      } catch (_) {
        /* ignore */
      }

      el.versionText.textContent = data.runtime?.version ? `v${data.runtime.version}` : "-";
      document.title = data.runtime?.version ? `VoicePaste v${data.runtime.version}` : "VoicePaste";

      autoCheckUpdatesOnce();
      updateCurrentModelBadge();
      loadHotwordGroups();
    } catch (err) {
      console.error("Failed to load settings", err);
      updateMicStatus("unknown");
      updateAccessibilityStatus("unknown");
    }
  }

  function autoCheckUpdatesOnce() {
    if (hasAutoCheckedUpdates || _updateState !== "idle") return;

    hasAutoCheckedUpdates = true;
    setUpdateState("checking");
    window.voiceSettings
      .checkForUpdates()
      .then((result) => {
        if (result.available) {
          setUpdateState("available", { version: result.version });
        } else {
          setUpdateState("not-available");
        }
      })
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
    setOverlayStyle(c.app?.overlay_style);
    if (currentPlatform !== "macos" && el.overlayStyleRow) {
      el.overlayStyleRow.style.display = "none";
    }

    if (data.runtime?.platform !== "macos" && el.accessibilityRow) {
      el.accessibilityRow.style.display = "none";
    }

    if (el.permHint) {
      el.permHint.textContent =
        data.runtime?.platform === "macos"
          ? "macOS 需要麦克风权限和辅助功能权限，可前往：系统设置 > 隐私与安全 > 麦克风 / 辅助功能"
          : "当前系统无需额外权限配置。";
    }

    const doubaoConfig = getMergedModelConfig(c, DOUBAO_MODEL_ID);
    el.wsUrl.value = doubaoConfig.url || "";
    el.resourceId.value = doubaoConfig.resource_id || "";
    el.language.value = doubaoConfig.language || "";

    el.enableDdc.checked = doubaoConfig.enable_ddc !== false;
    el.enableNonstream.checked = Boolean(doubaoConfig.enable_nonstream);
    el.enableItn.checked = doubaoConfig.enable_itn !== false;
    el.enablePunc.checked = doubaoConfig.enable_punc !== false;
    if (el.removeTrailingPeriod) {
      el.removeTrailingPeriod.checked = c.app?.remove_trailing_period !== false;
    }
    if (el.keepClipboard) {
      el.keepClipboard.checked = c.app?.keep_clipboard !== false;
    }

    el.boostingTableId.value = doubaoConfig.corpus?.boosting_table_id || "";

    el.appId.value = doubaoConfig.app_id || "";
    el.accessToken.value = doubaoConfig.access_token || "";
    el.secretKey.value = doubaoConfig.secret_key || "";
    if (el.doubaoAdvancedConfig) {
      const advanced = Object.fromEntries(
        Object.entries(doubaoConfig).filter(([key]) => !DOUBAO_VISIBLE_PARAMS.has(key)),
      );
      el.doubaoAdvancedConfig.innerHTML = renderModelConfigRows(DOUBAO_MODEL_ID, advanced);
      el.doubaoAdvancedConfig.querySelectorAll(".model-param").forEach((input) => {
        input.addEventListener("change", saveFormNow);
      });
    }

    // Model enable toggles: only the active provider's toggle should be on
    if (el.enableDoubao) {
      el.enableDoubao.checked = getAsrProvider(c) === DOUBAO_MODEL_ID;
    }

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
    el.betaUpdates.checked = Boolean(c.app?.beta_updates);
    el.llmModel.value = activeProviderConfig.model || c.llm?.model || activeProviderDefault.model;

    loadAndRenderPrompts();
  }

  /**
   * Apply consistent cleanup and state-variable overrides to a config payload
   * before saving. Ensures every save path produces the same output regardless
   * of whether it goes through collectConfig() or directly clones parsedConfig.
   */
  function finalizeConfigPayload(config) {
    // Clean up legacy / deprecated top-level keys
    delete config.connection;
    delete config.request;
    delete config.asr_online;
    delete config.asr_offline;

    // Clean up deprecated llm flat fields (moved to per-provider config maps)
    if (config.llm) {
      delete config.llm.base_url;
      delete config.llm.url;
      delete config.llm.api_key;
      delete config.llm.model;
      delete config.llm.prompt_id;
    }

    // State variables always win over whatever was in parsedConfig,
    // so cloned-parsedConfig saves never regress to stale values.
    config.app = config.app || {};
    config.app.theme = currentThemePreference;
    config.app.hotkey_mode = currentHotkeyMode;
    config.app.overlay_style = currentOverlayStyle;
    config.llm = config.llm || {};
    config.llm.provider = currentLlmProvider;

    return config;
  }

  function collectConfig() {
    persistVisibleProviderFields();
    const config = JSON.parse(JSON.stringify(parsedConfig));

    config.app = config.app || {};
    config.app.hotkey = config.app.hotkey || "F13";
    config.app.hotkey_mode = currentHotkeyMode;
    config.app.remove_trailing_period = el.removeTrailingPeriod
      ? el.removeTrailingPeriod.checked
      : config.app.remove_trailing_period !== false;
    config.app.keep_clipboard = el.keepClipboard
      ? el.keepClipboard.checked
      : config.app.keep_clipboard !== false;
    config.app.theme = currentThemePreference;
    config.app.overlay_style = currentOverlayStyle;
    config.app.sound = {
      enabled: el.soundEnabled.checked,
      start_sound: el.startSoundName.dataset.path || "",
      end_sound: el.endSoundName.dataset.path || "",
    };
    config.app.beta_updates = el.betaUpdates.checked;

    config.audio = config.audio || {};
    config.audio.provider = getAsrProvider(config);

    const doubaoConfig = ensureModelConfig(config, DOUBAO_MODEL_ID);
    doubaoConfig.url = el.wsUrl.value.trim();
    doubaoConfig.resource_id = el.resourceId.value.trim();
    doubaoConfig.app_id = el.appId.value.trim();
    doubaoConfig.access_token = el.accessToken.value.trim();
    doubaoConfig.secret_key = el.secretKey.value.trim();
    const lang = el.language.value.trim();
    if (lang) {
      doubaoConfig.language = lang;
    } else {
      delete doubaoConfig.language;
    }

    doubaoConfig.enable_ddc = el.enableDdc.checked;
    doubaoConfig.enable_nonstream = el.enableNonstream.checked;
    doubaoConfig.enable_itn = el.enableItn.checked;
    doubaoConfig.enable_punc = el.enablePunc.checked;
    doubaoConfig.corpus = doubaoConfig.corpus || {};
    doubaoConfig.corpus.boosting_table_id = el.boostingTableId.value.trim();
    if (el.doubaoAdvancedConfig) {
      el.doubaoAdvancedConfig.querySelectorAll(".model-param").forEach((input) => {
        const value = readModelParamInput(input);
        if (value !== undefined) {
          doubaoConfig[input.dataset.param] = value;
        }
      });
    }

    return finalizeConfigPayload(config);
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

  // ===== Microphone =====

  function updateMicStatus(status) {
    const labels = {
      granted: "已授权",
      denied: "已拒绝",
      prompt: "未授权",
      "not-determined": "未授权",
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
    let result;
    try {
      result = await window.voiceSettings.getMicrophoneStatus();
      if (result.status === "prompt" || result.status === "not-determined") {
        result = await window.voiceSettings.requestMicrophoneAccess();
      }
    } catch {
      result = { status: "unknown" };
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
    const prev = el.accDot.dataset.status;
    updateAccessibilityStatus(result.status || "unknown");

    // If accessibility permission was just granted and the hotkey listener
    // was never started (e.g. because permission was missing at launch),
    // try to reinitialize it now.
    if (result.status === "granted" && prev !== "granted") {
      window.voiceSettings.reinitHotkey();
    }
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function clonePlain(value) {
    return JSON.parse(JSON.stringify(value || {}));
  }

  function getAsrProvider(config = parsedConfig) {
    return config.audio?.provider || DOUBAO_MODEL_ID;
  }

  function getRegistryModel(modelId) {
    return Array.isArray(_modelRegistry)
      ? _modelRegistry.find((entry) => entry.id === modelId)
      : null;
  }

  function defaultModelConfig(modelId) {
    return clonePlain(getRegistryModel(modelId)?.default_config || {});
  }

  function ensureModelConfig(config, modelId) {
    config.audio = config.audio || {};
    if (!config.audio[modelId] || typeof config.audio[modelId] !== "object") {
      config.audio[modelId] = defaultModelConfig(modelId);
    }
    return config.audio[modelId];
  }

  function getMergedModelConfig(config, modelId) {
    return {
      ...defaultModelConfig(modelId),
      ...(config.audio?.[modelId] || {}),
    };
  }

  function labelForModelParam(key) {
    return MODEL_PARAM_LABELS[key] || key.replace(/_/g, " ");
  }

  function renderModelConfigRows(modelId, values) {
    return Object.entries(values || {})
      .map(([key, value]) => {
        const label = escapeHtml(labelForModelParam(key));
        const escapedKey = escapeHtml(key);
        if (typeof value === "boolean") {
          return `<div class="config-row"><span class="config-label">${label}</span><label class="toggle"><input type="checkbox" class="model-param" data-model-id="${escapeHtml(modelId)}" data-param="${escapedKey}" data-value-type="boolean" ${value ? "checked" : ""} /><span class="track"></span><span class="thumb"></span></label></div>`;
        }
        if (typeof value === "number") {
          return `<div class="config-row"><span class="config-label">${label}</span><input type="number" class="input-field model-param" data-model-id="${escapeHtml(modelId)}" data-param="${escapedKey}" data-value-type="number" value="${escapeHtml(String(value))}" step="0.1" /></div>`;
        }
        return `<div class="config-row"><span class="config-label">${label}</span><input type="text" class="input-field model-param" data-model-id="${escapeHtml(modelId)}" data-param="${escapedKey}" data-value-type="string" value="${escapeHtml(String(value ?? ""))}" /></div>`;
      })
      .join("");
  }

  function readModelParamInput(input) {
    if (input.dataset.valueType === "boolean") return input.checked;
    if (input.dataset.valueType === "number") {
      const val = parseFloat(input.value);
      return Number.isNaN(val) ? undefined : val;
    }
    return input.value.trim();
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
      const displayString = result?.displayString || "自定义快捷键";
      // If result.hotkey is a string, save as string (compatible with global-shortcut plugin).
      // Otherwise fall back to result.keys array (legacy uIOhook keycode format).
      const hotkey = result?.hotkey || (Array.isArray(result) ? result : result?.keys);

      if (hotkey && (typeof hotkey === "string" || (Array.isArray(hotkey) && hotkey.length > 0))) {
        parsedConfig.app = parsedConfig.app || {};
        parsedConfig.app.hotkey = typeof hotkey === "string" ? hotkey : hotkey;
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
          .then((result) => {
            if (result.available) {
              setUpdateState("available", { version: result.version });
            } else {
              setUpdateState("not-available");
            }
          })
          .catch((err) => setUpdateState("error", { message: err.message || "检查更新失败" }));
        break;
      case "available": {
        setUpdateState("downloading");
        const unsub = window.voiceSettings.onUpdateProgress((payload) => {
          if (payload.finished) {
            setUpdateState("downloaded");
          } else {
            const total = payload.contentLength || 0;
            const pct = total > 0 ? Math.round((payload.downloaded / total) * 100) : 0;
            setUpdateState("progress", { percent: pct });
          }
        });
        window.voiceSettings
          .downloadUpdate()
          .then(() => {
            unsub();
            setUpdateState("downloaded");
          })
          .catch((err) => {
            unsub();
            setUpdateState("error", {
              message: err?.message || "下载更新失败",
            });
          });
        break;
      }
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

    // Start with 3 days; auto-expand if no records found (up to 30 days)
    let daysBack = 3;
    let items = await window.voiceSettings.getHistory(daysBack);
    while ((!items || items.length === 0) && daysBack < 30) {
      daysBack += 3;
      items = await window.voiceSettings.getHistory(daysBack);
    }

    _historyDaysBack = daysBack;
    renderHistory(items);
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
      const previousPreference = currentThemePreference;

      // Optimistic UI update
      document.querySelectorAll(".theme-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.themeVal === preference);
      });
      currentThemePreference = preference;
      if (parsedConfig.app) {
        parsedConfig.app.theme = preference;
      }
      applyTheme(resolveTheme(preference));

      // Save through unified path so cleanup + state overrides are consistent
      const config = JSON.parse(JSON.stringify(parsedConfig));
      finalizeConfigPayload(config);
      try {
        await window.voiceSettings.saveConfigObject(config);
        // theme-changed event will also call applyTheme (double-safe)
      } catch (_err) {
        // Revert on error
        currentThemePreference = previousPreference;
        if (parsedConfig.app) {
          parsedConfig.app.theme = previousPreference;
        }
        document.querySelectorAll(".theme-btn").forEach((b) => {
          b.classList.toggle("active", b.dataset.themeVal === previousPreference);
        });
        applyTheme(resolveTheme(previousPreference));
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

  // Refresh accessibility status when window regains focus (e.g., after
  // user switches back from System Settings where they granted permission).
  window.addEventListener("focus", () => {
    refreshAccessibilityStatus();
  });

  // Save bar
  el.toggleAccessToken.addEventListener("click", () =>
    toggleSecret("accessToken", el.toggleAccessToken),
  );
  el.toggleSecretKey.addEventListener("click", () => toggleSecret("secretKey", el.toggleSecretKey));

  // Beta updates toggle
  el.betaUpdates.addEventListener("change", saveFormNow);

  // LLM fields
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
      // recordHotkey returns { hotkey, displayString, keys }
      // Use the hotkey string (e.g. "Control+Shift+A") for compatibility with
      // the global-shortcut plugin. Store as a single-element array for backward
      // compat with the prompts.json format.
      const hotkeyStr = result?.hotkey || "";
      const displayStr = result?.displayString || "";

      if (hotkeyStr) {
        // Store as string array for global-shortcut compatibility
        promptsData[index].hotkey = [hotkeyStr];
        promptsData[index]._displayString = displayStr;
        await savePromptsNow();
        renderPromptHotkeys();
      } else {
        promptsData[index].hotkey = [];
        delete promptsData[index]._displayString;
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
      currentThemePreference = event.payload.preference || currentThemePreference;
      // Keep parsedConfig in sync so direct saves don't overwrite with stale value.
      if (parsedConfig.app && event.payload.preference) {
        parsedConfig.app.theme = event.payload.preference;
      }
      applyTheme(event.payload.resolved);
    }
  });

  // ===== Model Tab Switching =====

  document.querySelectorAll("#modelTabs .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#modelTabs .seg-btn").forEach((b) => {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      document.getElementById("tab-online").classList.toggle("hidden", tab !== "online");
      document.getElementById("tab-offline").classList.toggle("hidden", tab !== "offline");
      if (tab === "offline") loadOfflineModels();
    });
  });

  // Doubao config expand/collapse
  if (el.doubaoExpandBtn) {
    el.doubaoExpandBtn.addEventListener("click", () => {
      const config = el.doubaoConfig;
      const btn = el.doubaoExpandBtn;
      const isHidden = config.classList.contains("hidden");
      config.classList.toggle("hidden", !isHidden);
      btn.classList.toggle("expanded", isHidden);
      btn.querySelector("span:last-child").textContent = isHidden ? "收起配置" : "展开配置";
    });
  }

  // ===== Model Enable Toggle (mutually exclusive) =====

  if (el.enableDoubao) {
    el.enableDoubao.addEventListener("change", async () => {
      if (el.enableDoubao.checked) {
        // Uncheck all offline model toggles
        if (el.offlineModelList) {
          el.offlineModelList.querySelectorAll(".offline-model-toggle").forEach((t) => {
            t.checked = false;
          });
        }
        await saveModelSelection(DOUBAO_MODEL_ID);
      }
    });
  }

  /** Uncheck the doubao toggle (called when an offline model is enabled). */
  function disableDoubaoToggle() {
    if (el.enableDoubao) {
      el.enableDoubao.checked = false;
    }
  }

  async function saveModelSelection(modelId) {
    // Clone parsedConfig to avoid mutating it in-place before saving.
    const config = JSON.parse(JSON.stringify(parsedConfig || {}));
    if (!config.audio) config.audio = {};
    config.audio.provider = modelId;
    ensureModelConfig(config, modelId);
    finalizeConfigPayload(config);
    try {
      await window.voiceSettings.saveConfigObject(config);
      await loadSettings();
    } catch (_err) {
      /* ignore */
    }
  }

  function updateCurrentModelBadge() {
    const c = parsedConfig || {};
    const modelId = getAsrProvider(c);
    if (el.currentModelBadge) {
      const item = Array.isArray(_modelRegistry)
        ? _modelRegistry.find((entry) => entry.id === modelId)
        : null;
      el.currentModelBadge.textContent = `当前：${item?.name || modelId}`;
    }
  }

  // ===== Offline Model List =====

  let _modelRegistry = null;
  let _downloadedModels = [];

  async function loadOfflineModels() {
    try {
      // Registry is already loaded in loadSettings(); only refresh downloads
      const dlResult = await window.voiceSettings.getDownloadedModels();
      _downloadedModels = dlResult?.models || [];
      renderOfflineModels();
      updateCurrentModelBadge();
    } catch (_err) {
      if (el.offlineModelList) {
        el.offlineModelList.innerHTML = '<div class="hint-text">加载模型列表失败</div>';
      }
    }
  }

  function renderOfflineModels() {
    if (!el.offlineModelList || !_modelRegistry) return;
    const offlineModels = _modelRegistry.filter((m) => m.type === "offline");
    if (offlineModels.length === 0) {
      el.offlineModelList.innerHTML = '<div class="hint-text">暂无可用本地模型</div>';
      return;
    }

    const c = parsedConfig || {};
    const currentModelId = getAsrProvider(c);

    // Sort: VAD first, then ASR
    const sorted = [...offlineModels].sort((a, b) => {
      if (a.category !== b.category) {
        if (a.category === "vad") return -1;
        if (b.category === "vad") return 1;
      }
      return 0;
    });

    el.offlineModelList.innerHTML = sorted
      .map((model) => {
        const isDownloaded = _downloadedModels.includes(model.id);
        const isActive = currentModelId === model.id;
        const isVad = model.category === "vad";
        const tags = (model.tags || [])
          .map((t) => `<span class="model-tag${isVad ? " vad-tag" : ""}">${escapeHtml(t)}</span>`)
          .join("");
        const langStr = model.languages?.length
          ? model.languages.slice(0, 3).join(", ") + (model.languages.length > 3 ? "…" : "")
          : "";
        const sizeStr = [
          model.file_size ? `${model.file_size}MB` : "",
          model.mem_size ? `${model.mem_size}MB 内存` : "",
        ]
          .filter(Boolean)
          .join(" · ");

        let body = `<div class="model-card">`;
        body += `<div class="model-card-head">`;
        body += `<div class="model-card-info">`;
        body += `<div class="model-card-name">${escapeHtml(model.name)}</div>`;
        body += `<div class="model-card-tags">${tags}</div>`;
        if (langStr || sizeStr) {
          body += `<div class="model-card-meta">${[langStr, sizeStr].filter(Boolean).join(" · ")}</div>`;
        }
        body += `</div>`;
        // ASR models get enable toggle; VAD/punctuation are base models — no toggle
        if (!isVad) {
          body += `<label class="toggle model-enable-toggle">`;
          body += `<input type="checkbox" data-model-id="${model.id}" class="offline-model-toggle" ${isActive ? "checked" : ""} ${!isDownloaded ? "disabled" : ""} />`;
          body += `<span class="track"></span><span class="thumb"></span>`;
          body += `</label>`;
        }
        body += `</div>`; // end model-card-head

        if (model.default_config && Object.keys(model.default_config).length > 0) {
          const configValues = getMergedModelConfig(c, model.id);
          body += `<div class="model-expand-wrap">`;
          body += `<button type="button" class="model-expand-btn model-config-expand-btn" data-model-id="${escapeHtml(model.id)}">`;
          body += `<span class="nav-icon" data-icon="chevron-down"></span>`;
          body += `<span>展开配置</span>`;
          body += `</button></div>`;
          body += `<div class="model-card-config hidden model-config" data-model-id="${escapeHtml(model.id)}">`;
          body += `<div class="config-group">`;
          body += renderModelConfigRows(model.id, configValues);
          body += `</div></div>`;
        }

        body += `<div class="model-card-status">`;
        if (isDownloaded) {
          body += `<span class="model-downloaded">已下载${model.file_size ? ` · ${model.file_size}MB` : ""}</span>`;
          body += `<button type="button" class="model-delete-btn" data-model-id="${model.id}">删除</button>`;
        } else {
          body += `<button type="button" class="model-download-btn" data-model-id="${model.id}">下载${model.file_size ? ` ${model.file_size}MB` : ""}</button>`;
        }
        body += `</div>`;

        body += `</div>`; // end model-card
        return body;
      })
      .join("");

    // Event listeners for enable toggles (ASR models only)
    el.offlineModelList.querySelectorAll(".offline-model-toggle").forEach((toggle) => {
      toggle.addEventListener("change", async (e) => {
        const modelId = e.target.dataset.modelId;
        if (e.target.checked) {
          disableDoubaoToggle();
          el.offlineModelList.querySelectorAll(".offline-model-toggle").forEach((t) => {
            if (t !== e.target) t.checked = false;
          });
          await saveModelSelection(modelId);
        }
      });
    });

    // Model config expand/collapse
    el.offlineModelList.querySelectorAll(".model-config-expand-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const config = [...el.offlineModelList.querySelectorAll(".model-config")].find(
          (item) => item.dataset.modelId === btn.dataset.modelId,
        );
        if (!config) return;
        const isHidden = config.classList.contains("hidden");
        config.classList.toggle("hidden", !isHidden);
        btn.classList.toggle("expanded", isHidden);
        btn.querySelector("span:last-child").textContent = isHidden ? "收起配置" : "展开配置";
      });
    });

    // Model param auto-save
    el.offlineModelList.querySelectorAll(".model-param").forEach((input) => {
      input.addEventListener("change", async () => {
        const config = JSON.parse(JSON.stringify(parsedConfig));
        const modelConfig = ensureModelConfig(config, input.dataset.modelId);
        const param = input.dataset.param;
        const value = readModelParamInput(input);
        if (value !== undefined) {
          modelConfig[param] = value;
        }
        finalizeConfigPayload(config);
        try {
          await window.voiceSettings.saveConfigObject(config);
          parsedConfig = config;
        } catch (_err) {
          /* ignore */
        }
      });
    });

    // Event listeners for download buttons
    el.offlineModelList.querySelectorAll(".model-download-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const modelId = btn.dataset.modelId;
        const VAD_ID = "silero-vad";

        // Step 1: If downloading an ASR model and VAD not downloaded,
        // trigger VAD download first — progress shown on VAD card.
        if (modelId !== VAD_ID && !_downloadedModels.includes(VAD_ID)) {
          const vadBtn = el.offlineModelList.querySelector(
            `.model-download-btn[data-model-id="${VAD_ID}"]`,
          );
          if (vadBtn) {
            vadBtn.disabled = true;
            vadBtn.textContent = "下载中 0%";
            const vadUnsub = window.voiceSettings.onModelDownloadProgress((payload) => {
              if (payload.model_id !== VAD_ID) return;
              if (payload.status === "downloading") {
                vadBtn.textContent = `下载中 ${payload.progress}%`;
              } else if (payload.status === "completed") {
                vadBtn.textContent = "下载完成";
              }
            });
            try {
              await window.voiceSettings.downloadModel(VAD_ID);
              vadUnsub();
              _downloadedModels.push(VAD_ID);
            } catch (_err) {
              vadUnsub();
              vadBtn.textContent = "下载失败";
              vadBtn.disabled = false;
              return;
            }
          }
        }

        // Step 2: Download the requested model
        btn.disabled = true;
        btn.textContent = "下载中 0%";
        const unsub = window.voiceSettings.onModelDownloadProgress((payload) => {
          if (payload.model_id !== modelId) return;
          if (payload.status === "downloading") {
            btn.textContent = `下载中 ${payload.progress}%`;
          } else if (payload.status === "completed") {
            btn.textContent = "下载完成";
          }
        });

        try {
          await window.voiceSettings.downloadModel(modelId);
          unsub();
          await loadOfflineModels();
        } catch (_err) {
          unsub();
          btn.textContent = "下载失败";
          btn.disabled = false;
        }
      });
    });

    // Event listeners for delete buttons
    el.offlineModelList.querySelectorAll(".model-delete-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const modelId = btn.dataset.modelId;
        try {
          await window.voiceSettings.deleteModel(modelId);
          await loadOfflineModels();
        } catch (_err) {
          /* ignore */
        }
      });
    });
  }

  // ===== Hotword Groups =====

  let _hotwordData = null;

  async function loadHotwordGroups() {
    try {
      _hotwordData = await window.voiceSettings.loadHotwords();
      renderHotwordGroups();
    } catch (_err) {
      _hotwordData = {
        active_group: "default",
        groups: [{ id: "default", name: "默认热词表", words: [] }],
      };
      renderHotwordGroups();
    }
  }

  async function saveHotwordData() {
    if (!_hotwordData) return;
    try {
      await window.voiceSettings.saveHotwords(_hotwordData);
    } catch (_err) {
      /* ignore */
    }
  }

  function renderHotwordGroups() {
    if (!el.hotwordGroupsList || !_hotwordData) return;
    const groups = _hotwordData.groups || [];

    el.hotwordGroupsList.innerHTML = groups
      .map((group) => {
        const isActive = group.id === _hotwordData.active_group;
        const tags = (group.words || [])
          .map(
            (word, i) =>
              `<span class="tag"><span>${escapeHtml(word)}</span><button type="button" class="tag-remove" data-group="${group.id}" data-index="${i}">&times;</button></span>`,
          )
          .join("");

        return (
          `<div class="hotword-group-card" data-group-id="${group.id}">` +
          `<div class="hotword-group-head">` +
          `<div>` +
          `<span class="hotword-group-name">${escapeHtml(group.name)}</span>` +
          (isActive ? `<span class="hotword-group-active">当前生效</span>` : "") +
          `</div>` +
          `<div class="hotword-group-actions">` +
          (isActive
            ? ""
            : `<button type="button" class="btn btn-sm hw-activate-btn" data-group="${group.id}">使用</button>`) +
          (group.id === "default"
            ? ""
            : `<button type="button" class="btn btn-sm hw-delete-group-btn" data-group="${group.id}">删除</button>`) +
          `</div>` +
          `</div>` +
          `<div class="hotword-input-group">` +
          `<input type="text" class="input-field hw-input" data-group="${group.id}" placeholder="输入热词（支持 热词|权重，1-10，默认4）" />` +
          `<button type="button" class="btn btn-sm hw-add-btn" data-group="${group.id}">添加</button>` +
          `</div>` +
          `<div class="tag-list" style="margin-top: 8px">${tags}</div>` +
          `</div>`
        );
      })
      .join("");

    // Event listeners for hotword groups
    el.hotwordGroupsList.querySelectorAll(".hw-activate-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        _hotwordData.active_group = btn.dataset.group;
        await saveHotwordData();
        renderHotwordGroups();
      });
    });

    el.hotwordGroupsList.querySelectorAll(".hw-delete-group-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const groupId = btn.dataset.group;
        _hotwordData.groups = _hotwordData.groups.filter((g) => g.id !== groupId);
        if (_hotwordData.active_group === groupId) {
          _hotwordData.active_group = "default";
        }
        await saveHotwordData();
        renderHotwordGroups();
      });
    });

    el.hotwordGroupsList.querySelectorAll(".hw-add-btn").forEach((btn) => {
      btn.addEventListener("click", () => addHotwordToGroup(btn.dataset.group));
    });

    el.hotwordGroupsList.querySelectorAll(".hw-input").forEach((input) => {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") addHotwordToGroup(input.dataset.group);
      });
    });

    el.hotwordGroupsList.querySelectorAll(".tag-remove").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const groupId = btn.dataset.group;
        const index = parseInt(btn.dataset.index, 10);
        const group = _hotwordData.groups.find((g) => g.id === groupId);
        if (group) {
          group.words.splice(index, 1);
          await saveHotwordData();
          renderHotwordGroups();
        }
      });
    });
  }

  async function addHotwordToGroup(groupId) {
    const input = el.hotwordGroupsList.querySelector(`.hw-input[data-group="${groupId}"]`);
    if (!input) return;
    const word = input.value.trim();
    if (!word) return;

    const group = _hotwordData.groups.find((g) => g.id === groupId);
    if (!group) return;

    if (group.words.includes(word)) return;
    group.words.push(word);
    input.value = "";
    await saveHotwordData();
    renderHotwordGroups();
  }

  if (el.addHotwordGroupBtn) {
    el.addHotwordGroupBtn.addEventListener("click", async () => {
      if (!_hotwordData) {
        _hotwordData = {
          active_group: "default",
          groups: [{ id: "default", name: "默认热词表", words: [] }],
        };
      }
      const id = `hw-${Date.now()}`;
      _hotwordData.groups.push({ id, name: "新建热词表", words: [] });
      await saveHotwordData();
      renderHotwordGroups();
    });
  }

  // ── Test-only exports ─────────────────────────────────────────────────
  // Exposed only in Node.js test environments; has zero effect in WebView.
  if (typeof process !== "undefined" && process.env?.NODE_ENV === "test") {
    module.exports = {
      normalizeHotkeyLabel,
      formatPromptHotkey,
      formatCompact,
      formatDuration,
      escapeHtml,
      clonePlain,
      getAsrProvider,
      getRegistryModel,
      defaultModelConfig,
      ensureModelConfig,
      getMergedModelConfig,
      labelForModelParam,
      readModelParamInput,
      soundFileName,
      renderModelConfigRows,
      resolveTheme,
    };
  }

  // ===== Init =====
  initIcons();
  loadAppIcon();
  loadSettings();
  loadHomeData();
  watchSystemTheme();
})();

(() => {
  let parsedConfig = {};
  let _originalConfigText = "";
  let hotwords = [];
  let isDirty = false;
  let currentThemePreference = "system";
  let currentHotkeyMode = "toggle";

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
    configPath: $("configPath"),
    autoStart: $("autoStart"),
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
    if (!displayString) {
      const kbd = document.createElement("kbd");
      kbd.textContent = "未设置";
      el.hotkeyDisplay.appendChild(kbd);
      return;
    }
    displayString
      .split("+")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((key) => {
        const kbd = document.createElement("kbd");
        kbd.textContent = key;
        el.hotkeyDisplay.appendChild(kbd);
      });
  }

  function setHotkeyMode(mode) {
    currentHotkeyMode = mode === "hold" ? "hold" : "toggle";
    el.hotkeyModeSelector.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.val === currentHotkeyMode);
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
      handleUpdateClick();
    } catch (_err) {
      /* ignore */
    }
  }

  function populateForm(data) {
    const c = parsedConfig;

    const hotkeyDisplay =
      data.runtime?.hotkeyDisplay ||
      (Array.isArray(c.app?.hotkey) ? "自定义快捷键" : c.app?.hotkey || "F13");
    renderHotkeyDisplay(hotkeyDisplay);
    setHotkeyMode(c.app?.hotkey_mode);

    el.configPath.textContent = data.configPath || "-";

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
  }

  function collectConfig() {
    const config = JSON.parse(JSON.stringify(parsedConfig));

    config.app = config.app || {};
    config.app.hotkey = config.app.hotkey || "F13";
    config.app.hotkey_mode = currentHotkeyMode;
    config.app.remove_trailing_period = el.removeTrailingPeriod.checked;
    config.app.keep_clipboard = el.keepClipboard.checked;
    config.app.theme = currentThemePreference;

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
        setHotkeyHint("", "");
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
      row.innerHTML = `<span class="history-time">${time}</span><div class="history-content"><div class="history-text">${escapeHtml(item.text)}</div></div>`;
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

  // Auto-start
  el.autoStart.addEventListener("change", async () => {
    await window.voiceSettings.setLoginItemSettings(el.autoStart.checked);
  });

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

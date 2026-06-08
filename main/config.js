const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");
const YAML = require("yaml");

function resolveConfigExamplePath() {
  if (process.resourcesPath) {
    const p = path.join(process.resourcesPath, "config.yaml.example");
    if (fs.existsSync(p)) return p;
  }

  const local = path.join(__dirname, "..", "config.yaml.example");
  if (fs.existsSync(local)) return local;

  return null;
}

function resolveConfigPath() {
  if (app.isPackaged) {
    const userConfigPath = path.join(app.getPath("userData"), "config.yaml");

    if (!fs.existsSync(userConfigPath)) {
      const examplePath = resolveConfigExamplePath();
      if (examplePath) {
        fs.copyFileSync(examplePath, userConfigPath);
      } else {
        fs.writeFileSync(userConfigPath, "", "utf8");
      }
    }

    return userConfigPath;
  }

  const candidates = [
    path.join(process.cwd(), "config.yaml"),
    path.join(__dirname, "..", "config.yaml"),
  ];

  const matched = candidates.find((candidate) => fs.existsSync(candidate));
  if (!matched) {
    throw new Error("未找到 config.yaml");
  }

  return matched;
}

const CONFIG_PATH = resolveConfigPath();

function resolvePromptsPath() {
  if (app.isPackaged) {
    return path.join(app.getPath("userData"), "prompts.json");
  }
  return path.join(__dirname, "..", "prompts.json");
}

const PROMPTS_PATH = resolvePromptsPath();

function resolvePromptsExamplePath() {
  if (process.resourcesPath) {
    const p = path.join(process.resourcesPath, "prompts.json.example");
    if (fs.existsSync(p)) return p;
  }

  const local = path.join(__dirname, "..", "prompts.json.example");
  if (fs.existsSync(local)) return local;

  return null;
}

function normalizePromptItem(item, index) {
  const fallbackId = `prompt-${index + 1}`;
  return {
    id: typeof item?.id === "string" && item.id.trim() ? item.id.trim() : fallbackId,
    title: typeof item?.title === "string" ? item.title : "",
    hotkey: Array.isArray(item?.hotkey) ? item.hotkey.filter((key) => Number.isFinite(key)) : [],
    hotkey_mode: item?.hotkey_mode === "hold" ? "hold" : "toggle",
    prompt: typeof item?.prompt === "string" ? item.prompt : "",
  };
}

function ensurePromptsFile() {
  if (!fs.existsSync(PROMPTS_PATH)) {
    const examplePath = resolvePromptsExamplePath();
    if (examplePath && fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, PROMPTS_PATH);
    } else {
      fs.writeFileSync(PROMPTS_PATH, "[]", "utf8");
    }
  }
}

function loadDefaultPrompts() {
  const examplePath = resolvePromptsExamplePath();
  if (!examplePath) return [];
  try {
    const content = fs.readFileSync(examplePath, "utf8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed.map(normalizePromptItem) : [];
  } catch {
    return [];
  }
}

function loadPrompts() {
  ensurePromptsFile();
  try {
    const content = fs.readFileSync(PROMPTS_PATH, "utf8");
    const parsed = JSON.parse(content);
    const prompts = Array.isArray(parsed) ? parsed.map(normalizePromptItem) : [];
    const defaults = loadDefaultPrompts();
    const existingIds = new Set(prompts.map((item) => item.id));
    const missingDefaults = defaults.filter((item) => !existingIds.has(item.id));
    if (missingDefaults.length > 0) {
      const merged = [...prompts, ...missingDefaults];
      fs.writeFileSync(PROMPTS_PATH, JSON.stringify(merged, null, 2), "utf8");
      return merged;
    }
    return prompts;
  } catch {
    return loadDefaultPrompts();
  }
}

function savePrompts(prompts) {
  const normalized = Array.isArray(prompts) ? prompts.map(normalizePromptItem) : [];
  fs.writeFileSync(PROMPTS_PATH, JSON.stringify(normalized, null, 2), "utf8");
}

function readConfigFile() {
  return fs.readFileSync(CONFIG_PATH, "utf8");
}

function parseConfigFile() {
  return YAML.parse(readConfigFile()) || {};
}

function parseContextHotwords(value) {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((word) => ({ word }));
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return { word: item.trim() };
        if (item && typeof item.word === "string" && item.word.trim()) {
          return { word: item.word.trim() };
        }
        return null;
      })
      .filter(Boolean);
  }

  return [];
}

/**
 * loadConfig() 返回与 config.yaml / 官方 API 文档完全一致的字段名（snake_case）。
 * 新增 API 参数只需在 config.yaml 中添加，loadConfig 会自动透传。
 */
function loadConfig() {
  const raw = parseConfigFile();

  return {
    app: {
      ...(raw.app || {}),
      hotkey: raw.app?.hotkey || "F13",
      hotkey_mode: raw.app?.hotkey_mode === "hold" ? "hold" : "toggle",
      remove_trailing_period: raw.app?.remove_trailing_period !== false,
      theme: raw.app?.theme || "system",
      overlay_style: raw.app?.overlay_style === "vibrancy" ? "vibrancy" : "liquid",
      overlay_glass_mode: ["light", "dark"].includes(raw.app?.overlay_glass_mode)
        ? raw.app.overlay_glass_mode
        : "auto",
    },
    connection: {
      ...(raw.connection || {}),
      url: raw.connection?.url || "",
      app_id: String(raw.connection?.app_id || ""),
      access_token: raw.connection?.access_token || "",
      resource_id: raw.connection?.resource_id || "",
    },
    audio: {
      ...(raw.audio || {}),
      format: raw.audio?.format || "pcm",
      rate: Number(raw.audio?.rate || 16000),
      bits: Number(raw.audio?.bits || 16),
      channel: Number(raw.audio?.channel || 1),
    },
    request: {
      ...(raw.request || {}),
      model_name: raw.request?.model_name || "bigmodel",
      model_version: String(raw.request?.model_version || "400"),
      operation: raw.request?.operation || "submit",
      sequence: Number(raw.request?.sequence ?? 0),
      enable_itn: raw.request?.enable_itn !== false,
      enable_punc: raw.request?.enable_punc !== false,
      enable_ddc: raw.request?.enable_ddc !== false,
      show_utterances: raw.request?.show_utterances !== false,
      result_type: raw.request?.result_type || "full",
      end_window_size: Number(raw.request?.end_window_size || 800),
      force_to_speech_time: Number(raw.request?.force_to_speech_time || 1000),
      accelerate_score: Number(raw.request?.accelerate_score || 0),
      vad_segment_duration: Number(raw.request?.vad_segment_duration || 3000),
      corpus: {
        ...(raw.request?.corpus || {}),
      },
      context_hotwords: parseContextHotwords(raw.request?.corpus?.context_hotwords),
    },
    llm: {
      ...(raw.llm || {}),
      enabled: Boolean(raw.llm?.enabled),
      provider: raw.llm?.provider || (raw.llm?.url ? "openai_compatible" : "deepseek"),
      deepseek: {
        ...(raw.llm?.deepseek || {}),
        url: raw.llm?.deepseek?.url || (raw.llm?.provider === "deepseek" ? raw.llm?.url : "") || "",
        api_key:
          raw.llm?.deepseek?.api_key ||
          (raw.llm?.provider === "deepseek" ? raw.llm?.api_key : "") ||
          "",
        model:
          raw.llm?.deepseek?.model ||
          (raw.llm?.provider === "deepseek" ? raw.llm?.model : "") ||
          "",
      },
      openai: {
        ...(raw.llm?.openai || {}),
        url: raw.llm?.openai?.url || (raw.llm?.provider === "openai" ? raw.llm?.url : "") || "",
        api_key:
          raw.llm?.openai?.api_key ||
          (raw.llm?.provider === "openai" ? raw.llm?.api_key : "") ||
          "",
        model:
          raw.llm?.openai?.model || (raw.llm?.provider === "openai" ? raw.llm?.model : "") || "",
      },
      anthropic: {
        ...(raw.llm?.anthropic || {}),
        url:
          raw.llm?.anthropic?.url || (raw.llm?.provider === "anthropic" ? raw.llm?.url : "") || "",
        api_key:
          raw.llm?.anthropic?.api_key ||
          (raw.llm?.provider === "anthropic" ? raw.llm?.api_key : "") ||
          "",
        model:
          raw.llm?.anthropic?.model ||
          (raw.llm?.provider === "anthropic" ? raw.llm?.model : "") ||
          "",
      },
      gemini: {
        ...(raw.llm?.gemini || {}),
        url: raw.llm?.gemini?.url || (raw.llm?.provider === "gemini" ? raw.llm?.url : "") || "",
        api_key:
          raw.llm?.gemini?.api_key ||
          (raw.llm?.provider === "gemini" ? raw.llm?.api_key : "") ||
          "",
        model:
          raw.llm?.gemini?.model || (raw.llm?.provider === "gemini" ? raw.llm?.model : "") || "",
      },
      openrouter: {
        ...(raw.llm?.openrouter || {}),
        url:
          raw.llm?.openrouter?.url ||
          (raw.llm?.provider === "openrouter" ? raw.llm?.url : "") ||
          "",
        api_key:
          raw.llm?.openrouter?.api_key ||
          (raw.llm?.provider === "openrouter" ? raw.llm?.api_key : "") ||
          "",
        model:
          raw.llm?.openrouter?.model ||
          (raw.llm?.provider === "openrouter" ? raw.llm?.model : "") ||
          "",
      },
      siliconflow: {
        ...(raw.llm?.siliconflow || {}),
        url:
          raw.llm?.siliconflow?.url ||
          (raw.llm?.provider === "siliconflow" ? raw.llm?.url : "") ||
          "",
        api_key:
          raw.llm?.siliconflow?.api_key ||
          (raw.llm?.provider === "siliconflow" ? raw.llm?.api_key : "") ||
          "",
        model:
          raw.llm?.siliconflow?.model ||
          (raw.llm?.provider === "siliconflow" ? raw.llm?.model : "") ||
          "",
      },
      ollama: {
        ...(raw.llm?.ollama || {}),
        url: raw.llm?.ollama?.url || (raw.llm?.provider === "ollama" ? raw.llm?.url : "") || "",
        api_key:
          raw.llm?.ollama?.api_key ||
          (raw.llm?.provider === "ollama" ? raw.llm?.api_key : "") ||
          "",
        model:
          raw.llm?.ollama?.model || (raw.llm?.provider === "ollama" ? raw.llm?.model : "") || "",
      },
      openai_compatible: {
        ...(raw.llm?.openai_compatible || {}),
        url: raw.llm?.openai_compatible?.url || raw.llm?.base_url || raw.llm?.url || "",
        api_key: raw.llm?.openai_compatible?.api_key || raw.llm?.api_key || "",
        model: raw.llm?.openai_compatible?.model || raw.llm?.model || "",
      },
    },
  };
}

function getEditableConfig() {
  return parseConfigFile();
}

function saveConfig(nextConfig) {
  const yaml = YAML.stringify(nextConfig, {
    indent: 2,
    lineWidth: 0,
  });
  fs.writeFileSync(CONFIG_PATH, yaml, "utf8");
}

function saveConfigText(text) {
  YAML.parse(text);
  fs.writeFileSync(CONFIG_PATH, text, "utf8");
}

function getConfigExamplePath() {
  return resolveConfigExamplePath();
}

function resetConfigToDefault() {
  const examplePath = getConfigExamplePath();
  if (!examplePath) {
    throw new Error("未找到 config.yaml.example");
  }

  const content = fs.readFileSync(examplePath, "utf8");
  fs.writeFileSync(CONFIG_PATH, content, "utf8");
}

module.exports = {
  CONFIG_PATH,
  PROMPTS_PATH,
  getEditableConfig,
  loadConfig,
  loadPrompts,
  readConfigFile,
  resetConfigToDefault,
  saveConfig,
  saveConfigText,
  savePrompts,
};

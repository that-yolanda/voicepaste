const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

function getConfigCandidates() {
  const candidates = [];

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "config.yaml"));
  }

  candidates.push(path.join(process.cwd(), "config.yaml"));
  candidates.push(path.join(__dirname, "..", "config.yaml"));

  return [...new Set(candidates)];
}

function resolveConfigPath() {
  const matched = getConfigCandidates().find((candidate) => fs.existsSync(candidate));

  if (!matched) {
    throw new Error("未找到 config.yaml");
  }

  return matched;
}

const CONFIG_PATH = resolveConfigPath();

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
      remove_trailing_period: raw.app?.remove_trailing_period !== false,
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
      // 需要类型转换的已知字段默认值
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
      // corpus 单独处理（context_hotwords 需要解析）
      corpus: {
        ...(raw.request?.corpus || {}),
      },
      context_hotwords: parseContextHotwords(raw.request?.corpus?.context_hotwords),
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
  if (process.resourcesPath) {
    const p = path.join(process.resourcesPath, "config.yaml.example");
    if (fs.existsSync(p)) return p;
  }

  const local = path.join(__dirname, "..", "config.yaml.example");
  if (fs.existsSync(local)) return local;

  return null;
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
  getEditableConfig,
  loadConfig,
  readConfigFile,
  resetConfigToDefault,
  saveConfig,
  saveConfigText,
};

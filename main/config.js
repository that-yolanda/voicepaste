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
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item === "string") {
        return { word: item };
      }

      if (item && typeof item.word === "string" && item.word.trim()) {
        return {
          word: item.word.trim(),
          ...(typeof item.weight === "number" ? { weight: item.weight } : {}),
        };
      }

      return null;
    })
    .filter(Boolean);
}

function loadConfig() {
  const config = parseConfigFile();

  return {
    app: {
      hotkey: config.app?.hotkey || "F13",
    },
    asr: {
      wsUrl: config.asr?.ws_url || "",
      resourceId: config.asr?.resource_id || "",
      language: config.asr?.language || "",
      sampleRate: Number(config.asr?.sample_rate || 16000),
      audioFormat: config.asr?.audio_format || "pcm",
      audioCodec: config.asr?.audio_codec || "raw",
      audioBits: Number(config.asr?.audio_bits || 16),
      audioChannel: Number(config.asr?.audio_channel || 1),
      modelName: config.asr?.model_name || "bigmodel",
      modelVersion: String(config.asr?.model_version || "400"),
      operation: config.asr?.operation || "submit",
      sequence: Number(config.asr?.sequence ?? 0),
      enableItn: config.asr?.enable_itn !== false,
      enablePunc: config.asr?.enable_punc !== false,
      enableNonstream: Boolean(config.asr?.enable_nonstream),
      enableDdc: config.asr?.enable_ddc !== false,
      showUtterances: config.asr?.show_utterances !== false,
      resultType: config.asr?.result_type || "full",
      endWindowSize: Number(config.asr?.end_window_size || 800),
      forceToSpeechTime: Number(config.asr?.force_to_speech_time || 1000),
      boostingTableId: config.asr?.boosting_table_id || "",
      contextHotwords: parseContextHotwords(config.asr?.context_hotwords),
    },
    auth: {
      appId: String(config.auth?.app_id || ""),
      accessToken: config.auth?.access_token || "",
      secretKey: config.auth?.secret_key || "",
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

module.exports = {
  CONFIG_PATH,
  getEditableConfig,
  loadConfig,
  readConfigFile,
  saveConfig,
  saveConfigText,
};

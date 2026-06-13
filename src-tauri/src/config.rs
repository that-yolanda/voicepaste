use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

pub const DOUBAO_STREAMING_ID: &str = "doubao-streaming";
pub const SILERO_VAD_ID: &str = "silero-vad";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub app: AppSettings,
    #[serde(default = "default_audio_settings")]
    pub audio: BTreeMap<String, serde_norway::Value>,
    #[serde(default)]
    pub llm: LlmConfig,
}

/// User-overridable VAD parameters stored in config.yaml.
/// All fields are `Option` so omitted values fall back to registry defaults.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VadParams {
    pub threshold: Option<f32>,
    pub min_silence_duration: Option<f32>,
    pub min_speech_duration: Option<f32>,
    pub max_speech_duration: Option<f32>,
    pub num_threads: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoubaoStreamingConfig {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub app_id: String,
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub secret_key: String,
    #[serde(default)]
    pub resource_id: String,
    #[serde(default = "default_format")]
    pub format: String,
    #[serde(default = "default_rate")]
    pub rate: u32,
    #[serde(default = "default_bits")]
    pub bits: u32,
    #[serde(default = "default_channel")]
    pub channel: u32,
    #[serde(default = "default_model_name")]
    pub model_name: String,
    #[serde(default)]
    pub model_version: String,
    #[serde(default = "default_operation")]
    pub operation: String,
    #[serde(default)]
    pub sequence: u32,
    #[serde(default)]
    pub language: String,
    #[serde(default = "default_true")]
    pub enable_ddc: bool,
    #[serde(default = "default_true")]
    pub enable_itn: bool,
    #[serde(default)]
    pub enable_nonstream: bool,
    #[serde(default = "default_true")]
    pub enable_punc: bool,
    #[serde(default)]
    pub show_utterances: bool,
    #[serde(default = "default_result_type")]
    pub result_type: String,
    #[serde(default)]
    pub end_window_size: Option<u32>,
    #[serde(default)]
    pub force_to_speech_time: Option<u32>,
    #[serde(default)]
    pub accelerate_score: Option<u32>,
    #[serde(default)]
    pub vad_segment_duration: Option<u32>,
    #[serde(default)]
    pub enable_accelerate_text: Option<bool>,
    #[serde(default)]
    pub corpus: Option<serde_norway::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default = "default_hotkey")]
    pub hotkey: serde_norway::Value,
    #[serde(default = "default_hotkey_mode")]
    pub hotkey_mode: String,
    #[serde(default = "default_true")]
    pub remove_trailing_period: bool,
    #[serde(default = "default_true")]
    pub keep_clipboard: bool,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_overlay_style")]
    pub overlay_style: String,
    #[serde(default)]
    pub sound: Option<SoundConfig>,
    /// When true, check for beta (prerelease) updates instead of stable only.
    #[serde(default)]
    pub beta_updates: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SoundConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub start_sound: String,
    #[serde(default)]
    pub end_sound: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub app_id: String,
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub secret_key: String,
    #[serde(default)]
    pub resource_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioConfig {
    #[serde(default = "default_format")]
    pub format: String,
    #[serde(default = "default_rate")]
    pub rate: u32,
    #[serde(default = "default_bits")]
    pub bits: u32,
    #[serde(default = "default_channel")]
    pub channel: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestConfig {
    #[serde(default = "default_model_name")]
    pub model_name: String,
    #[serde(default)]
    pub model_version: String,
    #[serde(default = "default_operation")]
    pub operation: String,
    #[serde(default)]
    pub sequence: u32,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default = "default_true")]
    pub enable_itn: bool,
    #[serde(default = "default_true")]
    pub enable_punc: bool,
    #[serde(default = "default_true")]
    pub enable_ddc: bool,
    #[serde(default = "default_true")]
    pub show_utterances: bool,
    #[serde(default = "default_result_type")]
    pub result_type: String,
    #[serde(default)]
    pub end_window_size: Option<u32>,
    #[serde(default)]
    pub force_to_speech_time: Option<u32>,
    #[serde(default)]
    pub accelerate_score: Option<u32>,
    #[serde(default)]
    pub vad_segment_duration: Option<u32>,
    #[serde(default)]
    pub enable_nonstream: Option<bool>,
    #[serde(default)]
    pub enable_accelerate_text: Option<bool>,
    #[serde(default)]
    pub corpus: Option<serde_norway::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LlmConfig {
    #[serde(default = "default_llm_provider")]
    pub provider: String,
    #[serde(default)]
    pub deepseek: Option<ProviderConfig>,
    #[serde(default)]
    pub openai: Option<ProviderConfig>,
    #[serde(default)]
    pub anthropic: Option<ProviderConfig>,
    #[serde(default)]
    pub gemini: Option<ProviderConfig>,
    #[serde(default)]
    pub openrouter: Option<ProviderConfig>,
    #[serde(default)]
    pub siliconflow: Option<ProviderConfig>,
    #[serde(default)]
    pub ollama: Option<ProviderConfig>,
    #[serde(default)]
    pub openai_compatible: Option<ProviderConfig>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptItem {
    pub id: String,
    #[serde(default)]
    pub title: String,
    /// Hotkey array — supports two formats:
    /// - Legacy uIOhook keycodes: `[29, 54, 4]` (numbers)
    /// - New accelerator strings: `["Control+Shift+A"]` (strings)
    #[serde(default)]
    pub hotkey: serde_norway::Value,
    #[serde(default = "default_hotkey_mode")]
    pub hotkey_mode: String,
    #[serde(default)]
    pub prompt: String,
}

// Default value functions
fn default_audio_settings() -> BTreeMap<String, serde_norway::Value> {
    let mut map = BTreeMap::new();
    map.insert(
        "provider".to_string(),
        serde_norway::Value::String(DOUBAO_STREAMING_ID.to_string()),
    );
    map
}

fn default_hotkey() -> serde_norway::Value {
    serde_norway::Value::String("F13".to_string())
}
fn default_hotkey_mode() -> String {
    "toggle".to_string()
}
fn default_true() -> bool {
    true
}
fn default_theme() -> String {
    "system".to_string()
}
fn default_overlay_style() -> String {
    "liquid".to_string()
}
fn default_format() -> String {
    "pcm".to_string()
}
fn default_rate() -> u32 {
    16000
}
fn default_bits() -> u32 {
    16
}
fn default_channel() -> u32 {
    1
}
fn default_model_name() -> String {
    "bigmodel".to_string()
}
fn default_operation() -> String {
    "submit".to_string()
}
fn default_result_type() -> String {
    "full".to_string()
}
fn default_llm_provider() -> String {
    "deepseek".to_string()
}

fn profile_to_json(value: &serde_norway::Value) -> Option<serde_json::Value> {
    serde_json::to_value(value).ok()
}

impl DoubaoStreamingConfig {
    pub fn to_connection_config(&self) -> ConnectionConfig {
        ConnectionConfig {
            url: self.url.clone(),
            app_id: self.app_id.clone(),
            access_token: self.access_token.clone(),
            secret_key: self.secret_key.clone(),
            resource_id: self.resource_id.clone(),
        }
    }

    pub fn to_audio_config(&self) -> AudioConfig {
        AudioConfig {
            format: self.format.clone(),
            rate: self.rate,
            bits: self.bits,
            channel: self.channel,
        }
    }

    pub fn to_request_config(&self) -> RequestConfig {
        RequestConfig {
            model_name: self.model_name.clone(),
            model_version: self.model_version.clone(),
            operation: self.operation.clone(),
            sequence: self.sequence,
            language: if self.language.trim().is_empty() {
                None
            } else {
                Some(self.language.clone())
            },
            enable_itn: self.enable_itn,
            enable_punc: self.enable_punc,
            enable_ddc: self.enable_ddc,
            show_utterances: self.show_utterances,
            result_type: self.result_type.clone(),
            end_window_size: self.end_window_size,
            force_to_speech_time: self.force_to_speech_time,
            accelerate_score: self.accelerate_score,
            vad_segment_duration: self.vad_segment_duration,
            enable_nonstream: Some(self.enable_nonstream),
            enable_accelerate_text: self.enable_accelerate_text,
            corpus: self.corpus.clone(),
        }
    }
}

impl AppConfig {
    pub fn audio_provider(&self) -> &str {
        self.audio
            .get("provider")
            .and_then(|v| v.as_str())
            .unwrap_or(DOUBAO_STREAMING_ID)
    }

    pub fn doubao_streaming_config(&self) -> DoubaoStreamingConfig {
        self.audio
            .get(DOUBAO_STREAMING_ID)
            .cloned()
            .and_then(|value| serde_norway::from_value(value).ok())
            .unwrap_or_default()
    }

    pub fn vad_params(&self) -> VadParams {
        self.audio
            .get(SILERO_VAD_ID)
            .cloned()
            .and_then(|value| serde_norway::from_value(value).ok())
            .unwrap_or_default()
    }

    pub fn model_config_json(&self, model_id: &str) -> Option<serde_json::Value> {
        self.audio.get(model_id).and_then(profile_to_json)
    }

    /// Whether to enable simulated streaming for non-streaming models.
    /// When enabled, offline ASR models use VAD + interim decoding to produce
    /// partial results during recording, mimicking streaming behavior.
    pub fn stream_simulate(&self) -> bool {
        self.audio
            .get("stream_simulate")
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    }
}

impl Default for DoubaoStreamingConfig {
    fn default() -> Self {
        Self {
            url: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async".to_string(),
            app_id: String::new(),
            access_token: String::new(),
            secret_key: String::new(),
            resource_id: "volc.seedasr.sauc.duration".to_string(),
            format: default_format(),
            rate: default_rate(),
            bits: default_bits(),
            channel: default_channel(),
            model_name: default_model_name(),
            model_version: "400".to_string(),
            operation: default_operation(),
            sequence: 0,
            language: String::new(),
            enable_ddc: true,
            enable_itn: true,
            enable_nonstream: false,
            enable_punc: true,
            show_utterances: true,
            result_type: default_result_type(),
            end_window_size: None,
            force_to_speech_time: None,
            accelerate_score: Some(10),
            vad_segment_duration: None,
            enable_accelerate_text: Some(true),
            corpus: Some(serde_norway::Value::Mapping(serde_norway::Mapping::new())),
        }
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            app: AppSettings {
                hotkey: default_hotkey(),
                hotkey_mode: default_hotkey_mode(),
                remove_trailing_period: true,
                keep_clipboard: true,
                theme: default_theme(),
                overlay_style: default_overlay_style(),
                sound: None,
                beta_updates: false,
            },
            audio: default_audio_settings(),
            llm: LlmConfig {
                provider: default_llm_provider(),
                deepseek: None,
                openai: None,
                anthropic: None,
                gemini: None,
                openrouter: None,
                siliconflow: None,
                ollama: None,
                openai_compatible: None,
                url: None,
                api_key: None,
                model: None,
                base_url: None,
            },
        }
    }
}

// -- Prompt helpers --

fn normalize_prompt_item(item: &serde_norway::Value, index: usize) -> PromptItem {
    let fallback_id = format!("prompt-{}", index + 1);
    let hotkey_value = item
        .get("hotkey")
        .cloned()
        .unwrap_or(serde_norway::Value::Sequence(vec![]));

    PromptItem {
        id: item
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or(fallback_id),
        title: item
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        hotkey: hotkey_value,
        hotkey_mode: if item
            .get("hotkey_mode")
            .and_then(|v| v.as_str())
            .map(|s| s == "hold")
            .unwrap_or(false)
        {
            "hold".to_string()
        } else {
            "toggle".to_string()
        },
        prompt: item
            .get("prompt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    }
}

/// Load default prompts from the example file.
fn load_default_prompts(example_path: &Option<PathBuf>) -> Vec<PromptItem> {
    let path = match example_path {
        Some(p) if p.exists() => p,
        _ => return vec![],
    };

    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    let parsed: Vec<serde_norway::Value> = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return vec![],
    };

    parsed
        .iter()
        .enumerate()
        .map(|(i, v)| normalize_prompt_item(v, i))
        .collect()
}

/// ConfigManager handles loading, saving, and managing the application configuration.
/// Configuration is cached in memory for fast access and synchronized with disk on write.
pub struct ConfigManager {
    config_path: PathBuf,
    prompts_path: PathBuf,
    cached_config: RwLock<AppConfig>,
    cached_prompts: RwLock<Vec<PromptItem>>,
}

impl ConfigManager {
    pub fn new(data_dir: &Path, resource_dir: &Path) -> Self {
        let config_path = data_dir.join("config.yaml");
        let prompts_path = data_dir.join("prompts.json");

        let config_example_path = if resource_dir.join("config.yaml.example").exists() {
            Some(resource_dir.join("config.yaml.example"))
        } else {
            None
        };

        let prompts_example_path = if resource_dir.join("prompts.json").exists() {
            Some(resource_dir.join("prompts.json"))
        } else {
            None
        };

        // Ensure config file exists
        if !config_path.exists() {
            if let Some(ref example) = config_example_path {
                let _ = fs::copy(example, &config_path);
            }
        }

        // Ensure prompts file exists
        if !prompts_path.exists() {
            if let Some(ref example) = prompts_example_path {
                let _ = fs::copy(example, &prompts_path);
            } else {
                let _ = fs::write(&prompts_path, "[]");
            }
        }

        // Load config into memory cache
        let config = Self::read_config_from_disk(&config_path);

        // Load prompts into memory cache (with default merge logic)
        let prompts = Self::read_and_merge_prompts(&prompts_path, &prompts_example_path);

        Self {
            config_path,
            prompts_path,
            cached_config: RwLock::new(config),
            cached_prompts: RwLock::new(prompts),
        }
    }

    /// Read config from disk and parse into AppConfig.
    fn read_config_from_disk(config_path: &Path) -> AppConfig {
        let content = match fs::read_to_string(config_path) {
            Ok(c) => c,
            Err(_) => return AppConfig::default(),
        };
        serde_norway::from_str(&content).unwrap_or_default()
    }

    /// Read prompts from disk, merge with defaults, and optionally save merged result.
    fn read_and_merge_prompts(
        prompts_path: &Path,
        example_path: &Option<PathBuf>,
    ) -> Vec<PromptItem> {
        let content = match fs::read_to_string(prompts_path) {
            Ok(c) => c,
            Err(_) => return load_default_prompts(example_path),
        };

        let parsed: Vec<serde_norway::Value> = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => return load_default_prompts(example_path),
        };

        let mut prompts: Vec<PromptItem> = parsed
            .iter()
            .enumerate()
            .map(|(i, v)| normalize_prompt_item(v, i))
            .collect();

        // Merge missing defaults
        let defaults = load_default_prompts(example_path);
        let existing_ids: std::collections::HashSet<String> =
            prompts.iter().map(|p| p.id.clone()).collect();
        let missing: Vec<PromptItem> = defaults
            .into_iter()
            .filter(|p| !existing_ids.contains(&p.id))
            .collect();

        if !missing.is_empty() {
            prompts.extend(missing);
            if let Ok(json) = serde_json::to_string_pretty(&prompts) {
                let _ = fs::write(prompts_path, json);
            }
        }

        prompts
    }

    /// Load config from memory cache (no disk I/O).
    pub fn load_config(&self) -> Result<AppConfig, String> {
        Ok(self.cached_config.read().unwrap().clone())
    }

    /// Save config as a parsed YAML value, update memory cache and disk.
    pub fn save_config(&self, config: &serde_norway::Value) -> Result<(), String> {
        let yaml = serde_norway::to_string(config)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;
        fs::write(&self.config_path, yaml).map_err(|e| format!("Failed to write config: {}", e))?;
        // Re-read from disk to populate cache, avoiding JSON→YAML value round-trip
        // deserialization issues that can cause silent fallback to defaults.
        *self.cached_config.write().unwrap() = Self::read_config_from_disk(&self.config_path);
        Ok(())
    }

    /// Get config as editable YAML value (reads from disk for settings UI).
    pub fn get_editable_config(&self) -> Result<serde_norway::Value, String> {
        let content = fs::read_to_string(&self.config_path)
            .map_err(|e| format!("Failed to read config: {}", e))?;
        serde_norway::from_str(&content).map_err(|e| format!("Failed to parse config: {}", e))
    }

    pub fn config_path(&self) -> &PathBuf {
        &self.config_path
    }

    // -- Prompts --

    /// Load prompts from memory cache (no disk I/O).
    pub fn load_prompts(&self) -> Vec<PromptItem> {
        self.cached_prompts.read().unwrap().clone()
    }

    /// Save prompts, update memory cache and disk.
    pub fn save_prompts(&self, prompts: &[PromptItem]) -> Result<(), String> {
        let json = serde_json::to_string_pretty(prompts)
            .map_err(|e| format!("Failed to serialize prompts: {}", e))?;
        fs::write(&self.prompts_path, json)
            .map_err(|e| format!("Failed to write prompts: {}", e))?;
        *self.cached_prompts.write().unwrap() = prompts.to_vec();
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ── DoubaoStreamingConfig defaults ───────────────────────────────────

    #[test]
    fn doubao_streaming_default_values() {
        let cfg = DoubaoStreamingConfig::default();
        assert!(cfg.url.contains("openspeech.bytedance.com"));
        assert_eq!(cfg.format, "pcm");
        assert_eq!(cfg.rate, 16000);
        assert_eq!(cfg.bits, 16);
        assert_eq!(cfg.channel, 1);
        assert_eq!(cfg.model_name, "bigmodel");
        assert_eq!(cfg.operation, "submit");
        assert!(cfg.enable_itn);
        assert!(cfg.enable_punc);
    }

    // ── DoubaoStreamingConfig conversions ────────────────────────────────

    #[test]
    fn to_connection_config_maps_fields() {
        let cfg = DoubaoStreamingConfig::default();
        let conn = cfg.to_connection_config();
        assert_eq!(conn.url, cfg.url);
        assert_eq!(conn.app_id, cfg.app_id);
        assert_eq!(conn.access_token, cfg.access_token);
        assert_eq!(conn.secret_key, cfg.secret_key);
        assert_eq!(conn.resource_id, cfg.resource_id);
    }

    #[test]
    fn to_audio_config_maps_fields() {
        let cfg = DoubaoStreamingConfig::default();
        let audio = cfg.to_audio_config();
        assert_eq!(audio.format, cfg.format);
        assert_eq!(audio.rate, cfg.rate);
        assert_eq!(audio.bits, cfg.bits);
        assert_eq!(audio.channel, cfg.channel);
    }

    #[test]
    fn to_request_config_empty_language_becomes_none() {
        let mut cfg = DoubaoStreamingConfig::default();
        cfg.language = "".to_string();
        let req = cfg.to_request_config();
        assert_eq!(req.language, None);
    }

    #[test]
    fn to_request_config_language_preserved() {
        let mut cfg = DoubaoStreamingConfig::default();
        cfg.language = "zh".to_string();
        let req = cfg.to_request_config();
        assert_eq!(req.language, Some("zh".to_string()));
    }

    #[test]
    fn to_request_config_language_whitespace_becomes_none() {
        let mut cfg = DoubaoStreamingConfig::default();
        cfg.language = "   ".to_string();
        let req = cfg.to_request_config();
        assert_eq!(req.language, None);
    }

    // ── AppConfig defaults ───────────────────────────────────────────────

    #[test]
    fn app_config_default_hotkey_is_f13() {
        let cfg = AppConfig::default();
        match &cfg.app.hotkey {
            serde_norway::Value::String(s) => assert_eq!(s, "F13"),
            _ => panic!("hotkey should be a string"),
        }
    }

    #[test]
    fn app_config_default_mode_is_toggle() {
        let cfg = AppConfig::default();
        assert_eq!(cfg.app.hotkey_mode, "toggle");
    }

    #[test]
    fn app_config_default_remove_trailing_period() {
        let cfg = AppConfig::default();
        assert!(cfg.app.remove_trailing_period);
    }

    // ── audio_provider ───────────────────────────────────────────────────

    #[test]
    fn audio_provider_defaults_to_doubao() {
        let cfg = AppConfig::default();
        assert_eq!(cfg.audio_provider(), "doubao-streaming");
    }

    #[test]
    fn audio_provider_reads_custom() {
        let mut cfg = AppConfig::default();
        cfg.audio.insert(
            "provider".to_string(),
            serde_norway::Value::String("sherpa-onnx-funasr-nano".to_string()),
        );
        assert_eq!(cfg.audio_provider(), "sherpa-onnx-funasr-nano");
    }

    // ── VadParams ────────────────────────────────────────────────────────

    #[test]
    fn vad_params_default_all_none() {
        let v: VadParams = serde_norway::from_str("{}").unwrap();
        assert!(v.threshold.is_none());
        assert!(v.min_silence_duration.is_none());
        assert!(v.min_speech_duration.is_none());
        assert!(v.max_speech_duration.is_none());
        assert!(v.num_threads.is_none());
    }

    #[test]
    fn vad_params_partial_deserialize() {
        let yaml = r#"
threshold: 0.5
min_silence_duration: 0.3
"#;
        let v: VadParams = serde_norway::from_str(yaml).unwrap();
        assert_eq!(v.threshold, Some(0.5));
        assert_eq!(v.min_silence_duration, Some(0.3));
        assert!(v.min_speech_duration.is_none());
    }

    // ── normalize_prompt_item ────────────────────────────────────────────

    /// Convert a serde_json::Value to serde_norway::Value for test helpers.
    fn to_norway(json: serde_json::Value) -> serde_norway::Value {
        let s = serde_json::to_string(&json).unwrap();
        serde_norway::from_str(&s).unwrap()
    }

    #[test]
    fn normalize_prompt_item_full_fields() {
        let json = serde_json::json!({
            "id": "summarize",
            "title": "Summarize",
            "prompt": "Summarize the following",
            "hotkey": ["Control+Shift+S"],
            "hotkey_mode": "hold"
        });
        let v = to_norway(json);
        let item = normalize_prompt_item(&v, 0);
        assert_eq!(item.id, "summarize");
        assert_eq!(item.title, "Summarize");
        assert_eq!(item.prompt, "Summarize the following");
        assert_eq!(item.hotkey_mode, "hold");
    }

    #[test]
    fn normalize_prompt_item_missing_id_generates_fallback() {
        let json = serde_json::json!({
            "title": "No ID",
            "prompt": "test"
        });
        let v = to_norway(json);
        let item = normalize_prompt_item(&v, 2);
        assert_eq!(item.id, "prompt-3"); // index 2 → prompt-3
    }

    #[test]
    fn normalize_prompt_item_empty_id_uses_fallback() {
        let json = serde_json::json!({
            "id": "",
            "title": "Empty ID",
            "prompt": "test"
        });
        let v = to_norway(json);
        let item = normalize_prompt_item(&v, 0);
        assert_eq!(item.id, "prompt-1");
    }

    #[test]
    fn normalize_prompt_item_default_mode_is_toggle() {
        let json = serde_json::json!({
            "id": "p1",
            "prompt": "test"
        });
        let v = to_norway(json);
        let item = normalize_prompt_item(&v, 0);
        assert_eq!(item.hotkey_mode, "toggle");
    }

    #[test]
    fn normalize_prompt_item_mode_hold() {
        let json = serde_json::json!({
            "id": "p1",
            "prompt": "test",
            "hotkey_mode": "hold"
        });
        let v = to_norway(json);
        let item = normalize_prompt_item(&v, 0);
        assert_eq!(item.hotkey_mode, "hold");
    }
}

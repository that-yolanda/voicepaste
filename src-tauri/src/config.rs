use serde::{Deserialize, Serialize};
use serde_norway;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub app: AppSettings,
    #[serde(default)]
    pub asr: AsrConfig,
    #[serde(default)]
    pub asr_online: AsrOnlineConfig,
    #[serde(default)]
    pub asr_offline: AsrOfflineConfig,
    pub connection: ConnectionConfig,
    pub audio: AudioConfig,
    pub request: RequestConfig,
    #[serde(default)]
    pub llm: LlmConfig,
}

// -- New ASR config sections --

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsrConfig {
    #[serde(default = "default_asr_engine")]
    pub engine: String,
    #[serde(default)]
    pub active_model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsrOnlineConfig {
    #[serde(default)]
    pub doubao: DoubaoOnlineConfig,
}

/// User-overridable VAD parameters stored in config.yaml.
/// All fields are `Option` so omitted values fall back to registry defaults.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VadParams {
    pub threshold: Option<f32>,
    pub min_silence_duration: Option<f32>,
    pub min_speech_duration: Option<f32>,
    pub max_speech_duration: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AsrOfflineConfig {
    #[serde(default)]
    pub vad: VadParams,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoubaoOnlineConfig {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub resource_id: String,
    #[serde(default)]
    pub app_id: String,
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub secret_key: String,
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
    pub boosting_table_id: String,
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
fn default_asr_engine() -> String {
    "doubao-streaming".to_string()
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

impl Default for AsrConfig {
    fn default() -> Self {
        Self {
            engine: default_asr_engine(),
            active_model: String::new(),
        }
    }
}

impl Default for DoubaoOnlineConfig {
    fn default() -> Self {
        Self {
            url: String::new(),
            resource_id: String::new(),
            app_id: String::new(),
            access_token: String::new(),
            secret_key: String::new(),
            language: String::new(),
            enable_ddc: true,
            enable_itn: true,
            enable_nonstream: false,
            enable_punc: true,
            boosting_table_id: String::new(),
        }
    }
}

impl Default for AsrOnlineConfig {
    fn default() -> Self {
        Self {
            doubao: DoubaoOnlineConfig::default(),
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
            asr: AsrConfig::default(),
            asr_online: AsrOnlineConfig::default(),
            asr_offline: AsrOfflineConfig::default(),
            connection: ConnectionConfig {
                url: String::new(),
                app_id: String::new(),
                access_token: String::new(),
                secret_key: String::new(),
                resource_id: String::new(),
            },
            audio: AudioConfig {
                format: default_format(),
                rate: default_rate(),
                bits: default_bits(),
                channel: default_channel(),
            },
            request: RequestConfig {
                model_name: default_model_name(),
                model_version: "400".to_string(),
                operation: default_operation(),
                sequence: 0,
                enable_itn: true,
                enable_punc: true,
                enable_ddc: true,
                show_utterances: true,
                result_type: default_result_type(),
                end_window_size: None,
                force_to_speech_time: None,
                accelerate_score: None,
                vad_segment_duration: None,
                enable_nonstream: None,
                enable_accelerate_text: None,
                corpus: None,
            },
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
    config_example_path: Option<PathBuf>,
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

        let prompts_example_path = if resource_dir.join("prompts.json.example").exists() {
            Some(resource_dir.join("prompts.json.example"))
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
            config_example_path,
            cached_config: RwLock::new(config),
            cached_prompts: RwLock::new(prompts),
        }
    }

    /// Read config from disk and parse into AppConfig.
    /// Performs bidirectional migration between old and new config structures.
    fn read_config_from_disk(config_path: &Path) -> AppConfig {
        let content = match fs::read_to_string(config_path) {
            Ok(c) => c,
            Err(_) => return AppConfig::default(),
        };
        let raw: serde_norway::Value = match serde_norway::from_str(&content) {
            Ok(v) => v,
            Err(_) => return AppConfig::default(),
        };
        let mut config: AppConfig = serde_norway::from_value(raw).unwrap_or_default();

        // Migrate old engine values to new model-ID format:
        //   "doubao"      → "doubao-streaming"
        //   "sherpa-onnx" → active_model (or sensible default)
        if config.asr.engine == "doubao" {
            config.asr.engine = "doubao-streaming".to_string();
        } else if config.asr.engine == "sherpa-onnx" {
            config.asr.engine = if config.asr.active_model.is_empty() {
                "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8".to_string()
            } else {
                std::mem::take(&mut config.asr.active_model)
            };
        }

        // Bidirectional migration: ensure both old and new fields are populated
        if config.connection.url.is_empty() && !config.asr_online.doubao.url.is_empty() {
            // New config → populate old fields for backward compat
            config.connection = ConnectionConfig {
                url: config.asr_online.doubao.url.clone(),
                resource_id: config.asr_online.doubao.resource_id.clone(),
                app_id: config.asr_online.doubao.app_id.clone(),
                access_token: config.asr_online.doubao.access_token.clone(),
                secret_key: config.asr_online.doubao.secret_key.clone(),
            };
            config.request.enable_ddc = config.asr_online.doubao.enable_ddc;
            config.request.enable_itn = config.asr_online.doubao.enable_itn;
            config.request.enable_nonstream = Some(config.asr_online.doubao.enable_nonstream);
            config.request.enable_punc = config.asr_online.doubao.enable_punc;
            if !config.asr_online.doubao.boosting_table_id.is_empty() {
                let mut corpus = serde_norway::Mapping::new();
                corpus.insert(
                    serde_norway::Value::String("boosting_table_id".to_string()),
                    serde_norway::Value::String(
                        config.asr_online.doubao.boosting_table_id.clone(),
                    ),
                );
                config.request.corpus = Some(serde_norway::Value::Mapping(corpus));
            }
        } else if !config.connection.url.is_empty()
            && config.asr_online.doubao.url.is_empty()
        {
            // Old config → populate new fields
            config.asr = AsrConfig::default();
            config.asr_online = AsrOnlineConfig {
                doubao: DoubaoOnlineConfig {
                    url: config.connection.url.clone(),
                    resource_id: config.connection.resource_id.clone(),
                    app_id: config.connection.app_id.clone(),
                    access_token: config.connection.access_token.clone(),
                    secret_key: config.connection.secret_key.clone(),
                    language: String::new(),
                    enable_ddc: config.request.enable_ddc,
                    enable_itn: config.request.enable_itn,
                    enable_nonstream: config.request.enable_nonstream.unwrap_or(false),
                    enable_punc: config.request.enable_punc,
                    boosting_table_id: config
                        .request
                        .corpus
                        .as_ref()
                        .and_then(|c| c.get("boosting_table_id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                },
            };
            config.asr_offline = AsrOfflineConfig::default();
        }

        config
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

    /// Read raw YAML text from disk (used by settings UI).
    pub fn read_config_text(&self) -> Result<String, String> {
        fs::read_to_string(&self.config_path).map_err(|e| format!("Failed to read config: {}", e))
    }

    /// Save config as raw YAML text, update memory cache and disk.
    pub fn save_config_text(&self, text: &str) -> Result<(), String> {
        let raw: serde_norway::Value =
            serde_norway::from_str(text).map_err(|e| format!("Invalid YAML: {}", e))?;
        let config: AppConfig = serde_norway::from_value(raw).unwrap_or_default();
        fs::write(&self.config_path, text).map_err(|e| format!("Failed to write config: {}", e))?;
        *self.cached_config.write().unwrap() = config;
        Ok(())
    }

    /// Save config as a parsed YAML value, update memory cache and disk.
    pub fn save_config(&self, config: &serde_norway::Value) -> Result<(), String> {
        let yaml = serde_norway::to_string(config)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;
        let parsed: AppConfig =
            serde_norway::from_value(config.clone()).unwrap_or_default();
        fs::write(&self.config_path, yaml).map_err(|e| format!("Failed to write config: {}", e))?;
        *self.cached_config.write().unwrap() = parsed;
        Ok(())
    }

    /// Get config as editable YAML value (reads from disk for settings UI).
    pub fn get_editable_config(&self) -> Result<serde_norway::Value, String> {
        let content = fs::read_to_string(&self.config_path)
            .map_err(|e| format!("Failed to read config: {}", e))?;
        serde_norway::from_str(&content).map_err(|e| format!("Failed to parse config: {}", e))
    }

    /// Reset config to default, update memory cache and disk.
    pub fn reset_to_default(&self) -> Result<(), String> {
        let example_path = self
            .config_example_path
            .as_ref()
            .ok_or("config.yaml.example not found")?;
        let content = fs::read_to_string(example_path)
            .map_err(|e| format!("Failed to read example config: {}", e))?;
        fs::write(&self.config_path, &content).map_err(|e| format!("Failed to write config: {}", e))?;
        let config: AppConfig = serde_norway::from_str(&content).unwrap_or_default();
        *self.cached_config.write().unwrap() = config;
        Ok(())
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
        fs::write(&self.prompts_path, json).map_err(|e| format!("Failed to write prompts: {}", e))?;
        *self.cached_prompts.write().unwrap() = prompts.to_vec();
        Ok(())
    }
}

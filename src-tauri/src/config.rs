use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use crate::model::ModelRegistry;

pub const DOUBAO_STREAMING_ID: &str = "doubao-streaming";
pub const SILERO_VAD_ID: &str = "silero-vad";
pub const ASR_DEFAULTS_ID: &str = "asr_defaults";

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
    pub provider: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsrDefaults {
    #[serde(default = "default_rate")]
    pub rate: u32,
    #[serde(default = "default_channel")]
    pub channel: u32,
    #[serde(default = "default_true")]
    pub stream_simulate: bool,
    #[serde(default = "default_hotword_llm_mode")]
    pub hotword_llm_mode: String,
    #[serde(default = "default_true")]
    pub hotword_replace: bool,
    #[serde(default = "default_num_threads")]
    pub num_threads: u32,
    #[serde(default = "default_asr_provider")]
    pub provider: String,
    #[serde(default = "default_punctuation_mode")]
    pub punctuation_mode: String,
    #[serde(default)]
    pub vad: AsrVadDefaults,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsrVadDefaults {
    #[serde(default = "default_vad_threshold")]
    pub threshold: f32,
    #[serde(default = "default_vad_min_silence")]
    pub min_silence_duration: f32,
    #[serde(default = "default_vad_min_speech")]
    pub min_speech_duration: f32,
    #[serde(default = "default_vad_max_speech")]
    pub max_speech_duration: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoubaoStreamingConfig {
    #[serde(default = "default_doubao_url")]
    pub url: String,
    /// Doubao console auth mode: "legacy" = App ID + Access Token,
    /// "v2" = single API Key (new Volcengine console). Defaults to legacy.
    #[serde(default = "default_auth_mode")]
    pub auth_mode: String,
    #[serde(default)]
    pub app_id: String,
    #[serde(default)]
    pub access_token: String,
    #[serde(default = "default_doubao_resource_id")]
    pub resource_id: String,
    /// New-console API Key (sent as X-Api-Key). Used only when auth_mode == "v2".
    #[serde(default)]
    pub api_key: String,
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
    #[serde(default = "default_doubao_model_version")]
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
    #[serde(default = "default_true")]
    pub show_utterances: bool,
    #[serde(default = "default_result_type")]
    pub result_type: String,
    #[serde(default)]
    pub end_window_size: Option<u32>,
    #[serde(default)]
    pub force_to_speech_time: Option<u32>,
    #[serde(default = "default_accelerate_score")]
    pub accelerate_score: Option<u32>,
    #[serde(default)]
    pub vad_segment_duration: Option<u32>,
    #[serde(default = "default_true_opt")]
    pub enable_accelerate_text: Option<bool>,
    #[serde(default = "default_ssd_version")]
    pub ssd_version: String,
    #[serde(default = "default_zh_variant")]
    pub output_zh_variant: String,
    #[serde(default = "default_empty_corpus")]
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
    #[serde(default)]
    pub keep_recordings: bool,
    #[serde(default)]
    pub prompt_hotkeys_stop_only: bool,
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
    pub auth_mode: String,
    #[serde(default)]
    pub app_id: String,
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub resource_id: String,
    #[serde(default)]
    pub api_key: String,
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
    pub ssd_version: Option<String>,
    #[serde(default)]
    pub output_zh_variant: Option<String>,
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

/// `true` only for built-in templates auto-seeded into a new user's library on
/// first run. Used by `skip_serializing_if` so the field stays out of user data
/// (where it is always false) — only the bundled `prompts.json` carries `true`.
fn is_false(b: &bool) -> bool {
    !b
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptItem {
    pub id: String,
    #[serde(default)]
    pub title: String,
    /// Hotkey as a `+`-joined accelerator string, e.g. `"ControlLeft+ShiftLeft"`
    /// or `"F13"`. Mirrors the main hotkey (`config.app.hotkey`) so both share
    /// `parse_hotkey_string`. Legacy array/numeric forms are normalized to this
    /// string form on read (see `hotkey_value_to_string`).
    #[serde(default)]
    pub hotkey: String,
    #[serde(default = "default_hotkey_mode")]
    pub hotkey_mode: String,
    #[serde(default)]
    pub prompt: String,
    /// Built-in classifier: true → auto-seed for new users. Stripped from user
    /// data via `skip_serializing_if`; defaults to false for user-created and
    /// legacy templates.
    #[serde(default)]
    #[serde(skip_serializing_if = "is_false")]
    pub default_add: bool,
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
fn default_num_threads() -> u32 {
    2
}
fn default_asr_provider() -> String {
    "cpu".to_string()
}
fn default_hotword_llm_mode() -> String {
    "auto".to_string()
}
fn default_punctuation_mode() -> String {
    "auto".to_string()
}
fn default_vad_threshold() -> f32 {
    0.2
}
fn default_vad_min_silence() -> f32 {
    0.2
}
fn default_vad_min_speech() -> f32 {
    0.2
}
fn default_vad_max_speech() -> f32 {
    10.0
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
fn default_doubao_url() -> String {
    "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async".to_string()
}
fn default_doubao_resource_id() -> String {
    "volc.seedasr.sauc.duration".to_string()
}
fn default_auth_mode() -> String {
    "legacy".to_string()
}
fn default_doubao_model_version() -> String {
    "400".to_string()
}
fn default_accelerate_score() -> Option<u32> {
    Some(10)
}
fn default_true_opt() -> Option<bool> {
    Some(true)
}
fn default_ssd_version() -> String {
    "200".to_string()
}
fn default_zh_variant() -> String {
    "off".to_string()
}
fn default_empty_corpus() -> Option<serde_norway::Value> {
    Some(serde_norway::Value::Mapping(serde_norway::Mapping::new()))
}

fn profile_to_json(value: &serde_norway::Value) -> Option<serde_json::Value> {
    serde_json::to_value(value).ok()
}

fn profile_has_key(value: Option<&serde_norway::Value>, key: &str) -> bool {
    value.and_then(|v| v.get(key)).is_some()
}

fn normalize_choice(value: &str, allowed: &[&str], fallback: &str) -> String {
    let normalized = value.trim().to_ascii_lowercase();
    if allowed.iter().any(|choice| *choice == normalized) {
        normalized
    } else {
        fallback.to_string()
    }
}

impl Default for AsrVadDefaults {
    fn default() -> Self {
        Self {
            threshold: default_vad_threshold(),
            min_silence_duration: default_vad_min_silence(),
            min_speech_duration: default_vad_min_speech(),
            max_speech_duration: default_vad_max_speech(),
        }
    }
}

impl Default for AsrDefaults {
    fn default() -> Self {
        Self {
            rate: default_rate(),
            channel: default_channel(),
            stream_simulate: true,
            hotword_llm_mode: default_hotword_llm_mode(),
            hotword_replace: true,
            num_threads: default_num_threads(),
            provider: default_asr_provider(),
            punctuation_mode: default_punctuation_mode(),
            vad: AsrVadDefaults::default(),
        }
    }
}

impl AsrDefaults {
    pub fn provider(&self) -> String {
        normalize_choice(&self.provider, &["cpu", "cuda", "coreml"], "cpu")
    }

    pub fn hotword_llm_mode(&self) -> String {
        normalize_choice(
            &self.hotword_llm_mode,
            &["auto", "disabled", "force"],
            "auto",
        )
    }

    pub fn punctuation_mode(&self) -> String {
        normalize_choice(
            &self.punctuation_mode,
            &["auto", "disabled", "force"],
            "auto",
        )
    }
}

impl DoubaoStreamingConfig {
    pub fn to_connection_config(&self) -> ConnectionConfig {
        ConnectionConfig {
            url: self.url.clone(),
            auth_mode: self.auth_mode.clone(),
            app_id: self.app_id.clone(),
            access_token: self.access_token.clone(),
            resource_id: self.resource_id.clone(),
            api_key: self.api_key.clone(),
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
            ssd_version: {
                let v = self.ssd_version.trim();
                if v.is_empty() {
                    None
                } else {
                    Some(self.ssd_version.clone())
                }
            },
            output_zh_variant: {
                let v = self.output_zh_variant.trim();
                if v.is_empty() {
                    None
                } else {
                    Some(self.output_zh_variant.clone())
                }
            },
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

    /// Resolve effective config for any engine by merging three layers:
    ///   1. registry.json → defaults.asr  (shared defaults)
    ///   2. registry.json → <model>.default_config  (model-specific defaults)
    ///   3. config.yaml → audio.<model_id>  (user overrides)
    ///
    /// This is the single config resolution path for ALL engine types
    /// (doubao, sherpa-onnx, VAD, punctuation).
    pub fn resolve_model_config(
        registry: &ModelRegistry,
        model_id: &str,
        user_audio: &BTreeMap<String, serde_norway::Value>,
    ) -> serde_json::Value {
        // Layer 1: shared defaults from registry
        let mut merged = registry
            .defaults
            .as_ref()
            .map(|d| d.asr.clone())
            .unwrap_or_else(|| serde_json::json!({}));

        // Layer 2: model-specific defaults from registry
        if let Some(entry) = registry.models.iter().find(|m| m.id == model_id) {
            if let Some(ref dc) = entry.default_config {
                if let Some(obj) = dc.as_object() {
                    if let Some(target) = merged.as_object_mut() {
                        for (k, v) in obj {
                            target.insert(k.clone(), v.clone());
                        }
                    }
                }
            }
        }

        // Layer 3: user overrides from config.yaml audio.<model_id>
        if let Some(user_config) = user_audio
            .get(model_id)
            .and_then(profile_to_json)
            .and_then(|v| v.as_object().cloned())
        {
            if let Some(target) = merged.as_object_mut() {
                for (k, v) in user_config {
                    target.insert(k, v);
                }
            }
        }

        merged
    }

    pub fn doubao_streaming_config(&self, registry: &ModelRegistry) -> DoubaoStreamingConfig {
        let merged = Self::resolve_model_config(registry, DOUBAO_STREAMING_ID, &self.audio);
        serde_json::from_value(merged).unwrap_or_default()
    }

    pub fn asr_defaults(&self, registry: &ModelRegistry) -> AsrDefaults {
        // Start from registry shared defaults
        let mut defaults: AsrDefaults = registry
            .defaults
            .as_ref()
            .and_then(|d| serde_json::from_value(d.asr.clone()).ok())
            .unwrap_or_default();

        // Overlay user config from audio.asr_defaults (only fields the user changed)
        if let Some(raw) = self.audio.get(ASR_DEFAULTS_ID) {
            if let Ok(user) = serde_norway::from_value::<AsrDefaults>(raw.clone()) {
                // Only override if the user explicitly set the field
                if let Some(v) = self.audio.get("stream_simulate").and_then(|v| v.as_bool()) {
                    defaults.stream_simulate = v;
                }
                // Merge user's asr_defaults over registry
                if profile_has_key(Some(raw), "rate") {
                    defaults.rate = user.rate;
                }
                if profile_has_key(Some(raw), "channel") {
                    defaults.channel = user.channel;
                }
                if profile_has_key(Some(raw), "stream_simulate") {
                    defaults.stream_simulate = user.stream_simulate;
                }
                if profile_has_key(Some(raw), "hotword_llm_mode") {
                    defaults.hotword_llm_mode = user.hotword_llm_mode;
                }
                if profile_has_key(Some(raw), "hotword_replace") {
                    defaults.hotword_replace = user.hotword_replace;
                }
                if profile_has_key(Some(raw), "num_threads") {
                    defaults.num_threads = user.num_threads;
                }
                if profile_has_key(Some(raw), "provider") {
                    defaults.provider = user.provider;
                }
                if profile_has_key(Some(raw), "punctuation_mode") {
                    defaults.punctuation_mode = user.punctuation_mode;
                }
                if profile_has_key(Some(raw), "vad") {
                    defaults.vad = user.vad;
                }
            }
        } else {
            // Legacy compat: audio.stream_simulate at top level
            if !profile_has_key(self.audio.get(ASR_DEFAULTS_ID), "stream_simulate") {
                if let Some(value) = self.audio.get("stream_simulate").and_then(|v| v.as_bool()) {
                    defaults.stream_simulate = value;
                }
            }
        }

        defaults.provider = defaults.provider();
        defaults.hotword_llm_mode = defaults.hotword_llm_mode();
        defaults.punctuation_mode = defaults.punctuation_mode();
        defaults
    }

    pub fn asr_defaults_json(&self, registry: &ModelRegistry) -> serde_json::Value {
        serde_json::to_value(self.asr_defaults(registry)).unwrap_or_else(|_| serde_json::json!({}))
    }

    pub fn vad_params(&self, registry: &ModelRegistry) -> VadParams {
        // Layer 1: registry shared VAD defaults
        let registry_vad: Option<VadParams> = registry
            .defaults
            .as_ref()
            .and_then(|d| serde_json::from_value(d.vad.clone()).ok());

        // Layer 2: registry silero-vad model defaults
        let silero_defaults: Option<VadParams> = registry
            .models
            .iter()
            .find(|m| m.id == SILERO_VAD_ID)
            .and_then(|m| m.default_config.as_ref())
            .and_then(|dc| serde_json::from_value(dc.clone()).ok());

        // Merge layers 1+2
        let mut params = merge_vad_params(registry_vad, silero_defaults).unwrap_or_default();

        // Merge shared asr_defaults num_threads/provider from registry
        if let Some(ref d) = registry.defaults {
            if let Ok(shared) = serde_json::from_value::<serde_json::Value>(d.asr.clone()) {
                if params.num_threads.is_none() {
                    params.num_threads = shared
                        .get("num_threads")
                        .and_then(|v| v.as_u64())
                        .map(|v| v as u32);
                }
                if params.provider.is_none() {
                    params.provider = shared
                        .get("provider")
                        .and_then(|v| v.as_str())
                        .map(|s| normalize_choice(s, &["cpu", "cuda", "coreml"], "cpu"));
                }
            }
        }

        // Layer 3: user overrides from audio.asr_defaults.vad
        let defaults = self.asr_defaults(registry);
        params.threshold = Some(defaults.vad.threshold);
        params.min_silence_duration = Some(defaults.vad.min_silence_duration);
        params.min_speech_duration = Some(defaults.vad.min_speech_duration);
        params.max_speech_duration = Some(defaults.vad.max_speech_duration);
        if let Some(nt) = params.num_threads {
            params.num_threads = Some(nt);
        }
        // num_threads and provider from asr_defaults override registry VAD
        if params.num_threads.is_none() {
            params.num_threads = Some(defaults.num_threads);
        }
        if params.provider.is_none() {
            params.provider = Some(defaults.provider());
        }

        params
    }

    pub fn model_config_json(&self, model_id: &str) -> Option<serde_json::Value> {
        self.audio.get(model_id).and_then(profile_to_json)
    }

    fn model_bool(&self, model_id: &str, key: &str, fallback: bool) -> bool {
        self.model_config_json(model_id)
            .and_then(|config| config.get(key).and_then(|v| v.as_bool()))
            .unwrap_or(fallback)
    }

    fn model_string(&self, model_id: &str, key: &str, fallback: String) -> String {
        self.model_config_json(model_id)
            .and_then(|config| {
                config
                    .get(key)
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(ToString::to_string)
            })
            .unwrap_or(fallback)
    }

    /// Whether to enable simulated streaming for non-streaming models.
    pub fn stream_simulate(&self, model_id: &str, registry: &ModelRegistry) -> bool {
        self.model_bool(
            model_id,
            "stream_simulate",
            self.asr_defaults(registry).stream_simulate,
        )
    }

    pub fn hotword_replace(&self, model_id: &str, registry: &ModelRegistry) -> bool {
        self.model_bool(
            model_id,
            "hotword_replace",
            self.asr_defaults(registry).hotword_replace,
        )
    }

    pub fn hotword_llm_mode(&self, model_id: &str, registry: &ModelRegistry) -> String {
        normalize_choice(
            &self.model_string(
                model_id,
                "hotword_llm_mode",
                self.asr_defaults(registry).hotword_llm_mode(),
            ),
            &["auto", "disabled", "force"],
            "auto",
        )
    }
}

/// Merge two VadParams, with `override_` taking priority for non-None fields.
fn merge_vad_params(base: Option<VadParams>, override_: Option<VadParams>) -> Option<VadParams> {
    match (base, override_) {
        (None, None) => None,
        (Some(b), None) => Some(b),
        (None, Some(o)) => Some(o),
        (Some(b), Some(o)) => Some(VadParams {
            threshold: o.threshold.or(b.threshold),
            min_silence_duration: o.min_silence_duration.or(b.min_silence_duration),
            min_speech_duration: o.min_speech_duration.or(b.min_speech_duration),
            max_speech_duration: o.max_speech_duration.or(b.max_speech_duration),
            num_threads: o.num_threads.or(b.num_threads),
            provider: o.provider.or(b.provider),
        }),
    }
}

impl Default for DoubaoStreamingConfig {
    fn default() -> Self {
        Self {
            url: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async".to_string(),
            auth_mode: "legacy".to_string(),
            app_id: String::new(),
            access_token: String::new(),
            resource_id: "volc.seedasr.sauc.duration".to_string(),
            api_key: String::new(),
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
            ssd_version: "200".to_string(),
            output_zh_variant: "off".to_string(),
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
                keep_recordings: false,
                prompt_hotkeys_stop_only: false,
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

/// Coerce a stored hotkey value into the canonical string form. Accepts the
/// new string form directly, and the legacy array form (`["A+B"]` or
/// `["A","B"]`) by joining elements with "+". Legacy numeric arrays
/// (`[29, 54, 4]`) drop their numbers → `""` (v2 user data never carries them;
/// `migration::migrate_prompts` already converted v1). Legacy compat — once
/// all user data is migrated to strings this can collapse to `as_str`.
fn hotkey_value_to_string(v: Option<&serde_norway::Value>) -> String {
    match v {
        Some(serde_norway::Value::String(s)) => s.clone(),
        Some(serde_norway::Value::Sequence(seq)) => seq
            .iter()
            .filter_map(|x| x.as_str())
            .collect::<Vec<_>>()
            .join("+"),
        _ => String::new(),
    }
}

fn normalize_prompt_item(item: &serde_norway::Value, index: usize) -> PromptItem {
    let fallback_id = format!("prompt-{}", index + 1);

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
        hotkey: hotkey_value_to_string(item.get("hotkey")),
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
        default_add: item
            .get("default_add")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
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
    /// Path to the bundled built-in `prompts.json` (read-only app resource).
    builtin_prompts_path: PathBuf,
    cached_config: RwLock<AppConfig>,
    cached_prompts: RwLock<Vec<PromptItem>>,
}

impl ConfigManager {
    pub fn new(data_dir: &Path, resource_dir: &Path) -> Self {
        let config_path = data_dir.join("config.yaml");
        let prompts_path = data_dir.join("prompts.json");
        let builtin_prompts_path = resource_dir.join("prompts.json");

        let config_example_path = if resource_dir.join("config.yaml.example").exists() {
            Some(resource_dir.join("config.yaml.example"))
        } else {
            None
        };

        let prompts_example_path = if builtin_prompts_path.exists() {
            Some(builtin_prompts_path.clone())
        } else {
            None
        };

        // Ensure config file exists
        if !config_path.exists() {
            if let Some(ref example) = config_example_path {
                let _ = fs::copy(example, &config_path);
            }
        }

        // First run: seed only built-in templates marked `default_add` (e.g.
        // "通用整理", which carries the default polish hotkey). Other built-ins
        // stay in the "常用润色提示词" picker for on-demand add. The flag is
        // stripped from seeded copies — it is a built-in-library classifier, not
        // a user-data property. Existing users (file present) keep their data
        // verbatim. Startup never merges defaults back in, so deletions persist.
        if !prompts_path.exists() {
            let seeded: Vec<PromptItem> = load_default_prompts(&prompts_example_path)
                .into_iter()
                .filter(|p| p.default_add)
                .map(|mut p| {
                    p.default_add = false;
                    p
                })
                .collect();
            let json = serde_json::to_string_pretty(&seeded).unwrap_or_else(|_| "[]".to_string());
            let _ = fs::write(&prompts_path, json);
        }

        // Load config into memory cache
        let config = Self::read_config_from_disk(&config_path);

        // Load prompts into memory cache (read-only, no default merge).
        let (prompts, prompts_dirty) = Self::read_prompts_from_disk(&prompts_path);
        // One-shot migration: if any stored hotkey was in the legacy array
        // form, rewrite the file so on-disk data is uniformly the string form.
        // Idempotent — next startup reads strings, dirty is false.
        if prompts_dirty {
            if let Ok(json) = serde_json::to_string_pretty(&prompts) {
                let _ = fs::write(&prompts_path, json);
            }
        }

        Self {
            config_path,
            prompts_path,
            builtin_prompts_path,
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

    /// Read prompts from disk into typed items. Read-only — never merges
    /// built-in defaults back in, so user deletions persist across restarts.
    /// Returns the items plus a `dirty` flag that is true when any stored
    /// hotkey was in the legacy array form and got normalized to a string — the
    /// caller persists the result so the on-disk format becomes uniform.
    fn read_prompts_from_disk(prompts_path: &Path) -> (Vec<PromptItem>, bool) {
        let content = match fs::read_to_string(prompts_path) {
            Ok(c) => c,
            Err(_) => return (Vec::new(), false),
        };
        let parsed: Vec<serde_norway::Value> = serde_json::from_str(&content).unwrap_or_default();
        let mut dirty = false;
        let items: Vec<PromptItem> = parsed
            .iter()
            .enumerate()
            .map(|(i, v)| {
                if v.get("hotkey").is_some_and(|h| h.is_sequence()) {
                    dirty = true;
                }
                normalize_prompt_item(v, i)
            })
            .collect();
        (items, dirty)
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

    /// Load built-in prompt templates from the bundled app resource
    /// (`prompts.json` in the resource dir). Read-only: never touches user
    /// data. Used by the "常用润色提示词" picker so app updates refresh the
    /// built-in library without affecting existing users.
    pub fn load_builtin_prompts(&self) -> Vec<PromptItem> {
        load_default_prompts(&Some(self.builtin_prompts_path.clone()))
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
        assert_eq!(cfg.auth_mode, "legacy");
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
        assert_eq!(conn.auth_mode, cfg.auth_mode);
        assert_eq!(conn.app_id, cfg.app_id);
        assert_eq!(conn.access_token, cfg.access_token);
        assert_eq!(conn.resource_id, cfg.resource_id);
        assert_eq!(conn.api_key, cfg.api_key);
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
        let cfg = DoubaoStreamingConfig {
            language: String::new(),
            ..Default::default()
        };
        let req = cfg.to_request_config();
        assert_eq!(req.language, None);
    }

    #[test]
    fn to_request_config_language_preserved() {
        let cfg = DoubaoStreamingConfig {
            language: "zh".to_string(),
            ..Default::default()
        };
        let req = cfg.to_request_config();
        assert_eq!(req.language, Some("zh".to_string()));
    }

    #[test]
    fn to_request_config_language_whitespace_becomes_none() {
        let cfg = DoubaoStreamingConfig {
            language: "   ".to_string(),
            ..Default::default()
        };
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

    #[test]
    fn normalize_prompt_item_default_add_true() {
        let json = serde_json::json!({ "id": "p1", "default_add": true });
        let item = normalize_prompt_item(&to_norway(json), 0);
        assert!(item.default_add);
    }

    #[test]
    fn normalize_prompt_item_default_add_absent_is_false() {
        let json = serde_json::json!({ "id": "p1" });
        let item = normalize_prompt_item(&to_norway(json), 0);
        assert!(!item.default_add);
    }

    #[test]
    fn normalize_prompt_item_default_add_non_bool_is_false() {
        let json = serde_json::json!({ "id": "p1", "default_add": "yes" });
        let item = normalize_prompt_item(&to_norway(json), 0);
        assert!(!item.default_add);
    }

    // ── hotkey_value_to_string (legacy array → string) ─────────────────

    #[test]
    fn hotkey_value_to_string_passes_string_through() {
        let v = to_norway(serde_json::json!("ControlLeft+ShiftLeft"));
        assert_eq!(hotkey_value_to_string(Some(&v)), "ControlLeft+ShiftLeft");
    }

    #[test]
    fn hotkey_value_to_string_joins_single_element_array() {
        let v = to_norway(serde_json::json!(["Control+Space"]));
        assert_eq!(hotkey_value_to_string(Some(&v)), "Control+Space");
    }

    #[test]
    fn hotkey_value_to_string_joins_multi_element_array() {
        let v = to_norway(serde_json::json!(["ControlLeft", "ShiftLeft"]));
        assert_eq!(hotkey_value_to_string(Some(&v)), "ControlLeft+ShiftLeft");
    }

    #[test]
    fn hotkey_value_to_string_empty_array_to_empty_string() {
        let v = to_norway(serde_json::json!([]));
        assert_eq!(hotkey_value_to_string(Some(&v)), "");
    }

    #[test]
    fn hotkey_value_to_string_none_to_empty_string() {
        assert_eq!(hotkey_value_to_string(None), "");
    }

    #[test]
    fn hotkey_value_to_string_numeric_array_drops_numbers() {
        // Legacy v1 evdev arrays ([29, 54, 4]) — numbers aren't strings, so
        // they drop → "". v2 user data never carries these (migration already
        // converted); this is just defensive.
        let v = to_norway(serde_json::json!([29, 54]));
        assert_eq!(hotkey_value_to_string(Some(&v)), "");
    }

    // ── ConfigManager: first-run seeding & no-merge ─────────────────────

    fn write_builtin_prompts(resource_dir: &std::path::Path, items: &[PromptItem]) {
        let json = serde_json::to_string_pretty(items).unwrap();
        std::fs::write(resource_dir.join("prompts.json"), json).unwrap();
    }

    fn builtin_prompt(id: &str, default_add: bool) -> PromptItem {
        PromptItem {
            id: id.to_string(),
            title: id.to_string(),
            hotkey: String::new(),
            hotkey_mode: "toggle".to_string(),
            prompt: format!("prompt-{id}"),
            default_add,
        }
    }

    #[test]
    fn new_seeds_only_default_add_prompts_for_new_user() {
        let data_dir = tempfile::tempdir().unwrap();
        let resource_dir = tempfile::tempdir().unwrap();
        write_builtin_prompts(
            resource_dir.path(),
            &[builtin_prompt("basic", true), builtin_prompt("adv", false)],
        );

        let mgr = ConfigManager::new(data_dir.path(), resource_dir.path());
        let loaded = mgr.load_prompts();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "basic");
        // Seeded copy must not carry the built-in classifier.
        assert!(!loaded[0].default_add);
    }

    #[test]
    fn load_builtin_returns_all_with_flags() {
        let data_dir = tempfile::tempdir().unwrap();
        let resource_dir = tempfile::tempdir().unwrap();
        write_builtin_prompts(
            resource_dir.path(),
            &[builtin_prompt("basic", true), builtin_prompt("adv", false)],
        );

        let mgr = ConfigManager::new(data_dir.path(), resource_dir.path());
        let builtin = mgr.load_builtin_prompts();
        assert_eq!(builtin.len(), 2);
        assert!(builtin.iter().any(|p| p.id == "basic" && p.default_add));
        assert!(builtin.iter().any(|p| p.id == "adv" && !p.default_add));
        // load_builtin never seeds into user data — only the basic one is there.
        assert_eq!(mgr.load_prompts().len(), 1);
    }

    #[test]
    fn read_prompts_does_not_merge_back_deleted_builtins() {
        let data_dir = tempfile::tempdir().unwrap();
        let resource_dir = tempfile::tempdir().unwrap();
        write_builtin_prompts(resource_dir.path(), &[builtin_prompt("basic", true)]);

        // First run seeds the basic prompt.
        let mgr = ConfigManager::new(data_dir.path(), resource_dir.path());
        assert_eq!(mgr.load_prompts().len(), 1);

        // User deletes it (writes an empty list to disk).
        std::fs::write(data_dir.path().join("prompts.json"), "[]").unwrap();

        // Re-construct (simulate restart): the deleted prompt must NOT reappear.
        let mgr2 = ConfigManager::new(data_dir.path(), resource_dir.path());
        assert!(mgr2.load_prompts().is_empty());
    }

    #[test]
    fn new_migrates_legacy_array_hotkey_on_startup() {
        let data_dir = tempfile::tempdir().unwrap();
        let resource_dir = tempfile::tempdir().unwrap();
        // User data with a legacy array-form hotkey.
        std::fs::write(
            data_dir.path().join("prompts.json"),
            r#"[{"id":"p1","title":"T","hotkey":["ControlLeft+ShiftLeft"],"hotkey_mode":"toggle","prompt":"x"}]"#,
        )
        .unwrap();

        let mgr = ConfigManager::new(data_dir.path(), resource_dir.path());
        // Cache is normalized to the string form.
        assert_eq!(mgr.load_prompts()[0].hotkey, "ControlLeft+ShiftLeft");

        // On-disk file has been rewritten to the string form (no array left).
        let on_disk = std::fs::read_to_string(data_dir.path().join("prompts.json")).unwrap();
        assert!(on_disk.contains("ControlLeft+ShiftLeft"));
        assert!(!on_disk.contains(r#""hotkey": ["#));

        // Idempotent: a second construction keeps the string form intact.
        let _mgr2 = ConfigManager::new(data_dir.path(), resource_dir.path());
        let on_disk2 = std::fs::read_to_string(data_dir.path().join("prompts.json")).unwrap();
        assert!(on_disk2.contains("ControlLeft+ShiftLeft"));
        assert!(!on_disk2.contains(r#""hotkey": ["#));
    }
}

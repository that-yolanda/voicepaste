//! OpenRouter one-shot ASR engine (HTTP `POST /audio/transcriptions`).
//!
//! Unlike the streaming WebSocket engines, this backend buffers the whole
//! recording and submits it in a single HTTP request once the user stops.
//! Audio chunks arriving via `append_audio` are held until
//! `commit_and_await_final` flushes them as base64 WAV inside a JSON body.
//! No partial results are produced during recording — the caller shows the
//! static recording hint (`show_recording_hint = true`) and the mic-driven
//! waveform instead.

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::mpsc;

use super::{AsrEngine, AsrEvent, AsrSession};
use crate::errors::{AppError, AppErrorCode};

pub const DEFAULT_URL: &str = "https://openrouter.ai/api/v1";
const TRANSCRIPTIONS_PATH: &str = "/audio/transcriptions";
const SAMPLE_RATE: f32 = 16000.0;
/// Timeout floor: covers DNS + TLS + upload and transcription of a short clip.
const TIMEOUT_FLOOR_SECS: f32 = 30.0;
/// Timeout budget per audio second: slow base64 upstream + provider processing.
const TIMEOUT_PER_AUDIO_SEC: f32 = 3.0;
const TIMEOUT_CAP_SECS: f32 = 300.0;
/// Refuse recordings beyond 10 minutes (~19 MB PCM / ~26 MB base64 JSON).
const MAX_AUDIO_SECS: f32 = 600.0;
/// Registry model ids served by this engine all start with this prefix.
pub fn is_openrouter_model(id: &str) -> bool {
    id.starts_with("openrouter-")
}

/// Merged per-model configuration (registry defaults + user overrides +
/// provider credentials), resolved by `create_engine_session`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct OpenRouterAsrConfig {
    pub url: String,
    pub api_key: String,
    /// OpenRouter model slug, e.g. "openai/whisper-large-v3".
    pub model: String,
    /// ISO-639-1 code (exactly two letters); empty = provider auto-detect.
    pub language: String,
    /// Sampling temperature, clamped to the 0..=1 protocol range.
    pub temperature: f64,
}

impl Default for OpenRouterAsrConfig {
    fn default() -> Self {
        Self {
            url: DEFAULT_URL.to_string(),
            api_key: String::new(),
            model: "openai/whisper-large-v3".to_string(),
            language: String::new(),
            temperature: 0.0,
        }
    }
}

/// Convert f32 samples (16 kHz mono) to little-endian s16 PCM bytes.
/// Non-finite samples collapse to silence; scaling is asymmetric so +1.0
/// maps to +32767 and -1.0 to -32768 without clipping.
fn pcm_s16le_bytes(samples: &[f32]) -> Vec<u8> {
    samples
        .iter()
        .flat_map(|&sample| {
            let sample = if sample.is_finite() {
                sample.clamp(-1.0, 1.0)
            } else {
                0.0
            };
            let scaled = sample * if sample < 0.0 { 32768.0 } else { 32767.0 };
            (scaled as i16).to_le_bytes()
        })
        .collect()
}

/// Wrap s16le samples in a canonical 44-byte WAV (RIFF) header.
///
/// Providers behind OpenRouter vary in accepted `input_audio.format`: raw
/// headerless "pcm" is only honored by some (ElevenLabs Scribe), while every
/// provider tested (Qwen3-ASR, Whisper, Nova-3, GPT-Transcribe) decodes
/// "wav" — the 44-byte overhead is negligible, so WAV is the safe default.
fn wav_s16le_bytes(samples: &[f32]) -> Vec<u8> {
    let data = pcm_s16le_bytes(samples);
    let data_len = data.len() as u32;
    let mut wav = Vec::with_capacity(44 + data.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&36u32.wrapping_add(data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM format tag
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&(SAMPLE_RATE as u32).to_le_bytes());
    wav.extend_from_slice(&((SAMPLE_RATE as u32) * 2).to_le_bytes()); // byte rate
    wav.extend_from_slice(&2u16.to_le_bytes()); // block align
    wav.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(&data);
    wav
}

/// Gate the `language` setting to the ISO-639-1 subset the protocol accepts:
/// empty → `None` (omit the field, provider auto-detects); exactly two ASCII
/// letters → normalized lowercase; anything else was rejected at session
/// creation and never reaches the request body.
fn normalized_language(raw: &str) -> Option<String> {
    let trimmed = raw.trim().to_ascii_lowercase();
    if trimmed.is_empty() {
        return None;
    }
    (trimmed.len() == 2 && trimmed.chars().all(|c| c.is_ascii_alphabetic())).then_some(trimmed)
}

/// Per-request deadline: floor 30 s plus 3 s per audio second, capped at
/// 300 s — a 2-minute recording gets a ~5-minute budget.
fn request_timeout(audio_secs: f32) -> Duration {
    Duration::from_secs_f32(
        (TIMEOUT_FLOOR_SECS + audio_secs * TIMEOUT_PER_AUDIO_SEC).min(TIMEOUT_CAP_SECS),
    )
}

/// Duration of a recording in seconds, or an error when it exceeds the
/// upload ceiling (fail honestly rather than silently truncate).
fn audio_seconds(samples: &[f32]) -> Result<f32, AppError> {
    let secs = samples.len() as f32 / SAMPLE_RATE;
    if secs > MAX_AUDIO_SECS {
        return Err(
            AppError::new(AppErrorCode::AsrRequestInvalid).with_detail(format!(
                "audio too long: {secs:.0}s exceeds the {MAX_AUDIO_SECS:.0}s limit"
            )),
        );
    }
    Ok(secs)
}

fn build_request_body(audio_b64: &str, config: &OpenRouterAsrConfig) -> Value {
    // "wav" wraps the capture pipeline's s16le/16 kHz/mono stream in a
    // RIFF header — the one `input_audio.format` every OpenRouter STT
    // provider accepts (raw "pcm" is provider-dependent).
    let mut body = json!({
        "model": config.model.trim(),
        "input_audio": { "data": audio_b64, "format": "wav" },
        "temperature": config.temperature,
    });
    if let Some(language) = normalized_language(&config.language) {
        body["language"] = json!(language);
    }
    body
}

fn classify_transport_error(error: &reqwest::Error) -> AppErrorCode {
    if error.is_timeout() {
        AppErrorCode::AsrTimeout
    } else {
        AppErrorCode::AsrNetwork
    }
}

/// Map HTTP status → engine-agnostic ASR code. Specific arms (504/524
/// timeouts) precede the generic 5xx server-error arm.
fn classify_http_error(status: u16) -> AppErrorCode {
    match status {
        401 | 403 => AppErrorCode::AsrAuthFailed,
        402 => AppErrorCode::AsrQuotaExhausted,
        429 => AppErrorCode::AsrRateLimited,
        504 | 524 => AppErrorCode::AsrTimeout,
        500..=599 => AppErrorCode::AsrServerError,
        _ => AppErrorCode::AsrRequestInvalid,
    }
}

/// Opaque provider-side failures forwarded by OpenRouter as HTTP 400. They
/// are not caused by our request shape (a genuine parameter problem gets an
/// actionable message such as "does not support keyterms"), so surface them
/// as server errors instead of the misleading "invalid request".
fn is_provider_side_rejection(message: &str) -> bool {
    message.starts_with("Provider returned") || message.starts_with("Provider could not process")
}

/// Status plus provider message → user-facing code.
fn classify_rejection(status: u16, message: &str) -> AppErrorCode {
    if status == 400 && is_provider_side_rejection(message) {
        return AppErrorCode::AsrServerError;
    }
    classify_http_error(status)
}

/// Extract `error.message` from an OpenRouter error body; fall back to the
/// raw (truncated) body when it is not the expected shape.
fn error_message(body: &str) -> String {
    let fallback = || {
        let mut text = body.trim().chars().take(200).collect::<String>();
        if text.is_empty() {
            text.push_str("<empty body>");
        }
        text
    };
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(|m| m.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(fallback)
}

/// Parse a successful transcription response: `{ text, usage }`.
fn parse_response(body: &str) -> Result<String, AppError> {
    let value: Value = serde_json::from_str(body)
        .map_err(|e| AppError::new(AppErrorCode::AsrProtocolError).with_detail(e.to_string()))?;
    let transcript = value.get("text").and_then(Value::as_str).ok_or_else(|| {
        AppError::new(AppErrorCode::AsrProtocolError)
            .with_detail("response is missing the text field")
    })?;
    Ok(transcript.trim().to_string())
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// Fetch the provider's STT model catalog
/// (`GET {url}/models?output_modalities=transcription`). The endpoint is
/// public; the API key is attached when present to stay on the safer quota
/// path. Returns the transparent `{data: [...]}` payload.
pub async fn list_stt_models(url: &str, api_key: &str) -> Result<Value, AppError> {
    let base = url.trim().trim_end_matches('/');
    let mut request = http_client()
        .get(format!("{base}/models"))
        .query(&[("output_modalities", "transcription")]);
    if !api_key.trim().is_empty() {
        request = request.bearer_auth(api_key.trim());
    }
    let response = request
        .send()
        .await
        .map_err(|e| AppError::new(classify_transport_error(&e)).with_detail(e.to_string()))?;
    if !response.status().is_success() {
        return Err(AppError::new(AppErrorCode::AsrTestFailed)
            .with_param("provider", "OpenRouter")
            .with_detail(format!("HTTP {}", response.status().as_u16())));
    }
    let catalog: Value = response.json().await.map_err(|_| {
        AppError::new(AppErrorCode::AsrTestFailed)
            .with_param("provider", "OpenRouter")
            .with_detail("invalid model catalog")
    })?;
    if !catalog.get("data").is_some_and(Value::is_array) {
        return Err(AppError::new(AppErrorCode::AsrTestFailed)
            .with_param("provider", "OpenRouter")
            .with_detail("invalid model catalog"));
    }
    Ok(catalog)
}

/// Normalize the raw provider catalog into `{data: [{id, name}]}` entries.
/// Pricing units differ across models, so do not infer a per-minute price.
pub fn catalog_entries(catalog: &Value) -> Value {
    let empty = Vec::new();
    let entries = catalog
        .get("data")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let mut out = Vec::new();
    for entry in entries {
        let Some(id) = entry
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
        else {
            continue;
        };
        let name = entry.get("name").and_then(Value::as_str).unwrap_or(id);
        out.push(json!({ "id": id, "name": name.trim() }));
    }
    Value::Object(
        [("data".to_string(), Value::Array(out))]
            .into_iter()
            .collect(),
    )
}

/// Derive a registry model id from an OpenRouter slug:
/// "openai/whisper-large-v3" → "openrouter-openai-whisper-large-v3".
/// Lowercase; anything outside [a-z0-9.-] collapses to '-'.
pub fn custom_model_id(slug: &str) -> String {
    let sanitized: String = slug
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches('-');
    format!("openrouter-{trimmed}")
}

/// Build the registry entry for a user-added catalog model. The template
/// lives in code (not in the bundled registry) so no OpenRouter model ships
/// built-in — users start from an empty list and add what they want from
/// the online catalog.
pub fn custom_entry(slug: &str, display_name: &str) -> crate::model::ModelEntry {
    use crate::model::{Capabilities, ModelCategory, ModelEntry};
    ModelEntry {
        id: custom_model_id(slug),
        model_type: "online".to_string(),
        category: ModelCategory::Asr,
        engine: "openrouter".to_string(),
        provider: Some("openrouter".to_string()),
        name: display_name.to_string(),
        name_en: Some(display_name.to_string()),
        description: "一次性整段转写".to_string(),
        description_en: Some("One-shot whole-clip transcription".to_string()),
        capabilities: Capabilities {
            streaming: false,
            hotwords: false,
            punctuation: true,
            itn: true,
        },
        languages: [
            "zh", "yue", "en", "ja", "ko", "de", "es", "fr", "pt", "ru", "ar", "it", "nl", "pl",
            "tr", "vi", "th", "id", "hi",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect(),
        requires_config: Some(vec!["api_key".to_string()]),
        architecture: None,
        download_url: None,
        file_size: None,
        mem_size: None,
        model_files: std::collections::HashMap::new(),
        default_config: Some(json!({
            "url": DEFAULT_URL,
            "api_key": "",
            "model": slug,
            "language": "",
            "temperature": 0,
        })),
        custom: true,
    }
}

// ---------------------------------------------------------------------------
// OpenRouterEngine — AsrEngine implementation
// ---------------------------------------------------------------------------

pub struct OpenRouterEngine {
    config: OpenRouterAsrConfig,
}

impl OpenRouterEngine {
    pub fn new(config: OpenRouterAsrConfig) -> Self {
        Self { config }
    }
}

fn config_missing(field: &str) -> AppError {
    AppError::new(AppErrorCode::AsrConfigMissing).with_param("field", field)
}

fn config_invalid(field: &str) -> AppError {
    AppError::new(AppErrorCode::AsrConfigFieldInvalid).with_param("field", field)
}

#[async_trait]
impl AsrEngine for OpenRouterEngine {
    async fn create_session(
        &self,
        _hotwords: &[String],
    ) -> Result<(Box<dyn AsrSession>, mpsc::UnboundedReceiver<AsrEvent>), AppError> {
        // HTTP has no connection handshake, so all checks are local and fail
        // fast here rather than after the user has spoken.
        if self.config.api_key.trim().is_empty() {
            return Err(config_missing("api_key"));
        }
        if self.config.model.trim().is_empty() {
            return Err(config_missing("model"));
        }
        let url = self.config.url.trim();
        if !(url.starts_with("http://") || url.starts_with("https://")) || url.contains("{}") {
            return Err(config_invalid("url"));
        }
        if !self.config.language.trim().is_empty()
            && normalized_language(&self.config.language).is_none()
        {
            return Err(config_invalid("language"));
        }
        if !(0.0..=1.0).contains(&self.config.temperature) || !self.config.temperature.is_finite() {
            return Err(config_invalid("temperature"));
        }

        let (event_tx, event_rx) = mpsc::unbounded_channel::<AsrEvent>();
        let session = OpenRouterSession {
            is_ready: Arc::new(AtomicBool::new(true)),
            is_committed: Arc::new(AtomicBool::new(false)),
            audio_buffer: Arc::new(Mutex::new(Vec::<f32>::new())),
            config: Arc::new(self.config.clone()),
        };
        // HTTP is stateless: the session is ready immediately. No events are
        // produced during recording (one-shot, not streaming).
        let _ = event_tx.send(AsrEvent::Open);
        Ok((Box::new(session), event_rx))
    }
}

// ---------------------------------------------------------------------------
// OpenRouterSession — AsrSession implementation
// ---------------------------------------------------------------------------

struct OpenRouterSession {
    is_ready: Arc<AtomicBool>,
    is_committed: Arc<AtomicBool>,
    audio_buffer: Arc<Mutex<Vec<f32>>>,
    config: Arc<OpenRouterAsrConfig>,
}

/// Submit the whole recording in one request and return the final transcript.
async fn submit(samples: &[f32], config: &OpenRouterAsrConfig) -> Result<String, AppError> {
    // A stop before any audio chunk arrived must not cost a network round
    // trip; surface it as an empty transcript through the existing path.
    if samples.is_empty() {
        log_asr!(
            info,
            "OpenRouter ASR commit with no audio; returning empty text"
        );
        return Ok(String::new());
    }
    let audio_secs = audio_seconds(samples)?;
    let wav = wav_s16le_bytes(samples);
    let audio_b64 = STANDARD.encode(&wav);
    let body = build_request_body(&audio_b64, config);
    log_asr!(
        info,
        "OpenRouter ASR submit: model={}, {:.1}s audio, {} bytes WAV",
        config.model.trim(),
        audio_secs,
        wav.len()
    );

    let url = format!(
        "{}{}",
        config.url.trim().trim_end_matches('/'),
        TRANSCRIPTIONS_PATH
    );
    let response = http_client()
        .post(&url)
        .bearer_auth(config.api_key.trim())
        .timeout(request_timeout(audio_secs))
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            AppError::new(classify_transport_error(&e)).with_detail(
                crate::logger::redact_credentials(&e.to_string(), &[config.api_key.trim()]),
            )
        })?;

    let status = response.status();
    let text = response.text().await.map_err(|e| {
        AppError::new(AppErrorCode::AsrNetwork).with_detail(crate::logger::redact_credentials(
            &e.to_string(),
            &[config.api_key.trim()],
        ))
    })?;
    if !status.is_success() {
        let message = error_message(&text);
        let code = classify_rejection(status.as_u16(), &message);
        return Err(AppError::new(code).with_detail(format!(
            "HTTP {}: {}",
            status.as_u16(),
            message
        )));
    }
    let transcript = parse_response(&text)?;
    // Log billed usage so cost is observable without the provider dashboard.
    if let Ok(value) = serde_json::from_str::<Value>(&text) {
        if let Some(usage) = value.get("usage").filter(|u| u.is_object()) {
            log_asr!(
                info,
                "OpenRouter ASR usage: cost=${}, seconds={}",
                usage.get("cost").and_then(Value::as_f64).unwrap_or(0.0),
                usage.get("seconds").and_then(Value::as_f64).unwrap_or(0.0)
            );
        }
    }
    Ok(transcript)
}

#[async_trait]
impl AsrSession for OpenRouterSession {
    fn is_ready(&self) -> bool {
        self.is_ready.load(Ordering::SeqCst)
    }

    fn append_audio(&self, samples: &[f32]) {
        if !self.is_ready() || self.is_committed.load(Ordering::SeqCst) {
            return;
        }
        if let Ok(mut buffer) = self.audio_buffer.lock() {
            buffer.extend_from_slice(samples);
        }
    }

    async fn commit_and_await_final(&self) -> Result<String, AppError> {
        if !self.is_ready() {
            return Err(AppError::new(AppErrorCode::AsrSessionClosed));
        }
        if self.is_committed.swap(true, Ordering::SeqCst) {
            return Err(AppError::new(AppErrorCode::AsrSessionClosed));
        }
        // Drain (not clone) — the buffer is dead after this point.
        let samples = std::mem::take(
            &mut *self
                .audio_buffer
                .lock()
                .map_err(|_| AppError::new(AppErrorCode::AsrWorkerAborted))?,
        );
        self.is_ready.store(false, Ordering::SeqCst);
        submit(&samples, &self.config).await
    }

    fn close(&self) {
        self.is_ready.store(false, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_partial_json, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn test_config(url: &str) -> OpenRouterAsrConfig {
        OpenRouterAsrConfig {
            url: url.to_string(),
            api_key: "test-key".to_string(),
            model: "openai/whisper-large-v3".to_string(),
            language: String::new(),
            temperature: 0.0,
        }
    }

    #[test]
    fn pcm_conversion_values() {
        let bytes = pcm_s16le_bytes(&[0.0, 1.0, -1.0, 0.5, f32::NAN, f32::INFINITY]);
        assert_eq!(bytes.len(), 12);
        assert_eq!(i16::from_le_bytes([bytes[0], bytes[1]]), 0);
        assert_eq!(i16::from_le_bytes([bytes[2], bytes[3]]), 32767);
        assert_eq!(i16::from_le_bytes([bytes[4], bytes[5]]), -32768);
        assert_eq!(i16::from_le_bytes([bytes[6], bytes[7]]), 16383);
        assert_eq!(i16::from_le_bytes([bytes[8], bytes[9]]), 0);
        assert_eq!(i16::from_le_bytes([bytes[10], bytes[11]]), 0);
    }

    #[test]
    fn wav_wraps_canonical_44_byte_header() {
        let wav = wav_s16le_bytes(&[0.0; 16000]); // 1 s
        assert_eq!(wav.len(), 44 + 32000);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(&wav[36..40], b"data");
        // RIFF size + 8 == file length; data size == payload length.
        assert_eq!(
            u32::from_le_bytes(wav[4..8].try_into().unwrap()) as usize + 8,
            wav.len()
        );
        assert_eq!(
            u32::from_le_bytes(wav[40..44].try_into().unwrap()) as usize,
            32000
        );
        // fmt payload: PCM tag, mono, 16 kHz, 32 kB/s, 2-byte align, 16-bit.
        assert_eq!(u16::from_le_bytes(wav[20..22].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16000);
        assert_eq!(u32::from_le_bytes(wav[28..32].try_into().unwrap()), 32000);
        assert_eq!(u16::from_le_bytes(wav[32..34].try_into().unwrap()), 2);
        assert_eq!(u16::from_le_bytes(wav[34..36].try_into().unwrap()), 16);
    }

    #[test]
    fn request_body_omits_optional_fields() {
        let config = test_config("https://example.com");
        let body = build_request_body("QWxwaGE=", &config);
        assert_eq!(body["model"], "openai/whisper-large-v3");
        assert_eq!(body["input_audio"]["data"], "QWxwaGE=");
        assert_eq!(body["input_audio"]["format"], "wav");
        assert_eq!(body["temperature"], 0.0);
        // Empty language = auto-detect; hotwords are not exposed for this engine.
        assert!(body.get("language").is_none());
        assert!(body.get("keyterms").is_none());
    }

    #[test]
    fn legacy_keyterms_setting_does_not_send_hotwords() {
        let config: OpenRouterAsrConfig = serde_json::from_value(json!({
            "language": "ZH",
            "enable_keyterms": true,
        }))
        .unwrap();
        let body = build_request_body("AA==", &config);
        assert_eq!(body["language"], "zh");
        assert!(body.get("keyterms").is_none());
    }

    #[test]
    fn normalized_language_gate() {
        assert_eq!(normalized_language(""), None);
        assert_eq!(normalized_language("  "), None);
        assert_eq!(normalized_language("zh"), Some("zh".to_string()));
        assert_eq!(normalized_language("ZH"), Some("zh".to_string()));
        assert_eq!(normalized_language("pol"), None);
        assert_eq!(normalized_language("zh-CN"), None);
        assert_eq!(normalized_language("z1"), None);
    }

    #[test]
    fn request_timeout_floor_linear_cap() {
        assert_eq!(request_timeout(0.0).as_secs_f32(), 30.0);
        assert_eq!(request_timeout(10.0).as_secs_f32(), 60.0);
        assert_eq!(request_timeout(200.0).as_secs_f32(), 300.0);
    }

    #[test]
    fn audio_seconds_rejects_over_limit() {
        assert_eq!(audio_seconds(&[0.0; 16000]).unwrap(), 1.0);
        let too_long = vec![0.0f32; (MAX_AUDIO_SECS as usize + 1) * 16000];
        let error = audio_seconds(&too_long).unwrap_err();
        assert_eq!(error.code, AppErrorCode::AsrRequestInvalid);
    }

    #[test]
    fn classify_http_error_table() {
        let cases = [
            (400u16, AppErrorCode::AsrRequestInvalid),
            (401, AppErrorCode::AsrAuthFailed),
            (403, AppErrorCode::AsrAuthFailed),
            (402, AppErrorCode::AsrQuotaExhausted),
            (404, AppErrorCode::AsrRequestInvalid),
            (413, AppErrorCode::AsrRequestInvalid),
            (422, AppErrorCode::AsrRequestInvalid),
            (429, AppErrorCode::AsrRateLimited),
            (500, AppErrorCode::AsrServerError),
            (502, AppErrorCode::AsrServerError),
            (503, AppErrorCode::AsrServerError),
            (504, AppErrorCode::AsrTimeout),
            (524, AppErrorCode::AsrTimeout),
            (529, AppErrorCode::AsrServerError),
        ];
        for (status, expected) in cases {
            assert_eq!(classify_http_error(status), expected, "status {status}");
        }
    }

    #[test]
    fn classify_rejection_separates_provider_faults_from_bad_params() {
        // Opaque provider-side 400s are server errors, not our fault.
        assert_eq!(
            classify_rejection(400, "Provider returned 400"),
            AppErrorCode::AsrServerError
        );
        assert_eq!(
            classify_rejection(
                400,
                "Provider could not process the audio input (unsupported or malformed audio)"
            ),
            AppErrorCode::AsrServerError
        );
        // Actionable parameter problems stay request-invalid…
        assert_eq!(
            classify_rejection(
                400,
                "The selected model does not support keyterms. Remove the field"
            ),
            AppErrorCode::AsrRequestInvalid
        );
        // …and so do provider-side messages on non-400 statuses.
        assert_eq!(
            classify_rejection(422, "Provider returned 400"),
            AppErrorCode::AsrRequestInvalid
        );
    }

    #[test]
    fn error_message_extracts_provider_detail() {
        let body = r#"{"error":{"code":402,"message":"Insufficient credits"}}"#;
        assert_eq!(error_message(body), "Insufficient credits");
        assert_eq!(error_message("not json"), "not json");
        assert_eq!(error_message("  "), "<empty body>");
    }

    #[test]
    fn parse_response_trims_and_rejects_bad_payloads() {
        assert_eq!(parse_response(r#"{"text":" 你好\n"}"#).unwrap(), "你好");
        let missing = parse_response(r#"{"usage":{}}"#).unwrap_err();
        assert_eq!(missing.code, AppErrorCode::AsrProtocolError);
        let bad = parse_response("not json").unwrap_err();
        assert_eq!(bad.code, AppErrorCode::AsrProtocolError);
    }

    #[test]
    fn catalog_entries_preserves_names_without_inferring_price_units() {
        let catalog = json!({
            "data": [
                { "id": "openai/whisper-large-v3", "name": "OpenAI: Whisper Large V3",
                  "pricing": { "prompt": "0.0000075" } },
                { "id": "openai/gpt-4o-transcribe", "name": "GPT-4o Transcribe",
                  "pricing": { "prompt": "0.0000025", "completion": "0.00001" } },
                { "id": "", "name": "broken" },
                { "name": "missing id" },
                { "id": "no-pricing/model", "name": "No Pricing" }
            ]
        });
        let entries = catalog_entries(&catalog)["data"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0]["id"], "openai/whisper-large-v3");
        assert_eq!(entries[0]["name"], "OpenAI: Whisper Large V3");
        assert_eq!(entries[1]["name"], "GPT-4o Transcribe");
        assert_eq!(entries[2]["name"], "No Pricing");
    }

    #[test]
    fn custom_model_id_sanitizes_slug() {
        assert_eq!(
            custom_model_id("openai/whisper-large-v3"),
            "openrouter-openai-whisper-large-v3"
        );
        assert_eq!(
            custom_model_id(" Qwen/Qwen3-ASR:free "),
            "openrouter-qwen-qwen3-asr-free"
        );
    }

    #[test]
    fn custom_entry_builds_registry_template() {
        let entry = custom_entry("qwen/qwen3-asr-1.7b", "Qwen3 ASR 1.7B");
        assert_eq!(entry.id, "openrouter-qwen-qwen3-asr-1.7b");
        assert_eq!(entry.engine, "openrouter");
        assert_eq!(entry.provider.as_deref(), Some("openrouter"));
        assert!(entry.custom);
        let defaults = entry.default_config.as_ref().expect("template defaults");
        assert_eq!(defaults["model"], "qwen/qwen3-asr-1.7b");
        assert_eq!(defaults["url"], DEFAULT_URL);
        assert!(!entry.capabilities.streaming);
        assert!(!entry.capabilities.hotwords);
        assert!(defaults.get("enable_keyterms").is_none());
        assert_eq!(entry.requires_config, Some(vec!["api_key".to_string()]));
    }

    #[tokio::test]
    async fn create_session_validates_config() {
        let cases: Vec<(OpenRouterAsrConfig, AppErrorCode, &str)> = vec![
            (
                OpenRouterAsrConfig {
                    api_key: String::new(),
                    ..test_config("https://example.com")
                },
                AppErrorCode::AsrConfigMissing,
                "api_key",
            ),
            (
                OpenRouterAsrConfig {
                    model: String::new(),
                    ..test_config("https://example.com")
                },
                AppErrorCode::AsrConfigMissing,
                "model",
            ),
            (
                OpenRouterAsrConfig {
                    url: "ftp://example.com".to_string(),
                    ..test_config("https://example.com")
                },
                AppErrorCode::AsrConfigFieldInvalid,
                "url",
            ),
            (
                OpenRouterAsrConfig {
                    url: "https://example.com/{}".to_string(),
                    ..test_config("https://example.com")
                },
                AppErrorCode::AsrConfigFieldInvalid,
                "url",
            ),
            (
                OpenRouterAsrConfig {
                    language: "zh-CN".to_string(),
                    ..test_config("https://example.com")
                },
                AppErrorCode::AsrConfigFieldInvalid,
                "language",
            ),
            (
                OpenRouterAsrConfig {
                    temperature: 1.5,
                    ..test_config("https://example.com")
                },
                AppErrorCode::AsrConfigFieldInvalid,
                "temperature",
            ),
        ];
        for (config, code, field) in cases {
            let engine = OpenRouterEngine::new(config);
            let error = match engine.create_session(&[]).await {
                Err(error) => error,
                Ok(_) => panic!("session creation should fail for {field}"),
            };
            assert_eq!(error.code, code, "field {field}");
            assert_eq!(error.params.get("field").map(String::as_str), Some(field));
        }
    }

    fn transcription_mock(status: u16, body: String) -> Mock {
        Mock::given(method("POST"))
            .and(path("/audio/transcriptions"))
            .and(body_partial_json(json!({"input_audio": {"format": "wav"}})))
            .respond_with(ResponseTemplate::new(status).set_body_string(body))
    }

    #[tokio::test]
    async fn commit_returns_transcribed_text() {
        let server = MockServer::start().await;
        transcription_mock(
            200,
            r#"{"text":"你好世界","usage":{"cost":0.000045,"seconds":6.0}}"#.to_string(),
        )
        .mount(&server)
        .await;

        let engine = OpenRouterEngine::new(test_config(&server.uri()));
        let (session, mut rx) = engine.create_session(&[]).await.unwrap();
        assert!(matches!(rx.try_recv(), Ok(AsrEvent::Open)));
        session.append_audio(&[0.0, 0.1, 0.2]);
        assert_eq!(session.commit_and_await_final().await.unwrap(), "你好世界");
        session.close();
    }

    #[tokio::test]
    async fn commit_maps_http_errors_to_codes() {
        let cases = [
            (401u16, "boom", AppErrorCode::AsrAuthFailed),
            (
                400,
                "The selected model does not support keyterms",
                AppErrorCode::AsrRequestInvalid,
            ),
            (400, "Provider returned 400", AppErrorCode::AsrServerError),
            (402, "Insufficient credits", AppErrorCode::AsrQuotaExhausted),
            (429, "Rate limited", AppErrorCode::AsrRateLimited),
            (504, "Gateway timeout", AppErrorCode::AsrTimeout),
            (529, "Overloaded", AppErrorCode::AsrServerError),
        ];
        for (status, message, code) in cases {
            let server = MockServer::start().await;
            transcription_mock(
                status,
                format!(r#"{{"error":{{"code":{status},"message":"{message}"}}}}"#),
            )
            .mount(&server)
            .await;
            let engine = OpenRouterEngine::new(test_config(&server.uri()));
            let (session, _rx) = engine.create_session(&[]).await.unwrap();
            session.append_audio(&[0.05]);
            let error = session.commit_and_await_final().await.unwrap_err();
            assert_eq!(error.code, code, "status {status}");
            assert!(
                error.detail.as_deref().is_some_and(|d| d.contains(message)),
                "status {status}"
            );
        }
    }

    #[tokio::test]
    async fn commit_without_audio_returns_empty_without_request() {
        let server = MockServer::start().await;
        transcription_mock(200, r#"{"text":"never"}"#.to_string())
            .expect(0)
            .mount(&server)
            .await;

        let engine = OpenRouterEngine::new(test_config(&server.uri()));
        let (session, _rx) = engine.create_session(&[]).await.unwrap();
        assert_eq!(session.commit_and_await_final().await.unwrap(), "");
    }

    #[tokio::test]
    async fn double_commit_is_rejected() {
        let engine = OpenRouterEngine::new(test_config("https://example.com"));
        let (session, _rx) = engine.create_session(&[]).await.unwrap();
        assert_eq!(session.commit_and_await_final().await.unwrap(), "");
        let error = session.commit_and_await_final().await.unwrap_err();
        assert_eq!(error.code, AppErrorCode::AsrSessionClosed);
    }

    #[tokio::test]
    async fn commit_after_close_is_rejected() {
        let engine = OpenRouterEngine::new(test_config("https://example.com"));
        let (session, _rx) = engine.create_session(&[]).await.unwrap();
        session.close();
        let error = session.commit_and_await_final().await.unwrap_err();
        assert_eq!(error.code, AppErrorCode::AsrSessionClosed);
    }

    #[tokio::test]
    async fn list_stt_models_queries_transcription_modality() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .and(query_param("output_modalities", "transcription"))
            .and(wiremock::matchers::header(
                "authorization",
                "Bearer test-key",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"data":[{"id":"openai/whisper-large-v3","name":"Whisper Large V3"}]}"#,
            ))
            .mount(&server)
            .await;

        let catalog = list_stt_models(&server.uri(), "test-key").await.unwrap();
        assert_eq!(catalog["data"][0]["id"], "openai/whisper-large-v3");
    }

    #[tokio::test]
    async fn list_stt_models_maps_http_failure() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;

        let error = list_stt_models(&server.uri(), "test-key")
            .await
            .unwrap_err();
        assert_eq!(error.code, AppErrorCode::AsrTestFailed);
    }
}

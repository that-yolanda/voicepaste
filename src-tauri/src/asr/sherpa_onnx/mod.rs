pub mod online;
pub mod offline;
pub mod punct;
pub mod qwen3_asr;
pub mod sense_voice;
pub mod funasr_nano;
pub mod simulated_streaming;
pub mod vad;

use async_trait::async_trait;
use std::path::PathBuf;
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use tokio::sync::mpsc;

use super::{AsrEngine, AsrEvent, AsrSession};
use self::punct::PunctuationProcessor;
use self::vad::{VadConfig, VadProcessor};
use crate::config::VadParams;
use crate::model;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

pub(crate) const SAMPLE_RATE: i32 = 16000;
const DEFAULT_STREAMING_CHUNK_SIZE: usize = 3200;
pub(crate) const AUDIO_QUEUE_CAPACITY: usize = 64;

// ---------------------------------------------------------------------------
// Shared JSON helpers
// ---------------------------------------------------------------------------

pub(crate) fn merged_model_config(
    base: Option<&serde_json::Value>,
    user: Option<&serde_json::Value>,
) -> serde_json::Value {
    let mut merged = base.cloned().unwrap_or_else(|| serde_json::json!({}));
    if let (Some(target), Some(source)) = (merged.as_object_mut(), user.and_then(|v| v.as_object()))
    {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
    merged
}

pub(crate) fn json_bool(config: &serde_json::Value, key: &str) -> Option<bool> {
    config.get(key).and_then(|v| v.as_bool())
}

pub(crate) fn json_f32(config: &serde_json::Value, key: &str) -> Option<f32> {
    config.get(key).and_then(|v| v.as_f64()).map(|v| v as f32)
}

pub(crate) fn json_u32(config: &serde_json::Value, key: &str) -> Option<u32> {
    config
        .get(key)
        .and_then(|v| v.as_u64())
        .and_then(|v| u32::try_from(v).ok())
}

pub(crate) fn json_i32(config: &serde_json::Value, key: &str) -> Option<i32> {
    config
        .get(key)
        .and_then(|v| v.as_i64())
        .and_then(|v| i32::try_from(v).ok())
}

pub(crate) fn json_usize(config: &serde_json::Value, key: &str) -> Option<usize> {
    config
        .get(key)
        .and_then(|v| v.as_u64())
        .and_then(|v| usize::try_from(v).ok())
}

pub(crate) fn json_string(config: &serde_json::Value, key: &str) -> Option<String> {
    config
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
}

// ---------------------------------------------------------------------------
// Shared worker types & helpers
// ---------------------------------------------------------------------------

pub(crate) enum WorkerCommand {
    Audio(Vec<f32>),
    Finish(std_mpsc::Sender<String>),
    Close,
}

pub(crate) fn append_text(accumulated: &mut String, text: &str) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    if !accumulated.is_empty() {
        accumulated.push(' ');
    }
    accumulated.push_str(text);
}

pub(crate) fn send_transcript(
    event_tx: &mpsc::UnboundedSender<AsrEvent>,
    final_text: String,
    partial_text: String,
) {
    let _ = event_tx.send(AsrEvent::Transcript {
        final_text,
        partial_text,
    });
}

// ---------------------------------------------------------------------------
// SherpaOnnxEngine
// ---------------------------------------------------------------------------

/// Sherpa-ONNX ASR engine for local models.
///
/// Single entry point that dispatches to the appropriate recognizer backend
/// based on `entry.capabilities.streaming` and `entry.architecture`.
pub struct SherpaOnnxEngine {
    data_dir: PathBuf,
    resource_dir: PathBuf,
    active_model_id: String,
    vad_params: VadParams,
    model_config: Option<serde_json::Value>,
    stream_simulate: bool,
}

impl SherpaOnnxEngine {
    pub fn new(
        data_dir: PathBuf,
        resource_dir: PathBuf,
        active_model_id: String,
        vad_params: VadParams,
        model_config: Option<serde_json::Value>,
        stream_simulate: bool,
    ) -> Self {
        Self {
            data_dir,
            resource_dir,
            active_model_id,
            vad_params,
            model_config,
            stream_simulate,
        }
    }

    /// Create a PunctuationProcessor if:
    /// 1. The ASR model does NOT have built-in punctuation
    /// 2. The punctuation model exists in the registry and is downloaded
    fn create_punctuation_processor(
        &self,
        registry: &model::ModelRegistry,
        asr_entry: &model::ModelEntry,
    ) -> Option<Arc<PunctuationProcessor>> {
        // Skip if the ASR model already has built-in punctuation
        if asr_entry.capabilities.punctuation {
            log_asr!(
                info,
                "ASR model '{}' has built-in punctuation, skipping external model",
                asr_entry.id
            );
            return None;
        }

        let punct_entry = match registry
            .models
            .iter()
            .find(|m| m.category == model::ModelCategory::Punctuation)
        {
            Some(e) => e,
            None => {
                log_asr!(info, "No punctuation model found in registry");
                return None;
            }
        };

        let model_dir = model::model_path(&self.data_dir, &punct_entry.id);
        if !model_dir.exists() {
            log_asr!(
                info,
                "Punctuation model not downloaded at {}, skipping",
                model_dir.display()
            );
            return None;
        }

        let num_threads = punct_entry
            .default_config
            .as_ref()
            .and_then(|c| json_u32(c, "num_threads"))
            .unwrap_or(2);

        match PunctuationProcessor::new(&model_dir, num_threads) {
            Ok(p) => {
                log_asr!(info, "Punctuation processor created for model '{}'", asr_entry.id);
                Some(Arc::new(p))
            }
            Err(e) => {
                log_asr!(warn, "Failed to create punctuation processor: {}", e);
                None
            }
        }
    }
}

#[async_trait]
impl AsrEngine for SherpaOnnxEngine {
    async fn create_session(
        &self,
        hotwords: &[String],
    ) -> Result<(Box<dyn AsrSession>, mpsc::UnboundedReceiver<AsrEvent>), String> {
        let model_dir = model::model_path(&self.data_dir, &self.active_model_id);
        if !model_dir.exists() {
            return Err(format!(
                "模型 {} 尚未下载，请先在设置中下载",
                self.active_model_id
            ));
        }

        // Load registry and find the model entry
        let registry = model::load_registry(&self.data_dir, &self.resource_dir);
        let entry = registry
            .models
            .iter()
            .find(|m| m.id == self.active_model_id)
            .ok_or_else(|| {
                format!(
                    "模型 {} 未在注册表 registry.json 中找到",
                    self.active_model_id
                )
            })?;

        // Build VAD config (all models use VAD)
        let vad_entry = registry.models.iter().find(|m| m.id == "silero-vad");
        let vad_base =
            VadConfig::from_registry(vad_entry.and_then(|e| e.default_config.as_ref()));
        let vad_config = VadConfig::merged(&vad_base, &self.vad_params);

        let model_config =
            merged_model_config(entry.default_config.as_ref(), self.model_config.as_ref());
        let asr_num_threads =
            json_u32(&model_config, "num_threads").unwrap_or(vad_config.num_threads);
        let streaming_chunk_size = json_usize(&model_config, "chunk_size")
            .unwrap_or(DEFAULT_STREAMING_CHUNK_SIZE)
            .max(1);

        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let _ = event_tx.send(AsrEvent::Open);

        // Create punctuation processor for ASR models without built-in punctuation
        let punct_processor = self.create_punctuation_processor(&registry, entry);

        if entry.capabilities.streaming {
            // ── Online (streaming transducer, e.g. Zipformer) ──
            let modeling_unit =
                json_string(&model_config, "modeling_unit").unwrap_or_default();

            let hotwords_buf = online::build_online_hotwords_buf(
                hotwords,
                &modeling_unit,
                &model_dir,
                entry,
            );

            if hotwords_buf.is_some() {
                log_asr!(
                    debug,
                    "Online session with hotwords_buf ({} entries)",
                    hotwords.iter().filter(|h| !h.trim().is_empty()).count()
                );
            } else if entry.capabilities.hotwords && !hotwords.is_empty() {
                log_asr!(warn, "All online hotwords were filtered as OOV");
            }

            let recognizer = online::build_online_recognizer(
                &model_dir,
                entry,
                asr_num_threads,
                &model_config,
                hotwords_buf,
            )?;

            let stream = recognizer.create_stream();

            // Create VAD for online model (filters silence/noise)
            let vad_dir = model::model_path(&self.data_dir, "silero-vad");
            let vad = VadProcessor::new(&vad_dir, &vad_config)?;

            let hotwords_for_restore = hotwords.to_vec();
            let (session, _worker_tx) = online::spawn_online_worker(
                recognizer,
                stream,
                vad,
                streaming_chunk_size,
                hotwords_for_restore,
                event_tx,
                punct_processor,
            )?;

            Ok((Box::new(session), event_rx))
        } else if self.stream_simulate {
            // ── Simulated streaming (offline model with interim decoding) ──
            let arch = entry.architecture.as_deref().unwrap_or("");

            let recognizer = match arch {
                "sense_voice" => sense_voice::build_sense_voice_recognizer(
                    &model_dir,
                    entry,
                    asr_num_threads,
                    &model_config,
                )?,
                "funasr_nano" => funasr_nano::build_funasr_nano_recognizer(
                    &model_dir,
                    entry,
                    asr_num_threads,
                    &model_config,
                    None, // hotwords are injected via model config in the builder
                )?,
                "qwen3_asr" => {
                    let hotwords_str = if entry.capabilities.hotwords && !hotwords.is_empty() {
                        funasr_nano::build_funasr_hotwords(hotwords)
                    } else {
                        None
                    };
                    qwen3_asr::build_qwen3_asr_recognizer(
                        &model_dir,
                        entry,
                        asr_num_threads,
                        &model_config,
                        hotwords_str.as_deref(),
                    )?
                }
                other => {
                    return Err(format!(
                        "非流式模型 {} 的 architecture '{}' 不支持",
                        entry.id, other
                    ));
                }
            };

            // Create VAD for simulated streaming
            let vad_dir = model::model_path(&self.data_dir, "silero-vad");
            let vad = VadProcessor::new(&vad_dir, &vad_config)?;

            let (session, _worker_tx) = simulated_streaming::spawn_simulated_streaming_worker(
                recognizer,
                vad,
                event_tx,
                punct_processor,
            )?;

            Ok((Box::new(session), event_rx))
        } else {
            // ── Offline (SenseVoice / FunASR-Nano) ──
            let arch = entry.architecture.as_deref().unwrap_or("");

            let funasr_hotwords = if (arch == "funasr_nano" || arch == "qwen3_asr")
                && entry.capabilities.hotwords
                && !hotwords.is_empty()
            {
                funasr_nano::build_funasr_hotwords(hotwords)
            } else {
                None
            };

            let recognizer = match arch {
                "sense_voice" => sense_voice::build_sense_voice_recognizer(
                    &model_dir,
                    entry,
                    asr_num_threads,
                    &model_config,
                )?,
                "funasr_nano" => funasr_nano::build_funasr_nano_recognizer(
                    &model_dir,
                    entry,
                    asr_num_threads,
                    &model_config,
                    funasr_hotwords.as_deref(),
                )?,
                "qwen3_asr" => qwen3_asr::build_qwen3_asr_recognizer(
                    &model_dir,
                    entry,
                    asr_num_threads,
                    &model_config,
                    funasr_hotwords.as_deref(),
                )?,
                other => {
                    return Err(format!(
                        "非流式模型 {} 的 architecture '{}' 不支持",
                        entry.id, other
                    ));
                }
            };

            // Offline models: hotwords handled in model config (FunASR-Nano, Qwen3 ASR)
            // or not supported (SenseVoice). Stream-level hotword injection
            // is disabled for both.
            let use_hotwords = false;
            let hotwords_str = String::new();

            // Create VAD for offline model (segments speech)
            let vad_dir = model::model_path(&self.data_dir, "silero-vad");
            let vad = VadProcessor::new(&vad_dir, &vad_config)?;

            let (session, _worker_tx) = offline::spawn_offline_worker(
                recognizer,
                vad,
                use_hotwords,
                hotwords_str,
                event_tx,
                punct_processor,
            )?;

            Ok((Box::new(session), event_rx))
        }
    }
}

// ---------------------------------------------------------------------------
// Tests for shared utilities
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_text_joins_with_space() {
        let mut acc = String::new();
        append_text(&mut acc, "hello");
        assert_eq!(acc, "hello");
        append_text(&mut acc, "world");
        assert_eq!(acc, "hello world");
    }

    #[test]
    fn append_text_skips_empty() {
        let mut acc = String::new();
        append_text(&mut acc, "");
        assert!(acc.is_empty());
        append_text(&mut acc, "   ");
        assert!(acc.is_empty());
    }

    #[test]
    fn merged_model_config_user_overrides_base() {
        let base = serde_json::json!({"a": 1, "b": 2});
        let user = serde_json::json!({"b": 42, "c": 3});
        let merged = merged_model_config(Some(&base), Some(&user));
        assert_eq!(merged["a"], 1);
        assert_eq!(merged["b"], 42);
        assert_eq!(merged["c"], 3);
    }

    #[test]
    fn merged_model_config_no_user() {
        let base = serde_json::json!({"a": 1});
        let merged = merged_model_config(Some(&base), None);
        assert_eq!(merged["a"], 1);
    }

    #[test]
    fn json_helpers_basic() {
        let cfg = serde_json::json!({
            "bool_true": true,
            "bool_false": false,
            "f32_val": 1.5,
            "u32_val": 42,
            "i32_val": -10,
            "usize_val": 100,
            "str_val": "hello",
            "empty_str": "",
            "whitespace_str": "   ",
        });

        assert_eq!(json_bool(&cfg, "bool_true"), Some(true));
        assert_eq!(json_bool(&cfg, "bool_false"), Some(false));
        assert_eq!(json_bool(&cfg, "missing"), None);
        assert!((json_f32(&cfg, "f32_val").unwrap() - 1.5).abs() < f32::EPSILON);
        assert_eq!(json_u32(&cfg, "u32_val"), Some(42));
        assert_eq!(json_i32(&cfg, "i32_val"), Some(-10));
        assert_eq!(json_usize(&cfg, "usize_val"), Some(100));
        assert_eq!(json_string(&cfg, "str_val").as_deref(), Some("hello"));
        assert_eq!(json_string(&cfg, "empty_str"), None);
        assert_eq!(json_string(&cfg, "whitespace_str"), None);
    }
}

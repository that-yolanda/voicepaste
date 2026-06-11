use async_trait::async_trait;
use sherpa_onnx::{
    OfflineRecognizer, OfflineRecognizerConfig, OfflineSenseVoiceModelConfig,
    OnlineRecognizer, OnlineRecognizerConfig,
};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

use super::{AsrEngine, AsrEvent, AsrSession};
use crate::asr::vad::{VadConfig, VadProcessor};
use crate::config::VadParams;
use crate::model::{self, ModelEntry};

/// Wraps both offline and online sherpa-onnx recognizers.
enum RecognizerBackend {
    Offline(OfflineRecognizer),
    Online(OnlineRecognizer),
}

/// Sherpa-ONNX ASR engine for local models.
pub struct SherpaOnnxEngine {
    data_dir: PathBuf,
    resource_dir: PathBuf,
    active_model_id: String,
    vad_params: VadParams,
}

impl SherpaOnnxEngine {
    pub fn new(
        data_dir: PathBuf,
        resource_dir: PathBuf,
        active_model_id: String,
        vad_params: VadParams,
    ) -> Self {
        Self {
            data_dir,
            resource_dir,
            active_model_id,
            vad_params,
        }
    }

    /// Build a recognizer from a registry ModelEntry.
    /// Uses `capabilities.streaming` to decide offline vs online recognizer:
    ///   streaming=false → OfflineRecognizer (SenseVoice)
    ///   streaming=true  → OnlineRecognizer  (Zipformer transducer)
    fn build_recognizer(
        model_dir: &Path,
        entry: &ModelEntry,
        num_threads: u32,
    ) -> Result<(RecognizerBackend, bool), String> {
        let p = |key: &str| -> Option<String> {
            let filename = entry.model_files.get(key)?;
            let path = model_dir.join(filename);
            if !path.exists() {
                return None;
            }
            path.to_str().map(|s| s.to_string())
        };

        let supports_hotwords = entry.capabilities.hotwords;
        let arch = entry.architecture.as_deref().unwrap_or("");
        let streaming = entry.capabilities.streaming;

        if streaming {
            // ── Online recognizer (streaming transducer, e.g. Zipformer) ──
            let mut config = OnlineRecognizerConfig::default();
            config.model_config.transducer.encoder = p("encoder");
            config.model_config.transducer.decoder = p("decoder");
            config.model_config.transducer.joiner = p("joiner");
            config.model_config.tokens = p("tokens");
            config.model_config.num_threads = num_threads as i32;
            config.model_config.debug = cfg!(debug_assertions);
            config.model_config.model_type = Some(arch.to_string());
            config.enable_endpoint = true;
            config.decoding_method = Some("greedy_search".to_string());

            let recognizer = OnlineRecognizer::create(&config)
                .ok_or_else(|| format!("创建在线识别器失败 (model: {})", entry.id))?;

            Ok((RecognizerBackend::Online(recognizer), supports_hotwords))
        } else {
            // ── Offline recognizer (non-streaming, e.g. SenseVoice) ──
            let mut config = OfflineRecognizerConfig::default();
            config.model_config.num_threads = num_threads as i32;
            config.model_config.debug = cfg!(debug_assertions);

            match arch {
                "sense_voice" => {
                    let model = p("model")
                        .ok_or_else(|| format!("模型 {} 缺少 model 文件", entry.id))?;
                    config.model_config.sense_voice = OfflineSenseVoiceModelConfig {
                        model: Some(model),
                        use_itn: entry
                            .default_config
                            .as_ref()
                            .and_then(|c| c.get("use_itn"))
                            .and_then(|v| v.as_bool())
                            .unwrap_or(true),
                        ..Default::default()
                    };
                    config.model_config.tokens = p("tokens");
                    config.model_config.model_type = Some(arch.to_string());
                }
                other => {
                    return Err(format!(
                        "非流式模型 {} 的 architecture '{}' 不支持",
                        entry.id, other
                    ));
                }
            }

            let recognizer = OfflineRecognizer::create(&config)
                .ok_or_else(|| format!("创建离线识别器失败 (model: {})", entry.id))?;

            Ok((RecognizerBackend::Offline(recognizer), supports_hotwords))
        }
    }
}

/// Process a segment with an OfflineRecognizer.
fn decode_offline_segment(
    recognizer: &OfflineRecognizer,
    samples: &[f32],
    use_hotwords: bool,
    hotwords_str: &str,
) -> Option<String> {
    let stream = if use_hotwords {
        recognizer.create_stream_with_hotwords(hotwords_str)
    } else {
        recognizer.create_stream()
    };
    stream.accept_waveform(16000, samples);
    recognizer.decode(&stream);
    stream
        .get_result()
        .map(|r| r.text.trim().to_string())
        .filter(|t| !t.is_empty())
}

/// Process a segment with an OnlineRecognizer.
///
/// Streaming transducer models (Zipformer) expect audio in small incremental
/// chunks, followed by tail padding (silence) to flush the decoder state.
/// This mirrors the official sherpa-onnx streaming examples.
fn decode_online_segment(
    recognizer: &OnlineRecognizer,
    samples: &[f32],
) -> Option<String> {
    const CHUNK_SIZE: usize = 3200; // 200ms at 16kHz — matches sherpa-onnx examples

    let stream = recognizer.create_stream();

    // Feed audio in fixed-size chunks so the streaming transducer can build
    // internal state incrementally.
    for chunk in samples.chunks(CHUNK_SIZE) {
        stream.accept_waveform(16000, chunk);
        while recognizer.is_ready(&stream) {
            recognizer.decode(&stream);
        }
    }

    // Tail padding: ~0.3s of silence flushes remaining decoder state.
    // Without this padding the model may not produce output for short segments.
    let tail: Vec<f32> = vec![0.0; (0.3 * 16000.0) as usize];
    stream.accept_waveform(16000, &tail);
    stream.input_finished();

    // Final decode — drain the decoder after signalling end-of-stream.
    while recognizer.is_ready(&stream) {
        recognizer.decode(&stream);
    }

    recognizer
        .get_result(&stream)
        .map(|r| r.text.trim().to_string())
        .filter(|t| !t.is_empty())
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
        let registry = model::load_registry(&self.resource_dir);
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

        // Build recognizer based on capabilities.streaming
        let vad_entry = registry.models.iter().find(|m| m.id == "silero-vad");
        let vad_base = VadConfig::from_registry(vad_entry.and_then(|e| e.default_config.as_ref()));
        let vad_config = VadConfig::merged(&vad_base, &self.vad_params);

        let (recognizer, supports_hotwords) = Self::build_recognizer(
            &model_dir,
            entry,
            vad_config.num_threads,
        )?;

        // For transducer models with hotwords support, pre-load tokens.txt to
        // validate hotwords.  sherpa-onnx throws an uncatchable C++ exception
        // when hotwords contain tokens not in the model's vocabulary.
        let valid_tokens: Option<Arc<HashSet<String>>> = if supports_hotwords {
            let tokens_path = entry
                .model_files
                .get("tokens")
                .map(|f| model_dir.join(f));
            let tokens = tokens_path
                .filter(|p| p.exists())
                .and_then(|p| fs::read_to_string(p).ok())
                .map(|content| {
                    content
                        .lines()
                        .map(|line| line.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect::<HashSet<_>>()
                });
            tokens.map(Arc::new)
        } else {
            None
        };

        // Build VAD
        let vad_dir = model::model_path(&self.data_dir, "silero-vad");
        let vad = VadProcessor::new(&vad_dir, &vad_config)?;

        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let _ = event_tx.send(AsrEvent::Open);

        let session = SherpaOnnxSession {
            is_ready: Arc::new(AtomicBool::new(true)),
            is_committed: Arc::new(AtomicBool::new(false)),
            recognizer: Arc::new(Mutex::new(Some(recognizer))),
            vad: Arc::new(Mutex::new(Some(vad))),
            accumulated_text: Arc::new(Mutex::new(String::new())),
            hotwords: hotwords.to_vec(),
            supports_hotwords,
            valid_tokens,
            event_tx: Arc::new(Mutex::new(event_tx)),
        };

        Ok((Box::new(session), event_rx))
    }
}

// ---------------------------------------------------------------------------
// SherpaOnnxSession
// ---------------------------------------------------------------------------

/// Sherpa-ONNX ASR session using VAD + recognizer (offline or online).
/// All shared state uses std::sync::Mutex for access from blocking threads.
struct SherpaOnnxSession {
    is_ready: Arc<AtomicBool>,
    is_committed: Arc<AtomicBool>,
    recognizer: Arc<Mutex<Option<RecognizerBackend>>>,
    vad: Arc<Mutex<Option<VadProcessor>>>,
    accumulated_text: Arc<Mutex<String>>,
    hotwords: Vec<String>,
    supports_hotwords: bool,
    valid_tokens: Option<Arc<HashSet<String>>>,
    /// Sends AsrEvent::Transcript to the overlay when new text is decoded.
    event_tx: Arc<Mutex<mpsc::UnboundedSender<AsrEvent>>>,
}

#[async_trait]
impl AsrSession for SherpaOnnxSession {
    fn is_ready(&self) -> bool {
        self.is_ready.load(Ordering::SeqCst)
    }

    fn append_audio(&self, samples: &[f32]) {
        if !self.is_ready() || self.is_committed.load(Ordering::SeqCst) {
            return;
        }

        let vad = self.vad.clone();
        let recognizer = self.recognizer.clone();
        let accumulated = self.accumulated_text.clone();
        let hotwords = self.hotwords.clone();
        let supports_hotwords = self.supports_hotwords;
        let valid_tokens = self.valid_tokens.clone();
        let event_tx = self.event_tx.clone();
        let samples = samples.to_vec();

        std::thread::spawn(move || {
            let mut vad_guard = match vad.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            let vad_proc = match vad_guard.as_mut() {
                Some(v) => v,
                None => return,
            };

            let segments = vad_proc.accept_waveform(&samples);
            if segments.is_empty() {
                return;
            }

            let filtered = filter_valid_hotwords(&hotwords, valid_tokens.as_deref());
            let use_hotwords = supports_hotwords && !filtered.is_empty();
            let hotwords_str = if use_hotwords {
                filtered.join("\n")
            } else {
                String::new()
            };

            let mut rec_guard = match recognizer.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            let rec = match rec_guard.as_mut() {
                Some(r) => r,
                None => return,
            };

            for segment_samples in segments {
                let duration = segment_samples.len() as f32 / 16000.0;
                if duration < 0.1 {
                    continue;
                }

                let text = match rec {
                    RecognizerBackend::Offline(r) => {
                        decode_offline_segment(r, &segment_samples, use_hotwords, &hotwords_str)
                    }
                    RecognizerBackend::Online(r) => {
                        decode_online_segment(r, &segment_samples)
                    }
                };

                if let Some(text) = text {
                    if let Ok(mut acc) = accumulated.lock() {
                        if !acc.is_empty() {
                            acc.push(' ');
                        }
                        acc.push_str(&text);
                        // Emit transcript event so the overlay shows partial
                        // results in real-time (especially for streaming models).
                        let current = acc.clone();
                        drop(acc);
                        if let Ok(tx) = event_tx.lock() {
                            let _ = tx.send(AsrEvent::Transcript {
                                final_text: current,
                                partial_text: String::new(),
                            });
                        }
                    }
                }
            }
        });
    }

    async fn commit_and_await_final(&self) -> Result<String, String> {
        if !self.is_ready() {
            return Err("ASR 会话已关闭".to_string());
        }
        if self.is_committed.load(Ordering::SeqCst) {
            return Err("录音已结束".to_string());
        }
        self.is_committed.store(true, Ordering::SeqCst);

        let vad = self.vad.clone();
        let recognizer = self.recognizer.clone();
        let accumulated = self.accumulated_text.clone();
        let hotwords = self.hotwords.clone();
        let supports_hotwords = self.supports_hotwords;
        let valid_tokens = self.valid_tokens.clone();

        let final_text = tokio::task::spawn_blocking(move || {
            // Flush remaining audio through VAD
            let mut vad_guard = match vad.lock() {
                Ok(g) => g,
                Err(_) => return accumulated.lock().map(|a| a.clone()).unwrap_or_default(),
            };
            let vad_proc = match vad_guard.as_mut() {
                Some(v) => v,
                None => return accumulated.lock().map(|a| a.clone()).unwrap_or_default(),
            };

            let segments = vad_proc.flush();
            if segments.is_empty() {
                return accumulated.lock().map(|a| a.clone()).unwrap_or_default();
            }

            let filtered = filter_valid_hotwords(&hotwords, valid_tokens.as_deref());
            let use_hotwords = supports_hotwords && !filtered.is_empty();
            let hotwords_str = if use_hotwords {
                filtered.join("\n")
            } else {
                String::new()
            };

            let mut rec_guard = match recognizer.lock() {
                Ok(g) => g,
                Err(_) => return accumulated.lock().map(|a| a.clone()).unwrap_or_default(),
            };
            let rec = match rec_guard.as_mut() {
                Some(r) => r,
                None => return accumulated.lock().map(|a| a.clone()).unwrap_or_default(),
            };

            let mut new_text = String::new();
            for segment_samples in segments {
                let duration = segment_samples.len() as f32 / 16000.0;
                if duration < 0.1 {
                    continue;
                }

                let text = match rec {
                    RecognizerBackend::Offline(r) => {
                        decode_offline_segment(r, &segment_samples, use_hotwords, &hotwords_str)
                    }
                    RecognizerBackend::Online(r) => {
                        decode_online_segment(r, &segment_samples)
                    }
                };

                if let Some(text) = text {
                    if !new_text.is_empty() {
                        new_text.push(' ');
                    }
                    new_text.push_str(&text);
                }
            }

            // Append new text to accumulated
            if let Ok(mut acc) = accumulated.lock() {
                if !new_text.is_empty() {
                    if !acc.is_empty() {
                        acc.push(' ');
                    }
                    acc.push_str(&new_text);
                }
                acc.clone()
            } else {
                new_text
            }
        })
        .await
        .unwrap_or_else(|e| format!("识别失败: {}", e));

        Ok(final_text)
    }

    fn close(&self) {
        self.is_ready.store(false, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------------
// Hotword vocabulary validation
// ---------------------------------------------------------------------------

/// Filter hotwords to only include those whose space-separated words are all
/// present in the model's tokens.txt vocabulary.
///
/// sherpa-onnx transducer models throw an uncatchable C++ exception when
/// hotwords contain out-of-vocabulary tokens, so we pre-validate them here.
fn filter_valid_hotwords(hotwords: &[String], tokens: Option<&HashSet<String>>) -> Vec<String> {
    let Some(vocab) = tokens else {
        return hotwords.to_vec();
    };

    hotwords
        .iter()
        .filter(|hw| {
            let valid = hw
                .split_whitespace()
                .all(|word| vocab.contains(word));
            if !valid {
                log_asr!(debug, "Skipping hotword (OOV): {:?}", hw);
            }
            valid
        })
        .cloned()
        .collect()
}

use async_trait::async_trait;
use sherpa_onnx::{
    OfflineFunASRNanoModelConfig, OfflineRecognizer, OfflineRecognizerConfig,
    OfflineSenseVoiceModelConfig, OnlineRecognizer, OnlineRecognizerConfig, OnlineStream,
};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
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

const SAMPLE_RATE: i32 = 16000;
const DEFAULT_STREAMING_CHUNK_SIZE: usize = 3200;
const AUDIO_QUEUE_CAPACITY: usize = 64;

fn merged_model_config(
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

fn json_bool(config: &serde_json::Value, key: &str) -> Option<bool> {
    config.get(key).and_then(|v| v.as_bool())
}

fn json_f32(config: &serde_json::Value, key: &str) -> Option<f32> {
    config.get(key).and_then(|v| v.as_f64()).map(|v| v as f32)
}

fn json_u32(config: &serde_json::Value, key: &str) -> Option<u32> {
    config
        .get(key)
        .and_then(|v| v.as_u64())
        .and_then(|v| u32::try_from(v).ok())
}

fn json_i32(config: &serde_json::Value, key: &str) -> Option<i32> {
    config
        .get(key)
        .and_then(|v| v.as_i64())
        .and_then(|v| i32::try_from(v).ok())
}

fn json_usize(config: &serde_json::Value, key: &str) -> Option<usize> {
    config
        .get(key)
        .and_then(|v| v.as_u64())
        .and_then(|v| usize::try_from(v).ok())
}

fn json_string(config: &serde_json::Value, key: &str) -> Option<String> {
    config
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
}

/// Sherpa-ONNX ASR engine for local models.
pub struct SherpaOnnxEngine {
    data_dir: PathBuf,
    resource_dir: PathBuf,
    active_model_id: String,
    hotword_group_id: String,
    vad_params: VadParams,
    model_config: Option<serde_json::Value>,
}

impl SherpaOnnxEngine {
    pub fn new(
        data_dir: PathBuf,
        resource_dir: PathBuf,
        active_model_id: String,
        hotword_group_id: String,
        vad_params: VadParams,
        model_config: Option<serde_json::Value>,
    ) -> Self {
        Self {
            data_dir,
            resource_dir,
            active_model_id,
            hotword_group_id,
            vad_params,
            model_config,
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
        model_config: &serde_json::Value,
        hotwords_file: Option<&str>,
        funasr_hotwords: Option<&str>,
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
            config.enable_endpoint = json_bool(&model_config, "enable_endpoint").unwrap_or(true);
            config.rule1_min_trailing_silence =
                json_f32(&model_config, "rule1_min_trailing_silence").unwrap_or(0.0);
            config.rule2_min_trailing_silence =
                json_f32(&model_config, "rule2_min_trailing_silence").unwrap_or(0.0);
            config.rule3_min_utterance_length =
                json_f32(&model_config, "rule3_min_utterance_length").unwrap_or(0.0);
            if let Some(file_path) = hotwords_file {
                config.decoding_method = Some("modified_beam_search".to_string());
                config.max_active_paths =
                    json_u32(&model_config, "max_active_paths").unwrap_or(4) as i32;
                config.hotwords_score = json_f32(&model_config, "hotwords_score").unwrap_or(2.0);
                config.hotwords_file = Some(file_path.to_string());

                // Set modeling unit (required for hotwords tokenization)
                config.model_config.modeling_unit =
                    json_string(&model_config, "modeling_unit");

                // Set bpe_vocab for bpe or cjkchar+bpe models
                let bpe_vocab_path = model_dir.join("bpe.vocab");
                if bpe_vocab_path.exists() {
                    config.model_config.bpe_vocab =
                        bpe_vocab_path.to_str().map(|s| s.to_string());
                }
            } else {
                config.decoding_method = Some("greedy_search".to_string());
            }

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
                    let model =
                        p("model").ok_or_else(|| format!("模型 {} 缺少 model 文件", entry.id))?;
                    config.model_config.sense_voice = OfflineSenseVoiceModelConfig {
                        model: Some(model),
                        language: json_string(&model_config, "language"),
                        use_itn: json_bool(&model_config, "use_itn").unwrap_or(true),
                    };
                    config.model_config.tokens = p("tokens");
                    config.model_config.model_type = Some(arch.to_string());
                }
                "funasr_nano" => {
                    let encoder_adaptor = p("encoder_adaptor")
                        .ok_or_else(|| format!("模型 {} 缺少 encoder_adaptor 文件", entry.id))?;
                    let llm = p("llm")
                        .ok_or_else(|| format!("模型 {} 缺少 llm 文件", entry.id))?;
                    let embedding = p("embedding")
                        .ok_or_else(|| format!("模型 {} 缺少 embedding 文件", entry.id))?;
                    let tokenizer = p("tokenizer")
                        .ok_or_else(|| format!("模型 {} 缺少 tokenizer 文件", entry.id))?;
                    config.model_config.funasr_nano = OfflineFunASRNanoModelConfig {
                        encoder_adaptor: Some(encoder_adaptor),
                        llm: Some(llm),
                        embedding: Some(embedding),
                        tokenizer: Some(tokenizer),
                        system_prompt: json_string(&model_config, "system_prompt"),
                        user_prompt: json_string(&model_config, "user_prompt"),
                        max_new_tokens: json_i32(&model_config, "max_new_tokens").unwrap_or(512),
                        temperature: json_f32(&model_config, "temperature").unwrap_or(1e-6),
                        top_p: json_f32(&model_config, "top_p").unwrap_or(0.8),
                        seed: json_i32(&model_config, "seed").unwrap_or(42),
                        language: json_string(&model_config, "language"),
                        itn: if json_bool(&model_config, "itn").unwrap_or(true) { 1 } else { 0 },
                        hotwords: funasr_hotwords.map(|s| s.to_string()),
                    };
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

enum WorkerCommand {
    Audio(Vec<f32>),
    Finish(std_mpsc::Sender<String>),
    Close,
}

fn append_text(accumulated: &mut String, text: &str) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    if !accumulated.is_empty() {
        accumulated.push(' ');
    }
    accumulated.push_str(text);
}

fn final_text_for_partial(finalized: &str) -> String {
    if finalized.is_empty() {
        String::new()
    } else {
        format!("{} ", finalized)
    }
}

fn send_transcript(
    event_tx: &mpsc::UnboundedSender<AsrEvent>,
    final_text: String,
    partial_text: String,
) {
    let _ = event_tx.send(AsrEvent::Transcript {
        final_text,
        partial_text,
    });
}

fn process_offline_segments(
    recognizer: &OfflineRecognizer,
    segments: Vec<Vec<f32>>,
    use_hotwords: bool,
    hotwords_str: &str,
    accumulated: &mut String,
    event_tx: &mpsc::UnboundedSender<AsrEvent>,
) {
    for segment_samples in segments {
        let duration = segment_samples.len() as f32 / SAMPLE_RATE as f32;
        if duration < 0.1 {
            continue;
        }

        if let Some(text) =
            decode_offline_segment(recognizer, &segment_samples, use_hotwords, hotwords_str)
        {
            append_text(accumulated, &text);
            send_transcript(event_tx, accumulated.clone(), String::new());
        }
    }
}

fn run_offline_worker(
    recognizer: OfflineRecognizer,
    mut vad: VadProcessor,
    use_hotwords: bool,
    hotwords_str: String,
    event_tx: mpsc::UnboundedSender<AsrEvent>,
    rx: std_mpsc::Receiver<WorkerCommand>,
) {
    let mut accumulated = String::new();

    while let Ok(command) = rx.recv() {
        match command {
            WorkerCommand::Audio(samples) => {
                let segments = vad.accept_waveform(&samples);
                process_offline_segments(
                    &recognizer,
                    segments,
                    use_hotwords,
                    &hotwords_str,
                    &mut accumulated,
                    &event_tx,
                );
            }
            WorkerCommand::Finish(reply_tx) => {
                let segments = vad.flush();
                process_offline_segments(
                    &recognizer,
                    segments,
                    use_hotwords,
                    &hotwords_str,
                    &mut accumulated,
                    &event_tx,
                );
                let _ = reply_tx.send(accumulated.clone());
                break;
            }
            WorkerCommand::Close => break,
        }
    }
}

fn decode_online_ready(
    recognizer: &OnlineRecognizer,
    stream: &OnlineStream,
    finalized: &mut String,
    last_partial: &mut String,
    event_tx: &mpsc::UnboundedSender<AsrEvent>,
) {
    while recognizer.is_ready(stream) {
        recognizer.decode(stream);

        if let Some(result) = recognizer.get_result(stream) {
            let text = result.text.trim().to_string();
            if !text.is_empty() && text != *last_partial {
                *last_partial = text.clone();
                send_transcript(event_tx, final_text_for_partial(finalized), text);
            }
        }

        if recognizer.is_endpoint(stream) {
            if let Some(result) = recognizer.get_result(stream) {
                let text = result.text.trim();
                if !text.is_empty() {
                    append_text(finalized, text);
                    send_transcript(event_tx, finalized.clone(), String::new());
                }
            }
            last_partial.clear();
            recognizer.reset(stream);
        }
    }
}

fn accept_online_samples(
    recognizer: &OnlineRecognizer,
    stream: &OnlineStream,
    buffer: &mut Vec<f32>,
    samples: &[f32],
    chunk_size: usize,
    finalized: &mut String,
    last_partial: &mut String,
    event_tx: &mpsc::UnboundedSender<AsrEvent>,
) {
    buffer.extend_from_slice(samples);

    while buffer.len() >= chunk_size {
        let chunk: Vec<f32> = buffer.drain(..chunk_size).collect();
        stream.accept_waveform(SAMPLE_RATE, &chunk);
        decode_online_ready(recognizer, stream, finalized, last_partial, event_tx);
    }
}

fn finish_online_stream(
    recognizer: &OnlineRecognizer,
    stream: &OnlineStream,
    buffer: &mut Vec<f32>,
    finalized: &mut String,
    last_partial: &mut String,
    event_tx: &mpsc::UnboundedSender<AsrEvent>,
) {
    if !buffer.is_empty() {
        stream.accept_waveform(SAMPLE_RATE, buffer.as_slice());
        buffer.clear();
        decode_online_ready(recognizer, stream, finalized, last_partial, event_tx);
    }

    let tail: Vec<f32> = vec![0.0; (0.3 * SAMPLE_RATE as f32) as usize];
    stream.accept_waveform(SAMPLE_RATE, &tail);
    stream.input_finished();

    decode_online_ready(recognizer, stream, finalized, last_partial, event_tx);

    if let Some(result) = recognizer.get_result(stream) {
        let text = result.text.trim();
        if !text.is_empty() {
            append_text(finalized, text);
        }
    }
    last_partial.clear();
    send_transcript(event_tx, finalized.clone(), String::new());
}

fn run_online_worker(
    recognizer: OnlineRecognizer,
    stream: OnlineStream,
    chunk_size: usize,
    event_tx: mpsc::UnboundedSender<AsrEvent>,
    rx: std_mpsc::Receiver<WorkerCommand>,
) {
    let mut finalized = String::new();
    let mut last_partial = String::new();
    let mut buffer = Vec::with_capacity(chunk_size * 2);

    while let Ok(command) = rx.recv() {
        match command {
            WorkerCommand::Audio(samples) => {
                accept_online_samples(
                    &recognizer,
                    &stream,
                    &mut buffer,
                    &samples,
                    chunk_size,
                    &mut finalized,
                    &mut last_partial,
                    &event_tx,
                );
            }
            WorkerCommand::Finish(reply_tx) => {
                finish_online_stream(
                    &recognizer,
                    &stream,
                    &mut buffer,
                    &mut finalized,
                    &mut last_partial,
                    &event_tx,
                );
                let _ = reply_tx.send(finalized.clone());
                break;
            }
            WorkerCommand::Close => break,
        }
    }
}

fn spawn_worker(
    recognizer: RecognizerBackend,
    vad: Option<VadProcessor>,
    use_hotwords: bool,
    hotwords_str: String,
    streaming_chunk_size: usize,
    event_tx: mpsc::UnboundedSender<AsrEvent>,
    rx: std_mpsc::Receiver<WorkerCommand>,
) -> Result<JoinHandle<()>, String> {
    thread::Builder::new()
        .name("sherpa-onnx-asr".to_string())
        .spawn(move || match recognizer {
            RecognizerBackend::Offline(recognizer) => {
                let Some(vad) = vad else {
                    let _ = event_tx.send(AsrEvent::Error("本地离线识别缺少 VAD".to_string()));
                    return;
                };
                run_offline_worker(recognizer, vad, use_hotwords, hotwords_str, event_tx, rx);
            }
            RecognizerBackend::Online(recognizer) => {
                let stream = recognizer.create_stream();
                run_online_worker(recognizer, stream, streaming_chunk_size, event_tx, rx);
            }
        })
        .map_err(|e| format!("启动本地识别线程失败: {}", e))
}

/// Build a comma-separated hotwords string for FunASR-Nano models.
///
/// The model takes hotwords directly in its config as `"word1,word2,…"` — no
/// file, no scores, no token validation needed.  This function extracts the
/// raw word from each hotword entry (stripping optional `|weight` suffixes)
/// and joins them with commas.
///
/// Returns `None` when the input list is empty.
pub(crate) fn build_funasr_hotwords(hotwords: &[String]) -> Option<String> {
    if hotwords.is_empty() {
        return None;
    }
    let words: Vec<String> = hotwords
        .iter()
        .map(|hw| {
            let (word, _) = crate::hotword::parse_hotword_entry(hw);
            word.to_string()
        })
        .collect();
    Some(words.join(","))
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

        // Build recognizer based on capabilities.streaming
        let vad_entry = registry.models.iter().find(|m| m.id == "silero-vad");
        let vad_base = VadConfig::from_registry(vad_entry.and_then(|e| e.default_config.as_ref()));
        let vad_config = VadConfig::merged(&vad_base, &self.vad_params);
        let model_config =
            merged_model_config(entry.default_config.as_ref(), self.model_config.as_ref());
        let asr_num_threads =
            json_u32(&model_config, "num_threads").unwrap_or(vad_config.num_threads);
        let streaming_chunk_size = json_usize(&model_config, "chunk_size")
            .unwrap_or(DEFAULT_STREAMING_CHUNK_SIZE)
            .max(1);

        // For pure cjkchar transducer models, pre-load tokens.txt to validate
        // hotwords at the character level.  sherpa-onnx throws an uncatchable C++
        // exception when hotwords contain out-of-vocabulary characters.
        //
        // For bpe or cjkchar+bpe models, we skip this pre-validation because:
        //   1. English words are tokenized by the bpe vocabulary into subword
        //      units, so word-level matching against tokens.txt is meaningless.
        //   2. sherpa-onnx handles OOV safely for bpe-based tokenization.
        let modeling_unit =
            json_string(&model_config, "modeling_unit").unwrap_or_default();
        let is_cjkchar_only = modeling_unit == "cjkchar";

        let valid_tokens: Option<Arc<HashSet<String>>> = if entry.capabilities.hotwords
            && is_cjkchar_only
        {
            let tokens_path = entry.model_files.get("tokens").map(|f| model_dir.join(f));
            let tokens = tokens_path
                .filter(|p| p.exists())
                .and_then(|p| fs::read_to_string(p).ok())
                .map(|content| {
                    content
                        .lines()
                        .filter_map(parse_token_line)
                        .collect::<HashSet<_>>()
                });
            tokens.map(Arc::new)
        } else {
            None
        };

        // Only apply character-level OOV filtering for pure cjkchar models.
        // For bpe / cjkchar+bpe models, pass hotwords through as-is.
        let mut filtered_hotwords = if is_cjkchar_only {
            filter_valid_hotwords(hotwords, valid_tokens.as_deref())
        } else {
            hotwords.to_vec()
        };

        // For bpe-based models, additionally filter hotwords that contain
        // ASCII characters not supported by the bpe vocabulary (e.g. `.`
        // in "AGENTS.md").  Such characters cause sherpa-onnx to emit
        // "Cannot find ID for token" errors during InitHotwords.
        if modeling_unit.contains("bpe") {
            let bpe_vocab_path = model_dir.join("bpe.vocab");
            let bpe_chars = bpe_char_set(&bpe_vocab_path);
            if !bpe_chars.is_empty() {
                let before = filtered_hotwords.len();
                filtered_hotwords = filter_bpe_chars(&filtered_hotwords, &bpe_chars);
                if filtered_hotwords.len() < before {
                    log_asr!(
                        debug,
                        "BPE char filter removed {} hotword(s), {} remaining",
                        before - filtered_hotwords.len(),
                        filtered_hotwords.len()
                    );
                }
            }
        }
        let use_hotwords = entry.capabilities.hotwords && !filtered_hotwords.is_empty();

        // FunASR-Nano takes hotwords as a comma-separated string directly in
        // the model config, not via stream-level hotword injection.
        let funasr_hotwords =
            if entry.architecture.as_deref() == Some("funasr_nano") && use_hotwords {
                build_funasr_hotwords(&filtered_hotwords)
            } else {
                None
            };
        let hotwords_str = if use_hotwords {
            // Build sherpa-onnx hotwords file with per-word scores.
            // User input format: "word" or "word|weight" (weight 1-10, default 4).
            // sherpa-onnx format: "CLEANED_WORD :score" (colon, not pipe).
            // Words are cleaned: punctuation removed, uppercased for bpe models.
            let is_bpe = modeling_unit.contains("bpe");
            let lines: Vec<String> = filtered_hotwords
                .iter()
                .map(|hw| {
                    let (word, weight) = crate::hotword::parse_hotword_entry(hw);
                    let cleaned = clean_hotword_for_file(&word, is_bpe);
                    format!("{} :{weight}", cleaned)
                })
                .collect();
            lines.join("\n")
        } else {
            String::new()
        };

        // Use (or lazily create) the per-model hotword file.
        // Normally the file is kept up-to-date by `refresh_hotword_file`
        // called from `save_hotwords`.  We only write here if the file
        // doesn't exist yet (first-ever recording with this model).
        let hotwords_file_path: Option<PathBuf> = if entry.capabilities.streaming && use_hotwords {
            let filename = format!("hotwords-sherpa-onnx-{}.txt", &self.hotword_group_id);
            let path = self.data_dir.join(&filename);
            if !path.exists() {
                if let Err(e) = fs::write(&path, hotwords_str.as_bytes()) {
                    log_asr!(warn, "Failed to write sherpa-onnx hotwords file: {}", e);
                } else {
                    log_asr!(
                        debug,
                        "Created initial sherpa-onnx hotwords file ({} entries) at {}",
                        filtered_hotwords.len(),
                        path.display()
                    );
                }
            }
            path.exists().then_some(path)
        } else {
            None
        };

        if use_hotwords {
            log_asr!(
                debug,
                "Using {} sherpa-onnx hotwords",
                filtered_hotwords.len()
            );
        } else if entry.capabilities.hotwords && !hotwords.is_empty() {
            log_asr!(warn, "All sherpa-onnx hotwords were filtered as OOV");
        }

        let hotwords_file_str = hotwords_file_path
            .as_ref()
            .and_then(|p| p.to_str());

        let (recognizer, _) = Self::build_recognizer(
            &model_dir,
            entry,
            asr_num_threads,
            &model_config,
            hotwords_file_str,
            funasr_hotwords.as_deref(),
        )?;

        // Streaming Zipformer uses sherpa-onnx online endpointing directly; VAD
        // is only needed for offline segment recognizers.
        let vad = if entry.capabilities.streaming {
            None
        } else {
            let vad_dir = model::model_path(&self.data_dir, "silero-vad");
            Some(VadProcessor::new(&vad_dir, &vad_config)?)
        };

        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let _ = event_tx.send(AsrEvent::Open);
        let (worker_tx, worker_rx) = std_mpsc::sync_channel(AUDIO_QUEUE_CAPACITY);

        // FunASR-Nano handles hotwords internally via model config; disable
        // stream-level hotword injection in the worker.
        let is_funasr_nano = entry.architecture.as_deref() == Some("funasr_nano");
        let worker_use_hotwords = use_hotwords && !is_funasr_nano;

        let worker_handle = spawn_worker(
            recognizer,
            vad,
            worker_use_hotwords,
            hotwords_str,
            streaming_chunk_size,
            event_tx,
            worker_rx,
        )?;

        let session = SherpaOnnxSession {
            is_ready: Arc::new(AtomicBool::new(true)),
            is_committed: Arc::new(AtomicBool::new(false)),
            worker_tx: Mutex::new(Some(worker_tx)),
            worker_handle: Mutex::new(Some(worker_handle)),
        };

        Ok((Box::new(session), event_rx))
    }
}

// ---------------------------------------------------------------------------
// SherpaOnnxSession
// ---------------------------------------------------------------------------

/// Sherpa-ONNX ASR session using VAD + recognizer (offline or online).
struct SherpaOnnxSession {
    is_ready: Arc<AtomicBool>,
    is_committed: Arc<AtomicBool>,
    worker_tx: Mutex<Option<std_mpsc::SyncSender<WorkerCommand>>>,
    worker_handle: Mutex<Option<JoinHandle<()>>>,
}

impl SherpaOnnxSession {
    fn stop_worker(&self) {
        if let Ok(mut tx_guard) = self.worker_tx.lock() {
            if let Some(tx) = tx_guard.take() {
                let _ = tx.try_send(WorkerCommand::Close);
            }
        }

        if let Ok(mut handle_guard) = self.worker_handle.lock() {
            if let Some(handle) = handle_guard.take() {
                let _ = handle.join();
            }
        }
    }
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

        let Ok(tx_guard) = self.worker_tx.lock() else {
            return;
        };
        let Some(tx) = tx_guard.as_ref() else {
            return;
        };
        match tx.try_send(WorkerCommand::Audio(samples.to_vec())) {
            Ok(()) => {}
            Err(std_mpsc::TrySendError::Full(_)) => {
                log_asr!(warn, "Dropped local ASR audio chunk: worker queue is full");
            }
            Err(std_mpsc::TrySendError::Disconnected(_)) => {
                log_asr!(warn, "Dropped local ASR audio chunk: worker is closed");
            }
        }
    }

    async fn commit_and_await_final(&self) -> Result<String, String> {
        if !self.is_ready() {
            return Err("ASR 会话已关闭".to_string());
        }
        if self.is_committed.load(Ordering::SeqCst) {
            return Err("录音已结束".to_string());
        }
        self.is_committed.store(true, Ordering::SeqCst);

        let tx = self
            .worker_tx
            .lock()
            .map_err(|_| "ASR worker 状态异常".to_string())?
            .take()
            .ok_or_else(|| "ASR worker 已关闭".to_string())?;
        let handle = self
            .worker_handle
            .lock()
            .map_err(|_| "ASR worker 状态异常".to_string())?
            .take();

        let result = tokio::task::spawn_blocking(move || {
            let (reply_tx, reply_rx) = std_mpsc::channel();
            tx.send(WorkerCommand::Finish(reply_tx))
                .map_err(|_| "ASR worker 已关闭".to_string())?;
            let final_text = reply_rx
                .recv()
                .map_err(|_| "ASR worker 未返回最终结果".to_string())?;
            if let Some(handle) = handle {
                let _ = handle.join();
            }
            Ok::<_, String>(final_text)
        })
        .await
        .unwrap_or_else(|e| Err(format!("识别失败: {}", e)));

        self.is_ready.store(false, Ordering::SeqCst);
        result
    }

    fn close(&self) {
        self.is_ready.store(false, Ordering::SeqCst);
        self.stop_worker();
    }
}

impl Drop for SherpaOnnxSession {
    fn drop(&mut self) {
        self.is_ready.store(false, Ordering::SeqCst);
        self.stop_worker();
    }
}

// ---------------------------------------------------------------------------
// Hotword vocabulary validation
// ---------------------------------------------------------------------------

pub(crate) fn parse_token_line(line: &str) -> Option<String> {
    line.split_whitespace().next().map(str::to_string)
}

pub(crate) fn hotword_tokens_for_validation(hotword: &str) -> Vec<String> {
    let trimmed = hotword.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if trimmed.split_whitespace().count() > 1 {
        return trimmed.split_whitespace().map(str::to_string).collect();
    }
    if trimmed.is_ascii() {
        return vec![trimmed.to_string()];
    }
    trimmed.chars().map(|ch| ch.to_string()).collect()
}

/// Filter hotwords to only include words/pieces present in tokens.txt.
///
/// sherpa-onnx transducer models throw an uncatchable C++ exception when
/// hotwords contain out-of-vocabulary tokens, so we pre-validate them here.
pub(crate) fn filter_valid_hotwords(hotwords: &[String], tokens: Option<&HashSet<String>>) -> Vec<String> {
    let Some(vocab) = tokens else {
        return hotwords.to_vec();
    };

    hotwords
        .iter()
        .filter(|hw| {
            let pieces = hotword_tokens_for_validation(hw);
            let valid = !pieces.is_empty() && pieces.iter().all(|piece| vocab.contains(piece));
            if !valid {
                log_asr!(debug, "Skipping hotword (OOV): {:?}", hw);
            }
            valid
        })
        .cloned()
        .collect()
}

/// Build a set of all characters that appear in the bpe.vocab file.
///
/// The bpe tokenizer can only encode characters that appear somewhere in its
/// vocabulary.  Hotwords containing characters outside this set (e.g. `.`)
/// will cause sherpa-onnx `EncodeBase: Cannot find ID for token` errors.
fn bpe_char_set(bpe_vocab_path: &Path) -> HashSet<char> {
    let Ok(content) = fs::read_to_string(bpe_vocab_path) else {
        return HashSet::new();
    };
    content
        .lines()
        .filter_map(|line| {
            let token = line.split('\t').next()?;
            if token.starts_with('<') {
                return None; // skip special tokens like <blk>, <unk>
            }
            // Strip the bpe word-boundary marker ▁ before collecting chars
            Some(token.trim_start_matches('▁').chars().collect::<Vec<_>>())
        })
        .flatten()
        .collect()
}

/// Clean a hotword for writing to a sherpa-onnx hotwords file:
/// remove ASCII punctuation, convert to uppercase for bpe models.
fn clean_hotword_for_file(word: &str, is_bpe: bool) -> String {
    let cleaned: String = word
        .chars()
        .filter(|c| !c.is_ascii_punctuation())
        .collect();
    if is_bpe {
        cleaned.to_uppercase()
    } else {
        cleaned
    }
}

/// Filter hotwords for bpe-based models: remove words containing ASCII
/// characters that the bpe vocabulary cannot encode (e.g. `.` in "AGENTS.md").
///
/// Punctuation is stripped before validation so that hotwords like
/// "AGENTS.md" are checked as "AGENTSMD" — the dot itself would never
/// appear in bpe.vocab but the remaining chars are all encodable.
fn filter_bpe_chars(hotwords: &[String], bpe_chars: &HashSet<char>) -> Vec<String> {
    hotwords
        .iter()
        .filter(|hw| {
            let (word, _weight) = crate::hotword::parse_hotword_entry(hw);
            let cleaned: String = word
                .chars()
                .filter(|c| !c.is_ascii_punctuation())
                .collect();
            if cleaned.is_empty() {
                log_asr!(debug, "Skipping hotword (empty after cleaning): {:?}", hw);
                return false;
            }
            let valid = cleaned.chars().all(|c| {
                !c.is_ascii_graphic() || c.is_ascii_alphabetic() || bpe_chars.contains(&c)
            });
            if !valid {
                log_asr!(debug, "Skipping hotword (char unsupported by bpe vocab): {:?}", hw);
            }
            valid
        })
        .cloned()
        .collect()
}

/// Regenerate the sherpa-onnx hotword file whenever hotwords are modified.
///
/// Called from `save_hotwords` to keep the file in sync with user edits.
/// Silently skips if the model isn't downloaded or the registry is missing.
pub fn refresh_hotword_file(
    data_dir: &Path,
    resource_dir: &Path,
    active_model_id: &str,
    hotword_group_id: &str,
    hotwords: &[String],
    model_config: Option<&serde_json::Value>,
) {
    let model_dir = crate::model::model_path(data_dir, active_model_id);
    if !model_dir.exists() {
        return;
    }

    let registry = crate::model::load_registry(data_dir, resource_dir);
    let Some(entry) = registry.models.iter().find(|m| m.id == active_model_id) else {
        return;
    };
    if !entry.capabilities.hotwords || !entry.capabilities.streaming {
        return;
    }

    let merged = merged_model_config(entry.default_config.as_ref(), model_config);
    let modeling_unit = json_string(&merged, "modeling_unit").unwrap_or_default();
    let is_bpe = modeling_unit.contains("bpe");

    let lines: Vec<String> = hotwords
        .iter()
        .filter_map(|hw| {
            let (word, weight) = crate::hotword::parse_hotword_entry(hw);
            let cleaned = clean_hotword_for_file(&word, is_bpe);
            if cleaned.is_empty() {
                return None;
            }
            Some(format!("{} :{weight}", cleaned))
        })
        .collect();

    if lines.is_empty() {
        return;
    }

    let filename = format!("hotwords-sherpa-onnx-{hotword_group_id}.txt");
    let path = data_dir.join(&filename);
    if let Err(e) = fs::write(&path, lines.join("\n").as_bytes()) {
        log_asr!(warn, "Failed to refresh sherpa-onnx hotword file: {e}");
    } else {
        log_asr!(debug, "Refreshed {} sherpa-onnx hotwords at {}", lines.len(), path.display());
    }
}

/// Restore original hotword casing and punctuation in recognized text.
///
/// Uses two matching strategies:
///   1. Space-aware: for multi-word hotwords like "Claude Code" →
///      the model preserves spaces, so we normalize with spaces.
///   2. Alphanumeric-only: for hotwords with punctuation like "AGENTS.md" →
///      the model strips punctuation, so we match purely on alphanumerics.
pub fn restore_hotword_case(text: &str, hotwords: &[String]) -> String {
    // Strategy A: normalize keeping single spaces (↵ replaced by space, collapsed).
    fn normalize_spaces(s: &str) -> (String, Vec<usize>) {
        let mut norm = String::new();
        let mut positions = Vec::new();
        let mut last_was_space = true; // skip leading spaces
        for (i, c) in s.char_indices() {
            if c.is_alphanumeric() {
                norm.push_str(&c.to_uppercase().to_string());
                positions.push(i);
                last_was_space = false;
            } else if !last_was_space {
                norm.push(' ');
                positions.push(i);
                last_was_space = true;
            }
        }
        if norm.ends_with(' ') {
            norm.pop();
            positions.pop();
        }
        (norm, positions)
    }

    // Strategy B: normalize to alphanumeric only (no spaces, no punctuation).
    fn normalize_alpha(s: &str) -> (String, Vec<usize>) {
        let mut norm = String::new();
        let mut positions = Vec::new();
        for (i, c) in s.char_indices() {
            if c.is_alphanumeric() {
                norm.push_str(&c.to_uppercase().to_string());
                positions.push(i);
            }
        }
        (norm, positions)
    }

    let mut result = text.to_string();

    // Build (needle, original_word, use_spaces) tuples, longest first
    let mut replacements: Vec<(String, String, bool)> = hotwords
        .iter()
        .filter_map(|hw| {
            let (original_word, _weight) = crate::hotword::parse_hotword_entry(hw);

            // Determine which strategy to use based on whether the hotword
            // contains spaces (space-aware) or only punctuation (alpha-only).
            let has_space = original_word.contains(' ');
            let (needle, _) = if has_space {
                normalize_spaces(&original_word)
            } else {
                normalize_alpha(&original_word)
            };

            if needle.is_empty() {
                return None;
            }
            // Skip no-ops: already uppercase and matches its normalized form
            if !has_space
                && original_word == original_word.to_uppercase()
                && original_word.chars().all(|c| c.is_alphanumeric())
            {
                return None;
            }
            Some((needle, original_word, has_space))
        })
        .collect();

    if replacements.is_empty() {
        return result;
    }

    replacements.sort_by(|a, b| b.0.len().cmp(&a.0.len()));

    for (needle, original, use_spaces) in &replacements {
        let needle_chars: Vec<char> = needle.chars().collect();
        let mut search_start = 0;

        loop {
            let (haystack_str, pos_map) = if *use_spaces {
                normalize_spaces(&result)
            } else {
                normalize_alpha(&result)
            };
            let haystack_chars: Vec<char> = haystack_str.chars().collect();
            if search_start >= haystack_chars.len() {
                break;
            }
            // Character-level search to avoid byte-offset issues with CJK
            let pos = haystack_chars[search_start..]
                .windows(needle_chars.len())
                .position(|w| w == needle_chars.as_slice());
            let Some(pos) = pos else {
                break;
            };
            let norm_start = search_start + pos;
            let norm_end = norm_start + needle_chars.len();
            if norm_end > pos_map.len() {
                break;
            }

            let mut byte_start = pos_map[norm_start];
            let mut byte_end = if norm_end < pos_map.len() {
                pos_map[norm_end]
            } else {
                result.len()
            };
            // Trim surrounding spaces from the matched range
            let result_bytes = result.as_bytes();
            while byte_start < byte_end && result_bytes[byte_start] == b' ' {
                byte_start += 1;
            }
            while byte_end > byte_start && result_bytes[byte_end - 1] == b' ' {
                byte_end -= 1;
            }

            // Skip if already the original text (prevents infinite loop)
            if &result[byte_start..byte_end] == original.as_str() {
                search_start = norm_start + 1;
                continue;
            }

            result.replace_range(byte_start..byte_end, original);
            search_start = 0;
        }
    }

    result
}


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    // ── restore_hotword_case tests ──────────────────────────────────────────

    #[test]
    fn restore_case_mixed() {
        let r = restore_hotword_case("CLAUDE CODE", &["Claude Code".to_string()]);
        assert_eq!(r, "Claude Code");
    }

    #[test]
    fn restore_case_lowercase_model_output() {
        let r = restore_hotword_case("claude code", &["Claude Code".to_string()]);
        assert_eq!(r, "Claude Code");
    }

    #[test]
    fn restore_punctuation_stripped() {
        let r = restore_hotword_case("AGENTSMD", &["AGENTS.md".to_string()]);
        assert_eq!(r, "AGENTS.md");
    }

    #[test]
    fn restore_punctuation_with_space() {
        let r = restore_hotword_case("AGENTS MD", &["AGENTS.md".to_string()]);
        assert_eq!(r, "AGENTS.md");
    }

    #[test]
    fn no_change_for_chinese() {
        let r = restore_hotword_case("流式输出", &["流式输出".to_string()]);
        assert_eq!(r, "流式输出");
    }

    #[test]
    fn restore_with_weight_format() {
        let r = restore_hotword_case("CLAUDE CODE", &["Claude Code|10".to_string()]);
        assert_eq!(r, "Claude Code");
    }

    #[test]
    fn restore_single_hotword() {
        let r = restore_hotword_case(
            "使用 CLAUDE CODE 和 OPENAI",
            &["Claude Code".to_string()],
        );
        assert_eq!(r, "使用 Claude Code 和 OPENAI");
    }

    #[test]
    fn restore_multiple_in_sentence() {
        let r = restore_hotword_case(
            "使用 CLAUDE CODE 和 OPENAI",
            &["Claude Code".to_string(), "OpenAI".to_string()],
        );
        assert_eq!(r, "使用 Claude Code 和 OpenAI");
    }

    // ── vocabulary validation tests ─────────────────────────────────────────

    #[test]
    fn parses_first_column_from_tokens_file() {
        assert_eq!(parse_token_line("你 42").as_deref(), Some("你"));
        assert_eq!(parse_token_line("<blk> 0").as_deref(), Some("<blk>"));
        assert_eq!(parse_token_line("   ").as_deref(), None);
    }

    #[test]
    fn validates_cjk_hotwords_by_character_token() {
        let vocab = ["语", "音", "输", "入"]
            .into_iter()
            .map(str::to_string)
            .collect::<HashSet<_>>();
        let hotwords = vec!["语音输入".to_string(), "语音转写".to_string()];

        assert_eq!(
            hotword_tokens_for_validation("语音输入"),
            vec!["语", "音", "输", "入"]
        );
        assert_eq!(
            filter_valid_hotwords(&hotwords, Some(&vocab)),
            vec!["语音输入"]
        );
    }

    // ── FunASR-Nano hotwords tests ────────────────────────────────────────────

    #[test]
    fn funasr_hotwords_comma_separated() {
        let hotwords = vec![
            "Claude Code".to_string(),
            "OpenAI".to_string(),
            "ChatGPT".to_string(),
        ];
        let result = build_funasr_hotwords(&hotwords);
        assert_eq!(result.as_deref(), Some("Claude Code,OpenAI,ChatGPT"));
    }

    #[test]
    fn funasr_hotwords_strips_weight_suffix() {
        let hotwords = vec![
            "Claude Code|10".to_string(),
            "OpenAI|5".to_string(),
            "mermaid".to_string(),
        ];
        let result = build_funasr_hotwords(&hotwords);
        assert_eq!(result.as_deref(), Some("Claude Code,OpenAI,mermaid"));
    }

    #[test]
    fn funasr_hotwords_empty_returns_none() {
        let result = build_funasr_hotwords(&[]);
        assert_eq!(result, None);
    }

    #[test]
    fn funasr_hotwords_single_word() {
        let hotwords = vec!["Claude Code".to_string()];
        let result = build_funasr_hotwords(&hotwords);
        assert_eq!(result.as_deref(), Some("Claude Code"));
    }

    #[test]
    fn funasr_hotwords_chinese_mixed() {
        let hotwords = vec![
            "流式输出".to_string(),
            "热词".to_string(),
            "OpenAI".to_string(),
        ];
        let result = build_funasr_hotwords(&hotwords);
        assert_eq!(result.as_deref(), Some("流式输出,热词,OpenAI"));
    }

    #[test]
    fn funasr_hotwords_preserves_original_case() {
        let hotwords = vec![
            "AGENTS.md".to_string(),
            "Claude Code".to_string(),
        ];
        let result = build_funasr_hotwords(&hotwords);
        assert_eq!(result.as_deref(), Some("AGENTS.md,Claude Code"));
    }
}

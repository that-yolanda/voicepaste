use sherpa_onnx::{OnlineRecognizer, OnlineRecognizerConfig, OnlineStream};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tokio::sync::mpsc;

use super::punct::PunctuationProcessor;
use super::vad::VadProcessor;
use super::{append_text, send_transcript, AsrEvent, AsrSession, WorkerCommand, SAMPLE_RATE};
use crate::model::ModelEntry;

use super::{json_bool, json_f32, json_string, json_u32};

// ---------------------------------------------------------------------------
// Online recognizer builder
// ---------------------------------------------------------------------------

/// Build an OnlineRecognizer for streaming transducer models (e.g. Zipformer).
///
/// Hotwords are passed via `hotwords_buf` (in-memory buffer) instead of a file path.
pub(crate) fn build_online_recognizer(
    model_dir: &Path,
    entry: &ModelEntry,
    num_threads: u32,
    model_config: &serde_json::Value,
    hotwords_buf: Option<Vec<u8>>,
) -> Result<OnlineRecognizer, String> {
    let p = |key: &str| -> Option<String> {
        let filename = entry.model_files.get(key)?;
        let path = model_dir.join(filename);
        if !path.exists() {
            return None;
        }
        path.to_str().map(|s| s.to_string())
    };

    let mut config = OnlineRecognizerConfig::default();
    config.model_config.transducer.encoder = p("encoder");
    config.model_config.transducer.decoder = p("decoder");
    config.model_config.transducer.joiner = p("joiner");
    config.model_config.tokens = p("tokens");
    config.model_config.num_threads = num_threads as i32;
    config.model_config.debug = cfg!(debug_assertions);
    config.model_config.provider = json_string(model_config, "provider");
    config.enable_endpoint = json_bool(model_config, "enable_endpoint").unwrap_or(true);
    config.rule1_min_trailing_silence =
        json_f32(model_config, "rule1_min_trailing_silence").unwrap_or(0.0);
    config.rule2_min_trailing_silence =
        json_f32(model_config, "rule2_min_trailing_silence").unwrap_or(0.0);
    config.rule3_min_utterance_length =
        json_f32(model_config, "rule3_min_utterance_length").unwrap_or(0.0);

    if let Some(buf) = hotwords_buf {
        config.decoding_method = Some("modified_beam_search".to_string());
        config.max_active_paths = json_u32(model_config, "max_active_paths").unwrap_or(4) as i32;
        config.hotwords_score = json_f32(model_config, "hotwords_score").unwrap_or(2.0);
        config.hotwords_buf = Some(buf);

        // Set modeling unit (required for hotwords tokenization)
        config.model_config.modeling_unit = json_string(model_config, "modeling_unit");

        // Set bpe_vocab for bpe or cjkchar+bpe models
        let bpe_vocab_path = model_dir.join("bpe.vocab");
        if bpe_vocab_path.exists() {
            config.model_config.bpe_vocab = bpe_vocab_path.to_str().map(|s| s.to_string());
        }
    } else {
        config.decoding_method = Some("greedy_search".to_string());
    }

    OnlineRecognizer::create(&config)
        .ok_or_else(|| format!("创建在线识别器失败 (model: {})", entry.id))
}

// ---------------------------------------------------------------------------
// Online hotword buffer builder
// ---------------------------------------------------------------------------

/// Build an in-memory hotwords buffer for sherpa-onnx OnlineRecognizer.
///
/// Parses `word|weight` entries, validates against model vocabulary, cleans
/// punctuation, uppercases for bpe models, and produces the format:
///
/// ```text
/// CLEANED_WORD :score
/// ANOTHER :score
/// ```
///
/// Returns `None` when no valid hotwords remain after filtering.
pub(crate) fn build_online_hotwords_buf(
    hotwords: &[String],
    modeling_unit: &str,
    model_dir: &Path,
    entry: &ModelEntry,
) -> Option<Vec<u8>> {
    if hotwords.is_empty() || !entry.capabilities.hotwords {
        return None;
    }

    let is_cjkchar_only = modeling_unit == "cjkchar";
    let is_bpe = modeling_unit.contains("bpe");

    // Step 1: cjkchar token OOV validation (read tokens.txt)
    let valid_tokens: Option<HashSet<String>> = if is_cjkchar_only {
        let tokens_path = entry.model_files.get("tokens").map(|f| model_dir.join(f));
        tokens_path
            .filter(|p| p.exists())
            .and_then(|p| fs::read_to_string(p).ok())
            .map(|content| {
                content
                    .lines()
                    .filter_map(parse_token_line)
                    .collect::<HashSet<_>>()
            })
    } else {
        None
    };

    // Step 2: OOV filtering for cjkchar models
    let mut filtered: Vec<String> = if is_cjkchar_only {
        filter_valid_hotwords(hotwords, valid_tokens.as_ref())
    } else {
        hotwords.to_vec()
    };

    // Step 3: BPE character set filtering
    if is_bpe {
        let bpe_vocab_path = model_dir.join("bpe.vocab");
        let bpe_chars = bpe_char_set(&bpe_vocab_path);
        if !bpe_chars.is_empty() {
            let before = filtered.len();
            filtered = filter_bpe_chars(&filtered, &bpe_chars);
            if filtered.len() < before {
                log_asr!(
                    debug,
                    "BPE char filter removed {} hotword(s), {} remaining",
                    before - filtered.len(),
                    filtered.len()
                );
            }
        }
    }

    if filtered.is_empty() {
        return None;
    }

    // Step 4: Build the hotwords buffer content
    let lines: Vec<String> = filtered
        .iter()
        .map(|hw| {
            let (word, weight) = crate::hotword::parse_hotword_entry(hw);
            let cleaned: String = word.chars().filter(|c| !c.is_ascii_punctuation()).collect();
            let cleaned = if is_bpe {
                cleaned.to_uppercase()
            } else {
                cleaned
            };
            format!("{} :{weight}", cleaned)
        })
        .collect();

    log_asr!(
        debug,
        "Built online hotwords buffer: {} entries",
        lines.len()
    );

    Some(lines.join("\n").into_bytes())
}

// ---------------------------------------------------------------------------
// Online worker
// ---------------------------------------------------------------------------

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
                let final_prefix = if finalized.is_empty() {
                    String::new()
                } else {
                    format!("{} ", finalized)
                };
                send_transcript(event_tx, final_prefix, text);
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

#[allow(clippy::too_many_arguments)]
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
    mut vad: VadProcessor,
    chunk_size: usize,
    event_tx: mpsc::UnboundedSender<AsrEvent>,
    rx: std_mpsc::Receiver<WorkerCommand>,
) {
    let mut finalized = String::new();
    let mut last_partial = String::new();
    let mut buffer = Vec::with_capacity(chunk_size * 2);
    let mut live_feeding = false;

    while let Ok(command) = rx.recv() {
        match command {
            WorkerCommand::Audio(samples) => {
                let speech_segments = vad.accept_waveform(&samples);

                if !speech_segments.is_empty() {
                    // VAD produced completed segments.  If we were already
                    // live-feeding raw audio (path below), skip the segment
                    // — that audio was already sent to the recognizer.
                    // Otherwise, feed the segment normally.
                    if !live_feeding {
                        for segment in speech_segments {
                            accept_online_samples(
                                &recognizer,
                                &stream,
                                &mut buffer,
                                &segment,
                                chunk_size,
                                &mut finalized,
                                &mut last_partial,
                                &event_tx,
                            );
                        }
                    }
                    live_feeding = false;
                } else if vad.detected() {
                    // VAD detects active speech but hasn't completed a segment
                    // yet — feed the raw audio so the recognizer can produce
                    // partial results without waiting for silence.
                    live_feeding = true;
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
                // Pure silence: skip, don't feed to recognizer.
            }
            WorkerCommand::Finish(reply_tx) => {
                // Flush remaining VAD segments.  Skip them when we were
                // live-feeding — the audio was already sent to the recognizer.
                let remaining = vad.flush();
                if !live_feeding {
                    for segment in remaining {
                        accept_online_samples(
                            &recognizer,
                            &stream,
                            &mut buffer,
                            &segment,
                            chunk_size,
                            &mut finalized,
                            &mut last_partial,
                            &event_tx,
                        );
                    }
                }
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

/// Spawn an online worker thread and return the session + command sender.
pub(crate) fn spawn_online_worker(
    recognizer: OnlineRecognizer,
    stream: OnlineStream,
    vad: VadProcessor,
    chunk_size: usize,
    event_tx: mpsc::UnboundedSender<AsrEvent>,
    punct_processor: Option<Arc<PunctuationProcessor>>,
) -> Result<(OnlineSession, std_mpsc::SyncSender<WorkerCommand>), String> {
    let (worker_tx, worker_rx) = std_mpsc::sync_channel(super::AUDIO_QUEUE_CAPACITY);

    let handle = std::thread::Builder::new()
        .name("sherpa-onnx-asr-online".to_string())
        .spawn(move || {
            run_online_worker(recognizer, stream, vad, chunk_size, event_tx, worker_rx);
        })
        .map_err(|e| format!("启动在线识别线程失败: {}", e))?;

    Ok((
        OnlineSession::new(worker_tx.clone(), handle, punct_processor),
        worker_tx,
    ))
}

// ---------------------------------------------------------------------------
// OnlineSession
// ---------------------------------------------------------------------------

/// Streaming ASR session for online transducer models.
pub(crate) struct OnlineSession {
    is_ready: Arc<AtomicBool>,
    is_committed: Arc<AtomicBool>,
    worker_tx: Mutex<Option<std_mpsc::SyncSender<WorkerCommand>>>,
    worker_handle: Mutex<Option<JoinHandle<()>>>,
    punct_processor: Option<Arc<PunctuationProcessor>>,
}

impl OnlineSession {
    fn new(
        worker_tx: std_mpsc::SyncSender<WorkerCommand>,
        worker_handle: JoinHandle<()>,
        punct_processor: Option<Arc<PunctuationProcessor>>,
    ) -> Self {
        Self {
            is_ready: Arc::new(AtomicBool::new(true)),
            is_committed: Arc::new(AtomicBool::new(false)),
            worker_tx: Mutex::new(Some(worker_tx)),
            worker_handle: Mutex::new(Some(worker_handle)),
            punct_processor,
        }
    }

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

#[async_trait::async_trait]
impl AsrSession for OnlineSession {
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
        .unwrap_or_else(|e| Err(format!("识别失败: {}", e)))?;

        // Post-process punctuation here. Hotword text restoration is applied
        // once in the app finalization path so every ASR backend behaves the same.
        let result = if let Some(ref punct) = self.punct_processor {
            punct.add_punctuation(&result)
        } else {
            result
        };

        self.is_ready.store(false, Ordering::SeqCst);
        Ok(result)
    }

    fn close(&self) {
        self.is_ready.store(false, Ordering::SeqCst);
        self.stop_worker();
    }
}

impl Drop for OnlineSession {
    fn drop(&mut self) {
        self.is_ready.store(false, Ordering::SeqCst);
        self.stop_worker();
    }
}

// ---------------------------------------------------------------------------
// Hotword vocabulary validation
// ---------------------------------------------------------------------------

fn parse_token_line(line: &str) -> Option<String> {
    line.split_whitespace().next().map(str::to_string)
}

fn hotword_tokens_for_validation(hotword: &str) -> Vec<String> {
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
fn filter_valid_hotwords(hotwords: &[String], tokens: Option<&HashSet<String>>) -> Vec<String> {
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
            let cleaned: String = word.chars().filter(|c| !c.is_ascii_punctuation()).collect();
            if cleaned.is_empty() {
                log_asr!(debug, "Skipping hotword (empty after cleaning): {:?}", hw);
                return false;
            }
            let valid = cleaned.chars().all(|c| {
                !c.is_ascii_graphic() || c.is_ascii_alphabetic() || bpe_chars.contains(&c)
            });
            if !valid {
                log_asr!(
                    debug,
                    "Skipping hotword (char unsupported by bpe vocab): {:?}",
                    hw
                );
            }
            valid
        })
        .cloned()
        .collect()
}

// ---------------------------------------------------------------------------
// Hotword case restoration (post-processing)
// ---------------------------------------------------------------------------

/// Restore original hotword casing and punctuation in recognized text.
///
/// Uses two matching strategies:
///   1. Space-aware: for multi-word hotwords like "Claude Code" →
///      the model preserves spaces, so we normalize with spaces.
///   2. Alphanumeric-only: for hotwords with punctuation like "AGENTS.md" →
///      the model strips punctuation, so we match purely on alphanumerics.
pub(crate) fn restore_hotword_case(text: &str, hotwords: &[String]) -> String {
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

    replacements.sort_by_key(|b| std::cmp::Reverse(b.0.len()));

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
        let r = restore_hotword_case("使用 CLAUDE CODE 和 OPENAI", &["Claude Code".to_string()]);
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
}

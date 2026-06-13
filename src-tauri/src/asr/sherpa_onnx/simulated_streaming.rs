use sherpa_onnx::OfflineRecognizer;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;
use tokio::sync::mpsc;

use super::punct::PunctuationProcessor;
use super::vad::VadProcessor;
use super::{append_text, send_transcript, AsrEvent, AsrSession, WorkerCommand, SAMPLE_RATE};

/// Interval between interim decodes (200ms).
const INTERIM_INTERVAL_MS: u128 = 200;

/// Minimum speech segment duration in seconds.
const MIN_SEGMENT_DURATION: f32 = 0.1;

// ---------------------------------------------------------------------------
// SimulatedSession
// ---------------------------------------------------------------------------

/// Simulated streaming ASR session for offline models.
///
/// Uses VAD + interim decoding to produce partial results during recording,
/// mimicking the experience of a streaming ASR engine.
pub(crate) struct SimulatedSession {
    is_ready: Arc<AtomicBool>,
    is_committed: Arc<AtomicBool>,
    worker_tx: Mutex<Option<std_mpsc::SyncSender<WorkerCommand>>>,
    worker_handle: Mutex<Option<JoinHandle<()>>>,
    punct_processor: Option<Arc<PunctuationProcessor>>,
}

impl SimulatedSession {
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
impl AsrSession for SimulatedSession {
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

        // Post-process: apply punctuation restoration
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

impl Drop for SimulatedSession {
    fn drop(&mut self) {
        self.is_ready.store(false, Ordering::SeqCst);
        self.stop_worker();
    }
}

// ---------------------------------------------------------------------------
// Simulated streaming worker
// ---------------------------------------------------------------------------

/// Run an interim decode on the accumulated speech buffer and return partial text.
fn interim_decode(recognizer: &OfflineRecognizer, buffer: &[f32]) -> String {
    if buffer.is_empty() {
        return String::new();
    }
    let stream = recognizer.create_stream();
    stream.accept_waveform(SAMPLE_RATE, buffer);
    recognizer.decode(&stream);
    stream
        .get_result()
        .map(|r| r.text.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_default()
}

/// Run final decode on a VAD segment and return the result text.
fn decode_segment(recognizer: &OfflineRecognizer, segment: &[f32]) -> String {
    if segment.is_empty() {
        return String::new();
    }
    let stream = recognizer.create_stream();
    stream.accept_waveform(SAMPLE_RATE, segment);
    recognizer.decode(&stream);
    stream
        .get_result()
        .map(|r| r.text.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_default()
}

/// Process completed VAD segments: decode each one, append to accumulated text,
/// and emit transcript events.
fn process_segments(
    recognizer: &OfflineRecognizer,
    segments: Vec<Vec<f32>>,
    accumulated: &mut String,
    event_tx: &mpsc::UnboundedSender<AsrEvent>,
) {
    for segment in segments {
        let duration = segment.len() as f32 / SAMPLE_RATE as f32;
        if duration < MIN_SEGMENT_DURATION {
            continue;
        }

        let text = decode_segment(recognizer, &segment);
        if !text.is_empty() {
            append_text(accumulated, &text);
            send_transcript(event_tx, accumulated.clone(), String::new());
        }
    }
}

/// Run the simulated streaming worker loop.
///
/// Uses the same VAD processing pattern as the regular offline worker
/// (feed chunks → drain segments → decode), but additionally buffers
/// audio for interim decodes every ~200 ms while speech is active,
/// producing partial results that mimic streaming ASR.
fn run_simulated_streaming_worker(
    recognizer: OfflineRecognizer,
    mut vad: VadProcessor,
    event_tx: mpsc::UnboundedSender<AsrEvent>,
    rx: std_mpsc::Receiver<WorkerCommand>,
) {
    let mut accumulated = String::new();
    let mut speech_buffer: Vec<f32> = Vec::new();
    let mut speech_active = false;
    let mut last_interim = Instant::now();
    let mut last_partial = String::new();

    while let Ok(command) = rx.recv() {
        match command {
            WorkerCommand::Audio(samples) => {
                // 1. Feed audio to VAD (same pattern as offline worker).
                let segments = vad.accept_waveform(&samples);

                // 2. Process completed VAD segments.
                if !segments.is_empty() {
                    process_segments(&recognizer, segments, &mut accumulated, &event_tx);

                    // VAD produced final segments → reset the interim buffer.
                    speech_buffer.clear();
                    speech_active = false;
                    last_partial.clear();
                }

                // 3. Accumulate audio for interim decoding.
                speech_buffer.extend_from_slice(&samples);

                // 4. Check VAD state for interim decoding.
                if vad.detected() {
                    if !speech_active {
                        speech_active = true;
                        last_interim = Instant::now();
                    }

                    // Interim decode every ~200 ms.
                    if last_interim.elapsed().as_millis() >= INTERIM_INTERVAL_MS {
                        let partial = interim_decode(&recognizer, &speech_buffer);
                        if !partial.is_empty() && partial != last_partial {
                            last_partial = partial.clone();
                            let final_prefix = if accumulated.is_empty() {
                                String::new()
                            } else {
                                format!("{} ", accumulated)
                            };
                            send_transcript(&event_tx, final_prefix, partial);
                        }
                        last_interim = Instant::now();
                    }
                } else if speech_active {
                    // Speech ended — clear the interim state.
                    speech_active = false;
                    last_partial.clear();
                }
            }
            WorkerCommand::Finish(reply_tx) => {
                // Flush remaining VAD segments.
                let remaining = vad.flush();
                process_segments(&recognizer, remaining, &mut accumulated, &event_tx);

                // Fallback: if nothing was recognized, decode the raw buffer.
                if accumulated.is_empty() && !speech_buffer.is_empty() {
                    let text = decode_segment(&recognizer, &speech_buffer);
                    if !text.is_empty() {
                        append_text(&mut accumulated, &text);
                    }
                }

                send_transcript(&event_tx, accumulated.clone(), String::new());
                let _ = reply_tx.send(accumulated.clone());
                break;
            }
            WorkerCommand::Close => break,
        }
    }
}

/// Spawn a simulated streaming worker thread and return the session + command sender.
pub(crate) fn spawn_simulated_streaming_worker(
    recognizer: OfflineRecognizer,
    vad: VadProcessor,
    event_tx: mpsc::UnboundedSender<AsrEvent>,
    punct_processor: Option<Arc<PunctuationProcessor>>,
) -> Result<(SimulatedSession, std_mpsc::SyncSender<WorkerCommand>), String> {
    let (worker_tx, worker_rx) = std_mpsc::sync_channel(super::AUDIO_QUEUE_CAPACITY);

    let handle = std::thread::Builder::new()
        .name("sherpa-onnx-asr-simulated-streaming".to_string())
        .spawn(move || {
            run_simulated_streaming_worker(recognizer, vad, event_tx, worker_rx);
        })
        .map_err(|e| format!("启动模拟流式识别线程失败: {}", e))?;

    Ok((
        SimulatedSession::new(worker_tx.clone(), handle, punct_processor),
        worker_tx,
    ))
}

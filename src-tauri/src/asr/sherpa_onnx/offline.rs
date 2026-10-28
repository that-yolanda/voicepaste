use sherpa_onnx::OfflineRecognizer;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tokio::sync::mpsc;

use super::punct::PunctuationProcessor;
use super::vad::VadProcessor;
use super::{append_text, send_transcript, AsrEvent, AsrSession, WorkerCommand, SAMPLE_RATE};
use crate::errors::{AppError, AppErrorCode};

/// Offline ASR session using VAD + OfflineRecognizer.
pub(crate) struct OfflineSession {
    is_ready: Arc<AtomicBool>,
    is_committed: Arc<AtomicBool>,
    worker_tx: Mutex<Option<std_mpsc::SyncSender<WorkerCommand>>>,
    worker_handle: Mutex<Option<JoinHandle<()>>>,
    punct_processor: Option<Arc<PunctuationProcessor>>,
}

impl OfflineSession {
    pub(crate) fn new(
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
impl AsrSession for OfflineSession {
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

    async fn commit_and_await_final(&self) -> Result<String, AppError> {
        if !self.is_ready() {
            return Err(AppError::new(AppErrorCode::AsrSessionClosed));
        }
        if self.is_committed.load(Ordering::SeqCst) {
            return Err(AppError::new(AppErrorCode::AsrSessionClosed));
        }
        self.is_committed.store(true, Ordering::SeqCst);

        let tx = self
            .worker_tx
            .lock()
            .map_err(|_| AppError::new(AppErrorCode::AsrWorkerAborted))?
            .take()
            .ok_or_else(|| AppError::new(AppErrorCode::AsrWorkerClosed))?;
        let handle = self
            .worker_handle
            .lock()
            .map_err(|_| AppError::new(AppErrorCode::AsrWorkerAborted))?
            .take();

        let result = tokio::task::spawn_blocking(move || {
            let (reply_tx, reply_rx) = std_mpsc::channel();
            tx.send(WorkerCommand::Finish(reply_tx))
                .map_err(|_| AppError::new(AppErrorCode::AsrWorkerClosed))?;
            let final_text = reply_rx
                .recv()
                .map_err(|_| AppError::new(AppErrorCode::AsrNoFinalResult))?;
            if let Some(handle) = handle {
                let _ = handle.join();
            }
            Ok::<_, AppError>(final_text)
        })
        .await
        .unwrap_or_else(|e| {
            Err(AppError::new(AppErrorCode::AsrRecognizeFailed).with_detail(e.to_string()))
        })?;

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

impl Drop for OfflineSession {
    fn drop(&mut self) {
        self.is_ready.store(false, Ordering::SeqCst);
        self.stop_worker();
    }
}

// ---------------------------------------------------------------------------
// Offline worker
// ---------------------------------------------------------------------------

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

        let stream = if use_hotwords {
            recognizer.create_stream_with_hotwords(hotwords_str)
        } else {
            recognizer.create_stream()
        };
        stream.accept_waveform(SAMPLE_RATE, &segment_samples);
        recognizer.decode(&stream);

        if let Some(text) = stream
            .get_result()
            .map(|r| r.text.trim().to_string())
            .filter(|t| !t.is_empty())
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

/// Spawn an offline worker thread and return the session + command sender.
pub(crate) fn spawn_offline_worker(
    recognizer: OfflineRecognizer,
    vad: VadProcessor,
    use_hotwords: bool,
    hotwords_str: String,
    event_tx: mpsc::UnboundedSender<AsrEvent>,
    punct_processor: Option<Arc<PunctuationProcessor>>,
) -> Result<(OfflineSession, std_mpsc::SyncSender<WorkerCommand>), AppError> {
    let (worker_tx, worker_rx) = std_mpsc::sync_channel(super::AUDIO_QUEUE_CAPACITY);

    let handle = std::thread::Builder::new()
        .name("sherpa-onnx-asr-offline".to_string())
        .spawn(move || {
            run_offline_worker(
                recognizer,
                vad,
                use_hotwords,
                hotwords_str,
                event_tx,
                worker_rx,
            );
        })
        .map_err(|e| {
            AppError::new(AppErrorCode::AsrThreadStartFailed).with_detail(e.to_string())
        })?;

    Ok((
        OfflineSession::new(worker_tx.clone(), handle, punct_processor),
        worker_tx,
    ))
}

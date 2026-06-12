use sherpa_onnx::OfflineRecognizer;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tokio::sync::mpsc;

use super::vad::VadProcessor;
use super::{
    append_text, send_transcript, AsrEvent, AsrSession, SAMPLE_RATE, WorkerCommand,
};

/// Offline ASR session using VAD + OfflineRecognizer.
pub(crate) struct OfflineSession {
    is_ready: Arc<AtomicBool>,
    is_committed: Arc<AtomicBool>,
    worker_tx: Mutex<Option<std_mpsc::SyncSender<WorkerCommand>>>,
    worker_handle: Mutex<Option<JoinHandle<()>>>,
}

impl OfflineSession {
    pub(crate) fn new(
        worker_tx: std_mpsc::SyncSender<WorkerCommand>,
        worker_handle: JoinHandle<()>,
    ) -> Self {
        Self {
            is_ready: Arc::new(AtomicBool::new(true)),
            is_committed: Arc::new(AtomicBool::new(false)),
            worker_tx: Mutex::new(Some(worker_tx)),
            worker_handle: Mutex::new(Some(worker_handle)),
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
) -> Result<(OfflineSession, std_mpsc::SyncSender<WorkerCommand>), String> {
    let (worker_tx, worker_rx) = std_mpsc::sync_channel(super::AUDIO_QUEUE_CAPACITY);

    let handle = std::thread::Builder::new()
        .name("sherpa-onnx-asr-offline".to_string())
        .spawn(move || {
            run_offline_worker(recognizer, vad, use_hotwords, hotwords_str, event_tx, worker_rx);
        })
        .map_err(|e| format!("启动离线识别线程失败: {}", e))?;

    Ok((OfflineSession::new(worker_tx.clone(), handle), worker_tx))
}

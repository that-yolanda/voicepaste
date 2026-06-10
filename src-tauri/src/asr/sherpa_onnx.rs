use async_trait::async_trait;
use sherpa_onnx::{
    OfflineRecognizer, OfflineRecognizerConfig, OfflineSenseVoiceModelConfig,
    OfflineTransducerModelConfig,
};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

use super::{AsrEngine, AsrEvent, AsrSession};
use crate::asr::vad::VadProcessor;
use crate::config::AsrOfflineConfig;
use crate::model;

/// Sherpa-ONNX ASR engine for local models.
pub struct SherpaOnnxEngine {
    data_dir: PathBuf,
    active_model_id: String,
    offline_config: AsrOfflineConfig,
}

impl SherpaOnnxEngine {
    pub fn new(
        data_dir: PathBuf,
        active_model_id: String,
        offline_config: AsrOfflineConfig,
    ) -> Self {
        Self {
            data_dir,
            active_model_id,
            offline_config,
        }
    }

    /// Build an OfflineRecognizer from the model directory.
    fn build_recognizer(
        &self,
        model_dir: &Path,
        model_id: &str,
        num_threads: u32,
    ) -> Result<OfflineRecognizer, String> {
        let p = |sub: &str| -> Option<String> {
            let path = model_dir.join(sub);
            if !path.exists() {
                return None;
            }
            path.to_str().map(|s| s.to_string())
        };

        let mut config = OfflineRecognizerConfig::default();
        config.model_config.num_threads = num_threads as i32;
        config.model_config.debug = cfg!(debug_assertions);

        // Detect model type by checking which files exist
        if p("model.int8.onnx").is_some() || p("model.onnx").is_some() {
            // SenseVoice / Paraformer style (single model file)
            let model_file = p("model.int8.onnx").or_else(|| p("model.onnx"));
            if let Some(model) = model_file {
                config.model_config.sense_voice = OfflineSenseVoiceModelConfig {
                    model: Some(model),
                    use_itn: true,
                    ..Default::default()
                };
                config.model_config.tokens = p("tokens.txt");
                config.model_config.model_type = Some("sense_voice".to_string());
            }
        } else if p("encoder-epoch-99-avg-1.int8.onnx").is_some()
            || model_id.contains("zipformer")
        {
            // Streaming Zipformer transducer
            config.model_config.transducer = OfflineTransducerModelConfig {
                encoder: p("encoder-epoch-99-avg-1.int8.onnx"),
                decoder: p("decoder-epoch-99-avg-1.onnx"),
                joiner: p("joiner-epoch-99-avg-1.int8.onnx"),
            };
            config.model_config.tokens = p("tokens.txt");
            config.model_config.model_type = Some("transducer".to_string());
        } else {
            return Err(format!(
                "无法识别模型 {} 的类型，请确认模型文件完整",
                model_id
            ));
        }

        OfflineRecognizer::create(&config)
            .ok_or_else(|| format!("创建识别器失败 (model: {})", model_id))
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

        // Build recognizer
        let recognizer = self.build_recognizer(
            &model_dir,
            &self.active_model_id,
            self.offline_config.num_threads,
        )?;

        // Build VAD
        let vad_dir = model::model_path(&self.data_dir, "silero-vad");
        let vad = VadProcessor::new(
            &vad_dir,
            &self.offline_config.vad,
            self.offline_config.num_threads,
        )?;

        let session = SherpaOnnxSession {
            is_ready: Arc::new(AtomicBool::new(true)),
            is_committed: Arc::new(AtomicBool::new(false)),
            recognizer: Arc::new(Mutex::new(Some(recognizer))),
            vad: Arc::new(Mutex::new(Some(vad))),
            accumulated_text: Arc::new(Mutex::new(String::new())),
            hotwords: hotwords.to_vec(),
        };

        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let _ = event_tx.send(AsrEvent::Open);

        Ok((Box::new(session), event_rx))
    }
}

// ---------------------------------------------------------------------------
// SherpaOnnxSession
// ---------------------------------------------------------------------------

/// Sherpa-ONNX ASR session using VAD + OfflineRecognizer.
/// All shared state uses std::sync::Mutex for access from blocking threads.
struct SherpaOnnxSession {
    is_ready: Arc<AtomicBool>,
    is_committed: Arc<AtomicBool>,
    recognizer: Arc<Mutex<Option<OfflineRecognizer>>>,
    vad: Arc<Mutex<Option<VadProcessor>>>,
    accumulated_text: Arc<Mutex<String>>,
    hotwords: Vec<String>,
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

        // Feed audio to VAD in a blocking thread (VAD + recognize are CPU-bound)
        let vad = self.vad.clone();
        let recognizer = self.recognizer.clone();
        let accumulated = self.accumulated_text.clone();
        let hotwords = self.hotwords.clone();
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

            let rec_guard = match recognizer.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            let recognizer = match rec_guard.as_ref() {
                Some(r) => r,
                None => return,
            };

            for segment_samples in segments {
                let duration = segment_samples.len() as f32 / 16000.0;
                if duration < 0.1 {
                    continue;
                }

                let stream = if hotwords.is_empty() {
                    recognizer.create_stream()
                } else {
                    // sherpa-onnx expects hotwords as newline-separated string
                    let hotwords_str = hotwords.join("\n");
                    recognizer.create_stream_with_hotwords(&hotwords_str)
                };
                stream.accept_waveform(16000, &segment_samples);
                recognizer.decode(&stream);

                if let Some(result) = stream.get_result() {
                    let text = result.text.trim().to_string();
                    if !text.is_empty() {
                        if let Ok(mut acc) = accumulated.lock() {
                            if !acc.is_empty() {
                                acc.push(' ');
                            }
                            acc.push_str(&text);
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

        // Flush VAD and recognize any remaining segments (CPU-bound)
        let vad = self.vad.clone();
        let recognizer = self.recognizer.clone();
        let accumulated = self.accumulated_text.clone();
        let hotwords = self.hotwords.clone();

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

            let rec_guard = match recognizer.lock() {
                Ok(g) => g,
                Err(_) => return accumulated.lock().map(|a| a.clone()).unwrap_or_default(),
            };
            let recognizer = match rec_guard.as_ref() {
                Some(r) => r,
                None => return accumulated.lock().map(|a| a.clone()).unwrap_or_default(),
            };

            let hotwords_str = if hotwords.is_empty() {
                String::new()
            } else {
                hotwords.join("\n")
            };

            let mut new_text = String::new();
            for segment_samples in segments {
                let duration = segment_samples.len() as f32 / 16000.0;
                if duration < 0.1 {
                    continue;
                }

                let stream = if hotwords_str.is_empty() {
                    recognizer.create_stream()
                } else {
                    recognizer.create_stream_with_hotwords(&hotwords_str)
                };
                stream.accept_waveform(16000, &segment_samples);
                recognizer.decode(&stream);

                if let Some(result) = stream.get_result() {
                    let text = result.text.trim().to_string();
                    if !text.is_empty() {
                        if !new_text.is_empty() {
                            new_text.push(' ');
                        }
                        new_text.push_str(&text);
                    }
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

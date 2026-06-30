pub mod doubao;
pub mod sherpa_onnx;

use std::path::PathBuf;

use async_trait::async_trait;
use tokio::sync::mpsc;

/// Unified ASR events sent from any engine to the app layer.
#[derive(Debug, Clone)]
pub enum AsrEvent {
    Open,
    Transcript {
        final_text: String,
        partial_text: String,
    },
    Error {
        message: String,
        /// Whether the error is unrecoverable (reconnecting cannot help). Fatal
        /// errors finalize the recording with whatever text was already
        /// recognized; non-fatal errors trigger an auto-reconnect attempt.
        fatal: bool,
    },
    Close {
        code: Option<u16>,
        reason: String,
    },
}

/// ASR engine trait — factory for creating recording sessions.
/// Each backend (Doubao WebSocket, sherpa-onnx, etc.) implements this.
#[async_trait]
pub trait AsrEngine: Send + Sync {
    /// Create a new recording session with optional hotwords.
    async fn create_session(
        &self,
        hotwords: &[String],
    ) -> Result<(Box<dyn AsrSession>, mpsc::UnboundedReceiver<AsrEvent>), String>;
}

/// ASR session trait — one recording session.
/// Created by an AsrEngine and used by the recording loop.
#[async_trait]
pub trait AsrSession: Send + Sync {
    /// Whether the session is ready to receive audio.
    fn is_ready(&self) -> bool;

    /// Append audio samples (16kHz mono f32 PCM).
    fn append_audio(&self, samples: &[f32]);

    /// Signal end-of-audio and wait for the final recognition result.
    async fn commit_and_await_final(&self) -> Result<String, String>;

    /// Close the session and release resources.
    fn close(&self);
}

/// Resolve the configured ASR engine from the model registry and open a new
/// session. Returns the session, its event receiver, and whether the overlay
/// should show a static "recording" hint (non-streaming engines produce no
/// partial results). Centralizes engine dispatch so the recording layer stays
/// unaware of which backend (sherpa-onnx vs Doubao) is configured.
pub async fn create_engine_session(
    config: &crate::config::AppConfig,
    registry: &crate::model::ModelRegistry,
    data_dir: PathBuf,
    resource_dir: PathBuf,
    hotwords: &[String],
) -> Result<(Box<dyn AsrSession>, mpsc::UnboundedReceiver<AsrEvent>, bool), String> {
    let engine_model_id = config.audio_provider();
    let entry = registry.models.iter().find(|m| m.id == engine_model_id);

    let (result, show_recording_hint) = match entry {
        Some(entry) if entry.engine == "sherpa-onnx" => {
            let punctuation_config = registry
                .models
                .iter()
                .find(|m| m.category == crate::model::ModelCategory::Punctuation)
                .and_then(|m| config.model_config_json(&m.id));
            let engine = sherpa_onnx::SherpaOnnxEngine::new(sherpa_onnx::SherpaOnnxEngineOptions {
                data_dir,
                resource_dir,
                active_model_id: engine_model_id.to_string(),
                vad_params: config.vad_params(registry),
                global_config: config.asr_defaults_json(registry),
                model_config: config.model_config_json(engine_model_id),
                punctuation_config,
                stream_simulate: config.stream_simulate(engine_model_id, registry),
            });
            // Non-streaming engines without simulated streaming produce no partials.
            let show_hint =
                !entry.capabilities.streaming && !config.stream_simulate(engine_model_id, registry);
            (engine.create_session(hotwords).await, show_hint)
        }
        _ => {
            // Default / volcengine: Doubao online engine
            let doubao_config = config.doubao_streaming_config(registry);
            let engine = doubao::DoubaoEngine::new(
                doubao_config.to_connection_config(),
                doubao_config.to_audio_config(),
                doubao_config.to_request_config(),
            );
            (engine.create_session(hotwords).await, false)
        }
    };

    result.map(|(session, event_rx)| (session, event_rx, show_recording_hint))
}

/// Apply engine-specific post-ASR text corrections. sherpa-onnx lowercases
/// proper nouns recognized via its hotword list, so their original casing is
/// restored here; other engines need no correction. Keeps the recording layer
/// from reaching into a specific engine's internals.
pub fn apply_post_asr_corrections(
    text: &str,
    hotwords: &[String],
    registry: &crate::model::ModelRegistry,
    model_id: &str,
) -> String {
    let is_sherpa = registry
        .models
        .iter()
        .find(|m| m.id == model_id)
        .map(|m| m.engine == "sherpa-onnx")
        .unwrap_or(false);
    if is_sherpa {
        sherpa_onnx::online::restore_hotword_case(text, hotwords)
    } else {
        text.to_string()
    }
}

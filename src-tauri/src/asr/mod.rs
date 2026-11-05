pub mod doubao;
pub mod elevenlabs;
pub mod sherpa_onnx;

use std::path::PathBuf;

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::errors::{AppError, AppErrorCode};

/// Unified ASR events sent from any engine to the app layer.
#[derive(Debug, Clone)]
pub enum AsrEvent {
    Open,
    Warning {
        error: AppError,
    },
    Transcript {
        final_text: String,
        partial_text: String,
    },
    Error {
        error: AppError,
        /// Whether the error is unrecoverable (reconnecting cannot help). Fatal
        /// errors fail the recording; recoverable errors may reconnect when
        /// the provider can preserve final-result integrity.
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
    ) -> Result<(Box<dyn AsrSession>, mpsc::UnboundedReceiver<AsrEvent>), AppError>;
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
    async fn commit_and_await_final(&self) -> Result<String, AppError>;

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
) -> Result<(Box<dyn AsrSession>, mpsc::UnboundedReceiver<AsrEvent>, bool), AppError> {
    let engine_model_id = config.audio_provider();
    let entry = registry.models.iter().find(|m| m.id == engine_model_id);

    let (result, show_recording_hint) = match entry {
        Some(entry) if entry.engine == "elevenlabs" => {
            let merged = crate::config::AppConfig::resolve_model_config(
                registry,
                engine_model_id,
                &config.audio,
            );
            let config = serde_json::from_value(merged).map_err(|_| {
                crate::errors::AppError::new(crate::errors::AppErrorCode::AsrConfigInvalid)
            })?;
            let engine = elevenlabs::ElevenLabsEngine::new(config);
            (engine.create_session(hotwords).await, false)
        }
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

/// Apply post-ASR text corrections: restore proper-noun casing that engines
/// (notably sherpa-onnx) may have lowercased, using the active hotword list.
/// Engine-agnostic and safe for every engine — engines that already preserve
/// casing have no variants to replace. `config.hotword_replace` decides whether
/// the caller invokes this at all. Keeps the recording layer out of hotword
/// text-processing internals.
pub fn apply_post_asr_corrections(text: &str, hotwords: &[String]) -> String {
    crate::hotword::restore_hotword_case(text, hotwords)
}

/// How long the "测试" probe waits for the engine's first lifecycle event
/// before reporting the provider as unreachable.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Probe one ASR provider's credentials by opening a throwaway engine session
/// and waiting for its first lifecycle event (manual "测试" button; never
/// triggered automatically). A session that opens proves endpoint + auth.
/// Engine-level failures (auth, network, protocol) return their classified
/// codes verbatim; only a silent provider maps to `asr.test_failed`.
/// Local providers have no network path — report success without touching
/// model files (the settings UI does not offer the button for them).
pub async fn test_asr_connection(
    config: &crate::config::AppConfig,
    registry: &crate::model::ModelRegistry,
    data_dir: PathBuf,
    resource_dir: PathBuf,
    provider_id: &str,
) -> Result<(), AppError> {
    use crate::model::{ModelCategory, ProviderKind};

    if registry
        .providers
        .iter()
        .any(|p| p.id == provider_id && p.kind == ProviderKind::Local)
    {
        return Ok(());
    }

    // Probe with the provider's first online ASR model, without touching the
    // saved default-model selection.
    let model_id = registry
        .models
        .iter()
        .find(|m| {
            m.provider.as_deref() == Some(provider_id)
                && m.category == ModelCategory::Asr
                && m.model_type == "online"
        })
        .map(|m| m.id.clone())
        .ok_or_else(|| {
            AppError::new(AppErrorCode::AsrModelNotInRegistry).with_param("model", provider_id)
        })?;
    let mut probe_config = config.clone();
    probe_config.audio.insert(
        "provider".to_string(),
        serde_norway::Value::String(model_id.clone()),
    );

    let (session, mut event_rx, _show_hint) =
        create_engine_session(&probe_config, registry, data_dir, resource_dir, &[]).await?;

    let outcome = tokio::time::timeout(PROBE_TIMEOUT, async {
        loop {
            match event_rx.recv().await {
                // Session accepted + authenticated: the probe succeeded.
                Some(AsrEvent::Open) | Some(AsrEvent::Transcript { .. }) => break Ok(()),
                Some(AsrEvent::Error { error, .. }) => break Err(error),
                Some(AsrEvent::Warning { .. }) => continue,
                // Socket closed (or dropped) before opening: handshake rejected.
                Some(AsrEvent::Close { code, reason }) => {
                    break Err(AppError::new(AppErrorCode::AsrTestFailed)
                        .with_param("provider", provider_id)
                        .with_detail(format!("close code={code:?} reason={reason}")));
                }
                None => {
                    break Err(AppError::new(AppErrorCode::AsrTestFailed)
                        .with_param("provider", provider_id)
                        .with_detail("event stream ended before the session opened"));
                }
            }
        }
    })
    .await;

    session.close();
    match outcome {
        Ok(result) => result,
        Err(_) => Err(AppError::new(AppErrorCode::AsrTestFailed)
            .with_param("provider", provider_id)
            .with_detail(format!("no lifecycle event within {}s", PROBE_TIMEOUT.as_secs()))),
    }
}

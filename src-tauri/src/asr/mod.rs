pub mod doubao;
pub mod sherpa_onnx;
pub mod stepfun;

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

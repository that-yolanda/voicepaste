use std::sync::Arc;
use tokio::sync::Mutex;

use crate::asr::{AsrEvent, AsrSession};
use crate::config::ConfigManager;
use crate::hotword::HotwordManager;
use crate::stats::StatsService;

/// Application recording state.
#[derive(Debug, Clone, PartialEq)]
pub enum AppState {
    Idle,
    Connecting,
    Recording,
    Finishing,
}

/// Global application state shared across all Tauri commands.
pub struct AppInner {
    pub state: Mutex<AppState>,
    pub config_manager: ConfigManager,
    pub hotword_manager: HotwordManager,
    pub log_path: std::path::PathBuf,
    pub stats: Mutex<StatsService>,
    pub asr_session: Mutex<Option<Arc<dyn AsrSession>>>,
    pub asr_events: Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<AsrEvent>>>,
    pub pending_audio_stop: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    pub pending_audio_warmup: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    pub latest_transcript: Mutex<(String, String)>, // (final_text, partial_text)
    /// Audio sample chunks captured before the ASR session is ready (background
    /// connect in progress, or during a reconnect gap). Drained into the session
    /// once it attaches. Always accessed while holding `asr_session` to stay
    /// ordered against the drain.
    pub pending_audio: Mutex<Vec<Vec<f32>>>,
    /// Resolves when the background ASR connect finishes (Ok) or fails (Err).
    /// `stop_recording` awaits this when the user stops before the session is ready.
    pub connect_rx: Mutex<Option<tokio::sync::oneshot::Receiver<Result<(), String>>>>,
    /// Recording-session generation. Bumped on each start and on cancel so a
    /// stale background connect task (from a cancelled/superseded session) can
    /// detect it is obsolete and discard its result.
    pub session_epoch: std::sync::atomic::AtomicU64,
    /// Finalized text carried across ASR reconnects within a single recording.
    /// Each reconnect starts a fresh server-side session with no memory of prior
    /// audio, so already-recognized text is accumulated here and prepended to the
    /// new session's output. Reset at the start of every recording.
    pub accumulated_text: Mutex<String>,
}

pub type AppHandle = Arc<AppInner>;

/// Create the shared application state.
pub fn create_app_state(
    config_manager: ConfigManager,
    hotword_manager: HotwordManager,
    log_path: std::path::PathBuf,
    stats_service: StatsService,
) -> AppHandle {
    Arc::new(AppInner {
        state: Mutex::new(AppState::Idle),
        config_manager,
        hotword_manager,
        log_path,
        stats: Mutex::new(stats_service),
        asr_session: Mutex::new(None),
        asr_events: Mutex::new(None),
        pending_audio_stop: Mutex::new(None),
        pending_audio_warmup: Mutex::new(None),
        latest_transcript: Mutex::new((String::new(), String::new())),
        pending_audio: Mutex::new(Vec::new()),
        connect_rx: Mutex::new(None),
        session_epoch: std::sync::atomic::AtomicU64::new(0),
        accumulated_text: Mutex::new(String::new()),
    })
}

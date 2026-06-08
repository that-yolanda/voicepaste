use std::sync::Arc;
use tokio::sync::Mutex;

use crate::asr::{AsrEvent, AsrSession};
use crate::config::ConfigManager;
use crate::logger::Logger;
use crate::stats::StatsService;

/// Application recording state.
#[derive(Debug, Clone, PartialEq)]
pub enum AppState {
    Idle,
    #[allow(dead_code)]
    Connecting,
    #[allow(dead_code)]
    Recording,
    #[allow(dead_code)]
    Finishing,
    #[allow(dead_code)]
    Error,
}

/// Global application state shared across all Tauri commands.
pub struct AppInner {
    pub state: Mutex<AppState>,
    pub config_manager: ConfigManager,
    pub logger: Mutex<Logger>,
    pub stats: Mutex<StatsService>,
    pub asr_session: Mutex<Option<Arc<AsrSession>>>,
    pub asr_events: Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<AsrEvent>>>,
    #[allow(dead_code)]
    pub pending_audio_stop: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    #[allow(dead_code)]
    pub active_prompt_id: Mutex<Option<String>>,
    #[allow(dead_code)]
    pub ws_ready: bool,
    #[allow(dead_code)]
    pub audio_warmup_ready: bool,
    #[allow(dead_code)]
    pub suppress_close_error: bool,
    #[allow(dead_code)]
    pub expecting_session_close: bool,
    #[allow(dead_code)]
    pub latest_transcript: Mutex<(String, String)>, // (final_text, partial_text)
}

pub type AppHandle = Arc<AppInner>;

/// Create the shared application state.
pub fn create_app_state(
    config_manager: ConfigManager,
    logger: Logger,
    stats: StatsService,
) -> AppHandle {
    Arc::new(AppInner {
        state: Mutex::new(AppState::Idle),
        config_manager,
        logger: Mutex::new(logger),
        stats: Mutex::new(stats),
        asr_session: Mutex::new(None),
        asr_events: Mutex::new(None),
        pending_audio_stop: Mutex::new(None),
        active_prompt_id: Mutex::new(None),
        ws_ready: false,
        audio_warmup_ready: false,
        suppress_close_error: false,
        expecting_session_close: false,
        latest_transcript: Mutex::new((String::new(), String::new())),
    })
}

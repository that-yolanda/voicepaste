use std::sync::Arc;
use tokio::sync::Mutex;

use crate::asr::{AsrEvent, AsrSession};
use crate::config::ConfigManager;
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
    pub log_path: std::path::PathBuf,
    pub stats: Mutex<StatsService>,
    pub asr_session: Mutex<Option<Arc<dyn AsrSession>>>,
    pub asr_events: Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<AsrEvent>>>,
    pub pending_audio_stop: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    pub pending_audio_warmup: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    pub latest_transcript: Mutex<(String, String)>, // (final_text, partial_text)
}

pub type AppHandle = Arc<AppInner>;

/// Create the shared application state.
pub fn create_app_state(
    config_manager: ConfigManager,
    log_path: std::path::PathBuf,
    stats_service: StatsService,
) -> AppHandle {
    Arc::new(AppInner {
        state: Mutex::new(AppState::Idle),
        config_manager,
        log_path,
        stats: Mutex::new(stats_service),
        asr_session: Mutex::new(None),
        asr_events: Mutex::new(None),
        pending_audio_stop: Mutex::new(None),
        pending_audio_warmup: Mutex::new(None),
        latest_transcript: Mutex::new((String::new(), String::new())),
    })
}

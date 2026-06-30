use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

use crate::asr::{AsrEvent, AsrSession};
use crate::config::ConfigManager;
use crate::hotkey;
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
    pub latest_transcript: Mutex<(String, String)>, // (final_text, partial_text)
    /// Audio sample chunks captured before the ASR session is ready (background
    /// connect in progress, or during a reconnect gap). Drained into the session
    /// once it attaches. Always accessed while holding `asr_session` to stay
    /// ordered against the drain.
    pub pending_audio: Mutex<Vec<Vec<f32>>>,
    /// Full-session 16k mono PCM captured from the same stream sent to ASR.
    /// Saved as a WAV when a recording is finalized, for diagnostics and review.
    pub recording_audio: Mutex<Vec<f32>>,
    /// WAV path for the current recording once saved.
    pub current_recording_wav: Mutex<Option<std::path::PathBuf>>,
    /// History timestamp of the failed entry currently being retried.
    pub current_retry_of: Mutex<Option<String>>,
    /// Latest failed history entry that has a WAV and can be retried from the overlay.
    pub current_failure_ts: Mutex<Option<String>>,
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
    /// Native microphone capture (cpal — CoreAudio on macOS, WASAPI on Windows,
    /// ALSA on Linux). The overlay renderer no longer captures audio.
    pub native_audio: Mutex<Option<crate::recording::NativeAudioCapture>>,
    /// Smoothed mic level feeding the overlay waveform. Updated by the audio
    /// emitter and consumed by `shared::wave_heights`, so both renderers share one
    /// smoothing state. Reset to 0 whenever the app leaves the Recording state.
    pub wave_smoothed: Mutex<f64>,
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
        latest_transcript: Mutex::new((String::new(), String::new())),
        pending_audio: Mutex::new(Vec::new()),
        recording_audio: Mutex::new(Vec::new()),
        current_recording_wav: Mutex::new(None),
        current_retry_of: Mutex::new(None),
        current_failure_ts: Mutex::new(None),
        connect_rx: Mutex::new(None),
        session_epoch: std::sync::atomic::AtomicU64::new(0),
        accumulated_text: Mutex::new(String::new()),
        native_audio: Mutex::new(None),
        wave_smoothed: Mutex::new(0.0),
    })
}

// ---------------------------------------------------------------------------
// Recording state machine helpers
// ---------------------------------------------------------------------------

/// Map an [`AppState`] to the string label emitted to the overlay and logged.
pub(crate) fn app_state_name(state: &AppState) -> &'static str {
    match state {
        AppState::Idle => "idle",
        AppState::Connecting => "connecting",
        AppState::Recording => "recording",
        AppState::Finishing => "finishing",
    }
}

/// ESC-cancel is only meaningful while a recording is in flight (or being
/// finalized). Idle keeps ESC off so it doesn't swallow ordinary key events.
pub(crate) fn should_enable_escape_shortcut(state: &AppState) -> bool {
    matches!(
        state,
        AppState::Connecting | AppState::Recording | AppState::Finishing
    )
}

/// Enable/disable the global ESC shortcut to match the new recording state.
pub(crate) fn sync_escape_shortcut(app: &tauri::AppHandle, state: &AppState) {
    if let Some(hc) = app.try_state::<hotkey::HotkeyConfig>() {
        hotkey::set_escape_enabled(&hc, should_enable_escape_shortcut(state));
    }
}

/// Transition to `next_state`: persist it, reset waveform smoothing when leaving
/// Recording, sync the ESC shortcut, and broadcast the change to the overlay.
pub(crate) async fn set_app_state(
    app: &tauri::AppHandle,
    app_inner: &Arc<AppInner>,
    next_state: AppState,
) {
    *app_inner.state.lock().await = next_state.clone();
    // Reset the waveform smoothing whenever we leave Recording, so the next
    // session's bars don't start from a stale loudness tail.
    if next_state != AppState::Recording {
        *app_inner.wave_smoothed.lock().await = 0.0;
    }
    sync_escape_shortcut(app, &next_state);

    let _ = app.emit(
        "overlay:event",
        serde_json::json!({
            "type": "state",
            "payload": { "state": app_state_name(&next_state) }
        }),
    );
    log_rec!(info, "State → {}", app_state_name(&next_state));
}

// ---------------------------------------------------------------------------
// Tauri managed-state wrappers
// ---------------------------------------------------------------------------

/// Wrapper to keep the HotkeyManager alive as Tauri managed state.
/// The `_inner` field is intentionally never read — its purpose is to hold
/// ownership of the HotkeyManager so its Drop stops the keytap listener.
pub struct HotkeyManagerState {
    pub _inner: std::sync::Mutex<hotkey::HotkeyManager>,
}

/// Simple recording toggle state managed by Tauri.
pub struct RecordingState(pub std::sync::Mutex<bool>);

/// Hotkey mode: "toggle" (press once to start, press again to stop) or "hold" (hold to speak).
pub struct HotkeyMode(pub std::sync::Mutex<String>);

/// Tracks which prompt template triggered the current recording session.
/// `None` means the main hotkey was used (not a prompt-specific hotkey).
pub struct ActivePromptId(pub std::sync::Mutex<Option<String>>);

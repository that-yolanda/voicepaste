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
/// A polish attempt that failed and is waiting on the user. Holds everything
/// needed to either retry the polish or fall back to pasting the raw text.
#[derive(Debug, Clone)]
pub struct PendingPolish {
    /// Recognized text after ASR cleanup, ready to paste as-is on fallback.
    pub raw_text: String,
    /// Prompt template the failed polish used, so a retry uses the same one.
    pub prompt_id: String,
}

/// Interruption for an in-flight polish retry, triggered by ESC/Enter while
/// the "润色中…" pass is running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolishRetryCommand {
    /// ESC: abort the retry and discard the text (no paste, no history entry).
    Cancel,
    /// Enter: abort the retry and paste the raw text immediately.
    DeliverRaw,
}

pub struct AppInner {
    pub overlay_epoch: std::sync::atomic::AtomicU64,
    pub feedback_visible: std::sync::atomic::AtomicBool,
    pub recording_hints: Mutex<Option<crate::overlay::shared::RecordingHints>>,
    pub recording_mode: Mutex<hotkey::HotkeyMode>,
    pub state: Mutex<AppState>,
    /// Resolved UI language (from `app.language`; `auto` already reflects the
    /// OS locale). Read on synchronous paths (tray rebuild, native overlay
    /// rendering, event emits) which cannot await, hence a std RwLock holding
    /// a Copy enum. Written once per language change.
    pub language: std::sync::RwLock<crate::lang::Language>,
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
    /// A failed LLM polish awaiting the user's decision. While this is set the
    /// recognized text has NOT been pasted yet: the overlay shows why polishing
    /// failed, the main hotkey retries, ESC discards the text,
    /// Enter pastes the raw text immediately, and a timer delivers it
    /// automatically if the user does nothing.
    pub pending_polish: Mutex<Option<PendingPolish>>,
    /// Generation counter for `pending_polish`. The auto-deliver timer captures
    /// the epoch it was armed with and stands down if a retry or ESC bumped it.
    pub polish_epoch: std::sync::atomic::AtomicU64,
    /// Whether a polish retry is currently in flight (between taking the
    /// pending text and delivering/re-arming it). Hotkey routing consults this
    /// to ignore presses and stray stops while the retry runs.
    pub polish_retry_active: std::sync::atomic::AtomicBool,
    /// Sender half of the interruption channel owned by the in-flight polish
    /// retry task. The receiver lives only inside that task, so commands sent
    /// after it finished are dropped with it.
    pub polish_retry_cmd_tx: Mutex<Option<tokio::sync::mpsc::UnboundedSender<PolishRetryCommand>>>,
    /// Shared sound detector, reset between recording sessions.
    pub wave_activity: Mutex<crate::overlay::shared::WaveActivity>,
}

pub type AppHandle = Arc<AppInner>;

/// Create the shared application state.
pub fn create_app_state(
    config_manager: ConfigManager,
    hotword_manager: HotwordManager,
    log_path: std::path::PathBuf,
    stats_service: StatsService,
    language: crate::lang::Language,
) -> AppHandle {
    Arc::new(AppInner {
        overlay_epoch: std::sync::atomic::AtomicU64::new(0),
        feedback_visible: std::sync::atomic::AtomicBool::new(false),
        recording_hints: Mutex::new(None),
        recording_mode: Mutex::new(hotkey::HotkeyMode::Toggle),
        state: Mutex::new(AppState::Idle),
        language: std::sync::RwLock::new(language),
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
        pending_polish: Mutex::new(None),
        polish_epoch: std::sync::atomic::AtomicU64::new(0),
        polish_retry_active: std::sync::atomic::AtomicBool::new(false),
        polish_retry_cmd_tx: Mutex::new(None),
        wave_activity: Mutex::new(crate::overlay::shared::WaveActivity::default()),
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
    if next_state != AppState::Idle {
        crate::overlay::invalidate_feedback(app_inner);
        crate::overlay::emit_shortcuts(app, &[]);
    }
    if next_state != AppState::Recording {
        *app_inner.recording_hints.lock().await = None;
    }
    *app_inner.state.lock().await = next_state.clone();
    // Reset sound activity so a new session starts with resting bars.
    if next_state != AppState::Recording {
        *app_inner.wave_activity.lock().await = crate::overlay::shared::WaveActivity::default();
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

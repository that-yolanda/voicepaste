//! Platform-agnostic overlay layout constants + derived-state logic.
//!
//! Single source of truth shared by the macOS native renderer (`overlay.rs`
//! macos module, which imports these directly) and the event emitters. The
//! Windows WebView fetches the layout constants via `get_overlay_layout_metrics`
//! and receives sound activity inside event payloads. Both renderers animate
//! locally using the same waveform timing and height constants.

// --- Layout constants (logical px). The macOS renderer imports these directly;
// the Windows WebView receives them via get_overlay_layout_metrics. ---
#[cfg(target_os = "macos")]
pub const FONT_SIZE: f64 = 14.0;
pub const PAD_LEFT: f64 = 16.0;
pub const PAD_RIGHT: f64 = 16.0;
pub const INDICATOR_W: f64 = 16.0;
#[cfg(target_os = "macos")]
pub const ICON_SIZE: f64 = 16.0;
pub const GAP: f64 = 12.0;
pub const PILL_H_SINGLE: f64 = 40.0;
pub const SINGLE_LINE_LIMIT: f64 = 520.0;
pub const MULTI_LINE_WIDTH: f64 = 520.0;
pub const MIN_PILL_W: f64 = 48.0;
pub const TEXT_SLACK: f64 = 10.0;
#[cfg(target_os = "macos")]
pub const MAX_LINES: usize = 3;
#[cfg(target_os = "macos")]
pub const BOTTOM_OFFSET: f64 = 48.0;

// --- Waveform (4 bars in the indicator slot, recording only) ---
pub const WAVE_N: usize = 4;
pub const WAVE_BAR_W: f64 = 4.0;
pub const WAVE_BAR_GAP: f64 = 2.0;
pub const WAVE_AREA_W: f64 = WAVE_BAR_W * WAVE_N as f64 + WAVE_BAR_GAP * (WAVE_N - 1) as f64; // 22
pub const WAVE_MAX_H: f64 = 22.0;
pub const WAVE_MIN_H: f64 = 4.0;
pub const WAVE_CORNER_RADIUS: f64 = WAVE_BAR_W / 2.0;
/// One cycle per bar, in seconds. Different periods keep the bars out of sync.
pub const WAVE_DURATIONS: [f64; WAVE_N] = [0.85, 0.7, 1.0, 0.8];
pub const WAVE_PEAKS: [f64; WAVE_N] = [0.65, 1.0, 0.85, 0.55];
pub const WAVE_SETTLE_SECONDS: f64 = 0.18;

/// Sound activity gates the animation; it never controls its amplitude.
/// Uses the same raw PCM gate as the recording no-speech check.
#[derive(Default)]
pub struct WaveActivity {
    last_sound: Option<std::time::Instant>,
}

impl WaveActivity {
    pub fn update(&mut self, samples: &[f32], now: std::time::Instant) -> bool {
        if crate::recording::audio_chunk_has_signal(samples) {
            self.last_sound = Some(now);
            return true;
        }
        self.last_sound
            .is_some_and(|last| now.duration_since(last) < std::time::Duration::from_millis(300))
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct Shortcut {
    pub key: String,
    pub label: String,
    /// Optional i18n key suffix for system actions ("retry"/"cancel"/"done"/"raw").
    /// When present, renderers localize the action name instead of using `label`;
    /// `label` stays as the verbatim fallback and for user data (prompt titles).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_key: Option<String>,
}

impl Shortcut {
    pub fn new(key: impl Into<String>, label: &str) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            label_key: None,
        }
    }

    /// System shortcut whose action name is localized via `ui.overlay.shortcut_*`.
    pub fn keyed(key: impl Into<String>, label: &str, label_key: &str) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            label_key: Some(label_key.into()),
        }
    }
}

/// Recording hints use raw signal timing, independently of waveform smoothing.
pub struct RecordingHints {
    pub toggle: bool,
    pub shortcuts: Vec<Shortcut>,
    pub last_signal: std::time::Instant,
    pub shown: bool,
}

impl RecordingHints {
    pub fn update(&mut self, signal: bool, now: std::time::Instant) -> bool {
        if signal {
            self.last_signal = now;
        }
        if self.toggle
            && !self.shown
            && now.duration_since(self.last_signal) >= std::time::Duration::from_secs(2)
        {
            self.shown = true;
            return true;
        }
        false
    }
}

/// Logical overlay state used to derive display text. Parallels the Windows
/// WebView's `OverlayState`; only the macOS renderer holds a live instance.
#[derive(Default)]
#[cfg(any(target_os = "macos", test))]
pub struct Model {
    pub shortcuts: Vec<Shortcut>,
    pub final_text: String,
    pub partial_text: String,
    pub hint_text: String,
    pub hint_level: String,   // "info" | "warn" | "error"
    pub hint_variant: String, // "text" | "progress" | "retry" | "success"
    pub app_state: String,    // "idle" | "connecting" | "recording" | "finishing"
    /// Sticky pill layout (prevents width jitter while recording/finishing).
    pub layout_width: f64,
    pub layout_wrap: bool,
    /// Appearance (macOS renderer only; loaded from config, refreshed on
    /// "appearance" events). Unused by the Windows WebView.
    pub style: String, // "liquid" | "liquid-standard" | "vibrancy"
    pub theme: String, // app.theme: "system" | "light" | "dark"
    /// UI language for the state placeholders in [`visible_hint`] (loaded
    /// from the shared language state, refreshed on "appearance" events).
    pub language: crate::lang::Language,
    pub loaded: bool,
}

/// The hint text shown in the pill body. State-driven placeholders take
/// precedence over the backend hint message. This is the authoritative logic;
/// the Windows WebView keeps an aligned TS copy in `overlayText`.
#[cfg(any(target_os = "macos", test))]
pub fn visible_hint(model: &Model) -> String {
    if model.hint_variant == "success" {
        return model.hint_text.clone();
    }
    let visual_state = model.app_state.as_str();
    let zh = model.language == crate::lang::Language::ZhCn;
    if visual_state == "connecting" {
        return if zh {
            "准备中".into()
        } else {
            "Preparing…".into()
        };
    }
    if visual_state == "finishing" && model.hint_variant == "retry" {
        // Placeholder shown only until the replayed transcript starts streaming
        // in; then yield to the live text below.
        if model.final_text.is_empty() && model.partial_text.is_empty() {
            return if zh {
                "重试中".into()
            } else {
                "Retrying…".into()
            };
        }
        return String::new();
    }
    if visual_state == "finishing" && model.hint_variant == "progress" {
        return if zh {
            "润色中".into()
        } else {
            "Polishing…".into()
        };
    }
    if visual_state == "finishing" && model.hint_text.is_empty() {
        return if zh {
            "识别中".into()
        } else {
            "Recognizing…".into()
        };
    }
    // Action shortcuts live above the pill; its body contains only the hint.
    model.hint_text.clone()
}

/// Layout constants exposed to the Windows WebView via `get_overlay_layout_metrics`.
/// The TS layout hook still measures text width in the DOM (font metrics are
/// platform-specific and can't move off the frontend), but every chrome constant
/// comes from here so the two pills size identically.
#[derive(serde::Serialize)]
pub struct LayoutMetrics {
    pub pad_left: f64,
    pub pad_right: f64,
    pub indicator_w: f64,
    pub gap: f64,
    pub pill_h_single: f64,
    pub single_line_limit: f64,
    pub multi_line_width: f64,
    pub min_pill_w: f64,
    pub text_slack: f64,
    pub wave_area_w: f64,
    pub wave_bar_w: f64,
    pub wave_bar_gap: f64,
    pub wave_corner_radius: f64,
    pub wave_min_h: f64,
    pub wave_max_h: f64,
    pub wave_durations: [f64; WAVE_N],
    pub wave_peaks: [f64; WAVE_N],
    pub wave_settle_seconds: f64,
}

impl LayoutMetrics {
    pub fn current() -> Self {
        Self {
            pad_left: PAD_LEFT,
            pad_right: PAD_RIGHT,
            indicator_w: INDICATOR_W,
            gap: GAP,
            pill_h_single: PILL_H_SINGLE,
            single_line_limit: SINGLE_LINE_LIMIT,
            multi_line_width: MULTI_LINE_WIDTH,
            min_pill_w: MIN_PILL_W,
            text_slack: TEXT_SLACK,
            wave_area_w: WAVE_AREA_W,
            wave_bar_w: WAVE_BAR_W,
            wave_bar_gap: WAVE_BAR_GAP,
            wave_corner_radius: WAVE_CORNER_RADIUS,
            wave_min_h: WAVE_MIN_H,
            wave_max_h: WAVE_MAX_H,
            wave_durations: WAVE_DURATIONS,
            wave_peaks: WAVE_PEAKS,
            wave_settle_seconds: WAVE_SETTLE_SECONDS,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(state: &str, hint: &str, variant: &str) -> Model {
        Model {
            app_state: state.into(),
            hint_text: hint.into(),
            hint_variant: variant.into(),
            language: crate::lang::Language::ZhCn,
            ..Default::default()
        }
    }

    #[test]
    fn visible_hint_state_placeholders() {
        assert_eq!(visible_hint(&model("connecting", "", "text")), "准备中");
        assert_eq!(visible_hint(&model("finishing", "", "progress")), "润色中");
        // Retry placeholder only while no transcript has streamed in yet.
        assert_eq!(visible_hint(&model("finishing", "", "retry")), "重试中");
        // Once transcript text arrives during a retry, yield to the live text.
        let mut m = model("finishing", "", "retry");
        m.final_text = "你好".into();
        assert_eq!(visible_hint(&m), "");
    }

    #[test]
    fn visible_hint_state_placeholders_in_english() {
        let mut m = Model {
            app_state: "connecting".into(),
            ..Default::default()
        }; // default language is English
        assert_eq!(visible_hint(&m), "Preparing…");
        m.app_state = "finishing".into();
        m.hint_variant = "progress".into();
        assert_eq!(visible_hint(&m), "Polishing…");
        m.hint_variant = "retry".into();
        assert_eq!(visible_hint(&m), "Retrying…");
        m.hint_variant = "text".into();
        assert_eq!(visible_hint(&m), "Recognizing…");
    }

    #[test]
    fn visible_hint_falls_back_to_hint_text() {
        assert_eq!(
            visible_hint(&model("recording", "录制中…", "text")),
            "录制中…"
        );
        assert_eq!(visible_hint(&model("idle", "出错了", "text")), "出错了");
    }

    #[test]
    fn recording_hints_show_at_two_seconds_and_remain_after_speech() {
        let now = std::time::Instant::now();
        let mut hints = RecordingHints {
            toggle: true,
            shortcuts: vec![],
            last_signal: now,
            shown: false,
        };
        assert!(!hints.update(false, now + std::time::Duration::from_millis(1999)));
        assert!(hints.update(false, now + std::time::Duration::from_secs(2)));
        assert!(!hints.update(true, now + std::time::Duration::from_secs(3)));
        assert!(hints.shown);
    }

    #[test]
    fn recording_hints_reset_pause_on_signal_without_waveform_hold() {
        let now = std::time::Instant::now();
        let mut hints = RecordingHints {
            toggle: true,
            shortcuts: vec![],
            last_signal: now,
            shown: false,
        };
        assert!(!hints.update(true, now + std::time::Duration::from_secs(1)));
        assert!(!hints.update(false, now + std::time::Duration::from_millis(2999)));
        assert!(hints.update(false, now + std::time::Duration::from_secs(3)));
        let mut hold = RecordingHints {
            toggle: false,
            shortcuts: vec![],
            last_signal: now,
            shown: false,
        };
        assert!(!hold.update(false, now + std::time::Duration::from_secs(30)));
        assert!(!hold.shown);
    }

    #[test]
    fn visible_hint_does_not_mistake_an_empty_success_for_processing() {
        assert_eq!(visible_hint(&model("idle", "", "success")), "");
        assert_eq!(visible_hint(&model("finishing", "", "success")), "");
        assert_eq!(visible_hint(&model("finishing", "", "text")), "识别中");
    }

    fn speech() -> Vec<f32> {
        (0..1600).map(|i| 0.024 * (i as f32 * 0.2).sin()).collect()
    }

    #[test]
    fn wave_activity_rejects_noise_and_isolated_clicks() {
        let mut activity = WaveActivity::default();
        let now = std::time::Instant::now();
        assert!(!activity.update(&[], now));
        assert!(!activity.update(&[0.0; 1600], now));
        assert!(!activity.update(&[0.002; 1600], now));
        // RMS alone is insufficient: low continuous hum must not trigger.
        assert!(!activity.update(&[0.01; 1600], now));
        let mut click = [0.0; 1600];
        click[0] = 0.05;
        assert!(!activity.update(&click, now));
        assert!(activity.update(&speech(), now));
    }

    #[test]
    fn wave_activity_holds_short_pauses_but_noise_cannot_extend_them() {
        let mut activity = WaveActivity::default();
        let now = std::time::Instant::now();
        assert!(activity.update(&speech(), now));
        assert!(activity.update(&[0.002; 1600], now + std::time::Duration::from_millis(200)));
        assert!(!activity.update(&[0.002; 1600], now + std::time::Duration::from_millis(300)));
        assert!(!activity.update(&[0.002; 1600], now + std::time::Duration::from_millis(500)));
        assert!(activity.update(&speech(), now + std::time::Duration::from_millis(600)));
        activity = WaveActivity::default();
        assert!(!activity.update(&[0.002; 1600], now + std::time::Duration::from_millis(700)));
    }
}

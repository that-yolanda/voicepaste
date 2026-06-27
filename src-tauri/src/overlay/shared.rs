//! Platform-agnostic overlay layout constants + derived-state logic.
//!
//! Single source of truth shared by the macOS native renderer (`overlay.rs`
//! macos module, which imports these directly) and the event emitters. The
//! Windows WebView fetches the layout constants via `get_overlay_layout_metrics`
//! and receives derived values (`waveHeights`) inside event payloads, so the two
//! renderers are driven by the same numbers instead of hand-mirrored copies.

// --- Layout constants (logical px). The macOS renderer imports these directly;
// the Windows WebView receives them via get_overlay_layout_metrics. ---
#[cfg(target_os = "macos")]
pub const FONT_SIZE: f64 = 14.0;
pub const PAD_LEFT: f64 = 14.0;
pub const PAD_RIGHT: f64 = 16.0;
pub const INDICATOR_W: f64 = 22.0;
pub const GAP: f64 = 12.0;
#[cfg(target_os = "macos")]
pub const DOT_SIZE: f64 = 14.0;
pub const PILL_H_SINGLE: f64 = 40.0;
pub const SINGLE_LINE_LIMIT: f64 = 520.0;
pub const MULTI_LINE_WIDTH: f64 = 520.0;
pub const MIN_PILL_W: f64 = 116.0;
pub const TEXT_SLACK: f64 = 10.0;
#[cfg(target_os = "macos")]
pub const MAX_LINES: usize = 3;
#[cfg(target_os = "macos")]
pub const BOTTOM_OFFSET: f64 = 48.0;

// --- Retry affordance geometry ---
pub const RETRY_SIZE: f64 = 22.0;
#[cfg(target_os = "macos")]
pub const RETRY_MIN_W: f64 = 38.0;
#[cfg(target_os = "macos")]
pub const RETRY_TEXT_PAD: f64 = 24.0;
pub const RETRY_GAP_LEFT: f64 = 8.0;
#[cfg(target_os = "macos")]
pub const RETRY_RIGHT_INSET: f64 = 26.0;

// --- Waveform (4 bars, right side, recording only) ---
pub const WAVE_N: usize = 4;
pub const WAVE_BAR_W: f64 = 3.0;
pub const WAVE_BAR_GAP: f64 = 2.0;
pub const WAVE_AREA_W: f64 = WAVE_BAR_W * WAVE_N as f64 + WAVE_BAR_GAP * (WAVE_N - 1) as f64; // 18
pub const WAVE_GAP_LEFT: f64 = 12.0;
pub const WAVE_MAX_H: f64 = 22.0;
pub const WAVE_MIN_H: f64 = 3.0;
/// Smoothing factor applied to the raw mic level before deriving bar heights.
pub const WAVE_SMOOTH: f64 = 0.35;

/// Smooth a raw 0..1 mic level (`smoothed` is caller-held state across calls)
/// and derive the `WAVE_N` per-bar heights — center bars taller via a symmetric
/// weight. The audio emitter calls this and puts the result in the `audio:level`
/// payload, so neither renderer re-computes the waveform.
pub fn wave_heights(smoothed: &mut f64, level: f64) -> [f64; WAVE_N] {
    *smoothed += (level - *smoothed) * WAVE_SMOOTH;
    let lvl = smoothed.clamp(0.0, 1.0);
    let mut out = [WAVE_MIN_H; WAVE_N];
    for (i, slot) in out.iter_mut().enumerate().take(WAVE_N) {
        let dist = ((i as f64) - 1.5).abs() / 1.5; // 0 (center) .. 1 (edge)
        let weight = 1.0 - 0.45 * dist;
        *slot = WAVE_MIN_H + (WAVE_MAX_H - WAVE_MIN_H) * (lvl * weight).clamp(0.0, 1.0);
    }
    out
}

/// Logical overlay state used to derive display text. Parallels the Windows
/// WebView's `OverlayState`; only the macOS renderer holds a live instance.
#[derive(Default)]
#[cfg(any(target_os = "macos", test))]
pub struct Model {
    pub final_text: String,
    pub partial_text: String,
    pub hint_text: String,
    pub hint_level: String,   // "info" | "warn" | "error"
    pub hint_variant: String, // "text" | "progress" | "retry"
    pub hint_retryable: bool,
    pub retry_hotkey: String, // formatted main hotkey label, e.g. "R ⌥"
    pub app_state: String,    // "idle" | "connecting" | "recording" | "finishing"
    /// Sticky pill layout (prevents width jitter while recording/finishing).
    pub layout_width: f64,
    pub layout_wrap: bool,
    /// Appearance (macOS renderer only; loaded from config, refreshed on
    /// "appearance" events). Unused by the Windows WebView.
    pub style: String, // "liquid" | "liquid-standard" | "vibrancy"
    pub theme: String, // app.theme: "system" | "light" | "dark"
    pub loaded: bool,
}

/// The hint text shown in the pill body. State-driven placeholders take
/// precedence over the backend hint message. This is the authoritative logic;
/// the Windows WebView keeps an aligned TS copy in `overlayText`.
#[cfg(any(target_os = "macos", test))]
pub fn visible_hint(model: &Model) -> String {
    let visual_state = model.app_state.as_str();
    let zh = true; // app is Chinese-first; matches the WebView's isZhLocale default.
    if visual_state == "connecting" {
        return if zh {
            "准备中…".into()
        } else {
            "Preparing…".into()
        };
    }
    if visual_state == "finishing" && model.hint_variant == "retry" {
        // Placeholder shown only until the replayed transcript starts streaming
        // in; then yield to the live text below.
        if model.final_text.is_empty() && model.partial_text.is_empty() {
            return if zh {
                "重试中…".into()
            } else {
                "Retrying…".into()
            };
        }
        return String::new();
    }
    if visual_state == "finishing" && model.hint_variant == "progress" {
        return if zh {
            "润色中…".into()
        } else {
            "Polishing…".into()
        };
    }
    // The retry label + hotkey live inside the retry button, not in the message
    // text, so the hint is just the error message.
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
    pub wave_gap_left: f64,
    pub retry_size: f64,
    pub retry_gap_left: f64,
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
            wave_gap_left: WAVE_GAP_LEFT,
            retry_size: RETRY_SIZE,
            retry_gap_left: RETRY_GAP_LEFT,
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
            ..Default::default()
        }
    }

    #[test]
    fn visible_hint_state_placeholders() {
        assert_eq!(visible_hint(&model("connecting", "", "text")), "准备中…");
        assert_eq!(visible_hint(&model("finishing", "", "progress")), "润色中…");
        // Retry placeholder only while no transcript has streamed in yet.
        assert_eq!(visible_hint(&model("finishing", "", "retry")), "重试中…");
        // Once transcript text arrives during a retry, yield to the live text.
        let mut m = model("finishing", "", "retry");
        m.final_text = "你好".into();
        assert_eq!(visible_hint(&m), "");
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
    fn wave_heights_symmetric_and_bounded() {
        let mut s = 0.0;
        let h = wave_heights(&mut s, 1.0);
        // All within [MIN, MAX].
        assert!(h.iter().all(|&v| (WAVE_MIN_H..=WAVE_MAX_H).contains(&v)));
        // Symmetric: bar 0 == bar 3, bar 1 == bar 2 (center taller).
        assert!((h[0] - h[3]).abs() < 1e-9);
        assert!((h[1] - h[2]).abs() < 1e-9);
        assert!(h[1] >= h[0]);
    }

    #[test]
    fn wave_heights_smooths_toward_level() {
        let mut s = 0.0;
        let first = wave_heights(&mut s, 1.0);
        // After repeated max input the smoothed value converges upward.
        for _ in 0..50 {
            let _ = wave_heights(&mut s, 1.0);
        }
        let converged = wave_heights(&mut s, 1.0);
        assert!(converged[1] > first[1]);
        assert!(converged[1] <= WAVE_MAX_H + 1e-9);
    }
}

//! Overlay event dispatch + native macOS Liquid Glass renderer.
//!
//! The backend already emits every overlay visual update as an `overlay:event`
//! (consumed by the WebView). A single Rust-side listener (registered in `lib.rs`)
//! forwards those same events here via [`handle_event`]. On Windows this is a no-op
//! (the WebView is the sole renderer). On macOS the event drives a native AppKit pill
//! rendered *inside* an `NSGlassEffectView`, so the transcript text receives the OS's
//! built-in, content-aware legibility adaptation (the whole point of the refactor) —
//! and the WebView is reduced to a hidden audio worker (see web/app.js).

use tauri::AppHandle;

/// Forward an `overlay:event` to the native macOS renderer. No-op elsewhere.
#[allow(unused_variables)]
pub fn handle_event(app: &AppHandle, event: &serde_json::Value) {
    #[cfg(target_os = "macos")]
    macos::dispatch(app, event);
}

/// Feed a microphone level (0..1) to the native waveform. No-op elsewhere.
#[allow(unused_variables)]
pub fn set_audio_level(app: &AppHandle, level: f64) {
    #[cfg(target_os = "macos")]
    macos::set_audio_level(app, level);
}

/// Native macOS overlay renderer. Builds and updates an AppKit pill
/// (`NSGlassEffectView` → container → indicator + transcript label) living inside
/// the overlay window's content view, above the transparent WebView.
#[cfg(target_os = "macos")]
mod macos {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, MainThreadMarker};
    use objc2_app_kit::{
        NSAppearance, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSColor, NSFont,
        NSGlassEffectView, NSGlassEffectViewStyle, NSLineBreakMode, NSProgressIndicator,
        NSProgressIndicatorStyle, NSTextField, NSView, NSVisualEffectBlendingMode,
        NSVisualEffectMaterial, NSVisualEffectState, NSVisualEffectView, NSWindow,
    };
    use objc2_foundation::{
        NSArray, NSAttributedString, NSMutableAttributedString, NSNumber, NSPoint, NSRange, NSRect,
        NSSize, NSString,
    };
    use std::cell::RefCell;
    use tauri::{AppHandle, Manager};

    // --- Layout constants (mirror web/styles.css + app.js scheduleResize) ---
    const FONT_SIZE: f64 = 14.0;
    const PAD_LEFT: f64 = 14.0;
    const PAD_RIGHT: f64 = 16.0;
    const INDICATOR_W: f64 = 22.0;
    const GAP: f64 = 12.0;
    const DOT_SIZE: f64 = 14.0;
    const PILL_H_SINGLE: f64 = 40.0;
    const SINGLE_LINE_LIMIT: f64 = 520.0;
    const MULTI_LINE_WIDTH: f64 = 520.0;
    const MIN_PILL_W: f64 = 116.0;
    const TEXT_SLACK: f64 = 10.0;
    const MAX_LINES: usize = 3;
    const BOTTOM_OFFSET: f64 = 48.0;
    // Waveform (right side, recording only) — mirrors web .status-bars (4 bars).
    const WAVE_N: usize = 4;
    const WAVE_BAR_W: f64 = 3.0;
    const WAVE_BAR_GAP: f64 = 2.0;
    const WAVE_AREA_W: f64 = WAVE_BAR_W * 4.0 + WAVE_BAR_GAP * 3.0; // 18
    const WAVE_GAP_LEFT: f64 = 12.0; // gap between text and waveform
    const WAVE_MAX_H: f64 = 22.0;
    const WAVE_MIN_H: f64 = 3.0;

    /// Logical overlay model, mirrored from overlay events (parallels app.js `state`).
    #[derive(Default)]
    struct Model {
        final_text: String,
        partial_text: String,
        hint_text: String,
        hint_level: String,   // "info" | "warn" | "error"
        hint_variant: String, // "text" | "progress"
        app_state: String,    // "idle" | "connecting" | "recording" | "finishing"
        // Sticky layout (prevents width jitter while recording/finishing).
        layout_width: f64,
        layout_wrap: bool,
        // Waveform: smoothed mic level + per-bar heights (driven by audio chunks).
        smoothed_level: f64,
        wave_heights: [f64; WAVE_N],
        // Appearance (loaded from config, refreshed on "appearance" events).
        style: String, // "liquid" (通透) | "liquid-standard" (标准) | "vibrancy"
        theme: String, // app.theme: "system" | "light" | "dark" — only applied for vibrancy
        loaded: bool,
    }

    enum GlassKind {
        Liquid(Retained<NSGlassEffectView>),
        Vibrancy(Retained<NSVisualEffectView>),
    }

    impl GlassKind {
        fn view(&self) -> &NSView {
            match self {
                GlassKind::Liquid(v) => v,
                GlassKind::Vibrancy(v) => v,
            }
        }
        fn kind(&self) -> &'static str {
            match self {
                GlassKind::Liquid(_) => "liquid",
                GlassKind::Vibrancy(_) => "vibrancy",
            }
        }
    }

    /// The retained native view tree (built once, updated per render).
    struct Views {
        glass: GlassKind,
        container: Retained<NSView>,
        indicator: Retained<NSView>,
        spinner: Retained<NSProgressIndicator>,
        label: Retained<NSTextField>,
        bars: [Retained<NSView>; WAVE_N],
        dot_layer: Retained<AnyObject>, // CALayer for the indicator dot
        ripple_layer: Retained<AnyObject>, // CALayer halo behind the dot (recording ripple)
        fade_mask: Retained<AnyObject>, // CAGradientLayer for the multi-line top fade
        applied_variant: String, // "" (auto/inherit) | "light" | "dark"
    }

    thread_local! {
        static MODEL: RefCell<Model> = RefCell::new(Model::default());
        static VIEWS: RefCell<Option<Views>> = const { RefCell::new(None) };
    }

    fn liquid_glass_available() -> bool {
        objc2::runtime::AnyClass::get(c"NSGlassEffectView").is_some()
    }

    /// Whether the configured style uses real Liquid Glass (vs the vibrancy fallback).
    fn uses_glass(style: &str) -> bool {
        matches!(style, "liquid" | "liquid-standard")
    }

    /// Map the configured style to a Liquid Glass style, chosen to match the on-screen
    /// look (which is the inverse of the API names here): the default `liquid` (通透,
    /// "transparent") renders most see-through with `Regular`, while `liquid-standard`
    /// (标准, "frosted") reads heavier with `Clear`.
    fn glass_style(style: &str) -> NSGlassEffectViewStyle {
        if style == "liquid-standard" {
            NSGlassEffectViewStyle::Clear
        } else {
            NSGlassEffectViewStyle::Regular
        }
    }

    /// Parse an incoming overlay event and update the native pill on the main thread.
    pub fn dispatch(app: &AppHandle, event: &serde_json::Value) {
        let kind = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
        // Only visual events drive the native pill. Audio lifecycle events
        // (audio:warmup / recording:start / recording:stop) belong to the WebView worker.
        let relevant = matches!(
            kind,
            "reset" | "state" | "transcript" | "hint" | "appearance"
        );
        if !relevant {
            return;
        }
        let app = app.clone();
        let event = event.clone();
        let _ = app.clone().run_on_main_thread(move || {
            apply_event(&app, &event);
        });
    }

    /// Mutate the model from an event, then re-render. Runs on the main thread.
    fn apply_event(app: &AppHandle, event: &serde_json::Value) {
        let kind = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let payload = event.get("payload");

        MODEL.with(|m| {
            let mut model = m.borrow_mut();
            ensure_loaded(app, &mut model);
            match kind {
                "reset" => {
                    model.final_text.clear();
                    model.partial_text.clear();
                    model.hint_text.clear();
                    model.hint_level = "info".into();
                    model.hint_variant = "text".into();
                    model.layout_width = 0.0;
                    model.layout_wrap = false;
                    model.smoothed_level = 0.0;
                    model.wave_heights = [WAVE_MIN_H; WAVE_N];
                }
                "state" => {
                    if let Some(s) = payload.and_then(|p| p.get("state")).and_then(|v| v.as_str()) {
                        model.app_state = s.into();
                        // Mirror app.js: entering these states clears info-level hints.
                        if matches!(s, "idle" | "connecting" | "recording" | "finishing")
                            && model.hint_level == "info"
                        {
                            model.hint_text.clear();
                            model.hint_variant = "text".into();
                        }
                        // Collapse the waveform when not actively recording.
                        if s != "recording" {
                            model.smoothed_level = 0.0;
                            model.wave_heights = [WAVE_MIN_H; WAVE_N];
                        }
                    }
                }
                "transcript" => {
                    model.final_text = payload
                        .and_then(|p| p.get("finalText"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .into();
                    model.partial_text = payload
                        .and_then(|p| p.get("partialText"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .into();
                }
                "hint" => {
                    model.hint_text = payload
                        .and_then(|p| p.get("text"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .into();
                    model.hint_level = payload
                        .and_then(|p| p.get("level"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("info")
                        .into();
                    model.hint_variant = payload
                        .and_then(|p| p.get("variant"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("text")
                        .into();
                }
                "appearance" => {
                    if let Some(s) = payload
                        .and_then(|p| p.get("overlayStyle"))
                        .and_then(|v| v.as_str())
                    {
                        model.style = s.into();
                    }
                    if let Some(t) = payload.and_then(|p| p.get("theme")).and_then(|v| v.as_str()) {
                        model.theme = t.into();
                    }
                }
                _ => {}
            }
            render(app, &mut model);
        });
    }

    /// Load the initial appearance (style + glass mode) from config once.
    fn ensure_loaded(app: &AppHandle, model: &mut Model) {
        if model.loaded {
            return;
        }
        model.loaded = true;
        model.style = "liquid".into();
        model.theme = "system".into();
        if let Some(inner) = app.try_state::<std::sync::Arc<crate::app_state::AppInner>>() {
            if let Ok(config) = inner.config_manager.load_config() {
                if !config.app.overlay_style.is_empty() {
                    model.style = config.app.overlay_style.clone();
                }
                if !config.app.theme.is_empty() {
                    model.theme = config.app.theme.clone();
                }
            }
        }
    }

    /// Resolve the effective appearance variant pinned on the window.
    ///
    /// Liquid Glass (Clear/Regular) self-adapts to the backdrop and follows the system
    /// light/dark on its own, so it is ALWAYS "" (auto — never pin an appearance).
    /// The vibrancy (`NSVisualEffectView`) material responds to `NSAppearance`, so for
    /// that style we follow the global `app.theme`: system → "" (follow system),
    /// light → "light", dark → "dark".
    fn resolved_variant(model: &Model) -> &'static str {
        if uses_glass(&model.style) {
            return "";
        }
        match model.theme.as_str() {
            "light" => "light",
            "dark" => "dark",
            _ => "",
        }
    }

    /// Compute the visible hint text (parallels app.js getVisibleHintText).
    fn visible_hint(model: &Model) -> String {
        let visual_state = model.app_state.as_str();
        let zh = true; // app is Chinese-first; matches app.js isZhLocale default.
        if visual_state == "connecting" {
            return if zh { "准备中…".into() } else { "Preparing…".into() };
        }
        if visual_state == "finishing" && model.hint_variant == "progress" {
            return if zh { "思考中…".into() } else { "Thinking…".into() };
        }
        model.hint_text.clone()
    }

    fn make_window_ptr(app: &AppHandle) -> Option<*mut std::ffi::c_void> {
        let overlay = app.get_webview_window("overlay")?;
        overlay.ns_window().ok()
    }

    /// (Re)build the native view tree if missing or if the glass style changed.
    fn ensure_views(content: &NSView, model: &Model, mtm: MainThreadMarker) {
        let want = if uses_glass(&model.style) && liquid_glass_available() {
            "liquid"
        } else {
            "vibrancy"
        };

        VIEWS.with(|v| {
            let mut slot = v.borrow_mut();
            let recreate = slot.as_ref().map(|x| x.glass.kind() != want).unwrap_or(true);
            if !recreate {
                return;
            }
            if let Some(old) = slot.take() {
                old.glass.view().removeFromSuperview();
            }

            let label = NSTextField::labelWithString(&NSString::from_str(""), mtm);
            label.setFont(Some(&NSFont::systemFontOfSize(FONT_SIZE)));

            let indicator = NSView::new(mtm);
            indicator.setWantsLayer(true);
            let ripple_layer = make_dot_layer();
            let dot_layer = make_dot_layer();
            unsafe {
                // Ripple starts invisible (its animation drives opacity when recording).
                let _: () = msg_send![&*ripple_layer, setOpacity: 0.0f32];
                let ind_layer: *mut AnyObject = msg_send![&*indicator, layer];
                if !ind_layer.is_null() {
                    let _: () = msg_send![ind_layer, addSublayer: &*ripple_layer]; // behind
                    let _: () = msg_send![ind_layer, addSublayer: &*dot_layer]; // in front
                }
            }

            let spinner = NSProgressIndicator::new(mtm);
            spinner.setStyle(NSProgressIndicatorStyle::Spinning);
            spinner.setIndeterminate(true);
            spinner.setDisplayedWhenStopped(false);
            spinner.setHidden(true);

            let container = NSView::new(mtm);
            // Clip overflowing transcript lines (multi-line keeps only the latest lines).
            container.setWantsLayer(true);
            set_clip(&container);
            container.addSubview(&indicator);
            container.addSubview(&spinner);
            container.addSubview(&label);

            // Waveform bars (right side), green and rounded; positioned per render.
            let bars: [Retained<NSView>; WAVE_N] = std::array::from_fn(|_| {
                let b = NSView::new(mtm);
                b.setWantsLayer(true);
                set_layer_color(&b, &NSColor::systemGreenColor(), WAVE_BAR_W / 2.0);
                b.setHidden(true);
                container.addSubview(&b);
                b
            });

            let glass = if want == "liquid" {
                let g = NSGlassEffectView::new(mtm);
                g.setStyle(glass_style(&model.style));
                g.setContentView(Some(&container));
                GlassKind::Liquid(g)
            } else {
                let g = NSVisualEffectView::new(mtm);
                g.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
                g.setState(NSVisualEffectState::Active);
                g.setMaterial(NSVisualEffectMaterial::HUDWindow);
                g.setWantsLayer(true);
                g.addSubview(&container);
                GlassKind::Vibrancy(g)
            };
            glass.view().setWantsLayer(true);
            content.addSubview(glass.view());

            log_app!(
                info,
                "native overlay view = {} (NSGlassEffectView available = {})",
                want,
                liquid_glass_available()
            );
            *slot = Some(Views {
                glass,
                container,
                indicator,
                spinner,
                label,
                bars,
                dot_layer,
                ripple_layer,
                fade_mask: make_fade_mask(),
                applied_variant: "<unset>".into(),
            });
        });
    }

    /// Set the overlay's appearance *environment baseline*.
    ///
    /// Liquid Glass adapts its material to the backdrop on its own and, at brightness
    /// extremes, switches its content's light/dark appearance via the NSAppearance
    /// system — so for "auto" we must NOT pin any appearance (let the glass drive it).
    /// For an explicit "light"/"dark" override we set the appearance on the *window*
    /// (the environment baseline: semantic colors, vibrancy, highlights), within which
    /// the glass still recalculates itself — rather than pinning the glass view, which
    /// would fight its built-in adaptation.
    fn apply_variant(window: &AnyObject, variant: &str) {
        if variant.is_empty() {
            // auto: follow the system; clear any forced appearance.
            unsafe {
                let _: () = msg_send![window, setAppearance: std::ptr::null::<AnyObject>()];
            }
            return;
        }
        let name = if variant == "dark" {
            unsafe { NSAppearanceNameDarkAqua }
        } else {
            unsafe { NSAppearanceNameAqua }
        };
        let appearance = NSAppearance::appearanceNamed(name);
        let ptr: *const AnyObject = match appearance.as_deref() {
            Some(a) => (a as *const NSAppearance).cast(),
            None => std::ptr::null(),
        };
        unsafe {
            let _: () = msg_send![window, setAppearance: ptr];
        }
    }

    /// Create the indicator dot as a standalone CALayer (anchor at its center so it can
    /// scale/"breathe"). Color + position are set per render.
    fn make_dot_layer() -> Retained<AnyObject> {
        unsafe {
            let cls = objc2::runtime::AnyClass::get(c"CALayer").expect("CALayer");
            let obj: *mut AnyObject = msg_send![cls, alloc];
            let obj: *mut AnyObject = msg_send![obj, init];
            let layer = Retained::from_raw(obj).expect("CALayer init");
            let _: () = msg_send![&*layer, setCornerRadius: DOT_SIZE / 2.0];
            layer
        }
    }

    /// Add or remove the recording dot's expanding-ring "ripple" on a halo layer,
    /// faithfully matching the web `vp-ring` keyframes: the dot itself stays fixed
    /// while a ring scales out from it and fades, looping every 1.6s (ease-out).
    fn set_ripple(layer: &AnyObject, on: bool) {
        unsafe {
            let key = NSString::from_str("ripple");
            if on {
                let existing: *mut AnyObject = msg_send![layer, animationForKey: &*key];
                if !existing.is_null() {
                    return; // already rippling
                }
                let anim_cls =
                    objc2::runtime::AnyClass::get(c"CABasicAnimation").expect("CABasicAnimation");
                // Ring grows from the dot edge to +8px: (7+8)/7 ≈ 2.14×.
                let scale_path = NSString::from_str("transform.scale");
                let scale: *mut AnyObject = msg_send![anim_cls, animationWithKeyPath: &*scale_path];
                let _: () = msg_send![scale, setFromValue: &*NSNumber::numberWithDouble(1.0)];
                let _: () = msg_send![scale, setToValue: &*NSNumber::numberWithDouble(2.14)];
                // Fades from a soft accent alpha to fully transparent.
                let op_path = NSString::from_str("opacity");
                let fade: *mut AnyObject = msg_send![anim_cls, animationWithKeyPath: &*op_path];
                let _: () = msg_send![fade, setFromValue: &*NSNumber::numberWithDouble(0.45)];
                let _: () = msg_send![fade, setToValue: &*NSNumber::numberWithDouble(0.0)];

                let group_cls =
                    objc2::runtime::AnyClass::get(c"CAAnimationGroup").expect("CAAnimationGroup");
                let group: *mut AnyObject = msg_send![group_cls, animation];
                let anims = NSArray::from_slice(&[&*scale, &*fade]);
                let _: () = msg_send![group, setAnimations: &*anims];
                let _: () = msg_send![group, setDuration: 1.6f64];
                let _: () = msg_send![group, setRepeatCount: f32::INFINITY];
                let _: () = msg_send![group, setRemovedOnCompletion: false];
                let tcls = objc2::runtime::AnyClass::get(c"CAMediaTimingFunction")
                    .expect("CAMediaTimingFunction");
                let tname = NSString::from_str("easeOut");
                let tf: *mut AnyObject = msg_send![tcls, functionWithName: &*tname];
                let _: () = msg_send![group, setTimingFunction: tf];
                let _: () = msg_send![layer, addAnimation: group, forKey: &*key];
            } else {
                let _: () = msg_send![layer, removeAnimationForKey: &*key];
            }
        }
    }

    fn set_layer_color(view: &NSView, color: &NSColor, corner: f64) {
        unsafe {
            let layer: *mut AnyObject = msg_send![view, layer];
            if layer.is_null() {
                return;
            }
            let cg: *mut AnyObject = msg_send![color, CGColor];
            let _: () = msg_send![layer, setBackgroundColor: cg];
            let _: () = msg_send![layer, setCornerRadius: corner];
        }
    }

    /// Build a vertical gradient layer (clear at top → opaque below) used as a mask
    /// so multi-line transcript fades out at the top instead of hard-clipping.
    fn make_fade_mask() -> Retained<AnyObject> {
        unsafe {
            let cls = objc2::runtime::AnyClass::get(c"CAGradientLayer").expect("CAGradientLayer");
            let obj: *mut AnyObject = msg_send![cls, alloc];
            let obj: *mut AnyObject = msg_send![obj, init];
            let mask = Retained::from_raw(obj).expect("CAGradientLayer init");

            let clear = NSColor::clearColor();
            let black = NSColor::blackColor();
            let clear_cg: *mut AnyObject = msg_send![&*clear, CGColor];
            let black_cg: *mut AnyObject = msg_send![&*black, CGColor];
            let colors = NSArray::from_slice(&[&*clear_cg, &*black_cg, &*black_cg]);
            let _: () = msg_send![&*mask, setColors: &*colors];

            let n0 = NSNumber::numberWithDouble(0.0);
            let n1 = NSNumber::numberWithDouble(0.30);
            let n2 = NSNumber::numberWithDouble(1.0);
            let locs = NSArray::from_slice(&[&*n0, &*n1, &*n2]);
            let _: () = msg_send![&*mask, setLocations: &*locs];

            // Layer unit coords: (0.5,1) = top, (0.5,0) = bottom.
            let _: () = msg_send![&*mask, setStartPoint: NSPoint { x: 0.5, y: 1.0 }];
            let _: () = msg_send![&*mask, setEndPoint: NSPoint { x: 0.5, y: 0.0 }];
            mask
        }
    }

    /// Apply (or remove) the top-fade mask on the container layer.
    fn apply_top_fade(container: &NSView, mask: &AnyObject, faded: bool, bounds: NSRect) {
        unsafe {
            let layer: *mut AnyObject = msg_send![container, layer];
            if layer.is_null() {
                return;
            }
            if faded {
                let _: () = msg_send![mask, setFrame: bounds];
                let _: () = msg_send![layer, setMask: mask];
            } else {
                let _: () = msg_send![layer, setMask: std::ptr::null::<AnyObject>()];
            }
        }
    }

    fn set_clip(view: &NSView) {
        unsafe {
            let layer: *mut AnyObject = msg_send![view, layer];
            if !layer.is_null() {
                let _: () = msg_send![layer, setMasksToBounds: true];
            }
        }
    }

    fn set_corner(view: &NSView, radius: f64) {
        unsafe {
            let layer: *mut AnyObject = msg_send![view, layer];
            if !layer.is_null() {
                let _: () = msg_send![layer, setCornerRadius: radius];
                let _: () = msg_send![layer, setMasksToBounds: true];
            }
        }
    }

    /// Position + size the 4 waveform bars on the right of the pill from
    /// `model.wave_heights`. Hidden unless `show` (recording without a hint).
    fn layout_bars(views: &Views, pill_w: f64, pill_h: f64, model: &Model, show: bool) {
        let area_right = pill_w - PAD_RIGHT;
        let area_left = area_right - WAVE_AREA_W;
        let center_y = pill_h / 2.0;
        for (i, bar) in views.bars.iter().enumerate() {
            bar.setHidden(!show);
            if !show {
                continue;
            }
            let h = model.wave_heights[i].clamp(WAVE_MIN_H, WAVE_MAX_H);
            let x = area_left + i as f64 * (WAVE_BAR_W + WAVE_BAR_GAP);
            bar.setFrame(NSRect {
                origin: NSPoint {
                    x,
                    y: center_y - h / 2.0,
                },
                size: NSSize {
                    width: WAVE_BAR_W,
                    height: h,
                },
            });
        }
    }

    /// Feed a new mic level (0..1) to the waveform. Smooths it, recomputes per-bar
    /// heights (center bars taller), and re-lays the bars. Runs on the main thread.
    pub fn set_audio_level(app: &AppHandle, level: f64) {
        let app = app.clone();
        let _ = app.clone().run_on_main_thread(move || {
            MODEL.with(|m| {
                let mut model = m.borrow_mut();
                if model.app_state != "recording" {
                    return;
                }
                model.smoothed_level += (level - model.smoothed_level) * 0.35;
                let lvl = model.smoothed_level.clamp(0.0, 1.0);
                for i in 0..WAVE_N {
                    let dist = ((i as f64) - 1.5).abs() / 1.5; // 0 (center) .. 1 (edge)
                    let weight = 1.0 - 0.45 * dist;
                    model.wave_heights[i] =
                        WAVE_MIN_H + (WAVE_MAX_H - WAVE_MIN_H) * (lvl * weight).clamp(0.0, 1.0);
                }
                VIEWS.with(|v| {
                    if let Some(views) = v.borrow().as_ref() {
                        let frame = views.glass.view().frame();
                        layout_bars(views, frame.size.width, frame.size.height, &model, true);
                    }
                });
            });
        });
    }

    /// Build the transcript attributed string: final (labelColor) + partial (secondary).
    fn transcript_attr(model: &Model) -> Retained<NSAttributedString> {
        let mtm = MainThreadMarker::new().unwrap();
        let final_s = &model.final_text;
        let partial_s = &model.partial_text;
        let combined = format!("{final_s}{partial_s}");
        let attr = NSMutableAttributedString::from_nsstring(&NSString::from_str(&combined));
        let font = NSFont::systemFontOfSize(FONT_SIZE);
        let full = NSRange::new(0, combined.encode_utf16().count());
        unsafe {
            attr.addAttribute_value_range(
                objc2_app_kit::NSFontAttributeName,
                &font,
                full,
            );
            let final_len = final_s.encode_utf16().count();
            if final_len > 0 {
                attr.addAttribute_value_range(
                    objc2_app_kit::NSForegroundColorAttributeName,
                    &NSColor::labelColor(),
                    NSRange::new(0, final_len),
                );
            }
            let partial_len = partial_s.encode_utf16().count();
            if partial_len > 0 {
                attr.addAttribute_value_range(
                    objc2_app_kit::NSForegroundColorAttributeName,
                    &NSColor::secondaryLabelColor(),
                    NSRange::new(final_len, partial_len),
                );
            }
        }
        let _ = mtm;
        Retained::into_super(attr)
    }

    fn hint_color(level: &str) -> Retained<NSColor> {
        match level {
            "error" => NSColor::systemRedColor(),
            "warn" => NSColor::systemOrangeColor(),
            _ => NSColor::labelColor(),
        }
    }

    /// The core render: choose content, measure, size the pill, lay out subviews,
    /// position bottom-center. Parallels app.js updateView + scheduleResize.
    fn render(app: &AppHandle, model: &mut Model) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let Some(ptr) = make_window_ptr(app) else {
            return;
        };
        if ptr.is_null() {
            return;
        }
        // SAFETY: ptr is the overlay window's live NSWindow for the app lifetime.
        let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        let Some(content) = ns_window.contentView() else {
            return;
        };

        ensure_views(&content, model, mtm);

        let hint = visible_hint(model);
        let has_hint = !hint.is_empty();
        let has_text = !model.final_text.is_empty() || !model.partial_text.is_empty();

        VIEWS.with(|v| {
            let mut slot = v.borrow_mut();
            let Some(views) = slot.as_mut() else {
                return;
            };

            // Appearance baseline (light/dark/auto) set on the window environment.
            let variant = resolved_variant(model);
            if views.applied_variant != variant {
                apply_variant(ns_window, variant);
                views.applied_variant = variant.to_string();
            }

            // --- Content ---
            if has_hint {
                let s = NSString::from_str(&hint);
                views.label.setStringValue(&s);
                views.label.setTextColor(Some(&hint_color(&model.hint_level)));
            } else {
                let attr = transcript_attr(model);
                views.label.setAttributedStringValue(&attr);
            }

            // --- Decide wrap, measure width ---
            // Single-line mode first to measure the natural width.
            views.label.setUsesSingleLineMode(true);
            views.label.setMaximumNumberOfLines(1);
            views.label.setPreferredMaxLayoutWidth(0.0);
            views.label.setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
            let natural = views.label.intrinsicContentSize();
            let measured_w = natural.width.ceil();

            let lock_layout = !has_hint
                && matches!(model.app_state.as_str(), "recording" | "finishing");
            let want_wrap = !has_hint && (model.layout_wrap || measured_w > SINGLE_LINE_LIMIT);

            // Waveform shows on the right while recording (reserve its width so the
            // pill doesn't jump when bars fade in/out — mirrors app.js chrome math).
            let show_wave = !has_hint && model.app_state == "recording";

            // Chrome around the text (left pad + indicator + gap + right pad + waveform).
            let wave_reserve = if show_wave {
                WAVE_GAP_LEFT + WAVE_AREA_W
            } else {
                0.0
            };
            let chrome = PAD_LEFT + INDICATOR_W + GAP + PAD_RIGHT + wave_reserve;
            let text_w = measured_w + TEXT_SLACK;
            let next_width = if want_wrap {
                MULTI_LINE_WIDTH + chrome
            } else {
                (SINGLE_LINE_LIMIT + chrome).min((text_w + chrome).max(MIN_PILL_W))
            };

            if !lock_layout {
                model.layout_width = next_width;
                model.layout_wrap = want_wrap;
            } else {
                model.layout_width = model.layout_width.max(next_width);
                model.layout_wrap = model.layout_wrap || want_wrap;
            }

            let pill_w = if model.layout_width > 0.0 {
                model.layout_width
            } else {
                next_width
            };
            let text_area_w = (pill_w - chrome).max(10.0);

            // --- Measure height (single vs wrapped) ---
            // `full_h` is the full wrapped text height (may exceed the visible window);
            // `visible_text_h` caps it to MAX_LINES so older lines overflow upward.
            let one_line_h = natural.height.ceil();
            let (pill_h, full_h, visible_text_h) = if model.layout_wrap {
                views.label.setUsesSingleLineMode(false);
                views.label.setMaximumNumberOfLines(0);
                views.label.setLineBreakMode(NSLineBreakMode::ByWordWrapping);
                views.label.setPreferredMaxLayoutWidth(text_area_w);
                let full = views.label.intrinsicContentSize().height.ceil();
                let max_visible = one_line_h * (MAX_LINES as f64) + 4.0;
                let visible = full.min(max_visible);
                ((visible + 16.0).max(56.0), full, visible)
            } else {
                (PILL_H_SINGLE, one_line_h, one_line_h)
            };

            // --- Lay out: pill bottom-center within the canvas content view ---
            let content_w = content.bounds().size.width;
            let glass_frame = NSRect {
                origin: NSPoint {
                    x: ((content_w - pill_w) / 2.0).round(),
                    y: BOTTOM_OFFSET,
                },
                size: NSSize {
                    width: pill_w,
                    height: pill_h,
                },
            };
            views.glass.view().setFrame(glass_frame);
            let radius = if model.layout_wrap {
                16.0
            } else {
                pill_h / 2.0
            };
            match &views.glass {
                GlassKind::Liquid(g) => {
                    // Style may change live between Clear and Regular without recreating.
                    g.setStyle(glass_style(&model.style));
                    g.setCornerRadius(radius);
                }
                GlassKind::Vibrancy(g) => set_corner(g, radius),
            }

            // Container fills the glass.
            let container_bounds = NSRect {
                origin: NSPoint { x: 0.0, y: 0.0 },
                size: NSSize {
                    width: pill_w,
                    height: pill_h,
                },
            };
            views.container.setFrame(container_bounds);
            // Top fade only when the transcript actually overflows the visible lines.
            let faded = model.layout_wrap && full_h > visible_text_h + 1.0;
            apply_top_fade(&views.container, &views.fade_mask, faded, container_bounds);

            // Indicator (left): a spinner while connecting/finishing (unless error),
            // otherwise a colored dot (green = recording, red = error, gray = idle).
            let show_spinner = model.hint_level != "error"
                && matches!(model.app_state.as_str(), "connecting" | "finishing");
            let spinner_size = 16.0;
            views.spinner.setFrame(NSRect {
                origin: NSPoint {
                    x: PAD_LEFT + (INDICATOR_W - spinner_size) / 2.0,
                    y: (pill_h - spinner_size) / 2.0,
                },
                size: NSSize {
                    width: spinner_size,
                    height: spinner_size,
                },
            });
            views.spinner.setHidden(!show_spinner);
            unsafe {
                if show_spinner {
                    views.spinner.startAnimation(None);
                } else {
                    views.spinner.stopAnimation(None);
                }
            }

            let dot_color = if model.hint_level == "error" {
                NSColor::systemRedColor()
            } else if model.app_state == "recording" {
                NSColor::systemGreenColor()
            } else {
                NSColor::tertiaryLabelColor()
            };
            // Indicator view occupies the slot; the dot is a centered sublayer that can
            // pulse (recording) independently of the view's frame.
            views.indicator.setFrame(NSRect {
                origin: NSPoint {
                    x: PAD_LEFT,
                    y: ((pill_h - INDICATOR_W) / 2.0).round(),
                },
                size: NSSize {
                    width: INDICATOR_W,
                    height: INDICATOR_W,
                },
            });
            views.indicator.setHidden(show_spinner);
            let dot_bounds = NSRect {
                origin: NSPoint { x: 0.0, y: 0.0 },
                size: NSSize {
                    width: DOT_SIZE,
                    height: DOT_SIZE,
                },
            };
            let dot_center = NSPoint {
                x: INDICATOR_W / 2.0,
                y: INDICATOR_W / 2.0,
            };
            let is_recording = model.app_state == "recording" && model.hint_level != "error";
            unsafe {
                let dl = &*views.dot_layer;
                let _: () = msg_send![dl, setBounds: dot_bounds];
                let _: () = msg_send![dl, setPosition: dot_center];
                let cg: *mut AnyObject = msg_send![&*dot_color, CGColor];
                let _: () = msg_send![dl, setBackgroundColor: cg];

                // The ripple halo shares the dot's geometry and the accent (green) color.
                let rl = &*views.ripple_layer;
                let _: () = msg_send![rl, setBounds: dot_bounds];
                let _: () = msg_send![rl, setPosition: dot_center];
                let green: *mut AnyObject = msg_send![&*NSColor::systemGreenColor(), CGColor];
                let _: () = msg_send![rl, setBackgroundColor: green];
                let _: () = msg_send![rl, setHidden: !is_recording];
            }
            set_ripple(&views.ripple_layer, is_recording);

            // Label, after the indicator. Anchored so the bottom `visible_text_h` of the
            // text sits in the (vertically centered) visible window: single-line is just
            // centered; multi-line lets the LATEST lines show while older lines overflow
            // upward and get clipped by the container (top fade is a later refinement).
            let label_x = PAD_LEFT + INDICATOR_W + GAP;
            let pad_v = ((pill_h - visible_text_h) / 2.0).round();
            views.label.setFrame(NSRect {
                origin: NSPoint {
                    x: label_x,
                    y: pad_v,
                },
                size: NSSize {
                    width: text_area_w,
                    height: full_h,
                },
            });

            // Waveform bars (right), shown only while recording.
            layout_bars(views, pill_w, pill_h, model, show_wave);

            // Keep the pill visible throughout an active session (so the indicator
            // stays up while waiting for the first transcript); only hide it when idle
            // with no content.
            let active = matches!(
                model.app_state.as_str(),
                "connecting" | "recording" | "finishing"
            );
            let empty = !has_hint && !has_text && !active;
            views.glass.view().setHidden(empty);
        });
    }
}

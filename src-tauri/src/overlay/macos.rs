use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
use objc2::{class, msg_send, sel, MainThreadMarker};
use objc2_app_kit::{
    NSAppearance, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSColor, NSFont,
    NSGlassEffectView, NSGlassEffectViewStyle, NSLayoutConstraint, NSLineBreakMode,
    NSTextAlignment, NSTextField, NSView, NSVisualEffectBlendingMode, NSVisualEffectMaterial,
    NSVisualEffectState, NSVisualEffectView, NSWindow,
};
use objc2_foundation::{
    NSArray, NSAttributedString, NSMutableAttributedString, NSNumber, NSPoint, NSRange, NSRect,
    NSSize, NSString,
};
use std::cell::{Cell, RefCell};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

// Layout constants, Model, and derived-state logic come from the
// platform-agnostic `shared` module so the macOS native renderer and the
// Windows WebView stay driven by the same numbers.
use super::shared::{
    visible_hint, Model, Shortcut, BOTTOM_OFFSET, FONT_SIZE, GAP, ICON_SIZE, INDICATOR_W,
    MAX_LINES, MIN_PILL_W, MULTI_LINE_WIDTH, PAD_LEFT, PAD_RIGHT, PILL_H_SINGLE, SINGLE_LINE_LIMIT,
    TEXT_SLACK, WAVE_AREA_W, WAVE_BAR_GAP, WAVE_BAR_W, WAVE_CORNER_RADIUS, WAVE_DURATIONS,
    WAVE_MAX_H, WAVE_MIN_H, WAVE_N, WAVE_PEAKS, WAVE_SETTLE_SECONDS,
};

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

struct WaveBar {
    view: Retained<NSView>,
    layer: Retained<AnyObject>,
}

struct ShortcutViews {
    keycap: Retained<NSView>,
    key_label: Retained<NSTextField>,
    label: Retained<NSTextField>,
}

/// The retained native view tree (built once, updated per render).
struct Views {
    host: Retained<NSView>,
    pivot: Retained<NSView>,
    width_constraint: Retained<NSLayoutConstraint>,
    height_constraint: Retained<NSLayoutConstraint>,
    glass: GlassKind,
    container: Retained<NSView>,
    indicator: Retained<NSView>,
    label: Retained<NSTextField>,
    /// Keyboard hints above the glass, without increasing the pill height.
    shortcuts_root: Retained<NSView>,
    shortcuts_background: Option<Retained<NSVisualEffectView>>,
    shortcuts_width: Retained<NSLayoutConstraint>,
    shortcuts_height: Retained<NSLayoutConstraint>,
    shortcut_items: Vec<ShortcutViews>,
    shortcut_content: Vec<Shortcut>,
    bars: [WaveBar; WAVE_N],
    icon_layer: Retained<AnyObject>,
    fade_mask: Retained<AnyObject>, // CAGradientLayer for the multi-line top fade
    resize: Option<Resize>,
    radius: f64,
    applied_variant: String, // "" (auto/inherit) | "light" | "dark"
}

thread_local! {
    static MODEL: RefCell<Model> = RefCell::new(Model::default());
    static VIEWS: RefCell<Option<Views>> = const { RefCell::new(None) };
    static RESIZE_TICK_PENDING: Cell<bool> = const { Cell::new(false) };
    static WAVE_ACTIVE: RefCell<bool> = const { RefCell::new(false) };
}

extern "C" fn pivot_hit_test(this: *mut AnyObject, _sel: Sel, point: NSPoint) -> *mut NSView {
    let view = unsafe { &*(this as *const NSView) };
    if view.isHidden() {
        return std::ptr::null_mut();
    }
    let parent = unsafe { view.superview() };
    let local = view.convertPoint_fromView(point, parent.as_deref());
    view.subviews()
        .lastObject()
        .and_then(|child| child.hitTest(local))
        .map(|hit| Retained::as_ptr(&hit) as *mut NSView)
        .unwrap_or(std::ptr::null_mut())
}

fn animation_pivot_class() -> &'static AnyClass {
    if let Some(cls) = AnyClass::get(c"VoicePasteAnimationPivot") {
        return cls;
    }
    let mut builder = ClassBuilder::new(c"VoicePasteAnimationPivot", class!(NSView))
        .expect("animation pivot class");
    unsafe {
        builder.add_method(
            sel!(hitTest:),
            pivot_hit_test as extern "C" fn(*mut AnyObject, Sel, NSPoint) -> *mut NSView,
        );
    }
    builder.register()
}

extern "C" fn content_appearance_changed(this: *mut AnyObject, _sel: Sel) {
    unsafe {
        let _: () = msg_send![
            super(&*this, class!(NSView)),
            viewDidChangeEffectiveAppearance
        ];
    }
    VIEWS.with(|v| {
        // AppKit also sends this during construction and a render's appearance change.
        if let Ok(slot) = v.try_borrow() {
            if let Some(views) = slot.as_ref() {
                sync_foreground(views);
            }
        }
    });
}

fn overlay_content_class() -> &'static AnyClass {
    if let Some(cls) = AnyClass::get(c"VoicePasteOverlayContent") {
        return cls;
    }
    let mut builder = ClassBuilder::new(c"VoicePasteOverlayContent", class!(NSView))
        .expect("overlay content class");
    unsafe {
        builder.add_method(
            sel!(viewDidChangeEffectiveAppearance),
            content_appearance_changed as extern "C" fn(*mut AnyObject, Sel),
        );
    }
    builder.register()
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

/// Fade the entire glass pill, including its content, without changing geometry.
pub(super) fn animate_visibility(app: &AppHandle, visible: bool) {
    MODEL.with(|m| {
        let mut model = m.borrow_mut();
        ensure_loaded(app, &mut model);
        render(app, &mut model);
    });
    let was_visible = app
        .get_window("overlay")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    VIEWS.with(|v| {
        let slot = v.borrow();
        let Some(views) = slot.as_ref() else {
            return;
        };
        fade_shortcuts(
            &views.shortcuts_root,
            visible && !views.shortcut_content.is_empty(),
        );
        unsafe {
            // Fade the parent layer so the glass and its content disappear together.
            let layer: *mut AnyObject = msg_send![&*views.pivot, layer];
            if layer.is_null() {
                return;
            }
            {
                let path = "opacity";
                let key = "vp-visibility-opacity";
                let start = 0.0;
                let end = if visible { 1.0 } else { 0.0 };
                let path = NSString::from_str(path);
                let key = NSString::from_str(key);
                let presentation: *mut AnyObject = msg_send![layer, presentationLayer];
                let from = if was_visible && !presentation.is_null() {
                    let value: *mut NSNumber = msg_send![presentation, valueForKeyPath: &*path];
                    if value.is_null() {
                        1.0
                    } else {
                        (&*value).doubleValue()
                    }
                } else {
                    start
                };
                let animation: *mut AnyObject =
                    msg_send![class!(CABasicAnimation), animationWithKeyPath: &*path];
                let _: () = msg_send![animation, setFromValue: &*NSNumber::numberWithDouble(from)];
                let _: () = msg_send![animation, setToValue: &*NSNumber::numberWithDouble(end)];
                let _: () =
                    msg_send![animation, setDuration: if visible { 0.16f64 } else { 0.12f64 }];
                let curve = NSString::from_str(if visible { "easeOut" } else { "easeIn" });
                let timing: *mut AnyObject =
                    msg_send![class!(CAMediaTimingFunction), functionWithName: &*curve];
                let _: () = msg_send![animation, setTimingFunction: timing];
                let _: () = msg_send![animation, setFillMode: &*NSString::from_str("forwards")];
                let _: () = msg_send![animation, setRemovedOnCompletion: visible];
                let _: () = msg_send![layer, addAnimation: animation, forKey: &*key];
            }
        }
    });
}

/// Parse an incoming overlay event and update the native pill on the main thread.
pub fn dispatch(app: &AppHandle, event: &serde_json::Value) {
    let kind = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if kind == "audio:level" {
        if let Some(active) = event
            .get("payload")
            .and_then(|p| p.get("active"))
            .and_then(|v| v.as_bool())
        {
            set_wave_activity(app, active);
        }
        return;
    }
    // Only visual events drive the native pill. Audio lifecycle events
    // (audio:warmup / recording:start / recording:stop) belong to the WebView worker.
    let relevant = matches!(
        kind,
        "reset" | "state" | "transcript" | "hint" | "appearance" | "shortcuts"
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
                model.shortcuts.clear();
                model.final_text.clear();
                model.partial_text.clear();
                model.hint_text.clear();
                model.hint_level = "info".into();
                model.hint_variant = "text".into();
                model.layout_width = 0.0;
                model.layout_wrap = false;
                WAVE_ACTIVE.with(|w| *w.borrow_mut() = false);
            }
            "state" => {
                if let Some(s) = payload
                    .and_then(|p| p.get("state"))
                    .and_then(|v| v.as_str())
                {
                    model.app_state = s.into();
                    // Mirror app.js: entering these states clears info-level hints.
                    if matches!(s, "idle" | "connecting" | "recording" | "finishing")
                        && (s != "idle"
                            || (model.hint_level == "info" && model.hint_variant != "success"))
                    {
                        model.hint_level = "info".into();
                        model.hint_text.clear();
                        model.hint_variant = "text".into();
                    }
                    // Collapse the waveform when not actively recording.
                    if s != "idle" {
                        model.shortcuts.clear();
                    }
                    if s != "recording" {
                        WAVE_ACTIVE.with(|w| *w.borrow_mut() = false);
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
            "shortcuts" => {
                model.shortcuts = payload
                    .and_then(|p| p.get("shortcuts"))
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
                    .unwrap_or_default();
            }
            "appearance" => {
                if let Some(s) = payload
                    .and_then(|p| p.get("overlayStyle"))
                    .and_then(|v| v.as_str())
                {
                    model.style = s.into();
                }
                if let Some(t) = payload
                    .and_then(|p| p.get("theme"))
                    .and_then(|v| v.as_str())
                {
                    model.theme = t.into();
                }
                if let Some(l) = payload
                    .and_then(|p| p.get("language"))
                    .and_then(|v| v.as_str())
                {
                    model.language = crate::lang::Language::from_pref(l);
                }
            }
            _ => {}
        }
        render(app, &mut model);
    });
}

/// Load the initial appearance (style + glass mode + language) from the
/// shared state once.
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
        if let Ok(language) = inner.language.read() {
            model.language = *language;
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

fn make_window_ptr(app: &AppHandle) -> Option<*mut std::ffi::c_void> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    // The macOS overlay is a plain native Window (no WebView), so reach its
    // NSWindow via the raw-window-handle AppKit handle instead of
    // WebviewWindow::ns_window (which only exists on webview windows).
    let overlay = app.get_window("overlay")?;
    let handle = overlay.window_handle().ok()?;
    let RawWindowHandle::AppKit(appkit) = handle.as_raw() else {
        return None;
    };
    let ns_view = appkit.ns_view.as_ptr();
    if ns_view.is_null() {
        return None;
    }
    // [ns_view window] — the NSView's owning NSWindow.
    let ns_window: *mut std::ffi::c_void =
        unsafe { objc2::msg_send![ns_view as *mut AnyObject, window] };
    (!ns_window.is_null()).then_some(ns_window)
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
        let recreate = slot
            .as_ref()
            .map(|x| x.glass.kind() != want || x.shortcuts_background.is_some() != (model.style == "vibrancy"))
            .unwrap_or(true);
        if !recreate {
            return;
        }
        if let Some(old) = slot.take() {
            old.host.removeFromSuperview();
            old.shortcuts_root.removeFromSuperview();
        }

        let label = NSTextField::labelWithString(&NSString::from_str(""), mtm);
        label.setFont(Some(&NSFont::systemFontOfSize(FONT_SIZE)));
        // Layer-backed so the hint-text pulse (a layer.opacity animation) works.
        label.setWantsLayer(true);

        // A separate root stays anchored to the window, outside width animations.
        let shortcuts_root = NSView::new(mtm);
        shortcuts_root.setTranslatesAutoresizingMaskIntoConstraints(false);
        shortcuts_root.setWantsLayer(true);
        shortcuts_root.setAlphaValue(0.0);
        content.addSubview(&shortcuts_root);
        let shortcuts_background = if model.style == "vibrancy" {
            let background = NSVisualEffectView::new(mtm);
            background.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
            background.setState(NSVisualEffectState::Active);
            background.setMaterial(NSVisualEffectMaterial::HUDWindow);
            background.setWantsLayer(true);
            set_corner(&background, 12.0);
            shortcuts_root.addSubview(&background);
            Some(background)
        } else {
            None
        };
        let shortcuts_width = shortcuts_root.widthAnchor().constraintEqualToConstant(0.0);
        let shortcuts_height = shortcuts_root.heightAnchor().constraintEqualToConstant(18.0);

        let indicator = NSView::new(mtm);
        indicator.setWantsLayer(true);
        let icon_layer = make_icon_layer();
        unsafe {
            let ind_layer: *mut AnyObject = msg_send![&*indicator, layer];
            if !ind_layer.is_null() { let _: () = msg_send![ind_layer, addSublayer: &*icon_layer]; }
        }

        let container = unsafe {
            let raw: *mut NSView = msg_send![overlay_content_class(), new];
            Retained::from_raw(raw).expect("overlay content view")
        };
        // Clip overflowing transcript lines (multi-line keeps only the latest lines).
        container.setWantsLayer(true);
        set_clip(&container);
        container.addSubview(&indicator);
        container.addSubview(&label);

        // Each fixed view hosts a capsule layer anchored at its horizontal midline.
        let bars: [WaveBar; WAVE_N] = std::array::from_fn(|_| unsafe {
            let view = NSView::new(mtm);
            view.setWantsLayer(true);
            let cls = AnyClass::get(c"CALayer").expect("CALayer");
            let raw: *mut AnyObject = msg_send![cls, new];
            let layer = Retained::from_raw(raw).expect("wave layer");
            let _: () = msg_send![&*layer, setAnchorPoint: NSPoint { x: 0.5, y: 0.5 }];
            let _: () = msg_send![&*layer, setPosition: NSPoint { x: WAVE_BAR_W / 2.0, y: WAVE_MAX_H / 2.0 }];
            let _: () = msg_send![&*layer, setBounds: NSRect {
                origin: NSPoint { x: 0.0, y: 0.0 },
                size: NSSize { width: WAVE_BAR_W, height: WAVE_MIN_H },
            }];
            let _: () = msg_send![&*layer, setCornerRadius: WAVE_CORNER_RADIUS];
            let color = NSColor::colorWithSRGBRed_green_blue_alpha(76.0 / 255.0, 210.0 / 255.0, 142.0 / 255.0, 1.0);
            let cg: *mut AnyObject = msg_send![&*color, CGColor];
            let _: () = msg_send![&*layer, setBackgroundColor: cg];
            let parent: *mut AnyObject = msg_send![&*view, layer];
            let _: () = msg_send![parent, addSublayer: &*layer];
            view.setHidden(true);
            container.addSubview(&view);
            WaveBar { view, layer }
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
        let host = NSView::new(mtm);
        host.setWantsLayer(true);
        unsafe {
            let supports: bool = msg_send![&*host, respondsToSelector: sel!(setClipsToBounds:)];
            if supports { let _: () = msg_send![&*host, setClipsToBounds: false]; }
        }
        host.setTranslatesAutoresizingMaskIntoConstraints(false);
        content.addSubview(&host);
        let width_constraint = host.widthAnchor().constraintEqualToConstant(MIN_PILL_W);
        let height_constraint = host.heightAnchor().constraintEqualToConstant(PILL_H_SINGLE);
        let pivot = unsafe {
            let raw: *mut NSView = msg_send![animation_pivot_class(), new];
            Retained::from_raw(raw).expect("animation pivot view")
        };
        pivot.setWantsLayer(true);
        pivot.setTranslatesAutoresizingMaskIntoConstraints(false);
        unsafe {
            // Newer AppKit versions clip view content by default; older versions
            // have no clipsToBounds property and already allow overflow.
            let supports_clipping: bool = msg_send![&*pivot, respondsToSelector: sel!(setClipsToBounds:)];
            if supports_clipping {
                let _: () = msg_send![&*pivot, setClipsToBounds: false];
            }
        }
        host.addSubview(&pivot);
        glass.view().setWantsLayer(true);
        glass.view().setTranslatesAutoresizingMaskIntoConstraints(false);
        pivot.addSubview(glass.view());
        NSLayoutConstraint::activateConstraints(&NSArray::from_retained_slice(&[
            host.centerXAnchor().constraintEqualToAnchor(&content.centerXAnchor()),
            host.bottomAnchor().constraintEqualToAnchor_constant(&content.bottomAnchor(), -BOTTOM_OFFSET),
            width_constraint.clone(),
            height_constraint.clone(),
            shortcuts_root.centerXAnchor().constraintEqualToAnchor(&content.centerXAnchor()),
            shortcuts_width.clone(),
            shortcuts_height.clone(),
            shortcuts_root.bottomAnchor().constraintEqualToAnchor_constant(&host.topAnchor(), -16.0),
            pivot.centerXAnchor().constraintEqualToAnchor(&host.centerXAnchor()),
            pivot.bottomAnchor().constraintEqualToAnchor(&host.bottomAnchor()),
            pivot.widthAnchor().constraintEqualToConstant(0.0),
            pivot.heightAnchor().constraintEqualToConstant(0.0),
            glass.view().centerXAnchor().constraintEqualToAnchor(&pivot.centerXAnchor()),
            glass.view().bottomAnchor().constraintEqualToAnchor(&pivot.bottomAnchor()),
            glass.view().widthAnchor().constraintEqualToAnchor(&host.widthAnchor()),
            glass.view().heightAnchor().constraintEqualToAnchor(&host.heightAnchor()),
        ]));
        content.layoutSubtreeIfNeeded();

        log_app!(
            info,
            "native overlay view = {} (NSGlassEffectView available = {})",
            want,
            liquid_glass_available()
        );
        *slot = Some(Views {
            host,
            pivot,
            width_constraint,
            height_constraint,
            glass,
            container,
            indicator,
            label,
            shortcuts_root,
            shortcuts_background,
            shortcuts_width,
            shortcuts_height,
            shortcut_items: Vec::new(),
            shortcut_content: Vec::new(),
            bars,
            icon_layer,
            fade_mask: make_fade_mask(),
            resize: None,
            radius: PILL_H_SINGLE / 2.0,
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

/// Lucide Check / Info geometry in the same 24-unit view box as the web icons.
fn make_icon_layer() -> Retained<AnyObject> {
    unsafe {
        let cls = AnyClass::get(c"CAShapeLayer").expect("CAShapeLayer");
        let raw: *mut AnyObject = msg_send![cls, new];
        let layer = Retained::from_raw(raw).expect("icon layer");
        let clear: *mut AnyObject = msg_send![&*NSColor::clearColor(), CGColor];
        let _: () = msg_send![&*layer, setFillColor: clear];
        let _: () = msg_send![&*layer, setLineWidth: 2.0f64];
        let round = NSString::from_str("round");
        let _: () = msg_send![&*layer, setLineCap: &*round];
        let _: () = msg_send![&*layer, setLineJoin: &*round];
        layer
    }
}

fn sync_foreground(views: &Views) {
    unsafe {
        // Use the glass content's appearance, which can differ from the window
        // when Liquid Glass adapts to the backdrop.
        let appearance: Retained<NSAppearance> = msg_send![&*views.container, effectiveAppearance];
        let _: () = msg_send![&*views.shortcuts_root, setAppearance: &*appearance];
        let update = RcBlock::new(|| {
            let color = NSColor::labelColor();
            let cg: *mut AnyObject = msg_send![&*color, CGColor];
            let _: () = msg_send![&*views.icon_layer, setStrokeColor: cg];
            let background = color.colorWithAlphaComponent(0.12);
            let background_cg: *mut AnyObject = msg_send![&*background, CGColor];
            for item in &views.shortcut_items {
                item.key_label.setTextColor(Some(&color));
                item.label.setTextColor(Some(&color));
                let layer: *mut AnyObject = msg_send![&*item.keycap, layer];
                let _: () = msg_send![layer, setBackgroundColor: background_cg];
            }
        });
        appearance.performAsCurrentDrawingAppearance(&update);
    }
}

fn set_icon(layer: &AnyObject, success: bool) {
    unsafe {
        let cls = AnyClass::get(c"NSBezierPath").expect("NSBezierPath");
        let path: *mut AnyObject = msg_send![cls, bezierPath];
        let scale = ICON_SIZE / 24.0;
        let point = |x: f64, y: f64| NSPoint {
            x: x * scale,
            y: (24.0 - y) * scale,
        };
        if success {
            // Lucide Check: M20 6 9 17l-5-5.
            let _: () = msg_send![path, moveToPoint: point(20.0, 6.0)];
            let _: () = msg_send![path, lineToPoint: point(9.0, 17.0)];
            let _: () = msg_send![path, lineToPoint: point(4.0, 12.0)];
        } else {
            let _: () = msg_send![path, appendBezierPathWithOvalInRect: NSRect {
                origin: NSPoint { x: 2.0 * scale, y: 2.0 * scale },
                size: NSSize { width: 20.0 * scale, height: 20.0 * scale }
            }];
            let _: () = msg_send![path, moveToPoint: point(12.0, 16.0)];
            let _: () = msg_send![path, lineToPoint: point(12.0, 12.0)];
            let _: () = msg_send![path, moveToPoint: point(12.0, 8.0)];
            let _: () = msg_send![path, lineToPoint: point(12.01, 8.0)];
        }
        let cg_path: *mut AnyObject = msg_send![path, CGPath];
        let _: () = msg_send![layer, setPath: cg_path];
        let _: () = msg_send![layer, setLineWidth: 2.0 * scale];
        let _: () = msg_send![layer, setBounds: NSRect { origin: NSPoint { x: 0.0, y: 0.0 }, size: NSSize { width: ICON_SIZE, height: ICON_SIZE } }];
        let _: () =
            msg_send![layer, setPosition: NSPoint { x: INDICATOR_W / 2.0, y: INDICATOR_W / 2.0 }];
    }
}

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

/// Pulse the hint label's opacity — a gentle breathing load indicator that
/// stays clean on Liquid Glass (it's the text itself fading, not an overlay on
/// the glass surface). `on` adds a reversing opacity animation; `off` removes
/// it. Reuses the "skip if key exists" pattern.
fn set_label_pulse(label: &NSTextField, on: bool) {
    unsafe {
        let ll: *mut AnyObject = msg_send![label, layer];
        if ll.is_null() {
            return;
        }
        let key = NSString::from_str("hint-pulse");
        if on {
            let existing: *mut AnyObject = msg_send![ll, animationForKey: &*key];
            if !existing.is_null() {
                return;
            }
            let anim_cls =
                objc2::runtime::AnyClass::get(c"CABasicAnimation").expect("CABasicAnimation");
            let path = NSString::from_str("opacity");
            let anim: *mut AnyObject = msg_send![anim_cls, animationWithKeyPath: &*path];
            let _: () = msg_send![anim, setFromValue: &*NSNumber::numberWithDouble(1.0)];
            let _: () = msg_send![anim, setToValue: &*NSNumber::numberWithDouble(0.45)];
            let _: () = msg_send![anim, setDuration: 0.9f64];
            let _: () = msg_send![anim, setAutoreverses: true];
            let _: () = msg_send![anim, setRepeatCount: f32::INFINITY];
            let tcls = objc2::runtime::AnyClass::get(c"CAMediaTimingFunction")
                .expect("CAMediaTimingFunction");
            let tname = NSString::from_str("easeInEaseOut");
            let tf: *mut AnyObject = msg_send![tcls, functionWithName: &*tname];
            let _: () = msg_send![anim, setTimingFunction: tf];
            let _: () = msg_send![ll, addAnimation: anim, forKey: &*key];
        } else {
            let _: () = msg_send![ll, removeAnimationForKey: &*key];
        }
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

/// Fixed bar frames keep the waveform anchored while the pill grows.
/// Capsule bounds animate around a fixed center, preserving rounded ends.
fn layout_bars(views: &Views, pill_h: f64, active: bool, show: bool) {
    let area_left = PAD_LEFT;
    for (i, bar) in views.bars.iter().enumerate() {
        bar.view.setHidden(!show);
        bar.view.setFrame(NSRect {
            origin: NSPoint {
                x: area_left + i as f64 * (WAVE_BAR_W + WAVE_BAR_GAP),
                y: (pill_h - WAVE_MAX_H) / 2.0,
            },
            size: NSSize {
                width: WAVE_BAR_W,
                height: WAVE_MAX_H,
            },
        });
        set_bar_animation(&bar.layer, i, show && active);
    }
}

fn set_bar_animation(layer: &AnyObject, index: usize, active: bool) {
    unsafe {
        let key = NSString::from_str("wave-loop");
        let settle_key = NSString::from_str("wave-settle");
        let path = NSString::from_str("bounds.size.height");
        let rest = WAVE_MIN_H;
        let existing: *mut AnyObject = msg_send![layer, animationForKey: &*key];
        // Set the model value so cancelling an animation always leaves resting bars.
        let _: () =
            msg_send![layer, setValue: &*NSNumber::numberWithDouble(rest), forKeyPath: &*path];
        if active {
            if !existing.is_null() {
                return;
            }
            let _: () = msg_send![layer, removeAnimationForKey: &*settle_key];
            let cls = AnyClass::get(c"CAKeyframeAnimation").expect("CAKeyframeAnimation");
            let anim: *mut AnyObject = msg_send![cls, animationWithKeyPath: &*path];
            let peak = WAVE_MAX_H * WAVE_PEAKS[index];
            let values = NSArray::from_retained_slice(&[
                NSNumber::numberWithDouble(rest),
                NSNumber::numberWithDouble(peak),
                NSNumber::numberWithDouble(peak * 0.45),
                NSNumber::numberWithDouble(rest),
            ]);
            let _: () = msg_send![anim, setValues: &*values];
            let _: () = msg_send![anim, setDuration: WAVE_DURATIONS[index]];
            let _: () = msg_send![anim, setRepeatCount: f32::INFINITY];
            let cls = AnyClass::get(c"CAMediaTimingFunction").expect("CAMediaTimingFunction");
            let name = NSString::from_str("easeInEaseOut");
            let timing: *mut AnyObject = msg_send![cls, functionWithName: &*name];
            let timing = Retained::retain(timing).expect("timing function");
            let timings = NSArray::from_retained_slice(&[timing.clone(), timing.clone(), timing]);
            let _: () = msg_send![anim, setTimingFunctions: &*timings];
            let _: () = msg_send![layer, addAnimation: anim, forKey: &*key];
        } else if !existing.is_null() {
            let presentation: *mut AnyObject = msg_send![layer, presentationLayer];
            let value: *mut AnyObject = if presentation.is_null() {
                std::ptr::null_mut()
            } else {
                msg_send![presentation, valueForKeyPath: &*path]
            };
            let cls = AnyClass::get(c"CABasicAnimation").expect("CABasicAnimation");
            let anim: *mut AnyObject = msg_send![cls, animationWithKeyPath: &*path];
            if !value.is_null() {
                let _: () = msg_send![anim, setFromValue: value];
            }
            let _: () = msg_send![anim, setToValue: &*NSNumber::numberWithDouble(rest)];
            let _: () = msg_send![anim, setDuration: WAVE_SETTLE_SECONDS];
            let _: () = msg_send![layer, removeAnimationForKey: &*key];
            let _: () = msg_send![layer, addAnimation: anim, forKey: &*settle_key];
        }
    }
}

fn set_wave_activity(app: &AppHandle, active: bool) {
    let _ = app.run_on_main_thread(move || {
        MODEL.with(|m| {
            let model = m.borrow();
            if model.app_state != "recording" {
                return;
            }
            let changed = WAVE_ACTIVE.with(|w| {
                let mut previous = w.borrow_mut();
                let changed = *previous != active;
                *previous = active;
                changed
            });
            if !changed {
                return;
            }
            VIEWS.with(|v| {
                if let Some(views) = v.borrow().as_ref() {
                    layout_bars(
                        views,
                        views.glass.view().frame().size.height,
                        active,
                        model.hint_level != "warn",
                    );
                }
            });
        });
    });
}

/// Build the transcript attributed string: final (labelColor) + partial (secondary).
fn transcript_attr(model: &Model) -> Retained<NSAttributedString> {
    let final_s = &model.final_text;
    let partial_s = &model.partial_text;
    let combined = format!("{final_s}{partial_s}");
    let attr = NSMutableAttributedString::from_nsstring(&NSString::from_str(&combined));
    let font = NSFont::systemFontOfSize(FONT_SIZE);
    let full = NSRange::new(0, combined.encode_utf16().count());
    unsafe {
        attr.addAttribute_value_range(objc2_app_kit::NSFontAttributeName, &font, full);
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
    Retained::into_super(attr)
}

fn fade_shortcuts(view: &NSView, visible: bool) {
    unsafe {
        let layer: *mut AnyObject = msg_send![view, layer];
        if layer.is_null() {
            return;
        }
        let presentation: *mut AnyObject = msg_send![layer, presentationLayer];
        let from: f32 = if presentation.is_null() {
            msg_send![layer, opacity]
        } else {
            msg_send![presentation, opacity]
        };
        let target = if visible { 1.0f32 } else { 0.0f32 };
        let _: () = msg_send![class!(CATransaction), begin];
        let _: () = msg_send![class!(CATransaction), setDisableActions: true];
        view.setAlphaValue(target as f64);
        let _: () = msg_send![class!(CATransaction), commit];
        let animation: *mut AnyObject = msg_send![class!(CABasicAnimation), animationWithKeyPath: &*NSString::from_str("opacity")];
        let _: () = msg_send![animation, setFromValue: &*NSNumber::numberWithDouble(from as f64)];
        let _: () = msg_send![animation, setToValue: &*NSNumber::numberWithDouble(target as f64)];
        let _: () = msg_send![animation, setDuration: if visible { 0.16f64 } else { 0.12f64 }];
        let timing: *mut AnyObject = msg_send![class!(CAMediaTimingFunction), functionWithName: &*NSString::from_str(if visible { "easeOut" } else { "easeIn" })];
        let _: () = msg_send![animation, setTimingFunction: timing];
        let _: () = msg_send![layer, addAnimation: animation, forKey: &*NSString::from_str("vp-shortcuts-opacity")];
    }
}

fn update_shortcuts(views: &mut Views, shortcuts: &[Shortcut], mtm: MainThreadMarker) {
    if views.shortcut_content == shortcuts {
        return;
    }
    views.shortcut_content = shortcuts.to_vec();
    if shortcuts.is_empty() {
        fade_shortcuts(&views.shortcuts_root, false);
        return; // Keep the rendered items alive until their fade finishes.
    }
    for item in views.shortcut_items.drain(..) {
        item.keycap.removeFromSuperview();
        item.label.removeFromSuperview();
    }
    let mut widths = Vec::new();
    for shortcut in shortcuts {
        let key_label = NSTextField::labelWithString(&NSString::from_str(&shortcut.key), mtm);
        key_label.setFont(Some(&NSFont::systemFontOfSize(11.0)));
        key_label.setAlignment(NSTextAlignment::Center);
        let key_size = key_label
            .cell()
            .map(|cell| cell.cellSize())
            .unwrap_or_else(|| key_label.intrinsicContentSize());
        let keycap = NSView::new(mtm);
        keycap.setWantsLayer(true);
        set_corner(&keycap, 4.0);
        keycap.addSubview(&key_label);
        let label = NSTextField::labelWithString(&NSString::from_str(&shortcut.label), mtm);
        label.setFont(Some(&NSFont::systemFontOfSize(11.0)));
        label.setUsesSingleLineMode(true);
        label.setLineBreakMode(NSLineBreakMode::ByClipping);
        let label_size = label
            .cell()
            .map(|cell| cell.cellSize())
            .unwrap_or_else(|| label.intrinsicContentSize());
        label.setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
        views.shortcuts_root.addSubview(&keycap);
        views.shortcuts_root.addSubview(&label);
        widths.push((
            key_size.width.ceil() + 8.0,
            label_size.width.ceil() + 2.0,
            key_size.height.ceil(),
            label_size.height.ceil(),
        ));
        views.shortcut_items.push(ShortcutViews {
            keycap,
            key_label,
            label,
        });
    }
    let total: f64 = widths.iter().map(|w| w.0 + 4.0 + w.1).sum::<f64>()
        + 14.0 * widths.len().saturating_sub(1) as f64;
    let padded = views.shortcuts_background.is_some();
    let padding_x = if padded { 12.0 } else { 0.0 };
    let padding_y = if padded { 6.0 } else { 0.0 };
    let max_width = unsafe { views.shortcuts_root.superview() }
        .map(|parent| (parent.bounds().size.width - 64.0).max(0.0))
        .unwrap_or(656.0);
    let width = (total + padding_x * 2.0).min(max_width);
    let height = 18.0 + padding_y * 2.0;
    views.shortcuts_width.setConstant(width);
    views.shortcuts_height.setConstant(height);
    if let Some(background) = &views.shortcuts_background {
        background.setFrame(NSRect {
            origin: NSPoint { x: 0.0, y: 0.0 },
            size: NSSize { width, height },
        });
    }
    // The template is the last action; shorten it without hiding cancel/complete.
    let overflow = (total + padding_x * 2.0 - width).max(0.0);
    let mut x = padding_x;
    let last = widths.len() - 1;
    for (index, (item, (key_w, label_w, key_h, label_h))) in
        views.shortcut_items.iter().zip(widths).enumerate()
    {
        let label_w = if index == last {
            (label_w - overflow).max(0.0)
        } else {
            label_w
        };
        item.keycap.setFrame(NSRect {
            origin: NSPoint { x, y: padding_y },
            size: NSSize {
                width: key_w,
                height: 18.0,
            },
        });
        item.key_label.setFrame(NSRect {
            origin: NSPoint {
                x: 0.0,
                y: (18.0 - key_h) / 2.0,
            },
            size: NSSize {
                width: key_w,
                height: key_h,
            },
        });
        item.label.setFrame(NSRect {
            origin: NSPoint {
                x: x + key_w + 4.0,
                y: padding_y + (18.0 - label_h) / 2.0,
            },
            size: NSSize {
                width: label_w,
                height: label_h,
            },
        });
        x += key_w + 4.0 + label_w + 14.0;
    }
    fade_shortcuts(&views.shortcuts_root, true);
}

fn hint_color(level: &str) -> Retained<NSColor> {
    match level {
        "error" => NSColor::labelColor(),
        "warn" => NSColor::systemOrangeColor(),
        _ => NSColor::labelColor(),
    }
}

// Resize real views each frame so AppKit also lays out its internal glass and
// text drawing layers. Animating only their backing layers leaves those internals
// at the destination size and makes the visible surface drift.
struct Resize {
    from: (NSSize, f64),
    to: (NSSize, f64),
    started: Instant,
    duration: f64,
}

impl Resize {
    fn frame(&self, now: Instant) -> (NSSize, f64) {
        let t = (now.duration_since(self.started).as_secs_f64() / self.duration).min(1.0);
        let progress = 1.0 - (1.0 - t).powi(3);
        let lerp = |from: f64, to: f64| from + (to - from) * progress;
        (
            NSSize {
                width: lerp(self.from.0.width, self.to.0.width),
                height: lerp(self.from.0.height, self.to.0.height),
            },
            lerp(self.from.1, self.to.1),
        )
    }
}

fn resize_frame(views: &mut Views, size: NSSize, radius: f64, duration: f64) -> (NSSize, f64) {
    let now = Instant::now();
    // Retarget from the last frame actually laid out, not an extrapolated frame.
    let current = (
        NSSize {
            width: views.width_constraint.constant(),
            height: views.height_constraint.constant(),
        },
        views.radius,
    );
    let target = (size, radius);
    if duration == 0.0 {
        views.resize = None;
        return target;
    }
    if views
        .resize
        .as_ref()
        .map(|resize| resize.to)
        .unwrap_or(current)
        != target
    {
        views.resize = Some(Resize {
            from: current,
            to: target,
            started: now,
            duration,
        });
    }
    if let Some(resize) = &views.resize {
        if now.duration_since(resize.started).as_secs_f64() < resize.duration {
            return resize.frame(now);
        }
        views.resize = None;
    }
    target
}

fn schedule_resize_tick(app: &AppHandle) {
    if RESIZE_TICK_PENDING.with(|pending| pending.replace(true)) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(16)).await;
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            RESIZE_TICK_PENDING.with(|pending| pending.set(false));
            MODEL.with(|model| render(&handle, &mut model.borrow_mut()));
        });
    });
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
    // SAFETY: ptr is the overlay window's live NSWindow for the app lifetime.
    let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
    let Some(content) = ns_window.contentView() else {
        return;
    };

    ensure_views(&content, model, mtm);

    let hint = visible_hint(model);
    let has_hint = !hint.is_empty();
    let has_text = !model.final_text.is_empty() || !model.partial_text.is_empty();
    let success = model.hint_variant == "success";
    let show_icon = model.hint_level == "error" || success;

    VIEWS.with(|v| {
        let mut slot = v.borrow_mut();
        let Some(views) = slot.as_mut() else {
            return;
        };

        let animate = unsafe {
            let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
            let reduced: bool = msg_send![workspace, accessibilityDisplayShouldReduceMotion];
            ns_window.isVisible() && !views.glass.view().isHidden() && !reduced
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
            views
                .label
                .setTextColor(Some(&hint_color(&model.hint_level)));
        } else if success {
            views.label.setStringValue(&NSString::from_str(""));
        } else {
            let attr = transcript_attr(model);
            views.label.setAttributedStringValue(&attr);
        }
        update_shortcuts(views, &model.shortcuts, mtm);

        // Reconnecting uses text only; recording keeps its waveform.
        let show_wave = model.app_state == "recording"
            && model.hint_level != "warn"
            && model.hint_level != "error";

        // AppKit cell sizing includes alignment-dependent padding.
        // Set the final alignment before measuring, including the first status frame.
        let center_text = has_hint && !show_wave && !show_icon;
        views.label.setAlignment(if center_text {
            NSTextAlignment::Center
        } else {
            NSTextAlignment::Left
        });

        // --- Decide wrap, measure width ---
        // Single-line mode first to measure the natural width.
        views.label.setUsesSingleLineMode(true);
        views.label.setMaximumNumberOfLines(1);
        views.label.setPreferredMaxLayoutWidth(0.0);
        views
            .label
            .setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
        // Measure the cell with clipping, independent of its previous narrow frame.
        views.label.setLineBreakMode(NSLineBreakMode::ByClipping);
        let natural = views
            .label
            .cell()
            .map(|cell| cell.cellSize())
            .unwrap_or_else(|| views.label.intrinsicContentSize());
        views
            .label
            .setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
        let measured_w = if has_hint || (has_text && !success) {
            natural.width.ceil()
        } else {
            0.0
        };
        let lock_layout = !show_icon
            && has_text
            && !has_hint
            && matches!(model.app_state.as_str(), "recording" | "finishing");
        let want_wrap = !show_icon
            && has_text
            && !has_hint
            && (model.layout_wrap || measured_w > SINGLE_LINE_LIMIT);

        // Chrome around the text (left pad + indicator/waveform slot + gap + right
        // action area). The waveform reuses the indicator slot, so it adds no width.
        let left_slot = if show_wave {
            WAVE_AREA_W + if has_text || has_hint { GAP } else { 0.0 }
        } else if show_icon {
            INDICATOR_W + if has_hint { GAP } else { 0.0 }
        } else {
            0.0
        };
        let chrome = PAD_LEFT + left_slot + PAD_RIGHT;
        let text_w = measured_w
            + if has_text && !has_hint && !show_icon {
                TEXT_SLACK
            } else if has_hint {
                2.0 // Protect the last glyph against fractional font metrics.
            } else {
                0.0
            };
        let next_width = if success && !has_hint {
            PAD_LEFT + INDICATOR_W + PAD_RIGHT
        } else if want_wrap {
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
            views
                .label
                .setLineBreakMode(NSLineBreakMode::ByWordWrapping);
            views.label.setPreferredMaxLayoutWidth(text_area_w);
            let full = views.label.intrinsicContentSize().height.ceil();
            let max_visible = one_line_h * (MAX_LINES as f64) + 4.0;
            let visible = full.min(max_visible);
            ((visible + 16.0).max(56.0), full, visible)
        } else if model.hint_level == "error" {
            // Error text may wrap; keyboard actions remain outside the pill.
            views.label.setUsesSingleLineMode(false);
            views.label.setMaximumNumberOfLines(3);
            views
                .label
                .setLineBreakMode(NSLineBreakMode::ByWordWrapping);
            views.label.setPreferredMaxLayoutWidth(text_area_w);
            let label_h = views.label.intrinsicContentSize().height.ceil();
            ((label_h + 16.0).max(PILL_H_SINGLE), label_h, label_h)
        } else {
            (PILL_H_SINGLE, one_line_h, one_line_h)
        };

        let target_radius = if model.layout_wrap || model.hint_level == "error" {
            16.0
        } else {
            pill_h / 2.0
        };
        let duration = if !animate {
            0.0
        } else if model.app_state == "recording" {
            0.14
        } else {
            0.2
        };
        let (size, radius) = resize_frame(
            views,
            NSSize {
                width: pill_w,
                height: pill_h,
            },
            target_radius,
            duration,
        );
        let pill_w = size.width;
        let pill_h = size.height;
        let text_area_w = (pill_w - chrome).max(10.0);
        views.radius = radius;
        unsafe {
            let _: () = msg_send![class!(NSAnimationContext), beginGrouping];
            let ctx: *mut AnyObject = msg_send![class!(NSAnimationContext), currentContext];
            let _: () = msg_send![ctx, setDuration: 0.0f64];
            let _: () = msg_send![ctx, setAllowsImplicitAnimation: false];
        }
        views.width_constraint.setConstant(pill_w);
        views.height_constraint.setConstant(pill_h);
        content.layoutSubtreeIfNeeded();
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

        views.indicator.setHidden(!show_icon);
        views.indicator.setFrame(NSRect {
            origin: NSPoint {
                x: if success && !has_hint {
                    (pill_w - INDICATOR_W) / 2.0
                } else {
                    PAD_LEFT
                },
                y: ((pill_h - INDICATOR_W) / 2.0).round(),
            },
            size: NSSize {
                width: INDICATOR_W,
                height: INDICATOR_W,
            },
        });
        if show_icon {
            set_icon(&views.icon_layer, success);
        }
        views.label.setHidden((!has_text || success) && !has_hint);
        views.label.setFrame(NSRect {
            origin: NSPoint {
                x: if center_text {
                    PAD_LEFT.max(PAD_RIGHT)
                } else {
                    PAD_LEFT + left_slot
                },
                y: ((pill_h - visible_text_h) / 2.0).round(),
            },
            size: NSSize {
                width: if center_text {
                    pill_w - 2.0 * PAD_LEFT.max(PAD_RIGHT)
                } else {
                    text_area_w
                },
                height: full_h,
            },
        });
        sync_foreground(views);

        let wave_active = WAVE_ACTIVE.with(|w| *w.borrow());
        layout_bars(views, pill_h, wave_active, show_wave);
        if show_wave && !has_text && !has_hint {
            for (i, bar) in views.bars.iter().enumerate() {
                let mut frame = bar.view.frame();
                frame.origin.x =
                    (pill_w - WAVE_AREA_W) / 2.0 + i as f64 * (WAVE_BAR_W + WAVE_BAR_GAP);
                bar.view.setFrame(frame);
            }
        }
        unsafe {
            let _: () = msg_send![class!(NSAnimationContext), endGrouping];
        }

        // Hint-text pulse (a gentle breathing opacity) for connecting/润色/重试/
        // 重连/录制中提示; off for transcript text, errors, and idle.
        let should_pulse =
            has_hint && model.hint_level != "error" && !success && model.app_state != "idle";
        set_label_pulse(&views.label, should_pulse);

        // Keep the pill visible throughout an active session (so the indicator
        // stays up while waiting for the first transcript); only hide it when idle
        // with no content.
        let active = matches!(
            model.app_state.as_str(),
            "connecting" | "recording" | "finishing"
        );
        let empty = !has_hint && !has_text && !active && !success;
        views.glass.view().setHidden(empty);
        unsafe {
            let layer: *mut AnyObject = msg_send![&*content, layer];
            if !layer.is_null() {
                let _: () = msg_send![layer, layoutIfNeeded];
            }
        }
    });
    if VIEWS.with(|views| {
        views
            .borrow()
            .as_ref()
            .is_some_and(|views| views.resize.is_some())
    }) {
        schedule_resize_tick(app);
    }
}

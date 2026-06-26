//! Overlay event dispatch + native macOS Liquid Glass renderer.
//!
//! The backend emits every overlay visual update as an `overlay:event`. A single
//! Rust-side listener (registered in `lib.rs`) forwards those same events here via
//! [`handle_event`]. On Windows this is a no-op (the WebviewWindow is the sole
//! renderer, hosting the React overlay). On macOS the overlay is a WebView-less
//! native Window; the event drives an AppKit pill rendered *inside* an
//! `NSGlassEffectView`, so the transcript text gets the OS's built-in,
//! content-aware legibility adaptation (the whole point of the native renderer).

pub(crate) mod shared;

use tauri::AppHandle;

/// Forward an `overlay:event` to the native macOS renderer. No-op elsewhere.
#[allow(unused_variables)]
pub fn handle_event(app: &AppHandle, event: &serde_json::Value) {
    #[cfg(target_os = "macos")]
    macos::dispatch(app, event);
}

/// Remember the app the user is currently working in, so we can hand keyboard
/// focus back to it after a retry (clicking the native retry button activates the
/// overlay, which would otherwise swallow the paste). No-op off macOS.
#[allow(unused_variables)]
pub fn capture_foreground_app(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    macos::capture_foreground_app(app);
}

/// Reactivate the app captured by [`capture_foreground_app`] so the subsequent
/// paste lands in the window the user was in. No-op off macOS.
#[allow(unused_variables)]
pub fn restore_foreground_app(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    macos::restore_foreground_app(app);
}

/// Native macOS overlay renderer. Builds and updates an AppKit pill
/// (`NSGlassEffectView` → container → indicator + transcript label) living inside
/// the overlay window's content view, above the transparent WebView.
#[cfg(target_os = "macos")]
mod macos;

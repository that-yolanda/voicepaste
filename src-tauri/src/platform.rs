//! Platform integration: macOS Dock visibility, app activation, and the
//! settings window show/rebuild lifecycle.

use tauri::AppHandle;
use tauri::Manager;

/// Show or hide the app in the macOS Dock.
#[cfg(target_os = "macos")]
pub(crate) fn set_dock_visible(visible: bool) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
    if let Some(mtm) = MainThreadMarker::new() {
        let app = NSApplication::sharedApplication(mtm);
        let policy = if visible {
            NSApplicationActivationPolicy::Regular
        } else {
            NSApplicationActivationPolicy::Accessory
        };
        app.setActivationPolicy(policy);
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn set_dock_visible(_visible: bool) {}

/// Bring the app to the foreground on macOS. After switching an accessory-policy
/// app back to Regular via `set_dock_visible(true)`, its windows still will not
/// reliably raise above other apps' windows without an explicit activate call.
///
/// Uses the legacy `-activateIgnoringOtherApps:` deliberately: its replacement
/// `-[NSApplication activate]` only exists on macOS 14+, while this app targets
/// 10.15 (`minimumSystemVersion`), where the new selector is absent and would
/// crash at runtime. The `#[allow(deprecated)]` silences the SDK deprecation
/// notice for this compatibility requirement.
#[cfg(target_os = "macos")]
pub(crate) fn activate_app() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;
    if let Some(mtm) = MainThreadMarker::new() {
        let app = NSApplication::sharedApplication(mtm);
        #[allow(deprecated)]
        app.activateIgnoringOtherApps(true);
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn activate_app() {}

/// Bring the settings window to front and show it in the Dock. If it was closed
/// (lazy lifecycle: closing destroys it to free the WebView), rebuild it from the
/// bundled window config before showing.
pub(crate) fn show_settings(app: &AppHandle) {
    // Switch back to Regular (show Dock) BEFORE showing/focusing the window: an
    // accessory-policy app cannot reliably raise its window above other apps, so
    // the policy flip must come first, and the foreground activation comes last.
    set_dock_visible(true);

    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    } else if let Some(cfg) = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "settings")
    {
        match tauri::WebviewWindowBuilder::from_config(app, cfg) {
            Ok(builder) => {
                if let Err(e) = builder.build() {
                    log_tray!(error, "failed to rebuild settings window: {e}");
                }
            }
            Err(e) => log_tray!(error, "failed to create settings window builder: {e}"),
        }
        // The rebuilt window has no implicit focus, so focus it explicitly.
        if let Some(window) = app.get_webview_window("settings") {
            let _ = window.set_focus();
        }
    }

    // Bring the app itself to the foreground so the window actually lands in front.
    activate_app();
}

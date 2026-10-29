//! Native permission checks for the same process that captures audio.

#[cfg(target_os = "macos")]
pub fn microphone_status() -> &'static str {
    use objc2::{class, msg_send};
    extern "C" {
        static AVMediaTypeAudio: *const objc2::runtime::AnyObject;
    }
    let status: isize = unsafe {
        msg_send![class!(AVCaptureDevice), authorizationStatusForMediaType: AVMediaTypeAudio]
    };
    match status {
        0 => "prompt",
        1 => "restricted",
        2 => "denied",
        3 => "granted",
        _ => "unknown",
    }
}

#[cfg(target_os = "windows")]
pub fn microphone_status() -> &'static str {
    use windows::Win32::{
        Media::Audio::{
            eCapture, eConsole, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
            AUDCLNT_SHAREMODE_SHARED,
        },
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
            COINIT_MULTITHREADED,
        },
    };
    // Probe WASAPI without starting capture or reading samples. This uses the
    // same default input role as cpal, and preserves native permission errors.
    let result = unsafe {
        let initialized = CoInitializeEx(None, COINIT_MULTITHREADED);
        if initialized.is_err() {
            return "unknown";
        }
        let result = (|| -> windows::core::Result<()> {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = enumerator.GetDefaultAudioEndpoint(eCapture, eConsole)?;
            let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
            let format = client.GetMixFormat()?;
            let result = client.Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 0, 0, format, None);
            CoTaskMemFree(Some(format.cast()));
            result
        })();
        CoUninitialize();
        result
    };
    match result {
        Ok(()) => "granted",
        Err(error) => windows_microphone_error(error.code().0),
    }
}

// Keep HRESULT classification independent of localized Windows error messages.
#[cfg(any(target_os = "windows", test))]
fn windows_microphone_error(code: i32) -> &'static str {
    match code as u32 {
        0x80070005 => "denied",    // E_ACCESSDENIED
        0x80070490 => "no_device", // E_NOTFOUND
        _ => "unavailable",
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn microphone_status() -> &'static str {
    "unknown"
}

pub async fn request_microphone() -> Result<&'static str, String> {
    #[cfg(target_os = "macos")]
    {
        use block2::RcBlock;
        use objc2::{class, msg_send, runtime::Bool};
        if microphone_status() == "prompt" {
            extern "C" {
                static AVMediaTypeAudio: *const objc2::runtime::AnyObject;
            }
            let (tx, rx) = tokio::sync::oneshot::channel();
            {
                let tx = std::sync::Mutex::new(Some(tx));
                let callback = RcBlock::new(move |_: Bool| {
                    if let Some(tx) = tx.lock().unwrap().take() {
                        let _ = tx.send(());
                    }
                });
                unsafe {
                    let _: () = msg_send![class!(AVCaptureDevice), requestAccessForMediaType: AVMediaTypeAudio, completionHandler: &*callback];
                }
                // AVFoundation copies the block before returning.
            }
            rx.await.map_err(|e| e.to_string())?;
        }
        Ok(microphone_status())
    }
    #[cfg(not(target_os = "macos"))]
    {
        tauri::async_runtime::spawn_blocking(microphone_status)
            .await
            .map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "macos")]
pub fn accessibility_status() -> &'static str {
    extern "C" {
        fn AXIsProcessTrusted() -> u8;
    }
    if unsafe { AXIsProcessTrusted() != 0 } {
        "granted"
    } else {
        "denied"
    }
}

#[cfg(not(target_os = "macos"))]
pub fn accessibility_status() -> &'static str {
    "granted"
}

pub fn open_microphone_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return open_settings(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    );
    #[cfg(target_os = "windows")]
    return open_settings("ms-settings:privacy-microphone");
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("Permission settings are not supported on this platform".into())
}

pub fn open_accessibility_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use core_foundation::{
            base::TCFType,
            boolean::CFBoolean,
            dictionary::CFDictionary,
            string::{CFString, CFStringRef},
        };
        extern "C" {
            static kAXTrustedCheckOptionPrompt: CFStringRef;
            fn AXIsProcessTrustedWithOptions(
                options: core_foundation::dictionary::CFDictionaryRef,
            ) -> u8;
        }
        if accessibility_status() != "granted" {
            let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
            let options = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
            unsafe {
                AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef());
            }
        }
        // Always navigate too: macOS may suppress a previously shown prompt.
        open_settings(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        )
    }
    #[cfg(not(target_os = "macos"))]
    Err("Accessibility settings are only available on macOS".into())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn open_settings(uri: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("explorer.exe");
        command.creation_flags(0x0800_0000);
        command
    };
    let status = command.arg(uri).status().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Could not open permission settings: {status}"))
    }
}

#[cfg(test)]
mod tests {
    use super::windows_microphone_error;

    #[test]
    fn windows_access_denied_is_not_confused_with_a_missing_or_broken_device() {
        assert_eq!(windows_microphone_error(0x80070005_u32 as i32), "denied");
        assert_eq!(windows_microphone_error(0x80070490_u32 as i32), "no_device");
        // AUDCLNT_E_DEVICE_INVALIDATED and AUDCLNT_E_SERVICE_NOT_RUNNING
        for code in [0x88890004_u32, 0x88890010, 0x80004005] {
            assert_eq!(windows_microphone_error(code as i32), "unavailable");
        }
    }
}

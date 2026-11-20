use std::sync::Mutex;
use std::time::Duration;

use objc2::{rc::autoreleasepool, runtime::ProtocolObject};
use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
use objc2_foundation::{NSArray, NSString};

use super::{simulate_paste, PasteResult};
use crate::errors::{AppError, AppErrorCode};

const CLIPBOARD_RESTORE_DELAY: Duration = Duration::from_secs(1);
static CLIPBOARD: Mutex<Clipboard> = Mutex::new(Clipboard { pending: None });

struct Clipboard {
    pending: Option<PendingRestore>,
}

struct PendingRestore {
    change_count: isize,
    original: String,
}

impl Clipboard {
    fn publish(
        &mut self,
        pasteboard: &NSPasteboard,
        text: &str,
        keep_clipboard: bool,
    ) -> Result<Option<isize>, AppError> {
        let pending = self.pending.take();
        let original = if keep_clipboard {
            None
        } else if let Some(pending) =
            pending.filter(|pending| pending.change_count == pasteboard.changeCount())
        {
            // Carry the user's original text across consecutive dictations.
            Some(pending.original)
        } else {
            // Match the clipboard plugin's first-text-item behavior.
            pasteboard.pasteboardItems().and_then(|items| {
                items
                    .iter()
                    .find_map(|item| item.stringForType(unsafe { NSPasteboardTypeString }))
                    .map(|text| text.to_string())
            })
        };

        let (change_count, written) = write_text(pasteboard, text);
        self.pending = original.map(|original| PendingRestore {
            change_count,
            original,
        });

        if !written {
            self.restore(pasteboard, change_count);
            return Err(AppError::new(AppErrorCode::PasteClipboardWriteFailed)
                .with_detail("NSPasteboard could not write the transcript"));
        }

        Ok(self.pending.as_ref().map(|pending| pending.change_count))
    }

    fn restore(&mut self, pasteboard: &NSPasteboard, change_count: isize) {
        let Some(pending) = self
            .pending
            .take_if(|pending| pending.change_count == change_count)
        else {
            return;
        };

        if pasteboard.changeCount() == change_count && !write_text(pasteboard, &pending.original).1
        {
            log_rec!(
                error,
                "Failed to restore clipboard: NSPasteboard write failed"
            );
        }
    }
}

fn write_text(pasteboard: &NSPasteboard, text: &str) -> (isize, bool) {
    let objects =
        NSArray::from_retained_slice(&[ProtocolObject::from_retained(NSString::from_str(text))]);
    // Use the count returned when we claim the pasteboard. Reading it after
    // writing could capture a newer copy from a different application.
    let change_count = pasteboard.clearContents();
    (change_count, pasteboard.writeObjects(&objects))
}

pub(super) fn paste_text(text: &str, keep_clipboard: bool) -> Result<PasteResult, AppError> {
    autoreleasepool(|_| {
        let mut clipboard = CLIPBOARD.lock().unwrap();
        let pasteboard = NSPasteboard::generalPasteboard();
        let restore = clipboard.publish(&pasteboard, text, keep_clipboard)?;
        let result = simulate_paste();

        if let Some(change_count) = restore {
            if result.ok {
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(CLIPBOARD_RESTORE_DELAY).await;
                    autoreleasepool(|_| {
                        CLIPBOARD
                            .lock()
                            .unwrap()
                            .restore(&NSPasteboard::generalPasteboard(), change_count);
                    });
                });
            } else {
                clipboard.restore(&pasteboard, change_count);
            }
        }
        Ok(result)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_clipboard(test: impl FnOnce(&mut Clipboard, &NSPasteboard)) {
        autoreleasepool(|_| {
            let pasteboard = NSPasteboard::pasteboardWithUniqueName();
            assert!(write_text(&pasteboard, "original").1);
            test(&mut Clipboard { pending: None }, &pasteboard);
            // SAFETY: This pasteboard was created with a unique name for this test.
            let _: () = unsafe { objc2::msg_send![&*pasteboard, releaseGlobally] };
        });
    }

    fn read_text(pasteboard: &NSPasteboard) -> String {
        pasteboard
            .stringForType(unsafe { NSPasteboardTypeString })
            .unwrap()
            .to_string()
    }

    #[test]
    fn restores_original_once_the_wait_ends() {
        with_clipboard(|clipboard, pasteboard| {
            let count = clipboard
                .publish(pasteboard, "transcript", false)
                .unwrap()
                .unwrap();
            assert_eq!(pasteboard.changeCount(), count);
            assert_eq!(read_text(pasteboard), "transcript");
            clipboard.restore(pasteboard, count);
            assert_eq!(read_text(pasteboard), "original");
        });
    }

    #[test]
    fn preserves_a_newer_copy_even_if_the_text_matches() {
        with_clipboard(|clipboard, pasteboard| {
            let count = clipboard
                .publish(pasteboard, "transcript", false)
                .unwrap()
                .unwrap();
            assert!(write_text(pasteboard, "transcript").1);
            clipboard.restore(pasteboard, count);
            assert_eq!(read_text(pasteboard), "transcript");
        });
    }

    #[test]
    fn consecutive_dictations_only_restore_after_the_latest_one() {
        with_clipboard(|clipboard, pasteboard| {
            let first = clipboard
                .publish(pasteboard, "first", false)
                .unwrap()
                .unwrap();
            let second = clipboard
                .publish(pasteboard, "second", false)
                .unwrap()
                .unwrap();
            clipboard.restore(pasteboard, first);
            assert_eq!(read_text(pasteboard), "second");
            clipboard.restore(pasteboard, second);
            assert_eq!(read_text(pasteboard), "original");
        });
    }

    #[test]
    fn keeping_transcript_supersedes_a_pending_restore() {
        with_clipboard(|clipboard, pasteboard| {
            let first = clipboard
                .publish(pasteboard, "first", false)
                .unwrap()
                .unwrap();
            assert_eq!(clipboard.publish(pasteboard, "second", true).unwrap(), None);
            clipboard.restore(pasteboard, first);
            assert_eq!(read_text(pasteboard), "second");
        });
    }
}

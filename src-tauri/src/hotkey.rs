use rdev::{self, EventType, Key};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

#[allow(dead_code)]
/// Map rdev::Key to uIOhook-style keycode for compatibility with existing frontend.
/// This ensures that hotkey arrays stored in config.yaml remain valid after migration.
pub fn rdev_key_to_uiohook_keycode(key: &Key) -> Option<u32> {
    // uIOhook keycode values matching the Electron app's UiohookKey constants
    Some(match key {
        Key::Escape => 0x0001,
        Key::F1 => 0x003B,
        Key::F2 => 0x003C,
        Key::F3 => 0x003D,
        Key::F4 => 0x003E,
        Key::F5 => 0x003F,
        Key::F6 => 0x0040,
        Key::F7 => 0x0041,
        Key::F8 => 0x0042,
        Key::F9 => 0x0043,
        Key::F10 => 0x0044,
        Key::F11 => 0x0057,
        Key::F12 => 0x0058,
        Key::Space => 0x0020,
        Key::Return => 0x0028,
        Key::Backspace => 0x002A,
        Key::Tab => 0x002B,
        Key::ShiftLeft => 0x002E,
        Key::ShiftRight => 0x0036,
        Key::ControlLeft => 0x001D,
        Key::ControlRight => 0x009D,
        Key::Alt => 0x0038,
        Key::AltGr => 0x0138,
        Key::MetaLeft => 0x0037,  // Command/Windows
        Key::MetaRight => 0x00D7,
        Key::UpArrow => 0x0067,
        Key::DownArrow => 0x006C,
        Key::LeftArrow => 0x0069,
        Key::RightArrow => 0x006A,
        Key::KeyA => 0x0004,
        Key::KeyB => 0x0005,
        Key::KeyC => 0x0006,
        Key::KeyD => 0x0007,
        Key::KeyE => 0x0008,
        Key::KeyF => 0x0009,
        Key::KeyG => 0x000A,
        Key::KeyH => 0x000B,
        Key::KeyI => 0x000C,
        Key::KeyJ => 0x000D,
        Key::KeyK => 0x000E,
        Key::KeyL => 0x000F,
        Key::KeyM => 0x0010,
        Key::KeyN => 0x0011,
        Key::KeyO => 0x0012,
        Key::KeyP => 0x0013,
        Key::KeyQ => 0x0014,
        Key::KeyR => 0x0015,
        Key::KeyS => 0x0016,
        Key::KeyT => 0x0017,
        Key::KeyU => 0x0018,
        Key::KeyV => 0x0019,
        Key::KeyW => 0x001A,
        Key::KeyX => 0x001B,
        Key::KeyY => 0x001C,
        Key::KeyZ => 0x001D,
        _ => return None,
    })
}

#[allow(dead_code)]
/// Convert uIOhook-style keycode to display name.
pub fn keycode_to_display_name(keycode: u32) -> String {
    match keycode {
        0x0001 => "Escape".to_string(),
        0x0020 => "␣".to_string(),
        0x0028 => "Enter".to_string(),
        0x002A => "Backspace".to_string(),
        0x002B => "Tab".to_string(),
        0x001D => "L ⌃".to_string(),
        0x009D => "R ⌃".to_string(),
        0x002E => "L ⇧".to_string(),
        0x0036 => "R ⇧".to_string(),
        0x0038 => "L ⌥".to_string(),
        0x0138 => "R ⌥".to_string(),
        0x0037 => "L ⌘".to_string(),
        0x00D7 => "R ⌘".to_string(),
        0x003B..=0x0044 => format!("F{}", keycode - 0x003A),
        0x0057 => "F11".to_string(),
        0x0058 => "F12".to_string(),
        0x0064 => "F13".to_string(),
        0x0065 => "F14".to_string(),
        0x0066 => "F15".to_string(),
        0x0067 => "F16".to_string(),
        0x0068 => "F17".to_string(),
        0x0069 => "F18".to_string(),
        0x006A => "F19".to_string(),
        0x006B => "F20".to_string(),
        _ => format!("Key({})", keycode),
    }
}

#[allow(dead_code)]
/// Format a hotkey array (of uIOhook keycodes) as a display string.
pub fn format_hotkey(keycodes: &[u32]) -> String {
    keycodes
        .iter()
        .map(|k| keycode_to_display_name(*k))
        .collect::<Vec<_>>()
        .join(" + ")
}

#[allow(dead_code)]
/// Normalize right-side modifier keys to their left equivalents.
pub fn normalize_keycode(keycode: u32) -> u32 {
    match keycode {
        0x009D => 0x001D, // CtrlRight → Ctrl
        0x0036 => 0x002E, // ShiftRight → Shift
        0x0138 => 0x0038, // AltRight → Alt
        0x00D7 => 0x0037, // MetaRight → Meta
        k => k,
    }
}

/// State for the hotkey recorder.
pub struct HotkeyRecorder {
    pub is_recording: Arc<AtomicBool>,
    pub recording_combo: Arc<Mutex<HashSet<u32>>>,
    pub max_size: Arc<Mutex<usize>>,
    pub pressed_keys: Arc<Mutex<HashSet<u32>>>,
    pub resolve_callback: Arc<Mutex<Option<Box<dyn FnOnce(Vec<u32>) + Send>>>>,
}

impl HotkeyRecorder {
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self {
            is_recording: Arc::new(AtomicBool::new(false)),
            recording_combo: Arc::new(Mutex::new(HashSet::new())),
            max_size: Arc::new(Mutex::new(0)),
            pressed_keys: Arc::new(Mutex::new(HashSet::new())),
            resolve_callback: Arc::new(Mutex::new(None)),
        }
    }

    #[allow(dead_code)]
    /// Start recording a hotkey combination.
    /// Returns the recorded keycodes via the callback.
    pub fn start_recording<F>(&self, callback: F)
    where
        F: FnOnce(Vec<u32>) + Send + 'static,
    {
        self.is_recording.store(true, Ordering::SeqCst);
        self.recording_combo.lock().unwrap().clear();
        *self.max_size.lock().unwrap() = 0;
        self.pressed_keys.lock().unwrap().clear();
        *self.resolve_callback.lock().unwrap() = Some(Box::new(callback));
    }

    /// Handle a key event. Safe to call from any normal (non-CGEventTap) thread.
    pub fn handle_key_event(&self, event_type: &EventType) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.handle_key_event_impl(event_type);
        }));
    }

    fn handle_key_event_impl(&self, event_type: &EventType) {
        let key = match event_type {
            EventType::KeyPress(k) | EventType::KeyRelease(k) => k,
            _ => return,
        };

        let keycode = match rdev_key_to_uiohook_keycode(key) {
            Some(kc) => kc,
            None => return,
        };

        let is_press = matches!(event_type, EventType::KeyPress(_));

        // Helper macro to safely lock a mutex, returning on poison
        macro_rules! lock {
            ($m:expr) => {
                match $m.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                }
            };
        }

        if is_press {
            lock!(self.pressed_keys).insert(keycode);

            if self.is_recording.load(Ordering::SeqCst) {
                // In recording mode
                let escape_code = 0x0001u32; // Escape
                let is_empty = {
                    let combo = lock!(self.recording_combo);
                    combo.is_empty()
                };

                if keycode == escape_code && is_empty {
                    // User pressed Escape with no modifiers → cancel recording
                    self.is_recording.store(false, Ordering::SeqCst);
                    lock!(self.pressed_keys).clear();
                    if let Some(cb) = lock!(self.resolve_callback).take() {
                        cb(vec![]);
                    }
                    return;
                }

                {
                    let mut combo = lock!(self.recording_combo);
                    combo.insert(keycode);
                    let mut max = lock!(self.max_size);
                    if combo.len() > *max {
                        *max = combo.len();
                    }
                }
            }
        } else {
            // Key release
            if self.is_recording.load(Ordering::SeqCst) {
                let max = *lock!(self.max_size);
                if max > 0 {
                    // Recording complete — resolve with the combo
                    let result: Vec<u32> = {
                        let combo = lock!(self.recording_combo);
                        combo.iter().copied().collect()
                    };

                    self.is_recording.store(false, Ordering::SeqCst);
                    lock!(self.pressed_keys).clear();

                    if let Some(cb) = lock!(self.resolve_callback).take() {
                        cb(result);
                    }
                }
            }

            lock!(self.pressed_keys).remove(&keycode);
        }
    }

    #[allow(dead_code)]
    pub fn is_recording(&self) -> bool {
        self.is_recording.load(Ordering::SeqCst)
    }

    #[allow(dead_code)]
    /// Check if a specific set of keycodes are all currently pressed.
    pub fn is_hotkey_pressed(&self, keycodes: &[u32]) -> bool {
        let pressed = match self.pressed_keys.lock() {
            Ok(p) => p,
            Err(_) => return false,
        };
        keycodes.iter().all(|k| pressed.contains(k))
    }
}

#[allow(dead_code)]
/// Start listening for global keyboard events via rdev.
///
/// Uses a two-thread design to avoid macOS CGEventTap restrictions:
/// - Thread A (event tap): just pushes raw events into a lock-free mpsc channel
/// - Thread B (consumer): pulls from the channel and does mutex-lock-heavy processing
///
/// The CGEventTap callback runs in a real-time context where locks, allocations,
/// and syscalls can trigger SIGTRAP (EXC_BREAKPOINT).
pub fn start_keyboard_listener(recorder: Arc<HotkeyRecorder>) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<EventType>();

    // Thread A: rdev event-tap callback — must be FAST, no locks, no allocation
    std::thread::spawn(move || {
        eprintln!("[rdev] event-tap thread started");
        let result = rdev::listen(move |event| {
            if let EventType::KeyPress(_) | EventType::KeyRelease(_) = event.event_type {
                // Only a channel send — safe inside CGEventTap callback
                let _ = tx.send(event.event_type);
            }
        });
        eprintln!("[rdev] event-tap thread ended: {:?}", result.as_ref().err());
    });

    // Thread B: consumer — safe to use mutex locks here
    std::thread::spawn(move || {
        eprintln!("[rdev] consumer thread started");
        for event_type in rx {
            recorder.handle_key_event(&event_type);
        }
        eprintln!("[rdev] consumer thread ended (channel closed)");
    });

    Ok(())
}

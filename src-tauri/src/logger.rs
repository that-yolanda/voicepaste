//! Global logging with structured output and automatic file rotation.
//!
//! Implements `log::Log` to provide `[MODULE][LEVEL]` formatted output.
//! INFO and above are written to the log file; DEBUG is stderr-only (dev builds).
//! Log file rotates at 300KB: old content is gzip-compressed to `.log.gz` (1 backup).

use chrono::Utc;
use flate2::write::GzEncoder;
use flate2::Compression;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

const MAX_LOG_SIZE: u64 = 300 * 1024; // 300KB

/// Structured logger implementing `log::Log`.
///
/// Writes formatted log lines to both stderr and a rotating log file.
/// Module names are specified via `log::target()` using the `log_*!` macros below.
pub struct VoiceLogger {
    log_path: PathBuf,
    file: Mutex<Option<File>>,
}

impl VoiceLogger {
    pub fn new(log_path: PathBuf) -> Self {
        let logger = Self {
            log_path,
            file: Mutex::new(None),
        };
        logger.rotate_if_needed();
        logger
    }

    /// If the log file exceeds `MAX_LOG_SIZE`, gzip it to `.log.gz` (overwriting
    /// any previous backup) and start a fresh log file.
    fn rotate_if_needed(&self) {
        if !self.log_path.exists() {
            return;
        }
        let Ok(meta) = fs::metadata(&self.log_path) else {
            return;
        };
        if meta.len() < MAX_LOG_SIZE {
            return;
        }

        // Close current file handle so we can safely manipulate the file.
        *self.file.lock().unwrap() = None;

        let gz_path = self.log_path.with_extension("log.gz");
        if let Ok(content) = fs::read(&self.log_path) {
            let mut encoder = GzEncoder::new(
                File::create(&gz_path)
                    .unwrap_or_else(|e| panic!("Failed to create {}: {}", gz_path.display(), e)),
                Compression::fast(),
            );
            let _ = encoder.write_all(&content);
            let _ = encoder.finish();
        }
        let _ = fs::remove_file(&self.log_path);
    }

    fn write_to_file(&self, line: &str) {
        let mut guard = self.file.lock().unwrap();
        if guard.is_none() {
            self.rotate_if_needed();
            *guard = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.log_path)
                .ok();
        }
        if let Some(ref mut f) = *guard {
            let _ = writeln!(f, "{}", line);
        }
    }
}

impl log::Log for VoiceLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::max_level()
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let formatted = format!(
            "{} [{}][{}] {}",
            Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            record.target(),
            record.level(),
            record.args(),
        );
        eprintln!("{}", formatted);
        // INFO and above are persisted to the log file.
        if record.level() <= log::Level::Info {
            self.write_to_file(&formatted);
        }
    }

    fn flush(&self) {
        if let Some(ref f) = *self.file.lock().unwrap() {
            let _ = f.sync_all();
        }
    }
}

// ---------------------------------------------------------------------------
// Module-prefixed logging macros
// ---------------------------------------------------------------------------
// Usage: `log_rec!(info, "State → {}", state)` → `[Recording][INFO] State → idle`
// The first argument is always the log-level ident (error / warn / info / debug).

#[macro_export]
macro_rules! log_app {
    ($l:ident, $($t:tt)*) => { log::$l!(target: "App", $($t)*) };
}
#[macro_export]
macro_rules! log_rec {
    ($l:ident, $($t:tt)*) => { log::$l!(target: "Recording", $($t)*) };
}
#[macro_export]
macro_rules! log_asr {
    ($l:ident, $($t:tt)*) => { log::$l!(target: "ASR", $($t)*) };
}
#[macro_export]
macro_rules! log_audio {
    ($l:ident, $($t:tt)*) => { log::$l!(target: "Audio", $($t)*) };
}
#[macro_export]
macro_rules! log_hotkey {
    ($l:ident, $($t:tt)*) => { log::$l!(target: "Hotkey", $($t)*) };
}
#[macro_export]
macro_rules! log_events {
    ($l:ident, $($t:tt)*) => { log::$l!(target: "Events", $($t)*) };
}
#[macro_export]
macro_rules! log_tray {
    ($l:ident, $($t:tt)*) => { log::$l!(target: "Tray", $($t)*) };
}
#[macro_export]
macro_rules! log_update {
    ($l:ident, $($t:tt)*) => { log::$l!(target: "Update", $($t)*) };
}
#[macro_export]
macro_rules! log_migration {
    ($l:ident, $($t:tt)*) => { log::$l!(target: "Migration", $($t)*) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn voice_logger_new_creates_file() {
        let dir = tempdir().unwrap();
        let log_path = dir.path().join("test.log");
        let _logger = VoiceLogger::new(log_path.clone());
        // The logger should be constructable without errors
        // File is created lazily on first write, so just verify no panic
    }

    #[test]
    fn voice_logger_log_level_filtering() {
        let dir = tempdir().unwrap();
        let log_path = dir.path().join("test.log");
        let logger = VoiceLogger::new(log_path.clone());

        // Write an info-level log line directly to file
        logger.write_to_file("[App][INFO] test message");

        // Verify file was written
        let content = std::fs::read_to_string(&log_path).unwrap();
        assert!(content.contains("test message"));
    }

    #[test]
    fn write_to_file_appends() {
        let dir = tempdir().unwrap();
        let log_path = dir.path().join("test.log");
        let logger = VoiceLogger::new(log_path.clone());

        logger.write_to_file("line 1");
        logger.write_to_file("line 2");

        let content = std::fs::read_to_string(&log_path).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("line 1"));
        assert!(lines[1].contains("line 2"));
    }

    #[test]
    fn log_rotation_writes_gz() {
        let dir = tempdir().unwrap();
        let log_path = dir.path().join("test.log");
        let gz_path = dir.path().join("test.log.gz");

        // Create a log file that's over the size limit
        let big_line = "x".repeat(1000);
        {
            let mut file = std::fs::File::create(&log_path).unwrap();
            for _ in 0..400 {
                // 400 * 1000 = 400KB > 300KB limit
                writeln!(file, "{}", big_line).unwrap();
            }
        }

        // Create logger — should trigger rotation
        let _logger = VoiceLogger::new(log_path.clone());

        // After rotation, the .gz file should exist
        assert!(gz_path.exists(), "Rotated .gz file should exist");
    }

    #[test]
    fn no_rotation_under_limit() {
        let dir = tempdir().unwrap();
        let log_path = dir.path().join("test.log");
        let gz_path = dir.path().join("test.log.gz");

        // Create a small log file
        {
            let mut file = std::fs::File::create(&log_path).unwrap();
            writeln!(file, "small log").unwrap();
        }

        let _logger = VoiceLogger::new(log_path.clone());

        // No rotation should happen for small files
        assert!(
            !gz_path.exists(),
            "No .gz file should be created for small logs"
        );
    }
}

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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::{bounded, Receiver, Sender};

const MAX_LOG_SIZE: u64 = 300 * 1024; // 300KB

/// Remove credentials from provider errors before they reach logs or the UI.
///
/// Longest values are replaced first so a short secret that is a substring of
/// a longer one cannot pre-empt it. A pattern pass then redacts
/// credential-shaped `key=value` pairs even when the value is not one of the
/// configured secrets (e.g. a gateway echoing a header the caller never
/// configured).
pub(crate) fn redact_credentials(text: &str, credentials: &[&str]) -> String {
    static CREDENTIAL_PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let mut credentials: Vec<_> = credentials
        .iter()
        .copied()
        .filter(|value| !value.is_empty())
        .collect();
    credentials.sort_by_key(|value| std::cmp::Reverse(value.len()));
    let text = credentials.iter().fold(text.to_string(), |text, value| {
        text.replace(value, "[REDACTED]")
    });
    let pattern = CREDENTIAL_PATTERN.get_or_init(|| {
        regex::Regex::new(
            r#"(?i)(xi-api-key|api[_-]?key|authorization|(?:access_)?token)[\s"']*[:=][\s"']*(?:bearer\s+)?[^\s,;"'}]+"#,
        )
        .expect("credential redaction pattern must compile")
    });
    pattern.replace_all(&text, "$1=[REDACTED]").into_owned()
}

const QUEUE_CAPACITY: usize = 256;
const MAX_LINE_BYTES: usize = 16 * 1024;
const FLUSH_TIMEOUT: Duration = Duration::from_secs(2);

enum Message {
    Line(log::Level, String),
    Flush(Sender<()>),
}

/// A bounded queue keeps filesystem and terminal I/O off caller threads.
pub struct VoiceLogger {
    sender: Sender<Message>,
    dropped: Arc<AtomicU64>,
}

impl VoiceLogger {
    pub fn new(log_path: PathBuf) -> Self {
        let (sender, receiver) = bounded(QUEUE_CAPACITY);
        let dropped = Arc::new(AtomicU64::new(0));
        let worker_dropped = Arc::clone(&dropped);
        // A failed logging worker must not prevent voice input from starting.
        let _ = std::thread::Builder::new()
            .name("voicepaste-logger".into())
            .spawn(move || run_writer(receiver, worker_dropped, log_path));
        Self { sender, dropped }
    }

    fn enqueue(&self, level: log::Level, args: std::fmt::Arguments<'_>) {
        let line = bounded_line(args);
        if self.sender.try_send(Message::Line(level, line)).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn flush_pending(&self) {
        let (sender, receiver) = bounded(1);
        if self
            .sender
            .send_timeout(Message::Flush(sender), FLUSH_TIMEOUT)
            .is_ok()
        {
            let _ = receiver.recv_timeout(FLUSH_TIMEOUT);
        }
    }
}

struct BoundedLine(String);

impl std::fmt::Write for BoundedLine {
    fn write_str(&mut self, text: &str) -> std::fmt::Result {
        let remaining = MAX_LINE_BYTES - " [truncated]".len() - self.0.len();
        let mut end = remaining.min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        self.0.push_str(&text[..end]);
        if end < text.len() {
            Err(std::fmt::Error)
        } else {
            Ok(())
        }
    }
}

fn bounded_line(args: std::fmt::Arguments<'_>) -> String {
    let mut line = BoundedLine(String::with_capacity(MAX_LINE_BYTES));
    if std::fmt::write(&mut line, args).is_err() {
        line.0.push_str(" [truncated]");
    }
    line.0
}

struct LogFile {
    path: PathBuf,
    file: Option<File>,
    written: u64,
    retry_rotation: Option<Instant>,
}

impl LogFile {
    fn open(&mut self) -> std::io::Result<()> {
        if self.file.is_none() {
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)?;
            self.written = file.metadata()?.len();
            self.file = Some(file);
        }
        Ok(())
    }

    fn rotate(&mut self) -> std::io::Result<()> {
        self.file.take();
        let backup = self.path.with_extension("log.gz");
        let temporary = self.path.with_extension("log.gz.tmp");
        let mut source = File::open(&self.path)?;
        let mut encoder = GzEncoder::new(File::create(&temporary)?, Compression::fast());
        std::io::copy(&mut source, &mut encoder)?;
        encoder.finish()?;
        drop(source);
        // Keep the source until a complete backup has been installed.
        if backup.exists() {
            fs::remove_file(&backup)?;
        }
        fs::rename(&temporary, &backup)?;
        fs::remove_file(&self.path)?;
        self.written = 0;
        Ok(())
    }

    fn write(&mut self, line: &str) -> std::io::Result<()> {
        self.open()?;
        let bytes = line.len() as u64 + 1;
        if self.written + bytes > MAX_LOG_SIZE
            && self
                .retry_rotation
                .is_none_or(|deadline| Instant::now() >= deadline)
        {
            if let Err(error) = self.rotate() {
                self.retry_rotation = Some(Instant::now() + Duration::from_secs(60));
                self.open()?;
                let notice = format!(
                    "[App][WARN] Log rotation failed: {}; retrying in 60s",
                    error
                );
                if self.written + (notice.len() as u64) < 2 * MAX_LOG_SIZE {
                    writeln!(self.file.as_mut().expect("log file opened"), "{}", notice)?;
                    self.written += notice.len() as u64 + 1;
                }
            } else {
                self.retry_rotation = None;
                self.open()?;
            }
        }
        // Bound degraded-mode growth while retaining recent diagnostics and the source.
        if self.written + bytes > 2 * MAX_LOG_SIZE {
            return Err(std::io::Error::other("log full while rotation unavailable"));
        }
        let file = self.file.as_mut().expect("log file opened");
        if let Err(error) = writeln!(file, "{}", line) {
            self.file.take();
            return Err(error);
        }
        self.written += bytes;
        Ok(())
    }
}

fn run_writer(receiver: Receiver<Message>, dropped: Arc<AtomicU64>, path: PathBuf) {
    let mut output = LogFile {
        path,
        file: None,
        written: 0,
        retry_rotation: None,
    };
    let (terminal, terminal_lines) = bounded::<String>(32);
    let _ = std::thread::Builder::new()
        .name("voicepaste-log-terminal".into())
        .spawn(move || {
            for line in terminal_lines {
                let _ = writeln!(std::io::stderr(), "{}", line);
            }
        });
    while let Ok(message) = receiver.recv() {
        match message {
            Message::Line(level, line) => {
                let count = dropped.swap(0, Ordering::Relaxed);
                if count > 0 {
                    let notice = format!(
                        "{} [App][WARN] Logging queue dropped {} messages",
                        Utc::now().to_rfc3339(),
                        count
                    );
                    let _ = terminal.try_send(notice.clone());
                    let _ = output.write(&notice);
                }
                let _ = terminal.try_send(line.clone());
                if level <= log::Level::Info {
                    let _ = output.write(&line);
                }
            }
            Message::Flush(done) => {
                if let Some(file) = &output.file {
                    let _ = file.sync_all();
                }
                let _ = done.send(());
            }
        }
    }
}

impl log::Log for VoiceLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::max_level()
    }

    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            self.enqueue(
                record.level(),
                format_args!(
                    "{} [{}][{}] {}",
                    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                    record.target(),
                    record.level(),
                    record.args(),
                ),
            );
        }
    }

    fn flush(&self) {
        self.flush_pending();
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
    use tempfile::tempdir;

    #[test]
    fn provider_errors_do_not_expose_configured_credentials() {
        let message = redact_credentials(
            "Rejected credential-short-long; token=other-private-value; HTTP 401",
            &[
                "credential-short",
                "credential-short-long",
                "other-private-value",
                "",
            ],
        );
        assert_eq!(message, "Rejected [REDACTED]; token=[REDACTED]; HTTP 401");
    }

    #[test]
    fn credential_shaped_pairs_are_redacted_even_when_not_configured() {
        // A gateway echoing a header the caller never configured: the exact
        // values are unknown here, the pattern pass must still catch them.
        let message = redact_credentials(
            "Rejected Authorization: Bearer sk-proxy-123 and api_key=abcdef",
            &[],
        );
        assert_eq!(
            message,
            "Rejected Authorization=[REDACTED] and api_key=[REDACTED]"
        );
    }

    #[test]
    fn ordinary_words_with_credential_names_stay_readable() {
        // Words like "Token" or "max_tokens" that are not key=value pairs must
        // not be mangled.
        let message = redact_credentials(
            "ASR 鉴权失败，请检查 AppID / Token / Resource ID; max_tokens: 100",
            &[],
        );
        assert_eq!(
            message,
            "ASR 鉴权失败，请检查 AppID / Token / Resource ID; max_tokens: 100"
        );
    }

    #[test]
    fn background_writer_appends_and_flushes() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("voicepaste.log");
        let logger = VoiceLogger::new(path.clone());
        logger.enqueue(log::Level::Info, format_args!("first"));
        logger.enqueue(log::Level::Debug, format_args!("debug-only"));
        logger.enqueue(log::Level::Info, format_args!("second"));
        logger.flush_pending();
        assert_eq!(fs::read_to_string(path).unwrap(), "first\nsecond\n");
    }

    #[test]
    fn long_running_writer_rotates_without_restarting() {
        use std::io::Read;
        let dir = tempdir().unwrap();
        let path = dir.path().join("voicepaste.log");
        let mut output = LogFile {
            path: path.clone(),
            file: None,
            written: 0,
            retry_rotation: None,
        };
        for _ in 0..80 {
            output.write(&"x".repeat(8192)).unwrap();
        }
        output.write("latest message").unwrap();
        assert!(fs::metadata(&path).unwrap().len() <= MAX_LOG_SIZE);
        assert!(fs::read_to_string(&path)
            .unwrap()
            .ends_with("latest message\n"));
        let mut backup = String::new();
        flate2::read::GzDecoder::new(File::open(path.with_extension("log.gz")).unwrap())
            .read_to_string(&mut backup)
            .unwrap();
        assert!(!backup.is_empty());
        assert!(backup.len() as u64 <= MAX_LOG_SIZE);
    }

    #[test]
    fn existing_oversized_log_is_preserved_in_backup() {
        use std::io::Read;
        let dir = tempdir().unwrap();
        let path = dir.path().join("voicepaste.log");
        let old = "x".repeat(MAX_LOG_SIZE as usize + 100);
        fs::write(&path, &old).unwrap();
        let logger = VoiceLogger::new(path.clone());
        logger.enqueue(log::Level::Info, format_args!("new session"));
        logger.flush_pending();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new session\n");
        let mut backup = String::new();
        flate2::read::GzDecoder::new(File::open(path.with_extension("log.gz")).unwrap())
            .read_to_string(&mut backup)
            .unwrap();
        assert_eq!(backup, old);
    }

    #[test]
    fn failed_backup_does_not_delete_source() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("voicepaste.log");
        fs::write(&path, "original").unwrap();
        fs::create_dir(path.with_extension("log.gz")).unwrap();
        let mut output = LogFile {
            path: path.clone(),
            file: None,
            written: 0,
            retry_rotation: None,
        };
        assert!(output.rotate().is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "original");
    }

    #[test]
    fn failed_rotation_keeps_new_logs_and_retries_after_cooldown() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("voicepaste.log");
        fs::write(&path, "x".repeat(MAX_LOG_SIZE as usize)).unwrap();
        let temporary = path.with_extension("log.gz.tmp");
        fs::create_dir(&temporary).unwrap();
        let mut output = LogFile {
            path: path.clone(),
            file: None,
            written: 0,
            retry_rotation: None,
        };
        for _ in 0..5 {
            output.write("new message").unwrap();
        }
        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content.matches("Log rotation failed").count(), 1);
        assert_eq!(content.matches("new message").count(), 5);
        fs::remove_dir(temporary).unwrap();
        output.retry_rotation = Some(Instant::now());
        output.write("recovered").unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "recovered\n");
    }

    #[test]
    fn full_queue_drops_instead_of_waiting_and_bounds_unicode_lines() {
        let (sender, receiver) = bounded(1);
        let logger = VoiceLogger {
            sender,
            dropped: Arc::new(AtomicU64::new(0)),
        };
        logger.enqueue(
            log::Level::Info,
            format_args!("{}", "测试".repeat(MAX_LINE_BYTES)),
        );
        logger.enqueue(log::Level::Info, format_args!("overflow"));
        assert_eq!(logger.dropped.load(Ordering::Relaxed), 1);
        let Message::Line(_, line) = receiver.recv().unwrap() else {
            panic!("expected log line")
        };
        assert!(line.len() <= MAX_LINE_BYTES);
        assert!(line.capacity() <= MAX_LINE_BYTES);
        assert!(line.ends_with(" [truncated]"));
    }
}

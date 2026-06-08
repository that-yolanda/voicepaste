use chrono::Utc;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

const MAX_LOG_SIZE: u64 = 1024 * 512; // 512KB

pub struct Logger {
    log_path: PathBuf,
    file: Option<File>,
}

impl Logger {
    pub fn new(log_path: PathBuf) -> Self {
        Self {
            log_path,
            file: None,
        }
    }

    fn ensure_file(&mut self) {
        if self.file.is_some() {
            return;
        }

        // Rotate if file is too large
        if self.log_path.exists() {
            if let Ok(metadata) = fs::metadata(&self.log_path) {
                if metadata.len() >= MAX_LOG_SIZE {
                    if let Ok(content) = fs::read_to_string(&self.log_path) {
                        let keep = &content[content.len() / 2..];
                        let cut_at = keep.find('\n').map(|i| i + 1).unwrap_or(0);
                        let truncated = &keep[cut_at..];
                        let _ = fs::write(&self.log_path, truncated);
                    }
                }
            }
        }

        if let Some(parent) = self.log_path.parent() {
            let _ = fs::create_dir_all(parent);
        }

        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_path)
            .ok();
    }

    pub fn log(&mut self, level: &str, message: &str, meta: Option<&str>) {
        self.ensure_file();
        let timestamp = Utc::now().to_rfc3339();
        let meta_part = meta.unwrap_or("");
        let line = if meta_part.is_empty() {
            format!("{} {} {}", timestamp, level, message)
        } else {
            format!("{} {} {} {}", timestamp, level, message, meta_part)
        };

        if let Some(ref mut file) = self.file {
            let _ = writeln!(file, "{}", line);
        }
    }

    pub fn info(&mut self, message: &str, meta: Option<&str>) {
        self.log("INFO", message, meta);
    }

    pub fn error(&mut self, message: &str, meta: Option<&str>) {
        self.log("ERROR", message, meta);
    }

    pub fn log_path(&self) -> &PathBuf {
        &self.log_path
    }
}

// Global logger accessor
#[allow(dead_code)]
pub fn init_logger(data_dir: &PathBuf) -> Mutex<Logger> {
    let log_path = data_dir.join("voicepaste.log");
    Mutex::new(Logger::new(log_path))
}

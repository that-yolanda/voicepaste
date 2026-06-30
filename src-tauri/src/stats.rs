use chrono::Local;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_DAILY_COUNTS_DAYS: i64 = 182;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Stats {
    #[serde(rename = "firstUsedAt")]
    pub first_used_at: Option<String>,
    #[serde(rename = "totalSessions")]
    pub total_sessions: u64,
    #[serde(rename = "totalCharacters")]
    pub total_characters: u64,
    #[serde(rename = "dailyCounts")]
    pub daily_counts: HashMap<String, u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub ts: String,
    pub text: String,
    #[serde(default)]
    pub chars: usize,
    #[serde(default = "default_history_status")]
    pub status: String,
    #[serde(rename = "audioPath", default, skip_serializing_if = "Option::is_none")]
    pub audio_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(rename = "retryOf", default, skip_serializing_if = "Option::is_none")]
    pub retry_of: Option<String>,
}

pub struct StatsService {
    data_dir: PathBuf,
    history_dir: PathBuf,
    stats: Stats,
}

impl StatsService {
    pub fn new(data_dir: &Path) -> Self {
        let history_dir = data_dir.join("history");
        let _ = fs::create_dir_all(&history_dir);

        let stats_path = data_dir.join("stats.json");
        let stats = if stats_path.exists() {
            match fs::read_to_string(&stats_path) {
                Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
                Err(_) => Stats::default(),
            }
        } else {
            Stats::default()
        };

        Self {
            data_dir: data_dir.to_path_buf(),
            history_dir,
            stats,
        }
    }

    pub fn record_session_with_audio(
        &mut self,
        text: &str,
        audio_path: Option<String>,
        retry_of: Option<String>,
    ) {
        if text.is_empty() {
            return;
        }

        let now = Local::now();
        let char_count = text.len();

        if self.stats.first_used_at.is_none() {
            self.stats.first_used_at = Some(now.to_rfc3339());
        }
        self.stats.total_sessions += 1;
        self.stats.total_characters += char_count as u64;

        let key = now.format("%Y-%m-%d").to_string();
        *self.stats.daily_counts.entry(key.clone()).or_insert(0) += char_count as u64;

        // Flush stats
        self.flush_stats();

        // Append history entry
        let entry = HistoryEntry {
            ts: now.to_rfc3339(),
            text: text.to_string(),
            chars: char_count,
            status: "success".to_string(),
            audio_path,
            error: None,
            retry_of,
        };
        self.append_history(&entry);
    }

    pub fn replace_history_with_success(
        &mut self,
        ts: &str,
        text: &str,
        audio_path: Option<String>,
    ) -> bool {
        if text.is_empty() {
            return false;
        }

        let Ok(d) = chrono::DateTime::parse_from_rfc3339(ts) else {
            return false;
        };
        let local = d.with_timezone(&Local);
        let key = local.format("%Y-%m-%d").to_string();
        let file_path = self.history_dir.join(format!("{}.jsonl", key));
        let Ok(content) = fs::read_to_string(&file_path) else {
            return false;
        };

        let mut replaced = false;
        let char_count = text.len();
        let mut next_lines = Vec::new();
        for line in content.lines().filter(|line| !line.is_empty()) {
            match serde_json::from_str::<HistoryEntry>(line) {
                Ok(mut entry) if entry.ts == ts => {
                    entry.text = text.to_string();
                    entry.chars = char_count;
                    entry.status = "success".to_string();
                    entry.audio_path = audio_path.clone();
                    entry.error = None;
                    entry.retry_of = None;
                    if let Ok(json) = serde_json::to_string(&entry) {
                        next_lines.push(json);
                        replaced = true;
                    } else {
                        next_lines.push(line.to_string());
                    }
                }
                Ok(entry) => {
                    if let Ok(json) = serde_json::to_string(&entry) {
                        next_lines.push(json);
                    } else {
                        next_lines.push(line.to_string());
                    }
                }
                Err(_) => next_lines.push(line.to_string()),
            }
        }

        if !replaced {
            return false;
        }

        if fs::write(&file_path, format!("{}\n", next_lines.join("\n"))).is_err() {
            return false;
        }
        self.record_usage(text);
        true
    }

    pub fn record_failure(
        &mut self,
        message: &str,
        audio_path: Option<String>,
        retry_of: Option<String>,
    ) -> String {
        let now = Local::now();
        let ts = now.to_rfc3339();
        let entry = HistoryEntry {
            ts: ts.clone(),
            text: message.to_string(),
            chars: 0,
            status: "failed".to_string(),
            audio_path,
            error: Some(message.to_string()),
            retry_of,
        };
        self.append_history(&entry);
        ts
    }

    pub fn get_stats(&self) -> &Stats {
        &self.stats
    }

    pub fn get_history(&self, days_back: u32) -> Vec<HistoryEntry> {
        // History is sparse — only days with real usage have a file on disk. A
        // user who hasn't typed recently still has older entries, so we enumerate
        // the dates that actually have files and keep the most recent N, instead
        // of probing a contiguous window of calendar days (which would report
        // "no records" whenever the window falls inside a usage gap).
        let mut keys: Vec<String> = fs::read_dir(&self.history_dir)
            .map(|rd| {
                rd.flatten()
                    .filter_map(|entry| {
                        let stem = entry.path().file_stem()?.to_str()?.to_string();
                        is_date_key(&stem).then_some(stem)
                    })
                    .collect()
            })
            .unwrap_or_default();
        keys.sort_unstable_by(|a, b| b.cmp(a));

        let limit = days_back.min(365) as usize;
        let mut all_items = Vec::new();
        for key in keys.into_iter().take(limit) {
            let file_path = self.history_dir.join(format!("{}.jsonl", key));
            if let Ok(content) = fs::read_to_string(&file_path) {
                for line in content.lines() {
                    if let Ok(entry) = serde_json::from_str::<HistoryEntry>(line) {
                        all_items.push(entry);
                    }
                }
            }
        }

        all_items.sort_by(|a, b| b.ts.cmp(&a.ts));
        all_items
    }

    pub fn delete_history(&mut self, ts: &str) {
        self.delete_history_entry(ts, true);
    }

    pub fn delete_history_entry(&mut self, ts: &str, delete_audio: bool) {
        if let Ok(d) = chrono::DateTime::parse_from_rfc3339(ts) {
            let local = d.with_timezone(&Local);
            let key = local.format("%Y-%m-%d").to_string();
            let file_path = self.history_dir.join(format!("{}.jsonl", key));

            if file_path.exists() {
                if let Ok(content) = fs::read_to_string(&file_path) {
                    let lines: Vec<&str> = content.lines().filter(|l| !l.is_empty()).collect();
                    let mut removed_audio_paths = Vec::new();
                    let new_lines: Vec<String> = lines
                        .iter()
                        .filter(|line| match serde_json::from_str::<HistoryEntry>(line) {
                            Ok(e) if e.ts == ts => {
                                if let Some(path) = e.audio_path {
                                    removed_audio_paths.push(path);
                                }
                                false
                            }
                            Ok(_) => true,
                            Err(_) => true,
                        })
                        .map(|s| s.to_string())
                        .collect();

                    if new_lines.len() != lines.len() {
                        if new_lines.is_empty() {
                            let _ = fs::remove_file(&file_path);
                        } else {
                            let _ = fs::write(&file_path, format!("{}\n", new_lines.join("\n")));
                        }
                        if delete_audio {
                            for path in removed_audio_paths {
                                let _ = fs::remove_file(path);
                            }
                        }
                    }
                }
            }
        }
    }

    pub fn find_history(&self, ts: &str) -> Option<HistoryEntry> {
        self.get_history(365)
            .into_iter()
            .find(|entry| entry.ts == ts)
    }

    fn flush_stats(&mut self) {
        self.prune_daily_counts();
        let path = self.data_dir.join("stats.json");
        if let Ok(json) = serde_json::to_string_pretty(&self.stats) {
            let _ = fs::write(path, json);
        }
    }

    fn record_usage(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }

        let now = Local::now();
        if self.stats.first_used_at.is_none() {
            self.stats.first_used_at = Some(now.to_rfc3339());
        }
        self.stats.total_sessions += 1;
        self.stats.total_characters += text.len() as u64;
        let key = now.format("%Y-%m-%d").to_string();
        *self.stats.daily_counts.entry(key).or_insert(0) += text.len() as u64;
        self.flush_stats();
    }

    fn prune_daily_counts(&mut self) {
        let cutoff = Local::now() - chrono::Duration::days(MAX_DAILY_COUNTS_DAYS);
        let cutoff_key = cutoff.format("%Y-%m-%d").to_string();
        self.stats.daily_counts.retain(|k, _| k >= &cutoff_key);
    }

    fn append_history(&self, entry: &HistoryEntry) {
        let _ = fs::create_dir_all(&self.history_dir);

        if let Ok(d) = chrono::DateTime::parse_from_rfc3339(&entry.ts) {
            let local = d.with_timezone(&Local);
            let key = local.format("%Y-%m-%d").to_string();
            let file_path = self.history_dir.join(format!("{}.jsonl", key));

            if let Ok(json) = serde_json::to_string(entry) {
                use std::io::Write;
                if let Ok(mut file) = fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&file_path)
                {
                    let _ = writeln!(file, "{}", json);
                }
            }
        }
    }
}

/// Whether a string is a `YYYY-MM-DD` history file date key.
fn is_date_key(s: &str) -> bool {
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
}

fn default_history_status() -> String {
    "success".to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    // ── Stats defaults & serialization ───────────────────────────────────

    #[test]
    fn stats_default_values() {
        let s = Stats::default();
        assert_eq!(s.first_used_at, None);
        assert_eq!(s.total_sessions, 0);
        assert_eq!(s.total_characters, 0);
        assert!(s.daily_counts.is_empty());
    }

    #[test]
    fn stats_serialize_roundtrip() {
        let s = Stats {
            total_sessions: 5,
            total_characters: 100,
            ..Default::default()
        };
        let json = serde_json::to_string(&s).unwrap();
        let restored: Stats = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.total_sessions, 5);
        assert_eq!(restored.total_characters, 100);
    }

    #[test]
    fn history_entry_serialize() {
        let entry = HistoryEntry {
            ts: "2025-01-01T00:00:00+00:00".to_string(),
            text: "hello".to_string(),
            chars: 5,
            status: "success".to_string(),
            audio_path: None,
            error: None,
            retry_of: None,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("hello"));
        assert!(json.contains("2025-01-01"));
    }

    // ── StatsService with temp dir ───────────────────────────────────────

    fn new_stats_service() -> (StatsService, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let svc = StatsService::new(dir.path());
        (svc, dir)
    }

    #[test]
    fn record_session_increments_counters() {
        let (mut svc, _dir) = new_stats_service();
        svc.record_session_with_audio("hello world", None, None);
        let stats = svc.get_stats();
        assert_eq!(stats.total_sessions, 1);
        assert_eq!(stats.total_characters, 11); // "hello world".len()
        assert!(stats.first_used_at.is_some());
    }

    #[test]
    fn record_session_empty_text_ignored() {
        let (mut svc, _dir) = new_stats_service();
        svc.record_session_with_audio("", None, None);
        let stats = svc.get_stats();
        assert_eq!(stats.total_sessions, 0);
    }

    #[test]
    fn record_session_multiple_increments() {
        let (mut svc, _dir) = new_stats_service();
        svc.record_session_with_audio("first", None, None);
        svc.record_session_with_audio("second", None, None);
        let stats = svc.get_stats();
        assert_eq!(stats.total_sessions, 2);
        assert_eq!(stats.total_characters, 11);
    }

    #[test]
    fn daily_counts_populated() {
        let (mut svc, _dir) = new_stats_service();
        svc.record_session_with_audio("test", None, None);
        let stats = svc.get_stats();
        assert_eq!(stats.daily_counts.len(), 1);
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        assert!(stats.daily_counts.contains_key(&today));
    }

    #[test]
    fn prune_daily_counts_drops_old_entries() {
        let (mut svc, _dir) = new_stats_service();
        // An entry far outside the retention window, plus today's, both seeded
        // directly so we don't depend on record_session's "today" stamping.
        svc.stats.daily_counts.insert("2000-01-01".to_string(), 5);
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        svc.stats.daily_counts.insert(today.clone(), 3);
        svc.prune_daily_counts();
        let stats = svc.get_stats();
        assert!(!stats.daily_counts.contains_key("2000-01-01"));
        assert!(stats.daily_counts.contains_key(&today));
    }

    #[test]
    fn is_date_key_validates_yyyy_mm_dd() {
        assert!(is_date_key("2025-01-01"));
        assert!(is_date_key("1999-12-31"));
        assert!(!is_date_key("2025-13-01")); // invalid month
        assert!(!is_date_key("not-a-date"));
        assert!(!is_date_key(""));
    }

    #[test]
    fn get_history_empty() {
        let (svc, _dir) = new_stats_service();
        let history = svc.get_history(7);
        assert!(history.is_empty());
    }

    #[test]
    fn get_history_persists_and_retrieves() {
        let dir = tempdir().unwrap();
        let svc_path = dir.path().join("stats.json");

        // Write a pre-populated stats and history
        let stats = Stats {
            total_sessions: 1,
            total_characters: 10,
            first_used_at: Some("2025-01-01T00:00:00+00:00".to_string()),
            ..Default::default()
        };
        let _ = fs::write(&svc_path, serde_json::to_string(&stats).unwrap());

        // Write a history entry for today
        let history_dir = dir.path().join("history");
        let _ = fs::create_dir_all(&history_dir);
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let history_file = history_dir.join(format!("{}.jsonl", today));
        let entry =
            serde_json::json!({"ts": "2025-06-01T12:00:00+00:00", "text": "hello", "chars": 5});
        let _ = fs::write(&history_file, format!("{}\n", entry));

        let svc = StatsService::new(dir.path());
        let stats = svc.get_stats();
        assert_eq!(stats.total_sessions, 1);

        let history = svc.get_history(365);
        assert!(!history.is_empty());
    }

    #[test]
    fn get_history_skips_usage_gaps() {
        // A user who hasn't typed in the last few days still has older entries.
        // Asking for the most recent 3 days of *records* should surface the lone
        // older entry instead of reporting empty because the last 3 calendar
        // days have no files.
        let dir = tempdir().unwrap();
        let history_dir = dir.path().join("history");
        let _ = fs::create_dir_all(&history_dir);

        let past = chrono::Local::now() - chrono::Duration::days(10);
        let past_key = past.format("%Y-%m-%d").to_string();
        let entry = serde_json::json!({"ts": past.to_rfc3339(), "text": "old", "chars": 3});
        let file = history_dir.join(format!("{}.jsonl", past_key));
        let _ = fs::write(&file, format!("{}\n", entry));

        let svc_path = dir.path().join("stats.json");
        let _ = fs::write(&svc_path, serde_json::to_string(&Stats::default()).unwrap());

        let svc = StatsService::new(dir.path());
        let history = svc.get_history(3);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].text, "old");
    }

    #[test]
    fn replace_history_with_success_updates_entry_in_place() {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let (mut svc, _dir) = new_stats_service();
        let failure_ts = svc.record_failure("timeout", Some("/tmp/retry.wav".to_string()), None);

        assert_eq!(failure_ts[0..10], today);
        assert!(svc.replace_history_with_success(&failure_ts, "重试成功", None));

        let history = svc.get_history(365);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].ts, failure_ts);
        assert_eq!(history[0].text, "重试成功");
        assert_eq!(history[0].status, "success");
        assert_eq!(history[0].chars, "重试成功".len());
        assert!(history[0].audio_path.is_none());
        assert!(history[0].error.is_none());
        assert_eq!(svc.get_stats().total_sessions, 1);
    }

    #[test]
    fn delete_history_removes_entry() {
        let dir = tempdir().unwrap();
        let history_dir = dir.path().join("history");
        let _ = fs::create_dir_all(&history_dir);

        // Use a timestamp that maps to today's date in local timezone
        // so the history file and the entry's date key match.
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let ts = format!("{}T12:00:00+00:00", today);
        let history_file = history_dir.join(format!("{}.jsonl", today));

        let _ = fs::write(
            &history_file,
            format!(
                "{}\n",
                serde_json::json!({"ts": ts, "text": "hello", "chars": 5})
            ),
        );

        let svc_path = dir.path().join("stats.json");
        let _ = fs::write(&svc_path, serde_json::to_string(&Stats::default()).unwrap());

        let mut svc = StatsService::new(dir.path());
        svc.delete_history(&ts);

        let history = svc.get_history(365);
        let has_entry = history.iter().any(|e| e.ts == ts);
        assert!(!has_entry, "Entry should have been deleted");
    }
}

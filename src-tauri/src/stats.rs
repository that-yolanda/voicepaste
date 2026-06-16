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

    pub fn record_session(&mut self, text: &str) {
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
        };
        self.append_history(&entry);
    }

    pub fn get_stats(&self) -> &Stats {
        &self.stats
    }

    pub fn get_history(&self, days_back: u32) -> Vec<HistoryEntry> {
        let days = days_back.min(365);
        let mut all_items = Vec::new();

        for i in 0..days {
            let d = Local::now() - chrono::Duration::days(i as i64);
            let key = d.format("%Y-%m-%d").to_string();
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
        if let Ok(d) = chrono::DateTime::parse_from_rfc3339(ts) {
            let local = d.with_timezone(&Local);
            let key = local.format("%Y-%m-%d").to_string();
            let file_path = self.history_dir.join(format!("{}.jsonl", key));

            if file_path.exists() {
                if let Ok(content) = fs::read_to_string(&file_path) {
                    let lines: Vec<&str> = content.lines().filter(|l| !l.is_empty()).collect();
                    let new_lines: Vec<String> = lines
                        .iter()
                        .filter(|line| {
                            serde_json::from_str::<HistoryEntry>(line)
                                .map(|e| e.ts != ts)
                                .unwrap_or(true)
                        })
                        .map(|s| s.to_string())
                        .collect();

                    if new_lines.len() != lines.len() {
                        if new_lines.is_empty() {
                            let _ = fs::remove_file(&file_path);
                        } else {
                            let _ = fs::write(&file_path, format!("{}\n", new_lines.join("\n")));
                        }
                    }
                }
            }
        }
    }

    fn flush_stats(&mut self) {
        self.prune_daily_counts();
        let path = self.data_dir.join("stats.json");
        if let Ok(json) = serde_json::to_string_pretty(&self.stats) {
            let _ = fs::write(path, json);
        }
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
        svc.record_session("hello world");
        let stats = svc.get_stats();
        assert_eq!(stats.total_sessions, 1);
        assert_eq!(stats.total_characters, 11); // "hello world".len()
        assert!(stats.first_used_at.is_some());
    }

    #[test]
    fn record_session_empty_text_ignored() {
        let (mut svc, _dir) = new_stats_service();
        svc.record_session("");
        let stats = svc.get_stats();
        assert_eq!(stats.total_sessions, 0);
    }

    #[test]
    fn record_session_multiple_increments() {
        let (mut svc, _dir) = new_stats_service();
        svc.record_session("first");
        svc.record_session("second");
        let stats = svc.get_stats();
        assert_eq!(stats.total_sessions, 2);
        assert_eq!(stats.total_characters, 11);
    }

    #[test]
    fn daily_counts_populated() {
        let (mut svc, _dir) = new_stats_service();
        svc.record_session("test");
        let stats = svc.get_stats();
        assert_eq!(stats.daily_counts.len(), 1);
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        assert!(stats.daily_counts.contains_key(&today));
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

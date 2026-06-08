use chrono::Local;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_DAILY_COUNTS_DAYS: i64 = 182;

#[derive(Debug, Clone, Serialize, Deserialize)]
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

impl Default for Stats {
    fn default() -> Self {
        Stats {
            first_used_at: None,
            total_sessions: 0,
            total_characters: 0,
            daily_counts: HashMap::new(),
        }
    }
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

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
    /// Prompt template this session was polished with, when a prompt hotkey drove
    /// it. Its presence is what makes an entry re-polishable from the history list.
    #[serde(rename = "promptId", default, skip_serializing_if = "Option::is_none")]
    pub prompt_id: Option<String>,
    /// Transcript as recognized, before polishing. Kept only when it differs from
    /// the delivered text, so a re-polish starts from the raw transcript instead
    /// of re-polishing already-polished prose.
    #[serde(rename = "rawText", default, skip_serializing_if = "Option::is_none")]
    pub raw_text: Option<String>,
    /// Structured error code (plus interpolation params) when the failure came
    /// from a migrated domain; the frontend renders the localized headline from
    /// it. `detail` is deliberately NOT persisted — it can echo transcripts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<crate::errors::AppErrorCode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<std::collections::BTreeMap<String, String>>,
}

/// Polish provenance for a finished session: enough to re-run the polish later
/// from the history list. Default (both `None`) means the session was never
/// polished, e.g. the main hotkey.
#[derive(Debug, Clone, Default)]
pub struct PolishRecord {
    pub prompt_id: Option<String>,
    pub raw_text: Option<String>,
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
        polish: PolishRecord,
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
            prompt_id: polish.prompt_id,
            raw_text: polish.raw_text,
            code: None,
            params: None,
        };
        self.append_history(&entry);
    }

    /// Apply `mutate` to the history entry with this timestamp and rewrite its
    /// day file in place. Lines that fail to parse are passed through untouched,
    /// so one corrupt record never costs the user the rest of that day's history.
    /// Returns `true` when a matching entry was found and the file was rewritten.
    fn mutate_history_entry<F>(&self, ts: &str, mut mutate: F) -> bool
    where
        F: FnMut(&mut HistoryEntry),
    {
        let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(ts) else {
            return false;
        };
        let key = parsed.with_timezone(&Local).format("%Y-%m-%d").to_string();
        let file_path = self.history_dir.join(format!("{}.jsonl", key));
        let Ok(content) = fs::read_to_string(&file_path) else {
            return false;
        };

        let mut replaced = false;
        let mut next_lines = Vec::new();
        for line in content.lines().filter(|line| !line.is_empty()) {
            let Ok(mut entry) = serde_json::from_str::<HistoryEntry>(line) else {
                next_lines.push(line.to_string());
                continue;
            };
            let is_target = entry.ts == ts;
            if is_target {
                mutate(&mut entry);
            }
            match serde_json::to_string(&entry) {
                Ok(json) => {
                    next_lines.push(json);
                    replaced |= is_target;
                }
                Err(_) => next_lines.push(line.to_string()),
            }
        }

        if !replaced {
            return false;
        }
        fs::write(&file_path, format!("{}\n", next_lines.join("\n"))).is_ok()
    }

    /// Turn a recorded failure into a success after a retry produced text.
    pub fn replace_history_with_success(
        &mut self,
        ts: &str,
        text: &str,
        audio_path: Option<String>,
        polish: PolishRecord,
    ) -> bool {
        if text.is_empty() {
            return false;
        }
        let char_count = text.len();
        let replaced = self.mutate_history_entry(ts, |entry| {
            entry.text = text.to_string();
            entry.chars = char_count;
            entry.status = "success".to_string();
            entry.audio_path = audio_path.clone();
            entry.error = None;
            entry.retry_of = None;
            entry.prompt_id = polish.prompt_id.clone();
            entry.raw_text = polish.raw_text.clone();
        });
        if replaced {
            self.record_usage(text);
        }
        replaced
    }

    /// Rewrite an existing successful entry's text in place, preserving its
    /// timestamp, status, and saved audio. Used when the user regenerates a kept
    /// recording whose original transcription lost content. Aggregate usage
    /// counters are left untouched — this replaces text rather than adding a new
    /// session. Returns `true` when a matching entry was found and rewritten.
    ///
    /// The new text is a fresh unpolished transcript, so any stored `raw_text` is
    /// dropped: a later re-polish must start from this text, not the old one.
    pub fn update_history_text(&mut self, ts: &str, text: &str) -> bool {
        if text.is_empty() {
            return false;
        }
        let char_count = text.len();
        self.mutate_history_entry(ts, |entry| {
            entry.text = text.to_string();
            entry.chars = char_count;
            entry.raw_text = None;
        })
    }

    /// Rewrite an entry after a successful re-polish, remembering the transcript
    /// and template it was polished from so the entry stays re-polishable. Usage
    /// counters are left untouched: this replaces text rather than adding a session.
    pub fn update_history_polished_text(
        &mut self,
        ts: &str,
        text: &str,
        raw_text: &str,
        prompt_id: &str,
    ) -> bool {
        if text.is_empty() {
            return false;
        }
        let char_count = text.len();
        self.mutate_history_entry(ts, |entry| {
            entry.text = text.to_string();
            entry.chars = char_count;
            entry.raw_text = Some(raw_text.to_string());
            entry.prompt_id = Some(prompt_id.to_string());
        })
    }

    pub fn record_failure(
        &mut self,
        message: &str,
        audio_path: Option<String>,
        retry_of: Option<String>,
        error: Option<&crate::errors::AppError>,
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
            prompt_id: None,
            raw_text: None,
            code: error.map(|e| e.code),
            params: error
                .filter(|e| !e.params.is_empty())
                .map(|e| e.params.clone()),
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
            prompt_id: None,
            raw_text: None,
            code: None,
            params: None,
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
        svc.record_session_with_audio("hello world", None, None, PolishRecord::default());
        let stats = svc.get_stats();
        assert_eq!(stats.total_sessions, 1);
        assert_eq!(stats.total_characters, 11); // "hello world".len()
        assert!(stats.first_used_at.is_some());
    }

    #[test]
    fn record_session_empty_text_ignored() {
        let (mut svc, _dir) = new_stats_service();
        svc.record_session_with_audio("", None, None, PolishRecord::default());
        let stats = svc.get_stats();
        assert_eq!(stats.total_sessions, 0);
    }

    #[test]
    fn record_session_multiple_increments() {
        let (mut svc, _dir) = new_stats_service();
        svc.record_session_with_audio("first", None, None, PolishRecord::default());
        svc.record_session_with_audio("second", None, None, PolishRecord::default());
        let stats = svc.get_stats();
        assert_eq!(stats.total_sessions, 2);
        assert_eq!(stats.total_characters, 11);
    }

    #[test]
    fn daily_counts_populated() {
        let (mut svc, _dir) = new_stats_service();
        svc.record_session_with_audio("test", None, None, PolishRecord::default());
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
        let failure_ts =
            svc.record_failure("timeout", Some("/tmp/retry.wav".to_string()), None, None);

        assert_eq!(failure_ts[0..10], today);
        assert!(svc.replace_history_with_success(
            &failure_ts,
            "重试成功",
            None,
            PolishRecord::default()
        ));

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
    fn polish_provenance_round_trips_through_history() {
        let (mut svc, _dir) = new_stats_service();
        svc.record_session_with_audio(
            "润色后的文本",
            None,
            None,
            PolishRecord {
                prompt_id: Some("polish".to_string()),
                raw_text: Some("原始 转写 文本".to_string()),
            },
        );

        let entry = svc.get_history(365).remove(0);
        assert_eq!(entry.prompt_id.as_deref(), Some("polish"));
        assert_eq!(entry.raw_text.as_deref(), Some("原始 转写 文本"));
    }

    #[test]
    fn unpolished_session_stores_no_provenance() {
        let (mut svc, _dir) = new_stats_service();
        svc.record_session_with_audio("主快捷键直接粘贴", None, None, PolishRecord::default());

        let entry = svc.get_history(365).remove(0);
        assert!(entry.prompt_id.is_none());
        assert!(entry.raw_text.is_none());
    }

    #[test]
    fn history_entries_written_before_polish_provenance_still_load() {
        // Entries on disk from earlier versions have neither field; serde
        // defaults must keep them readable instead of dropping the day's file.
        let legacy =
            r#"{"ts":"2026-01-01T10:00:00+08:00","text":"旧记录","chars":9,"status":"success"}"#;
        let entry: HistoryEntry = serde_json::from_str(legacy).expect("legacy entry parses");
        assert_eq!(entry.text, "旧记录");
        assert!(entry.prompt_id.is_none());
        assert!(entry.raw_text.is_none());
    }

    #[test]
    fn update_history_polished_text_keeps_the_source_transcript() {
        let (mut svc, _dir) = new_stats_service();
        svc.record_session_with_audio(
            "原始转写",
            None,
            None,
            PolishRecord {
                prompt_id: Some("polish".to_string()),
                raw_text: None,
            },
        );
        let ts = svc.get_history(365)[0].ts.clone();
        let sessions_before = svc.get_stats().total_sessions;

        assert!(svc.update_history_polished_text(&ts, "润色后的文本", "原始转写", "polish"));

        let entry = svc.get_history(365).remove(0);
        assert_eq!(entry.text, "润色后的文本");
        assert_eq!(entry.chars, "润色后的文本".len());
        assert_eq!(entry.raw_text.as_deref(), Some("原始转写"));
        // Still re-polishable, and no extra session was counted.
        assert_eq!(entry.prompt_id.as_deref(), Some("polish"));
        assert_eq!(svc.get_stats().total_sessions, sessions_before);
    }

    #[test]
    fn update_history_polished_text_records_the_chosen_template() {
        // A main-hotkey entry was never polished; polishing it from the history
        // list must remember the template so the next re-polish reuses it.
        let (mut svc, _dir) = new_stats_service();
        svc.record_session_with_audio("原始转写", None, None, PolishRecord::default());
        let ts = svc.get_history(365)[0].ts.clone();

        assert!(svc.update_history_polished_text(&ts, "润色后", "原始转写", "email"));

        let entry = svc.get_history(365).remove(0);
        assert_eq!(entry.prompt_id.as_deref(), Some("email"));
        assert_eq!(entry.raw_text.as_deref(), Some("原始转写"));
    }

    #[test]
    fn update_history_text_drops_stale_raw_text() {
        let (mut svc, _dir) = new_stats_service();
        svc.record_session_with_audio(
            "润色后",
            None,
            None,
            PolishRecord {
                prompt_id: Some("polish".to_string()),
                raw_text: Some("旧转写".to_string()),
            },
        );
        let ts = svc.get_history(365)[0].ts.clone();

        assert!(svc.update_history_text(&ts, "新转写"));

        let entry = svc.get_history(365).remove(0);
        assert_eq!(entry.text, "新转写");
        assert!(entry.raw_text.is_none());
        assert_eq!(entry.prompt_id.as_deref(), Some("polish"));
    }

    #[test]
    fn update_history_text_rewrites_entry_in_place() {
        let (mut svc, _dir) = new_stats_service();
        svc.record_session_with_audio(
            "old text",
            Some("/tmp/kept.wav".to_string()),
            None,
            PolishRecord::default(),
        );
        let ts = svc.get_history(365)[0].ts.clone();
        let sessions_before = svc.get_stats().total_sessions;

        assert!(svc.update_history_text(&ts, "regenerated text"));

        let history = svc.get_history(365);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].ts, ts);
        assert_eq!(history[0].text, "regenerated text");
        assert_eq!(history[0].chars, "regenerated text".len());
        assert_eq!(history[0].status, "success");
        // Audio is preserved so the entry can be regenerated again.
        assert_eq!(history[0].audio_path.as_deref(), Some("/tmp/kept.wav"));
        // Regeneration replaces text; it must not count as a new session.
        assert_eq!(svc.get_stats().total_sessions, sessions_before);
    }

    #[test]
    fn update_history_text_missing_entry_returns_false() {
        let (mut svc, _dir) = new_stats_service();
        svc.record_session_with_audio("only entry", None, None, PolishRecord::default());
        let ts = svc.get_history(365)[0].ts.clone();
        // A timestamp on the same day but not matching any entry.
        let other_ts = format!("{}9", &ts[..ts.len() - 1]);
        assert!(!svc.update_history_text(&other_ts, "nope"));
        assert!(!svc.update_history_text(&ts, ""));
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

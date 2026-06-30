use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

/// Hotword library data stored in `hotwords.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotwordData {
    #[serde(default = "default_active_group")]
    pub active_group: String,
    #[serde(default)]
    pub groups: Vec<HotwordGroup>,
}

/// A named group of hotwords.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotwordGroup {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub words: Vec<String>,
}

fn default_active_group() -> String {
    "default".to_string()
}

impl Default for HotwordData {
    fn default() -> Self {
        Self {
            active_group: default_active_group(),
            groups: vec![HotwordGroup {
                id: "default".to_string(),
                name: "默认热词表".to_string(),
                words: Vec::new(),
            }],
        }
    }
}

/// Manages the hotword library file (`hotwords.json`).
/// Pattern mirrors `ConfigManager` — in-memory cache, read-through on load.
pub struct HotwordManager {
    path: PathBuf,
    cached: RwLock<HotwordData>,
}

impl HotwordManager {
    pub fn new(data_dir: &Path, resource_dir: &Path) -> Self {
        let path = data_dir.join("hotwords.json");
        let example_path = resource_dir.join("hotwords.json");

        // Ensure file exists
        if !path.exists() {
            if example_path.exists() {
                let _ = fs::copy(&example_path, &path);
            } else {
                let default = HotwordData::default();
                if let Ok(json) = serde_json::to_string_pretty(&default) {
                    let _ = fs::write(&path, json);
                }
            }
        }

        let mut data = Self::read_from_disk(&path);
        if let Some(defaults) = Self::read_example(&example_path) {
            let changed = Self::merge_defaults(&mut data, defaults);
            if changed {
                if let Ok(json) = serde_json::to_string_pretty(&data) {
                    let _ = fs::write(&path, json);
                }
            }
        }
        Self {
            path,
            cached: RwLock::new(data),
        }
    }

    fn read_from_disk(path: &Path) -> HotwordData {
        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => return HotwordData::default(),
        };
        serde_json::from_str(&content).unwrap_or_default()
    }

    fn read_example(path: &Path) -> Option<HotwordData> {
        let content = fs::read_to_string(path).ok()?;
        serde_json::from_str(&content).ok()
    }

    fn merge_defaults(data: &mut HotwordData, defaults: HotwordData) -> bool {
        let mut changed = false;

        for default_group in defaults.groups {
            if let Some(group) = data.groups.iter_mut().find(|g| g.id == default_group.id) {
                for word in default_group.words {
                    if !group.words.contains(&word) {
                        group.words.push(word);
                        changed = true;
                    }
                }
            } else {
                data.groups.push(default_group);
                changed = true;
            }
        }

        if data.groups.iter().all(|g| g.id != data.active_group) {
            data.active_group = default_active_group();
            changed = true;
        }

        changed
    }

    /// Load hotword data from memory cache (no disk I/O).
    pub fn load(&self) -> HotwordData {
        self.cached.read().unwrap().clone()
    }

    /// Save hotword data, update memory cache and disk.
    pub fn save(&self, data: &HotwordData) -> Result<(), String> {
        let json = serde_json::to_string_pretty(data)
            .map_err(|e| format!("Failed to serialize hotwords: {}", e))?;
        fs::write(&self.path, json).map_err(|e| format!("Failed to write hotwords: {}", e))?;
        *self.cached.write().unwrap() = data.clone();
        Ok(())
    }

    /// Get the words from the currently active group.
    pub fn active_words(&self) -> Vec<String> {
        let data = self.cached.read().unwrap();
        data.groups
            .iter()
            .find(|g| g.id == data.active_group)
            .map(|g| g.words.clone())
            .unwrap_or_default()
    }

    /// Import hotwords from legacy config (comma-separated string).
    /// Words are merged into the default group without duplicates.
    pub fn import_from_legacy(&self, hotwords_str: &str) -> Result<(), String> {
        let words: Vec<String> = hotwords_str
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        if words.is_empty() {
            return Ok(());
        }

        let mut data = self.load();
        if let Some(default_group) = data.groups.iter_mut().find(|g| g.id == "default") {
            for word in &words {
                if !default_group.words.contains(word) {
                    default_group.words.push(word.clone());
                }
            }
        }
        self.save(&data)
    }
}

/// Extract the pure word from a "word|weight" entry (strip weight suffix).
/// Returns the whole entry if no `|` is found.
pub fn strip_weight(entry: &str) -> &str {
    entry.split('|').next().unwrap_or(entry).trim()
}

/// Build the proper-noun hint suffix to append to an LLM system prompt, from
/// the active hotwords (weights stripped). Returns `None` when empty so callers
/// can skip the append entirely.
pub fn build_llm_hint_suffix(hotwords: &[String]) -> Option<String> {
    let hw: Vec<String> = hotwords
        .iter()
        .map(|w| strip_weight(w).to_string())
        .collect();
    if hw.is_empty() {
        None
    } else {
        Some(format!(
            "\n\n需要注意以下专有名词的准确拼写：{}",
            hw.join("、")
        ))
    }
}

/// Parse a hotword entry in "word" or "word|weight" format.
/// Weight defaults to 4.0 and is clamped to [1.0, 10.0].
pub fn parse_hotword_entry(entry: &str) -> (String, f32) {
    let trimmed = entry.trim();
    if let Some(pos) = trimmed.rfind('|') {
        let word = trimmed[..pos].trim().to_string();
        let w: f32 = trimmed[pos + 1..].trim().parse().unwrap_or(4.0);
        (word, w.clamp(1.0, 10.0))
    } else {
        (trimmed.to_string(), 4.0)
    }
}

/// Restore proper-noun casing that ASR engines (notably sherpa-onnx online
/// transducers) lowercase when recognizing via their hotword list. Walks the
/// text and replaces any case/space/punctuation variant of each hotword with
/// its original spelling.
///
/// Engine-agnostic: engines that already preserve casing (e.g. Doubao) simply
/// have no variants to replace, so this is safe to call for every engine —
/// `config.hotword_replace` gates whether to call it at all. Lives in the
/// hotword domain (alongside `build_llm_hint_suffix`) since it is pure
/// hotword-driven text processing with no ASR dependency.
///
/// Uses two matching strategies:
///   1. Space-aware: for multi-word hotwords like "Claude Code" → the engine
///      preserves spaces, so we normalize with spaces.
///   2. Alphanumeric-only: for hotwords with punctuation like "AGENTS.md" →
///      the engine strips punctuation, so we match purely on alphanumerics.
pub(crate) fn restore_hotword_case(text: &str, hotwords: &[String]) -> String {
    // Strategy A: normalize keeping single spaces (collapsed).
    fn normalize_spaces(s: &str) -> (String, Vec<usize>) {
        let mut norm = String::new();
        let mut positions = Vec::new();
        let mut last_was_space = true; // skip leading spaces
        for (i, c) in s.char_indices() {
            if c.is_alphanumeric() {
                norm.push_str(&c.to_uppercase().to_string());
                positions.push(i);
                last_was_space = false;
            } else if !last_was_space {
                norm.push(' ');
                positions.push(i);
                last_was_space = true;
            }
        }
        if norm.ends_with(' ') {
            norm.pop();
            positions.pop();
        }
        (norm, positions)
    }

    // Strategy B: normalize to alphanumeric only (no spaces, no punctuation).
    fn normalize_alpha(s: &str) -> (String, Vec<usize>) {
        let mut norm = String::new();
        let mut positions = Vec::new();
        for (i, c) in s.char_indices() {
            if c.is_alphanumeric() {
                norm.push_str(&c.to_uppercase().to_string());
                positions.push(i);
            }
        }
        (norm, positions)
    }

    let mut result = text.to_string();

    // Build (needle, original_word, use_spaces) tuples, longest first.
    let mut replacements: Vec<(String, String, bool)> = hotwords
        .iter()
        .filter_map(|hw| {
            let (original_word, _weight) = parse_hotword_entry(hw);

            // Determine which strategy to use based on whether the hotword
            // contains spaces (space-aware) or only punctuation (alpha-only).
            let has_space = original_word.contains(' ');
            let (needle, _) = if has_space {
                normalize_spaces(&original_word)
            } else {
                normalize_alpha(&original_word)
            };

            if needle.is_empty() {
                return None;
            }
            // Skip no-ops: already uppercase and matches its normalized form.
            if !has_space
                && original_word == original_word.to_uppercase()
                && original_word.chars().all(|c| c.is_alphanumeric())
            {
                return None;
            }
            Some((needle, original_word, has_space))
        })
        .collect();

    if replacements.is_empty() {
        return result;
    }

    replacements.sort_by_key(|b| std::cmp::Reverse(b.0.len()));

    for (needle, original, use_spaces) in &replacements {
        let needle_chars: Vec<char> = needle.chars().collect();
        let mut search_start = 0;

        loop {
            let (haystack_str, pos_map) = if *use_spaces {
                normalize_spaces(&result)
            } else {
                normalize_alpha(&result)
            };
            let haystack_chars: Vec<char> = haystack_str.chars().collect();
            if search_start >= haystack_chars.len() {
                break;
            }
            // Character-level search to avoid byte-offset issues with CJK.
            let pos = haystack_chars[search_start..]
                .windows(needle_chars.len())
                .position(|w| w == needle_chars.as_slice());
            let Some(pos) = pos else {
                break;
            };
            let norm_start = search_start + pos;
            let norm_end = norm_start + needle_chars.len();
            if norm_end > pos_map.len() {
                break;
            }

            let mut byte_start = pos_map[norm_start];
            let mut byte_end = if norm_end < pos_map.len() {
                pos_map[norm_end]
            } else {
                result.len()
            };
            // Trim surrounding spaces from the matched range.
            let result_bytes = result.as_bytes();
            while byte_start < byte_end && result_bytes[byte_start] == b' ' {
                byte_start += 1;
            }
            while byte_end > byte_start && result_bytes[byte_end - 1] == b' ' {
                byte_end -= 1;
            }

            // Skip if already the original text (prevents infinite loop).
            if &result[byte_start..byte_end] == original.as_str() {
                search_start = norm_start + 1;
                continue;
            }

            result.replace_range(byte_start..byte_end, original);
            search_start = 0;
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::{HotwordData, HotwordGroup, HotwordManager};

    // ── restore_hotword_case tests ───────────────────────────────────────

    #[test]
    fn restore_case_mixed() {
        let r = super::restore_hotword_case("CLAUDE CODE", &["Claude Code".to_string()]);
        assert_eq!(r, "Claude Code");
    }

    #[test]
    fn restore_case_lowercase_model_output() {
        let r = super::restore_hotword_case("claude code", &["Claude Code".to_string()]);
        assert_eq!(r, "Claude Code");
    }

    #[test]
    fn restore_punctuation_stripped() {
        let r = super::restore_hotword_case("AGENTSMD", &["AGENTS.md".to_string()]);
        assert_eq!(r, "AGENTS.md");
    }

    #[test]
    fn restore_punctuation_with_space() {
        let r = super::restore_hotword_case("AGENTS MD", &["AGENTS.md".to_string()]);
        assert_eq!(r, "AGENTS.md");
    }

    #[test]
    fn no_change_for_chinese() {
        let r = super::restore_hotword_case("流式输出", &["流式输出".to_string()]);
        assert_eq!(r, "流式输出");
    }

    #[test]
    fn restore_with_weight_format() {
        let r = super::restore_hotword_case("CLAUDE CODE", &["Claude Code|10".to_string()]);
        assert_eq!(r, "Claude Code");
    }

    #[test]
    fn restore_single_hotword() {
        let r =
            super::restore_hotword_case("使用 CLAUDE CODE 和 OPENAI", &["Claude Code".to_string()]);
        assert_eq!(r, "使用 Claude Code 和 OPENAI");
    }

    #[test]
    fn restore_multiple_in_sentence() {
        let r = super::restore_hotword_case(
            "使用 CLAUDE CODE 和 OPENAI",
            &["Claude Code".to_string(), "OpenAI".to_string()],
        );
        assert_eq!(r, "使用 Claude Code 和 OpenAI");
    }

    #[test]
    fn merge_defaults_adds_missing_words_without_duplicates() {
        let mut data = HotwordData::default();
        let defaults = HotwordData {
            active_group: "default".to_string(),
            groups: vec![HotwordGroup {
                id: "default".to_string(),
                name: "默认热词表".to_string(),
                words: vec!["Claude".to_string(), "OpenAI".to_string()],
            }],
        };

        assert!(HotwordManager::merge_defaults(&mut data, defaults.clone()));
        assert_eq!(data.groups[0].words, vec!["Claude", "OpenAI"]);
        assert!(!HotwordManager::merge_defaults(&mut data, defaults));
    }

    #[test]
    fn parse_hotword_with_weight() {
        let (w, s) = super::parse_hotword_entry("Claude Code|10");
        assert_eq!(w, "Claude Code");
        assert!((s - 10.0).abs() < f32::EPSILON);

        let (w, s) = super::parse_hotword_entry("流式输出|8");
        assert_eq!(w, "流式输出");
        assert!((s - 8.0).abs() < f32::EPSILON);
    }

    #[test]
    fn parse_hotword_without_weight() {
        let (w, s) = super::parse_hotword_entry("Claude Code");
        assert_eq!(w, "Claude Code");
        assert!((s - 4.0).abs() < f32::EPSILON);
    }

    #[test]
    fn parse_hotword_clamps_weight() {
        let (_, s) = super::parse_hotword_entry("word|15");
        assert!((s - 10.0).abs() < f32::EPSILON);

        let (_, s) = super::parse_hotword_entry("word|0");
        assert!((s - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn strip_weight_removes_suffix() {
        assert_eq!(super::strip_weight("Claude Code|10"), "Claude Code");
        assert_eq!(super::strip_weight("skill"), "skill");
        assert_eq!(super::strip_weight("word|"), "word");
    }
}

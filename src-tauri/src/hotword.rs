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

    /// Get the id of the currently active group.
    pub fn active_group_id(&self) -> String {
        self.cached.read().unwrap().active_group.clone()
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

#[cfg(test)]
mod tests {
    use super::{HotwordData, HotwordGroup, HotwordManager};

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

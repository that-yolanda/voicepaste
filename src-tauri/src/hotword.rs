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

#[allow(dead_code)]
impl HotwordManager {
    pub fn new(data_dir: &Path, resource_dir: &Path) -> Self {
        let path = data_dir.join("hotwords.json");

        // Ensure file exists
        if !path.exists() {
            let example_path = resource_dir.join("hotwords.json.example");
            if example_path.exists() {
                let _ = fs::copy(&example_path, &path);
            } else {
                let default = HotwordData::default();
                if let Ok(json) = serde_json::to_string_pretty(&default) {
                    let _ = fs::write(&path, json);
                }
            }
        }

        let data = Self::read_from_disk(&path);
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

    /// Load hotword data from memory cache (no disk I/O).
    pub fn load(&self) -> HotwordData {
        self.cached.read().unwrap().clone()
    }

    /// Save hotword data, update memory cache and disk.
    pub fn save(&self, data: &HotwordData) -> Result<(), String> {
        let json = serde_json::to_string_pretty(data)
            .map_err(|e| format!("Failed to serialize hotwords: {}", e))?;
        fs::write(&self.path, json)
            .map_err(|e| format!("Failed to write hotwords: {}", e))?;
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

    pub fn path(&self) -> &PathBuf {
        &self.path
    }
}

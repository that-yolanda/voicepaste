use sherpa_onnx::{OfflinePunctuation, OfflinePunctuationConfig, OfflinePunctuationModelConfig};
use std::fmt;
use std::path::Path;

use crate::model::ModelEntry;

/// Wrapper around sherpa-onnx OfflinePunctuation for punctuation restoration.
///
/// Uses the CT-Transformer model (Chinese + English bilingual) to add punctuation
/// to ASR output text after recognition completes.
pub struct PunctuationProcessor {
    inner: OfflinePunctuation,
}

impl fmt::Debug for PunctuationProcessor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PunctuationProcessor").finish()
    }
}

impl PunctuationProcessor {
    /// Create a new punctuation processor from a registry entry.
    ///
    /// `entry.model_files["model"]` names the CT-Transformer ONNX file inside `model_dir`.
    pub fn new(
        entry: &ModelEntry,
        model_dir: &Path,
        num_threads: u32,
        provider: &str,
    ) -> Result<Self, String> {
        let model_path = entry
            .model_files
            .get("model")
            .map(|filename| model_dir.join(filename))
            .ok_or_else(|| format!("标点模型 {} 缺少 model 文件定义", entry.id))?;
        if !model_path.exists() {
            return Err(format!("标点模型文件不存在: {}", model_path.display()));
        }

        let config = OfflinePunctuationConfig {
            model: OfflinePunctuationModelConfig {
                ct_transformer: Some(model_path.to_string_lossy().to_string()),
                num_threads: num_threads as i32,
                provider: Some(provider.to_string()),
                debug: cfg!(debug_assertions),
            },
        };

        let inner = OfflinePunctuation::create(&config)
            .ok_or_else(|| "创建标点恢复模型失败".to_string())?;

        Ok(Self { inner })
    }

    /// Add punctuation to the given text.
    /// Returns the punctuated text, or the original text if punctuation fails.
    pub fn add_punctuation(&self, text: &str) -> String {
        self.inner
            .add_punctuation(text)
            .unwrap_or_else(|| text.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal punctuation ModelEntry with the given `model_files` map.
    fn entry_with_model_files(files: serde_json::Value) -> ModelEntry {
        serde_json::from_value(serde_json::json!({
            "id": "punct-test",
            "type": "offline",
            "category": "punctuation",
            "engine": "sherpa-onnx",
            "name": "T",
            "description": "T",
            "model_files": files,
        }))
        .expect("entry should parse")
    }

    #[test]
    fn test_new_missing_model_file() {
        let entry = entry_with_model_files(serde_json::json!({"model": "model.int8.onnx"}));
        let result = PunctuationProcessor::new(&entry, Path::new("/nonexistent/path"), 1, "cpu");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("标点模型文件不存在"));
    }

    #[test]
    fn test_new_missing_model_files_definition() {
        // No "model" key in model_files → should report a missing-definition error.
        let entry = entry_with_model_files(serde_json::json!({}));
        let result = PunctuationProcessor::new(&entry, Path::new("/nonexistent/path"), 1, "cpu");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("缺少 model 文件定义"));
    }
}

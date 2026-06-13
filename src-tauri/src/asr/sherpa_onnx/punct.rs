use sherpa_onnx::{OfflinePunctuation, OfflinePunctuationConfig, OfflinePunctuationModelConfig};
use std::fmt;
use std::path::Path;

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
    /// Create a new punctuation processor.
    ///
    /// `model_dir` should contain `model.int8.onnx` (the CT-Transformer model).
    pub fn new(model_dir: &Path, num_threads: u32) -> Result<Self, String> {
        let model_path = model_dir.join("model.int8.onnx");
        if !model_path.exists() {
            return Err(format!("标点模型文件不存在: {}", model_path.display()));
        }

        let config = OfflinePunctuationConfig {
            model: OfflinePunctuationModelConfig {
                ct_transformer: Some(model_path.to_string_lossy().to_string()),
                num_threads: num_threads as i32,
                provider: Some("cpu".to_string()),
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

    #[test]
    fn test_new_missing_model_dir() {
        let result = PunctuationProcessor::new(Path::new("/nonexistent/path"), 1);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("标点模型文件不存在"));
    }
}

use sherpa_onnx::{OfflineFunASRNanoModelConfig, OfflineRecognizer, OfflineRecognizerConfig};
use std::path::Path;

use crate::model::ModelEntry;

use super::{
    json_bool, json_f32, json_i32, json_string,
};

/// Build a comma-separated hotwords string for FunASR-Nano models.
///
/// The model takes hotwords directly in its config as `"word1,word2,…"` — no
/// file, no scores, no token validation needed.  This function extracts the
/// raw word from each hotword entry (stripping optional `|weight` suffixes)
/// and joins them with commas.
///
/// Returns `None` when the input list is empty.
pub(crate) fn build_funasr_hotwords(hotwords: &[String]) -> Option<String> {
    if hotwords.is_empty() {
        return None;
    }
    let words: Vec<String> = hotwords
        .iter()
        .map(|hw| {
            let (word, _) = crate::hotword::parse_hotword_entry(hw);
            word.to_string()
        })
        .collect();
    Some(words.join(","))
}

/// Build a FunASR-Nano OfflineRecognizer from a registry entry.
pub(crate) fn build_funasr_nano_recognizer(
    model_dir: &Path,
    entry: &ModelEntry,
    num_threads: u32,
    model_config: &serde_json::Value,
    funasr_hotwords: Option<&str>,
) -> Result<OfflineRecognizer, String> {
    let p = |key: &str| -> Option<String> {
        let filename = entry.model_files.get(key)?;
        let path = model_dir.join(filename);
        if !path.exists() {
            return None;
        }
        path.to_str().map(|s| s.to_string())
    };

    let mut config = OfflineRecognizerConfig::default();
    config.model_config.num_threads = num_threads as i32;
    config.model_config.debug = cfg!(debug_assertions);

    let encoder_adaptor = p("encoder_adaptor")
        .ok_or_else(|| format!("模型 {} 缺少 encoder_adaptor 文件", entry.id))?;
    let llm = p("llm")
        .ok_or_else(|| format!("模型 {} 缺少 llm 文件", entry.id))?;
    let embedding = p("embedding")
        .ok_or_else(|| format!("模型 {} 缺少 embedding 文件", entry.id))?;
    let tokenizer = p("tokenizer")
        .ok_or_else(|| format!("模型 {} 缺少 tokenizer 文件", entry.id))?;
    config.model_config.funasr_nano = OfflineFunASRNanoModelConfig {
        encoder_adaptor: Some(encoder_adaptor),
        llm: Some(llm),
        embedding: Some(embedding),
        tokenizer: Some(tokenizer),
        system_prompt: json_string(model_config, "system_prompt"),
        user_prompt: json_string(model_config, "user_prompt"),
        max_new_tokens: json_i32(model_config, "max_new_tokens").unwrap_or(512),
        temperature: json_f32(model_config, "temperature").unwrap_or(1e-6),
        top_p: json_f32(model_config, "top_p").unwrap_or(0.8),
        seed: json_i32(model_config, "seed").unwrap_or(42),
        language: json_string(model_config, "language"),
        itn: if json_bool(model_config, "itn").unwrap_or(true) { 1 } else { 0 },
        hotwords: funasr_hotwords.map(|s| s.to_string()),
    };
    config.model_config.model_type = Some("funasr_nano".to_string());

    OfflineRecognizer::create(&config)
        .ok_or_else(|| format!("创建离线识别器失败 (model: {})", entry.id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn funasr_hotwords_comma_separated() {
        let hotwords = vec![
            "Claude Code".to_string(),
            "OpenAI".to_string(),
            "ChatGPT".to_string(),
        ];
        let result = build_funasr_hotwords(&hotwords);
        assert_eq!(result.as_deref(), Some("Claude Code,OpenAI,ChatGPT"));
    }

    #[test]
    fn funasr_hotwords_strips_weight_suffix() {
        let hotwords = vec![
            "Claude Code|10".to_string(),
            "OpenAI|5".to_string(),
            "mermaid".to_string(),
        ];
        let result = build_funasr_hotwords(&hotwords);
        assert_eq!(result.as_deref(), Some("Claude Code,OpenAI,mermaid"));
    }

    #[test]
    fn funasr_hotwords_empty_returns_none() {
        let result = build_funasr_hotwords(&[]);
        assert_eq!(result, None);
    }

    #[test]
    fn funasr_hotwords_single_word() {
        let hotwords = vec!["Claude Code".to_string()];
        let result = build_funasr_hotwords(&hotwords);
        assert_eq!(result.as_deref(), Some("Claude Code"));
    }

    #[test]
    fn funasr_hotwords_chinese_mixed() {
        let hotwords = vec![
            "流式输出".to_string(),
            "热词".to_string(),
            "OpenAI".to_string(),
        ];
        let result = build_funasr_hotwords(&hotwords);
        assert_eq!(result.as_deref(), Some("流式输出,热词,OpenAI"));
    }

    #[test]
    fn funasr_hotwords_preserves_original_case() {
        let hotwords = vec![
            "AGENTS.md".to_string(),
            "Claude Code".to_string(),
        ];
        let result = build_funasr_hotwords(&hotwords);
        assert_eq!(result.as_deref(), Some("AGENTS.md,Claude Code"));
    }
}

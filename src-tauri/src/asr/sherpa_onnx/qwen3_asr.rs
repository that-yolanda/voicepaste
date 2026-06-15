use sherpa_onnx::{OfflineQwen3ASRModelConfig, OfflineRecognizer, OfflineRecognizerConfig};
use std::path::Path;

use crate::model::ModelEntry;

use super::{json_f32, json_i32, json_string};

/// Build a Qwen3 ASR OfflineRecognizer from a registry entry.
///
/// The model uses conv_frontend + encoder + decoder + tokenizer (directory).
/// Hotwords are passed as a comma-separated string in the model config,
/// following the same pattern as FunASR-Nano.
pub(crate) fn build_qwen3_asr_recognizer(
    model_dir: &Path,
    entry: &ModelEntry,
    num_threads: u32,
    model_config: &serde_json::Value,
    hotwords_str: Option<&str>,
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
    config.model_config.provider = json_string(model_config, "provider");

    let conv_frontend =
        p("conv_frontend").ok_or_else(|| format!("模型 {} 缺少 conv_frontend 文件", entry.id))?;
    let encoder = p("encoder").ok_or_else(|| format!("模型 {} 缺少 encoder 文件", entry.id))?;
    let decoder = p("decoder").ok_or_else(|| format!("模型 {} 缺少 decoder 文件", entry.id))?;
    let tokenizer =
        p("tokenizer").ok_or_else(|| format!("模型 {} 缺少 tokenizer 文件", entry.id))?;

    config.model_config.qwen3_asr = OfflineQwen3ASRModelConfig {
        conv_frontend: Some(conv_frontend),
        encoder: Some(encoder),
        decoder: Some(decoder),
        tokenizer: Some(tokenizer),
        max_total_len: json_i32(model_config, "max_total_len").unwrap_or(512),
        max_new_tokens: json_i32(model_config, "max_new_tokens").unwrap_or(128),
        temperature: json_f32(model_config, "temperature").unwrap_or(1e-6),
        top_p: json_f32(model_config, "top_p").unwrap_or(0.8),
        seed: json_i32(model_config, "seed").unwrap_or(42),
        hotwords: hotwords_str.map(|s| s.to_string()),
    };

    // tokens must be set to empty string for Qwen3 ASR (uses tokenizer directory)
    config.model_config.tokens = Some(String::new());

    OfflineRecognizer::create(&config)
        .ok_or_else(|| format!("创建离线识别器失败 (model: {})", entry.id))
}

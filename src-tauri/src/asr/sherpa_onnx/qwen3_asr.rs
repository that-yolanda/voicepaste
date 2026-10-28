use sherpa_onnx::{OfflineQwen3ASRModelConfig, OfflineRecognizer, OfflineRecognizerConfig};
use std::path::Path;

use crate::errors::{AppError, AppErrorCode};
use crate::model::ModelEntry;

use super::{build_model_path, json_f32, json_i32, json_string};

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
) -> Result<OfflineRecognizer, AppError> {
    let mut config = OfflineRecognizerConfig::default();
    config.model_config.num_threads = num_threads as i32;
    config.model_config.debug = cfg!(debug_assertions);
    config.model_config.provider = json_string(model_config, "provider");

    let missing_file_error = |file: &str| {
        AppError::new(AppErrorCode::AsrModelFileMissing)
            .with_param("model", entry.id.as_str())
            .with_param("file", file)
    };
    let conv_frontend = build_model_path(model_dir, entry, "conv_frontend")
        .ok_or_else(|| missing_file_error("conv_frontend"))?;
    let encoder = build_model_path(model_dir, entry, "encoder")
        .ok_or_else(|| missing_file_error("encoder"))?;
    let decoder = build_model_path(model_dir, entry, "decoder")
        .ok_or_else(|| missing_file_error("decoder"))?;
    let tokenizer = build_model_path(model_dir, entry, "tokenizer")
        .ok_or_else(|| missing_file_error("tokenizer"))?;

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

    OfflineRecognizer::create(&config).ok_or_else(|| {
        AppError::new(AppErrorCode::AsrRecognizerCreateFailed)
            .with_detail(format!("model: {}", entry.id))
    })
}

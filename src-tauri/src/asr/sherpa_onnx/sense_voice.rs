use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, OfflineSenseVoiceModelConfig};
use std::path::Path;

use crate::model::ModelEntry;

use super::{build_model_path, json_bool, json_string};

/// Build a SenseVoice OfflineRecognizer from a registry entry.
pub(crate) fn build_sense_voice_recognizer(
    model_dir: &Path,
    entry: &ModelEntry,
    num_threads: u32,
    model_config: &serde_json::Value,
) -> Result<OfflineRecognizer, String> {
    let mut config = OfflineRecognizerConfig::default();
    config.model_config.num_threads = num_threads as i32;
    config.model_config.debug = cfg!(debug_assertions);
    config.model_config.provider = json_string(model_config, "provider");

    let model = build_model_path(model_dir, entry, "model")
        .ok_or_else(|| format!("模型 {} 缺少 model 文件", entry.id))?;
    config.model_config.sense_voice = OfflineSenseVoiceModelConfig {
        model: Some(model),
        language: json_string(model_config, "language"),
        use_itn: json_bool(model_config, "use_itn").unwrap_or(true),
    };
    config.model_config.tokens = build_model_path(model_dir, entry, "tokens");
    config.model_config.model_type = Some("sense_voice".to_string());

    OfflineRecognizer::create(&config)
        .ok_or_else(|| format!("创建离线识别器失败 (model: {})", entry.id))
}

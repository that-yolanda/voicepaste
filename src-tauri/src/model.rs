use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

/// Model category: what the model does (not its online/offline nature).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ModelCategory {
    Asr,
    Vad,
    Punctuation,
}

/// Engine capabilities.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capabilities {
    pub streaming: bool,
    #[serde(default)]
    pub hotwords: bool,
    #[serde(default)]
    pub punctuation: bool,
    #[serde(default)]
    pub itn: bool,
}

/// Model entry in the registry (matches registry.json schema).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelEntry {
    /// Global unique ID, e.g. "doubao-streaming", "silero-vad".
    pub id: String,
    /// "online" | "offline"
    #[serde(rename = "type")]
    pub model_type: String,
    /// "asr" | "vad" | "punctuation"
    pub category: ModelCategory,
    /// Engine/provider: "volcengine" | "sherpa-onnx"
    pub provider: String,
    /// Display name in the UI.
    pub name: String,
    /// Display description in the UI.
    pub description: String,
    /// Feature tags beyond capabilities.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Capabilities.
    pub capabilities: Capabilities,
    /// Supported language codes, e.g. ["zh", "en"].
    #[serde(default)]
    pub languages: Vec<String>,

    // -- Online models only --
    /// Config fields the user must fill (e.g. url, app_id, access_token, …).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_config: Option<Vec<String>>,

    // -- Offline models only --
    /// Sherpa-ONNX architecture: "sense_voice", "transducer", "vad", etc.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub architecture: Option<String>,
    /// Download URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_url: Option<String>,
    /// Approximate download size in MB.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_size: Option<u64>,
    /// Approximate runtime memory in MB.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mem_size: Option<u64>,
    /// Required model files (key → relative filename in the extracted directory).
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub model_files: std::collections::HashMap<String, String>,
    /// Default model parameters (sherpa-onnx config overrides).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_config: Option<serde_json::Value>,
}

/// Top-level registry structure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelRegistry {
    pub version: u32,
    #[serde(default)]
    pub updated_at: String,
    pub models: Vec<ModelEntry>,
}

/// Load the model registry from the resource directory, falling back to a minimal default.
pub fn load_registry(resource_dir: &Path) -> ModelRegistry {
    let registry_path = resource_dir.join("registry.json");
    if registry_path.exists() {
        if let Ok(content) = fs::read_to_string(&registry_path) {
            if let Ok(registry) = serde_json::from_str(&content) {
                return registry;
            }
        }
    }
    // Fallback: minimal registry with just the online Doubao entry
    minimal_registry()
}

fn minimal_registry() -> ModelRegistry {
    ModelRegistry {
        version: 3,
        updated_at: String::new(),
        models: vec![ModelEntry {
            id: "doubao-streaming".to_string(),
            model_type: "online".to_string(),
            category: ModelCategory::Asr,
            provider: "volcengine".to_string(),
            name: "火山引擎 - 豆包流式输出大模型".to_string(),
            description: "基于豆包大模型的流式语音识别服务".to_string(),
            tags: vec![
                "流式输出".to_string(),
                "免费可用".to_string(),
                "热词库".to_string(),
                "中文,英文,方言".to_string(),
            ],
            capabilities: Capabilities {
                streaming: true,
                hotwords: true,
                punctuation: true,
                itn: true,
            },
            languages: vec!["zh".to_string(), "en".to_string()],
            requires_config: Some(vec![
                "url".to_string(),
                "app_id".to_string(),
                "access_token".to_string(),
                "secret_key".to_string(),
                "resource_id".to_string(),
            ]),
            architecture: None,
            download_url: None,
            file_size: None,
            mem_size: None,
            model_files: std::collections::HashMap::new(),
            default_config: None,
        }],
    }
}

impl ModelEntry {
    /// Whether this model can be downloaded (has a download_url and is offline).
    pub fn is_downloadable(&self) -> bool {
        self.download_url.is_some()
    }
}

/// Resolve the models directory under app data dir.
pub fn models_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("models")
}

/// Check which models from the registry are already downloaded.
pub fn get_downloaded_models(data_dir: &Path, registry: &ModelRegistry) -> Vec<String> {
    let dir = models_dir(data_dir);
    registry
        .models
        .iter()
        .filter(|m| m.is_downloadable())
        .filter(|m| is_model_downloaded(&dir, m))
        .map(|m| m.id.clone())
        .collect()
}

/// Check if a specific model's required files exist.
fn is_model_downloaded(models_base: &Path, model: &ModelEntry) -> bool {
    if model.model_files.is_empty() {
        return false;
    }
    let model_dir = models_base.join(&model.id);
    model
        .model_files
        .values()
        .all(|filename| model_dir.join(filename).exists())
}

/// Download a model, emitting progress events to the frontend.
pub async fn download_model(
    app: &AppHandle,
    data_dir: &Path,
    registry: &ModelRegistry,
    model_id: &str,
) -> Result<(), String> {
    let entry = registry
        .models
        .iter()
        .find(|m| m.id == model_id)
        .ok_or_else(|| format!("模型 {} 未在注册表中找到", model_id))?;

    let url = entry
        .download_url
        .as_ref()
        .ok_or_else(|| format!("模型 {} 没有下载地址（在线模型无需下载）", model_id))?;

    let dir = models_dir(data_dir);
    let model_dir = dir.join(model_id);
    fs::create_dir_all(&model_dir)
        .map_err(|e| format!("创建模型目录失败: {}", e))?;

    log_app!(info, "Downloading model {} from {}", model_id, url);

    let _ = app.emit(
        "model:download:progress",
        serde_json::json!({
            "model_id": model_id,
            "status": "downloading",
            "progress": 0,
        }),
    );

    // Download the archive
    let response = reqwest::get(url)
        .await
        .map_err(|e| format!("下载失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("下载失败: HTTP {}", response.status()));
    }

    let total_size = response.content_length();
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;

    let mut downloaded: u64 = 0;
    let mut chunks: Vec<u8> = Vec::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断: {}", e))?;
        downloaded += chunk.len() as u64;
        chunks.extend_from_slice(&chunk);

        if let Some(total) = total_size {
            let progress = (downloaded as f64 / total as f64 * 100.0) as u32;
            let _ = app.emit(
                "model:download:progress",
                serde_json::json!({
                    "model_id": model_id,
                    "status": "downloading",
                    "progress": progress,
                }),
            );
        }
    }

    // Extract archive
    let archive_data = chunks;
    if url.ends_with(".tar.gz") || url.ends_with(".tgz") {
        use flate2::read::GzDecoder;
        let gz = GzDecoder::new(&archive_data[..]);
        let mut archive = tar::Archive::new(gz);
        archive
            .unpack(&model_dir)
            .map_err(|e| format!("解压失败: {}", e))?;
    } else if url.ends_with(".tar.bz2") || url.ends_with(".tbz2") {
        use bzip2::read::BzDecoder;
        let bz = BzDecoder::new(&archive_data[..]);
        let mut archive = tar::Archive::new(bz);
        archive
            .unpack(&model_dir)
            .map_err(|e| format!("解压失败: {}", e))?;
    } else {
        // Single file — save directly using the first model_files value
        if let Some(filename) = entry.model_files.values().next() {
            fs::write(model_dir.join(filename), &archive_data)
                .map_err(|e| format!("保存文件失败: {}", e))?;
        }
    }

    // Verify model files
    if !entry.model_files.is_empty() && !is_model_downloaded(&dir, entry) {
        // Maybe files are nested in a subdirectory — try to flatten
        flatten_single_subdir(&model_dir);
    }

    if !is_model_downloaded(&dir, entry) {
        return Err(format!(
            "模型 {} 下载完成但文件校验失败，请重试",
            model_id
        ));
    }

    let _ = app.emit(
        "model:download:progress",
        serde_json::json!({
            "model_id": model_id,
            "status": "completed",
            "progress": 100,
        }),
    );

    log_app!(info, "Model {} downloaded successfully", model_id);
    Ok(())
}

/// If the extract created a single subdirectory, move its contents up.
fn flatten_single_subdir(dir: &Path) {
    let entries: Vec<_> = fs::read_dir(dir)
        .ok()
        .map(|rd| rd.filter_map(|e| e.ok()).collect())
        .unwrap_or_default();

    if entries.len() == 1 && entries[0].path().is_dir() {
        let subdir = &entries[0].path();
        if let Ok(sub_entries) = fs::read_dir(subdir) {
            for entry in sub_entries.filter_map(|e| e.ok()) {
                let dest = dir.join(entry.file_name());
                let _ = fs::rename(entry.path(), dest);
            }
        }
        let _ = fs::remove_dir(subdir);
    }
}

/// Delete a downloaded model's directory.
pub fn delete_model(data_dir: &Path, model_id: &str) -> Result<(), String> {
    let dir = models_dir(data_dir).join(model_id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("删除模型失败: {}", e))?;
    }
    Ok(())
}

/// Resolve the model directory path for a given model ID.
pub fn model_path(data_dir: &Path, model_id: &str) -> PathBuf {
    models_dir(data_dir).join(model_id)
}

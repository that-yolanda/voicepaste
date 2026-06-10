use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

/// Model category: online (cloud), offline (local), or vad.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ModelCategory {
    Online,
    Offline,
    Vad,
}

/// Language descriptor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanguageInfo {
    pub code: String,
    pub name: String,
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

/// Model entry in the registry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelEntry {
    pub id: String,
    pub category: ModelCategory,
    pub provider: String,
    /// For offline models: "offline" or "online" (streaming local).
    /// For online models: omitted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_type: Option<String>,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub features: Vec<String>,
    #[serde(default)]
    pub recommend_tags: Vec<String>,
    #[serde(default)]
    pub languages: Vec<LanguageInfo>,
    pub capabilities: Capabilities,
    /// Online models: config fields the user must fill.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_config: Option<Vec<String>>,
    /// Offline/VAD models: download URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_url: Option<String>,
    /// Approximate download size in MB.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_size_mb: Option<u64>,
    /// Approximate runtime memory in MB.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_mb: Option<u64>,
    /// Required model files (key → relative filename).
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub model_files: std::collections::HashMap<String, String>,
    /// Default model parameters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_config: Option<serde_json::Value>,
    /// VAD models: which categories depend on this model.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_by: Option<Vec<String>>,
}

/// Top-level registry structure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelRegistry {
    pub version: u32,
    #[serde(default)]
    pub updated_at: String,
    pub models: Vec<ModelEntry>,
}

/// Load the model registry from the bundled assets, falling back to a minimal default.
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
        version: 2,
        updated_at: String::new(),
        models: vec![ModelEntry {
            id: "doubao-streaming".to_string(),
            category: ModelCategory::Online,
            provider: "volcengine".to_string(),
            model_type: None,
            name: "火山引擎 - 豆包流式输出大模型".to_string(),
            description: "基于豆包大模型的流式语音识别服务".to_string(),
            features: vec![
                "流式输出".to_string(),
                "免费可用".to_string(),
                "热词库".to_string(),
                "中文,英文,方言".to_string(),
            ],
            recommend_tags: vec!["免费可用".to_string()],
            languages: vec![
                LanguageInfo {
                    code: "zh".to_string(),
                    name: "中文".to_string(),
                },
                LanguageInfo {
                    code: "en".to_string(),
                    name: "英文".to_string(),
                },
            ],
            capabilities: Capabilities {
                streaming: true,
                hotwords: true,
                punctuation: true,
                itn: true,
            },
            requires_config: Some(vec![
                "url".to_string(),
                "app_id".to_string(),
                "access_token".to_string(),
                "secret_key".to_string(),
                "resource_id".to_string(),
            ]),
            download_url: None,
            file_size_mb: None,
            memory_mb: None,
            model_files: std::collections::HashMap::new(),
            default_config: None,
            required_by: None,
        }],
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
        .filter(|m| m.category != ModelCategory::Online)
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

/// Ensure the VAD model is downloaded. Returns error if not available.
pub fn ensure_vad_model(data_dir: &Path, registry: &ModelRegistry) -> Result<PathBuf, String> {
    let vad_entry = registry
        .models
        .iter()
        .find(|m| m.category == ModelCategory::Vad)
        .ok_or("VAD 模型未在注册表中找到")?;

    let dir = models_dir(data_dir);
    if is_model_downloaded(&dir, vad_entry) {
        return Ok(dir.join(&vad_entry.id));
    }
    Err("VAD 模型尚未下载，请先在设置中下载".to_string())
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

/// Find a model entry by ID.
pub fn find_model<'a>(registry: &'a ModelRegistry, model_id: &str) -> Option<&'a ModelEntry> {
    registry.models.iter().find(|m| m.id == model_id)
}

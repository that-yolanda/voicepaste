use serde::{Deserialize, Serialize};
use sherpa_onnx::{SileroVadModelConfig, VadModelConfig, VoiceActivityDetector};
use std::path::Path;

use crate::model::ModelEntry;

/// VAD configuration loaded from registry.json's silero-vad model entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VadConfig {
    #[serde(default = "default_vad_threshold")]
    pub threshold: f32,
    #[serde(default = "default_vad_min_silence")]
    pub min_silence_duration: f32,
    #[serde(default = "default_vad_min_speech")]
    pub min_speech_duration: f32,
    #[serde(default = "default_vad_max_speech")]
    pub max_speech_duration: f32,
    #[serde(default = "default_num_threads")]
    pub num_threads: u32,
    #[serde(default = "default_provider")]
    pub provider: String,
}

fn default_vad_threshold() -> f32 {
    0.2
}
fn default_vad_min_silence() -> f32 {
    0.2
}
fn default_vad_min_speech() -> f32 {
    0.2
}
fn default_vad_max_speech() -> f32 {
    10.0
}
fn default_num_threads() -> u32 {
    2
}
fn default_provider() -> String {
    "cpu".to_string()
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            threshold: default_vad_threshold(),
            min_silence_duration: default_vad_min_silence(),
            min_speech_duration: default_vad_min_speech(),
            max_speech_duration: default_vad_max_speech(),
            num_threads: default_num_threads(),
            provider: default_provider(),
        }
    }
}

impl VadConfig {
    /// Parse VAD config from a registry model entry's `default_config` JSON value.
    pub fn from_registry(default_config: Option<&serde_json::Value>) -> Self {
        default_config
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default()
    }

    /// Merge registry defaults with user overrides from config.yaml.
    /// User values take precedence; omitted fields keep the registry default.
    pub fn merged(base: &Self, user: &crate::config::VadParams) -> Self {
        Self {
            threshold: user.threshold.unwrap_or(base.threshold),
            min_silence_duration: user
                .min_silence_duration
                .unwrap_or(base.min_silence_duration),
            min_speech_duration: user.min_speech_duration.unwrap_or(base.min_speech_duration),
            max_speech_duration: user.max_speech_duration.unwrap_or(base.max_speech_duration),
            num_threads: user.num_threads.unwrap_or(base.num_threads),
            provider: user
                .provider
                .clone()
                .unwrap_or_else(|| base.provider.clone()),
        }
    }
}

/// Wrapper around sherpa-onnx VoiceActivityDetector.
/// Buffers incoming audio, feeds it in 512-sample windows, and collects speech segments.
pub struct VadProcessor {
    detector: VoiceActivityDetector,
    buffer: Vec<f32>,
    window_size: usize,
}

impl VadProcessor {
    /// Create a new VAD processor from a registry entry.
    ///
    /// `entry.model_files["model"]` names the Silero VAD ONNX file inside `model_dir`.
    pub fn new(entry: &ModelEntry, model_dir: &Path, config: &VadConfig) -> Result<Self, String> {
        let model_path = entry
            .model_files
            .get("model")
            .map(|filename| model_dir.join(filename))
            .ok_or_else(|| format!("VAD 模型 {} 缺少 model 文件定义", entry.id))?;
        if !model_path.exists() {
            return Err(format!("VAD 模型文件不存在: {}", model_path.display()));
        }

        let silero_config = SileroVadModelConfig {
            model: model_path.to_str().map(|s| s.to_string()),
            threshold: config.threshold,
            min_silence_duration: config.min_silence_duration,
            min_speech_duration: config.min_speech_duration,
            max_speech_duration: config.max_speech_duration,
            ..Default::default()
        };

        let vad_config = VadModelConfig {
            silero_vad: silero_config,
            sample_rate: 16000,
            num_threads: config.num_threads as i32,
            provider: Some(config.provider.clone()),
            ..Default::default()
        };

        // 30-second buffer for VAD
        let detector = VoiceActivityDetector::create(&vad_config, 30.0)
            .ok_or_else(|| "创建 VAD 检测器失败".to_string())?;

        Ok(Self {
            detector,
            buffer: Vec::with_capacity(1024),
            window_size: 512, // Silero VAD at 16kHz
        })
    }

    /// Feed audio samples. Returns completed speech segments.
    pub fn accept_waveform(&mut self, samples: &[f32]) -> Vec<Vec<f32>> {
        self.buffer.extend_from_slice(samples);
        let mut segments = Vec::new();

        while self.buffer.len() >= self.window_size {
            self.detector
                .accept_waveform(&self.buffer[..self.window_size]);
            self.buffer.drain(..self.window_size);

            while let Some(segment) = self.detector.front() {
                let samples = segment.samples().to_vec();
                if !samples.is_empty() {
                    segments.push(samples);
                }
                self.detector.pop();
            }
        }

        segments
    }

    /// Whether the VAD is currently detecting voice activity.
    /// Returns `true` from the moment speech starts until a complete segment is formed.
    pub fn detected(&self) -> bool {
        self.detector.detected()
    }

    /// Flush any remaining buffered audio and return final speech segments.
    pub fn flush(&mut self) -> Vec<Vec<f32>> {
        // Zero-pad remaining buffer to window size
        if !self.buffer.is_empty() {
            self.buffer.resize(self.window_size, 0.0);
            self.detector
                .accept_waveform(&self.buffer[..self.window_size]);
            self.buffer.clear();
        }

        self.detector.flush();

        let mut segments = Vec::new();
        while let Some(segment) = self.detector.front() {
            let samples = segment.samples().to_vec();
            if !samples.is_empty() {
                segments.push(samples);
            }
            self.detector.pop();
        }

        segments
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_vad_config_defaults() {
        let config = super::VadConfig::default();
        assert!((config.threshold - 0.2).abs() < f32::EPSILON);
        assert!((config.min_silence_duration - 0.2).abs() < f32::EPSILON);
        assert_eq!(config.num_threads, 2);
    }

    #[test]
    fn test_vad_config_from_registry() {
        let json = serde_json::json!({
            "threshold": 0.5,
            "min_silence_duration": 0.3,
            "min_speech_duration": 0.4,
            "max_speech_duration": 15.0,
            "num_threads": 4
        });
        let config = super::VadConfig::from_registry(Some(&json));
        assert!((config.threshold - 0.5).abs() < f32::EPSILON);
        assert_eq!(config.num_threads, 4);
    }

    #[test]
    fn test_vad_config_from_registry_none() {
        let config = super::VadConfig::from_registry(None);
        assert!((config.threshold - 0.2).abs() < f32::EPSILON);
    }

    #[test]
    fn test_new_missing_model_files_definition() {
        // No "model" key in model_files → should report a missing-definition error.
        let entry: crate::model::ModelEntry = serde_json::from_value(serde_json::json!({
            "id": "vad-test",
            "type": "offline",
            "category": "vad",
            "engine": "sherpa-onnx",
            "name": "T",
            "description": "T",
            "model_files": {}
        }))
        .unwrap();
        let result = super::VadProcessor::new(
            &entry,
            std::path::Path::new("/nonexistent"),
            &super::VadConfig::default(),
        );
        assert!(result.is_err());
        assert!(result.err().unwrap().contains("缺少 model 文件定义"));
    }
}

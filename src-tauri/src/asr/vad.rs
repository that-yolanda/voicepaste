use sherpa_onnx::{SileroVadModelConfig, VadModelConfig, VoiceActivityDetector};
use std::path::Path;

use crate::config::VadConfig;

/// Wrapper around sherpa-onnx VoiceActivityDetector.
/// Buffers incoming audio, feeds it in 512-sample windows, and collects speech segments.
pub struct VadProcessor {
    detector: VoiceActivityDetector,
    buffer: Vec<f32>,
    window_size: usize,
}

impl VadProcessor {
    /// Create a new VAD processor. `vad_model_dir` should contain `silero_vad.onnx`.
    pub fn new(vad_model_dir: &Path, config: &VadConfig, num_threads: u32) -> Result<Self, String> {
        let model_path = vad_model_dir.join("silero_vad.onnx");
        if !model_path.exists() {
            return Err(format!(
                "VAD 模型文件不存在: {}",
                model_path.display()
            ));
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
            num_threads: num_threads as i32,
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
        let config = crate::config::VadConfig::default();
        assert!((config.threshold - 0.2).abs() < f32::EPSILON);
        assert!((config.min_silence_duration - 0.2).abs() < f32::EPSILON);
    }
}

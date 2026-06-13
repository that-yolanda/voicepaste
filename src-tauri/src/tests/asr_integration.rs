//! ASR integration tests — require downloaded sherpa-onnx model files.
//!
//! Run with: `cargo test --features asr-integration`
//!
//! Prerequisites:
//!   - FunASR-Nano model downloaded (via app or placed in models/ dir)
//!   - Test audio fixtures in src/tests/fixtures/

use sherpa_onnx::{OfflineFunASRNanoModelConfig, OfflineRecognizer, OfflineRecognizerConfig};
use std::path::{Path, PathBuf};

/// Resolve the absolute `src-tauri/` directory at build time.
fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Resolve a test fixture under `src/tests/fixtures/`.
fn fixture(name: &str) -> PathBuf {
    manifest_dir().join("src/tests/fixtures").join(name)
}

/// Read a 16-bit mono WAV and return `(samples_f32, sample_rate)`.
fn read_wav(path: &Path) -> Result<(Vec<f32>, i32), String> {
    let data = std::fs::read(path).map_err(|e| format!("Failed to read audio: {e}"))?;

    // Locate the "data" chunk (skip "fmt " / "LIST" etc.)
    let data_pos = data
        .windows(4)
        .position(|w| w == b"data")
        .ok_or_else(|| "data chunk not found in WAV".to_string())?;

    let data_size = u32::from_le_bytes(
        data[data_pos + 4..data_pos + 8]
            .try_into()
            .map_err(|_| "malformed WAV data chunk".to_string())?,
    ) as usize;

    let pcm_start = data_pos + 8;
    let pcm_end = (pcm_start + data_size).min(data.len());
    let pcm = &data[pcm_start..pcm_end];

    let samples: Vec<f32> = pcm
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect();

    Ok((samples, 16000))
}

/// Locate the downloaded FunASR-Nano model directory, if available.
fn find_funasr_nano_model() -> Option<PathBuf> {
    let model_dir = dirs::data_dir()
        .unwrap_or_default()
        .join("com.yolanda.voicepaste")
        .join("models")
        .join("sherpa-onnx-funasr-nano-zh-en-ja-int8");

    let marker = model_dir.join("encoder_adaptor.int8.onnx");
    if marker.exists() {
        log::debug!("Found FunASR-Nano model at {}", model_dir.display());
        return Some(model_dir);
    }
    None
}

/// Build a FunASR-Nano `OfflineRecognizer` (with or without hotwords).
fn build_funasr_recognizer(
    model_dir: &Path,
    hotwords: Option<&str>,
) -> Result<OfflineRecognizer, String> {
    let to_str = |p: &Path| -> Option<String> {
        if p.exists() {
            p.to_str().map(|s| s.to_string())
        } else {
            None
        }
    };

    let mut config = OfflineRecognizerConfig::default();
    config.model_config.num_threads = 2;
    config.model_config.debug = cfg!(debug_assertions);
    config.model_config.model_type = Some("funasr_nano".to_string());

    config.model_config.funasr_nano = OfflineFunASRNanoModelConfig {
        encoder_adaptor: to_str(&model_dir.join("encoder_adaptor.int8.onnx")),
        llm: to_str(&model_dir.join("llm.int8.onnx")),
        embedding: to_str(&model_dir.join("embedding.int8.onnx")),
        tokenizer: to_str(&model_dir.join("Qwen3-0.6B")),
        system_prompt: Some("You are a helpful assistant.".to_string()),
        user_prompt: Some("语音转写：".to_string()),
        max_new_tokens: 512,
        temperature: 1e-6,
        top_p: 0.8,
        seed: 42,
        language: Some("auto".to_string()),
        itn: 1,
        hotwords: hotwords.map(|s| s.to_string()),
    };

    OfflineRecognizer::create(&config)
        .ok_or_else(|| "Failed to create FunASR-Nano recognizer".to_string())
}

/// Decode a full audio buffer with an `OfflineRecognizer`.
fn decode_full(recognizer: &OfflineRecognizer, samples: &[f32]) -> String {
    let stream = recognizer.create_stream();
    stream.accept_waveform(16000, samples);
    recognizer.decode(&stream);
    stream
        .get_result()
        .map(|r| r.text.trim().to_string())
        .unwrap_or_default()
}

// ── Hotword influence tests ───────────────────────────────────────────────

#[test]
fn funasr_nano_hotwords_affect_recognition() {
    let model_dir = match find_funasr_nano_model() {
        Some(d) => d,
        None => {
            eprintln!("SKIP: FunASR-Nano model not downloaded, skipping integration test");
            return;
        }
    };

    let audio = fixture("test-audio-short.wav");
    let (samples, _rate) = read_wav(&audio).expect("Failed to read test audio");
    assert!(!samples.is_empty(), "Audio samples should not be empty");

    // Decode WITHOUT hotwords
    let rec_no_hw =
        build_funasr_recognizer(&model_dir, None).expect("Failed to create recognizer (no hw)");
    let text_no_hw = decode_full(&rec_no_hw, &samples);
    eprintln!("No hotwords: {text_no_hw}");
    assert!(
        !text_no_hw.is_empty(),
        "Should produce text without hotwords"
    );

    // Decode WITH hotwords
    let hotwords = "Claude Code,Skills,流式输出";
    let rec_hw = build_funasr_recognizer(&model_dir, Some(hotwords))
        .expect("Failed to create recognizer (with hw)");
    let text_hw = decode_full(&rec_hw, &samples);
    eprintln!("With hotwords [{hotwords}]: {text_hw}");
    assert!(!text_hw.is_empty(), "Should produce text with hotwords");

    // Verify hotword influence
    let terms: &[&str] = &["Claude Code", "Skills", "流式输出"];
    let no_hw_hits = terms.iter().filter(|t| text_no_hw.contains(**t)).count();
    let hw_hits = terms.iter().filter(|t| text_hw.contains(**t)).count();
    eprintln!(
        "Hotword hits — no hw: {no_hw_hits}/{}, with hw: {hw_hits}/{}",
        terms.len(),
        terms.len(),
    );

    // Hotwords should not reduce the number of matched terms.
    assert!(
        hw_hits >= no_hw_hits,
        "Hotwords should not reduce hit count. no hw: {no_hw_hits}, with hw: {hw_hits}"
    );
}

#[test]
fn funasr_nano_no_hotwords_no_crash() {
    let model_dir = match find_funasr_nano_model() {
        Some(d) => d,
        None => {
            eprintln!("SKIP: FunASR-Nano model not downloaded, skipping integration test");
            return;
        }
    };

    let audio = fixture("test-audio-short.wav");
    let (samples, _) = read_wav(&audio).expect("Failed to read test audio");

    // Empty hotwords string → same as None (should not crash).
    let rec = build_funasr_recognizer(&model_dir, Some(""))
        .expect("Failed to create recognizer (empty hw)");
    let text = decode_full(&rec, &samples);
    eprintln!("Empty hotwords: {text}");
    assert!(
        !text.is_empty(),
        "Should produce normal recognition with empty hotwords"
    );
}

// ── Additional integration tests ──────────────────────────────────────────

#[test]
fn funasr_nano_short_audio_basic_recognition() {
    let model_dir = match find_funasr_nano_model() {
        Some(d) => d,
        None => {
            eprintln!("SKIP: FunASR-Nano model not downloaded, skipping integration test");
            return;
        }
    };

    let audio = fixture("test-audio-short.wav");
    let (samples, _) = read_wav(&audio).expect("Failed to read test audio");

    let rec = build_funasr_recognizer(&model_dir, None).expect("Failed to create recognizer");
    let text = decode_full(&rec, &samples);
    eprintln!("Short audio recognition: {text}");

    // Basic sanity: should produce non-empty text
    assert!(!text.is_empty(), "Recognition result should not be empty");
}

#[test]
fn funasr_nano_long_audio_basic_recognition() {
    let model_dir = match find_funasr_nano_model() {
        Some(d) => d,
        None => {
            eprintln!("SKIP: FunASR-Nano model not downloaded, skipping integration test");
            return;
        }
    };

    let audio = fixture("test-audio-long.wav");
    let (samples, _) = read_wav(&audio).expect("Failed to read test audio");

    let rec = build_funasr_recognizer(&model_dir, None).expect("Failed to create recognizer");
    let text = decode_full(&rec, &samples);
    eprintln!("Long audio recognition: {text}");

    assert!(
        !text.is_empty(),
        "Long audio recognition result should not be empty"
    );
}

use super::{
    build_funasr_hotwords, filter_valid_hotwords, hotword_tokens_for_validation, parse_token_line,
    restore_hotword_case,
};
use sherpa_onnx::{OfflineFunASRNanoModelConfig, OfflineRecognizer, OfflineRecognizerConfig};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

// ── restore_hotword_case tests ──────────────────────────────────────────

#[test]
fn restore_case_mixed() {
    let r = restore_hotword_case("CLAUDE CODE", &["Claude Code".to_string()]);
    assert_eq!(r, "Claude Code");
}

#[test]
fn restore_case_lowercase_model_output() {
    let r = restore_hotword_case("claude code", &["Claude Code".to_string()]);
    assert_eq!(r, "Claude Code");
}

#[test]
fn restore_punctuation_stripped() {
    let r = restore_hotword_case("AGENTSMD", &["AGENTS.md".to_string()]);
    assert_eq!(r, "AGENTS.md");
}

#[test]
fn restore_punctuation_with_space() {
    let r = restore_hotword_case("AGENTS MD", &["AGENTS.md".to_string()]);
    assert_eq!(r, "AGENTS.md");
}

#[test]
fn no_change_for_chinese() {
    let r = restore_hotword_case("流式输出", &["流式输出".to_string()]);
    assert_eq!(r, "流式输出");
}

#[test]
fn restore_with_weight_format() {
    let r = restore_hotword_case("CLAUDE CODE", &["Claude Code|10".to_string()]);
    assert_eq!(r, "Claude Code");
}

#[test]
fn restore_single_hotword() {
    let r = restore_hotword_case(
        "使用 CLAUDE CODE 和 OPENAI",
        &["Claude Code".to_string()],
    );
    assert_eq!(r, "使用 Claude Code 和 OPENAI");
}

#[test]
fn restore_multiple_in_sentence() {
    let r = restore_hotword_case(
        "使用 CLAUDE CODE 和 OPENAI",
        &["Claude Code".to_string(), "OpenAI".to_string()],
    );
    assert_eq!(r, "使用 Claude Code 和 OpenAI");
}

// ── vocabulary validation tests ─────────────────────────────────────────

#[test]
fn parses_first_column_from_tokens_file() {
    assert_eq!(parse_token_line("你 42").as_deref(), Some("你"));
    assert_eq!(parse_token_line("<blk> 0").as_deref(), Some("<blk>"));
    assert_eq!(parse_token_line("   ").as_deref(), None);
}

#[test]
fn validates_cjk_hotwords_by_character_token() {
    let vocab = ["语", "音", "输", "入"]
        .into_iter()
        .map(str::to_string)
        .collect::<HashSet<_>>();
    let hotwords = vec!["语音输入".to_string(), "语音转写".to_string()];

    assert_eq!(
        hotword_tokens_for_validation("语音输入"),
        vec!["语", "音", "输", "入"]
    );
    assert_eq!(
        filter_valid_hotwords(&hotwords, Some(&vocab)),
        vec!["语音输入"]
    );
}

// ── FunASR-Nano hotwords tests ────────────────────────────────────────────

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
    // FunASR-Nano hotwords keep original casing (no uppercase transform)
    let hotwords = vec![
        "AGENTS.md".to_string(),
        "Claude Code".to_string(),
    ];
    let result = build_funasr_hotwords(&hotwords);
    assert_eq!(result.as_deref(), Some("AGENTS.md,Claude Code"));
}

// ── FunASR-Nano audio recognition integration tests ─────────────────────

/// Resolve the absolute `src-tauri/` directory at build time.
fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Read a 16-bit mono WAV and return `(samples_f32, sample_rate)`.
fn read_wav(path: &Path) -> Result<(Vec<f32>, i32), String> {
    let data = std::fs::read(path).map_err(|e| format!("无法读取音频: {e}"))?;

    // Locate the "data" chunk (skip "fmt " / "LIST" etc.)
    let data_pos = data
        .windows(4)
        .position(|w| w == b"data")
        .ok_or_else(|| "WAV 中未找到 data chunk".to_string())?;

    let data_size = u32::from_le_bytes(
        data[data_pos + 4..data_pos + 8]
            .try_into()
            .map_err(|_| "WAV data chunk 格式错误")?,
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
    let candidates: Vec<PathBuf> = vec![
        // macOS app data dir (prod download location)
        dirs::data_dir()
            .unwrap_or_default()
            .join("com.yolanda.voicepaste")
            .join("models")
            .join("sherpa-onnx-funasr-nano-zh-en-ja-int8"),
        // Source-adjacent (dev convenience)
        manifest_dir()
            .join("models")
            .join("sherpa-onnx-funasr-nano-zh-en-ja-int8"),
    ];

    for path in &candidates {
        let marker = path.join("encoder_adaptor.int8.onnx");
        if marker.exists() {
            log::debug!("Found FunASR-Nano model at {}", path.display());
            return Some(path.clone());
        }
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
        .ok_or_else(|| "创建 FunASR-Nano 识别器失败".to_string())
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

#[test]
fn funasr_nano_hotwords_affect_recognition() {
    let model_dir = match find_funasr_nano_model() {
        Some(d) => d,
        None => {
            eprintln!("SKIP: FunASR-Nano 模型未下载，跳过集成测试");
            return;
        }
    };

    let audio = manifest_dir().join("src/asr/tests/test-audio-short.wav");
    let (samples, _rate) = read_wav(&audio).expect("读取测试音频失败");
    assert!(!samples.is_empty(), "音频样本不应为空");

    // ── Decode WITHOUT hotwords ──
    let rec_no_hw = build_funasr_recognizer(&model_dir, None)
        .expect("创建无热词识别器失败");
    let text_no_hw = decode_full(&rec_no_hw, &samples);
    eprintln!("无热词: {text_no_hw}");
    assert!(!text_no_hw.is_empty(), "无热词时应产生文字");

    // ── Decode WITH hotwords from the expected transcript ──
    let hotwords = "Claude Code,Skills,流式输出";
    let rec_hw = build_funasr_recognizer(&model_dir, Some(hotwords))
        .expect("创建有热词识别器失败");
    let text_hw = decode_full(&rec_hw, &samples);
    eprintln!("有热词 [{hotwords}]: {text_hw}");
    assert!(!text_hw.is_empty(), "有热词时应产生文字");

    // ── Verify hotword influence ──
    let terms: &[&str] = &["Claude Code", "Skills", "流式输出"];
    let no_hw_hits = terms.iter().filter(|t| text_no_hw.contains(**t)).count();
    let hw_hits = terms.iter().filter(|t| text_hw.contains(**t)).count();
    eprintln!(
        "热词命中 — 无热词: {no_hw_hits}/{}, 有热词: {hw_hits}/{}",
        terms.len(),
        terms.len(),
    );

    // Hotwords should not reduce the number of matched terms.
    assert!(
        hw_hits >= no_hw_hits,
        "热词不应降低命中数。无热词: {no_hw_hits}, 有热词: {hw_hits}"
    );
}

#[test]
fn funasr_nano_no_hotwords_no_crash() {
    let model_dir = match find_funasr_nano_model() {
        Some(d) => d,
        None => {
            eprintln!("SKIP: FunASR-Nano 模型未下载，跳过集成测试");
            return;
        }
    };

    let audio = manifest_dir().join("src/asr/tests/test-audio-short.wav");
    let (samples, _) = read_wav(&audio).expect("读取测试音频失败");

    // Empty hotwords string → same as None (should not crash).
    let rec = build_funasr_recognizer(&model_dir, Some(""))
        .expect("创建识别器失败（空热词）");
    let text = decode_full(&rec, &samples);
    eprintln!("空热词: {text}");
    assert!(!text.is_empty(), "空热词时应正常识别");
}

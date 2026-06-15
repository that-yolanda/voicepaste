//! Diagnostic tests for the `sherpa-onnx-streaming-zipformer-zh-en` online model's
//! hotwords buffer construction.
//!
//! This model uses `modeling_unit = "cjkchar+bpe"`, which combines single-CJK-char
//! tokens with uppercase BPE subword tokens. Empirically (see
//! `zipformer_zh_en_decode_with_hotwords`) sherpa-onnx re-encodes BPE whole-words,
//! so English hotwords like `CLAUDE CODE :4` work even though `CLAUDE` is not a
//! literal token. But the CJK half is `cjkchar`-unit: `tokens.txt` only has single
//! characters (`流`, `式`, …), never multi-char words. A whole-word CJK hotword
//! like `流式输出 :4` is out-of-vocabulary and silently dropped — it has zero
//! effect on recognition. To bias CJK, each character must be listed separately:
//! `流 式 输 出 :4`.
//!
//! These tests print exactly what the app feeds the recognizer and verify,
//! token-by-token, whether each piece exists in the vocabulary.
//!
//! Gated behind `asr-integration` (needs the downloaded model + tokens.txt).
//!
//! Run a single test with visible output:
//! ```text
//! cargo test --features asr-integration -- --nocapture zipformer_zh_en
//! ```

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use sherpa_onnx::OnlineRecognizer;

use crate::asr::sherpa_onnx::online::{build_online_hotwords_buf, build_online_recognizer};
use crate::model::{self, ModelEntry};

/// The model under test.
const MODEL_ID: &str = "sherpa-onnx-streaming-zipformer-zh-en";

/// Resolve the app data directory (`~/Library/Application Support/com.yolanda.voicepaste`).
fn app_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.yolanda.voicepaste")
}

/// Resolve a test fixture under `src/tests/fixtures/`.
fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src/tests/fixtures")
        .join(name)
}

/// Locate the downloaded model directory plus its registry entry.
/// Returns `None` (and prints a SKIP note) when the model is not present.
fn find_model() -> Option<(PathBuf, ModelEntry)> {
    let data_dir = app_data_dir();
    let registry = model::load_registry(&data_dir, &data_dir);
    let entry = registry.models.iter().find(|m| m.id == MODEL_ID).cloned()?;

    let model_dir = model::model_path(&data_dir, MODEL_ID);
    let tokens_present = entry
        .model_files
        .get("tokens")
        .map(|f| model_dir.join(f))
        .is_some_and(|p| p.exists());
    if !tokens_present || !model_dir.exists() {
        return None;
    }
    Some((model_dir, entry))
}

/// Load the first-column token set from `tokens.txt`.
fn load_token_set(tokens_path: &Path) -> HashSet<String> {
    fs::read_to_string(tokens_path)
        .map(|content| {
            content
                .lines()
                .filter_map(|line| line.split_whitespace().next().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Read a 16-bit mono WAV and return `(samples_f32, sample_rate)`.
fn read_wav(path: &Path) -> Result<(Vec<f32>, i32), String> {
    let data = std::fs::read(path).map_err(|e| format!("Failed to read audio: {e}"))?;

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

// ── Buffer construction + per-token vocabulary check ───────────────────────

/// Build the hotwords buffer the way the app does, print it verbatim, and verify
/// each space-separated piece against `tokens.txt`. This is the core diagnostic:
/// any piece marked "MISSING" is an out-of-vocabulary token that sherpa-onnx
/// will reject, which is why the hotword has no effect.
#[test]
fn zipformer_zh_en_hotwords_buf_format() {
    let (model_dir, entry) = match find_model() {
        Some(x) => x,
        None => {
            eprintln!("SKIP: {MODEL_ID} model not downloaded");
            return;
        }
    };

    let modeling_unit = entry
        .default_config
        .as_ref()
        .and_then(|c| c.get("modeling_unit"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    eprintln!("==========================================================");
    eprintln!("Model: {MODEL_ID}");
    eprintln!("modeling_unit          = {modeling_unit:?}");
    eprintln!(
        "is_cjkchar_only (== \"cjkchar\")  = {}",
        modeling_unit == "cjkchar"
    );
    eprintln!(
        "is_bpe         (contains \"bpe\") = {}",
        modeling_unit.contains("bpe")
    );
    eprintln!("==========================================================");

    let tokens_path = entry
        .model_files
        .get("tokens")
        .map(|f| model_dir.join(f))
        .expect("tokens file path");
    let vocab = load_token_set(&tokens_path);
    eprintln!("tokens.txt loaded: {} entries", vocab.len());
    eprintln!();

    // Representative hotword inputs: English, CJK, mixed, punctuation, weighted.
    let cases: Vec<Vec<String>> = vec![
        vec!["Claude Code".to_string()],
        vec!["流式输出".to_string()],
        vec!["AGENTS.md".to_string()],
        vec!["OpenAI".to_string()],
        vec!["Claude Code|10".to_string()],
        vec!["流式输出|8".to_string()],
        vec![
            "Claude Code".to_string(),
            "流式输出".to_string(),
            "AGENTS.md".to_string(),
        ],
    ];

    for hotwords in &cases {
        let buf = build_online_hotwords_buf(hotwords, modeling_unit, &model_dir, &entry);

        eprintln!("----------------------------------------------------------");
        eprintln!("input hotwords: {hotwords:?}");

        let Some(buf) = buf else {
            eprintln!("buf = None  (empty after cleaning / OOV filter / capabilities)");
            eprintln!();
            continue;
        };

        let text = String::from_utf8_lossy(&buf);
        eprintln!("buf = {} bytes", buf.len());
        eprintln!("<<<");
        eprintln!("{text}");
        eprintln!(">>>");

        // Validate every space-separated token of each line against the vocab.
        //
        // CJK pieces must be literal single-char tokens — a missing one is fatal
        // (sherpa-onnx drops the whole hotword). Latin pieces are allowed to be
        // absent for BPE models because sherpa-onnx re-encodes whole words.
        let is_bpe = modeling_unit.contains("bpe");
        let mut any_missing = false;
        for (li, line) in text.lines().enumerate() {
            let mut pieces = line.split_whitespace().collect::<Vec<_>>();
            // The trailing ":score" is the last whitespace piece; strip it so we
            // only validate word tokens (the weight is never a vocab token).
            if pieces.last().is_some_and(|last| last.starts_with(':')) {
                pieces.pop();
            }
            eprintln!("  line[{li}]: {line:?}");
            for piece in &pieces {
                let present = vocab.contains(*piece);
                let re_encodable = is_bpe && piece.is_ascii();
                if !present && !re_encodable {
                    any_missing = true;
                }
                let status = if present {
                    "OK".to_string()
                } else if re_encodable {
                    "absent (bpe re-encodes)".to_string()
                } else {
                    "MISSING (OOV)".to_string()
                };
                eprintln!("    token {:<14} -> {status}", format!("{piece:?}"));
            }
        }
        if any_missing {
            eprintln!(
                "  >> WARNING: buf contains OOV CJK tokens — sherpa-onnx will drop these hotwords"
            );
        }
        eprintln!();
    }
}

// ── Empirical: decode with the app's hotwords buf vs. without ──────────────

/// Build the recognizer with the app-generated hotwords buffer and decode a
/// test wav, then compare against decoding with no hotwords. Also reports
/// whether `OnlineRecognizer::create` accepts the buffer (an OOV panic from the
/// C++ side would abort the whole test binary — that itself is a signal).
#[test]
fn zipformer_zh_en_decode_with_hotwords() {
    let (model_dir, entry) = match find_model() {
        Some(x) => x,
        None => {
            eprintln!("SKIP: {MODEL_ID} model not downloaded");
            return;
        }
    };

    let modeling_unit = entry
        .default_config
        .as_ref()
        .and_then(|c| c.get("modeling_unit"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let model_config = entry
        .default_config
        .clone()
        .unwrap_or_else(|| serde_json::json!({}));

    let hotwords = vec![
        "Claude Code".to_string(),
        "流式输出".to_string(),
        "OpenAI".to_string(),
    ];

    let buf = build_online_hotwords_buf(&hotwords, modeling_unit, &model_dir, &entry);

    eprintln!("==========================================================");
    eprintln!("Empirical decode test ({MODEL_ID})");
    match &buf {
        Some(b) => eprintln!("hotwords buf:\n{}", String::from_utf8_lossy(b)),
        None => eprintln!("hotwords buf: None"),
    }
    eprintln!("==========================================================");

    // Decode WITHOUT hotwords (greedy search baseline).
    let rec_plain = build_online_recognizer(&model_dir, &entry, 2, &model_config, None)
        .expect("failed to build recognizer without hotwords");
    let text_plain = decode_full_online(&rec_plain, &fixture("test-audio-short.wav"));
    eprintln!("[no hotwords]    {text_plain:?}");

    // Decode WITH the app-generated hotwords buffer.
    let rec_hw = build_online_recognizer(&model_dir, &entry, 2, &model_config, buf.clone())
        .expect("failed to build recognizer with hotwords");
    let text_hw = decode_full_online(&rec_hw, &fixture("test-audio-short.wav"));
    eprintln!("[with hotwords]  {text_hw:?}");

    // Sanity: recognizer should always produce some output.
    assert!(
        !text_plain.is_empty(),
        "baseline recognition should not be empty"
    );
}

// ── Fix validation: split CJK hotwords into single-char tokens ─────────────

/// Split a CJK hotword into space-separated single characters.
///
/// `cjkchar`-unit tokenizers (including the CJK half of `cjkchar+bpe`) treat
/// each character as a token, so the transducer hotwords buffer must list them
/// individually: `流式输出` → `流 式 输 出`. Whole-word CJK pieces are OOV and
/// silently dropped, which is why the app's current output has no effect.
fn cjk_hotword_line(word: &str, weight: f32) -> String {
    let mut joined = String::new();
    for c in word.chars().filter(|c| !c.is_ascii_punctuation()) {
        if !joined.is_empty() {
            joined.push(' ');
        }
        joined.push(c);
    }
    format!("{joined} :{weight}")
}

/// Explore whether splitting a CJK hotword into single-char tokens (the format
/// `cjkchar`-unit models require) plus a higher score can flip the model's
/// `流逝输出` → `流式输出` misrecognition. The app's current whole-word buf is
/// OOV and has no effect; this test reports the outcome of each candidate
/// format/score on a fixed test clip. Note: on this particular clip the homophone
/// 式/逝 is hard to override even at max score, so a non-flip here does NOT prove
/// the char-split format is wrong — it only shows the score/format trade-off.
/// Run with `--nocapture`.
#[test]
fn zipformer_zh_en_cjk_split_format_exploration() {
    let (model_dir, entry) = match find_model() {
        Some(x) => x,
        None => {
            eprintln!("SKIP: {MODEL_ID} model not downloaded");
            return;
        }
    };

    let model_config = entry
        .default_config
        .clone()
        .unwrap_or_else(|| serde_json::json!({}));

    // The audio says "流式输出"; the model tends to hear "流逝输出" (式 → 逝).
    let target = "流式输出";
    let wav = fixture("test-audio-short.wav");

    eprintln!("==========================================================");
    eprintln!("CJK hotword format exploration (target = {target:?})");
    eprintln!("==========================================================");

    // Baseline: greedy search, no hotwords.
    let rec_plain = build_online_recognizer(&model_dir, &entry, 2, &model_config, None)
        .expect("failed to build recognizer (no hotwords)");
    let text_plain = decode_full_online(&rec_plain, &wav);
    eprintln!("[no hotwords]              {text_plain:?}");

    // Candidate formats / scores.
    let candidates: &[(&str, Vec<u8>)] = &[
        (
            "whole-word @4.0 (app's current output)",
            format!("{target} :4").into_bytes(),
        ),
        (
            "char-split @4.0",
            cjk_hotword_line(target, 4.0).into_bytes(),
        ),
        (
            "char-split @10.0",
            cjk_hotword_line(target, 10.0).into_bytes(),
        ),
    ];

    for (label, buf) in candidates {
        let rec = build_online_recognizer(&model_dir, &entry, 2, &model_config, Some(buf.clone()))
            .expect("failed to build recognizer");
        let text = decode_full_online(&rec, &wav);
        eprintln!("[{label:<34}] {text:?}  contains={}", text.contains(target));
    }
}

/// Feed a full WAV through an `OnlineRecognizer` and return the finalized text.
fn decode_full_online(recognizer: &OnlineRecognizer, wav_path: &Path) -> String {
    let (samples, _rate) = read_wav(wav_path).unwrap_or_default();
    if samples.is_empty() {
        return String::new();
    }

    let stream = recognizer.create_stream();
    // Feed in chunks so the streaming decoder can emit intermediate states.
    for chunk in samples.chunks(3200) {
        stream.accept_waveform(16000, chunk);
        while recognizer.is_ready(&stream) {
            recognizer.decode(&stream);
        }
    }
    // Flush with trailing silence, then a final decode pass.
    let tail: Vec<f32> = vec![0.0; (0.3 * 16000.0) as usize];
    stream.accept_waveform(16000, &tail);
    while recognizer.is_ready(&stream) {
        recognizer.decode(&stream);
    }

    recognizer
        .get_result(&stream)
        .map(|r| r.text.trim().to_string())
        .unwrap_or_default()
}

//! ASR Doubao unit tests — verify binary protocol parsing and utterance/definite
//! splitting logic that drives the overlay text color change:
//! - `definite: true` utterances → white (final_text)
//! - `definite: false` utterances → gray (partial_text)
//!
//! These tests do NOT require network or API keys — they work with hand-crafted
//! binary frames and JSON payloads.

use serde_json::{json, Value};
use std::cell::RefCell;

use crate::config::{AudioConfig, RequestConfig};

// ---------------------------------------------------------------------------
// Binary frame builders (mirrors the Doubao protocol wire format)
// ---------------------------------------------------------------------------

/// Build a 4-byte header matching the Doubao binary protocol.
fn build_header(message_type: u8, flags: u8, serialization: u8, compression: u8) -> [u8; 4] {
    [
        0x11,
        (message_type << 4) | (flags & 0x0f),
        (serialization << 4) | (compression & 0x0f),
        0x00,
    ]
}

/// Encode a result JSON payload into a gzip-compressed binary frame.
fn make_result_frame(payload: &Value) -> Vec<u8> {
    let json_str = serde_json::to_string(payload).unwrap();
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    use std::io::Write;
    encoder.write_all(json_str.as_bytes()).unwrap();
    let compressed = encoder.finish().unwrap();

    let header = build_header(0x01, 0x00, 0x01, 0x01);
    let size = (compressed.len() as u32).to_be_bytes();

    let mut frame = Vec::with_capacity(4 + 4 + compressed.len());
    frame.extend_from_slice(&header);
    frame.extend_from_slice(&size);
    frame.extend_from_slice(&compressed);
    frame
}

/// Encode a raw-text (non-JSON, uncompressed) binary frame.
fn make_raw_text_frame(text: &str) -> Vec<u8> {
    let payload = text.as_bytes();
    // message_type=0x01, serialization=0x01, compression=0x00 (no gzip)
    let header = build_header(0x01, 0x00, 0x01, 0x00);
    let size = (payload.len() as u32).to_be_bytes();

    let mut frame = Vec::with_capacity(4 + 4 + payload.len());
    frame.extend_from_slice(&header);
    frame.extend_from_slice(&size);
    frame.extend_from_slice(payload);
    frame
}

/// Encode an error binary frame (message_type=0x0f).
fn make_error_frame(code: u32, message: &str) -> Vec<u8> {
    let message_bytes = message.as_bytes();
    let header = build_header(0x0f, 0x00, 0x01, 0x00);
    // offset = (0x11 & 0x0f) * 4 = 4
    let code_bytes = code.to_be_bytes();
    let msg_size = (message_bytes.len() as u32).to_be_bytes();

    let mut frame = Vec::with_capacity(4 + 4 + 4 + message_bytes.len());
    frame.extend_from_slice(&header);
    frame.extend_from_slice(&code_bytes);
    frame.extend_from_slice(&msg_size);
    frame.extend_from_slice(message_bytes);
    frame
}

/// Encode an ack frame (message_type=0x09).
fn make_ack_frame(seq: u32, payload: &[u8]) -> Vec<u8> {
    let header = build_header(0x09, 0x00, 0x00, 0x00);
    // offset = 4, then +4 for ack → offset = 8
    let seq_bytes = seq.to_be_bytes();
    let size = (payload.len() as u32).to_be_bytes();

    let mut frame = Vec::with_capacity(8 + 4 + payload.len());
    frame.extend_from_slice(&header);
    // The ack skips 4 bytes via offset += 4, so we need 4 dummy bytes first
    // Actually the parser does: offset = (0x11 & 0x0f)*4 = 4; if ack → offset += 4 = 8
    // Then reads payload_size at offset 8, then payload at offset 12
    frame.extend_from_slice(&seq_bytes); // bytes 4-7 (dummy/seq)
    frame.extend_from_slice(&size); // bytes 8-11
    frame.extend_from_slice(payload); // bytes 12+
    frame
}

// ---------------------------------------------------------------------------
// Utterance splitting logic — exact mirror of the production code in
// doubao.rs lines 611-670
// ---------------------------------------------------------------------------

/// Represents the result of splitting utterances by `definite`.
#[derive(Debug, PartialEq, Eq)]
struct SplitResult {
    final_text: String,
    partial_text: String,
}

/// Split ASR result utterances into final (definite=true) and partial
/// (definite=false) text — mirrors the production tokio::spawn handler.
fn split_utterances_for_display(
    utterances: &[Value],
    result_text: &str,
    committed: bool,
    accumulated_final: &str,
) -> SplitResult {
    let completed: String = utterances
        .iter()
        .filter(|u| u.get("definite").and_then(|v| v.as_bool()).unwrap_or(false))
        .filter_map(|u| u.get("text").and_then(|v| v.as_str()).map(|s| s.trim()))
        .collect::<Vec<&str>>()
        .join("");

    let streaming_partial: String = utterances
        .iter()
        .filter(|u| !u.get("definite").and_then(|v| v.as_bool()).unwrap_or(false))
        .filter_map(|u| u.get("text").and_then(|v| v.as_str()).map(|s| s.trim()))
        .collect::<Vec<&str>>()
        .join("");

    let next_partial = if completed.is_empty() {
        result_text.to_string()
    } else if let Some(rest) = result_text.strip_prefix(&completed) {
        rest.trim().to_string()
    } else {
        streaming_partial
    };

    if committed {
        SplitResult {
            final_text: result_text.to_string(),
            partial_text: String::new(),
        }
    } else {
        let ft = if completed.is_empty() {
            accumulated_final.to_string()
        } else {
            completed.clone()
        };
        SplitResult {
            final_text: ft,
            partial_text: next_partial,
        }
    }
}

// ===========================================================================
// Tests: parse_server_response — binary frame parsing
// ===========================================================================

#[test]
fn parse_result_with_utterances() {
    let payload = json!({
        "result": {
            "text": "你好我是语音助手",
            "utterances": [
                {"text": "你好", "definite": true},
                {"text": "我是语音助手", "definite": false}
            ]
        }
    });
    let frame = make_result_frame(&payload);
    let parsed = crate::asr::doubao::parse_server_response(&frame);

    assert!(parsed.is_some(), "should parse successfully");
    let p = parsed.unwrap();
    let result = p.get("result").unwrap();
    let utterances = result.get("utterances").unwrap().as_array().unwrap();
    assert_eq!(utterances.len(), 2);
    assert_eq!(utterances[0]["text"], "你好");
    assert_eq!(utterances[0]["definite"], true);
    assert_eq!(utterances[1]["text"], "我是语音助手");
    assert_eq!(utterances[1]["definite"], false);
}

#[test]
fn parse_result_with_all_definite() {
    let payload = json!({
        "result": {
            "text": "今天天气不错。",
            "utterances": [
                {"text": "今天天气不错。", "definite": true}
            ]
        }
    });
    let frame = make_result_frame(&payload);
    let parsed = crate::asr::doubao::parse_server_response(&frame);

    let r = parsed.unwrap();
    let utterances = r["result"]["utterances"].as_array().unwrap();
    assert_eq!(utterances.len(), 1);
    assert_eq!(utterances[0]["definite"], true);
}

#[test]
fn parse_result_with_no_utterances() {
    let payload = json!({
        "result": {
            "text": "流式文本内容"
        }
    });
    let frame = make_result_frame(&payload);
    let parsed = crate::asr::doubao::parse_server_response(&frame);

    let r = parsed.unwrap();
    assert_eq!(r["result"]["text"], "流式文本内容");
    assert!(r["result"].get("utterances").is_none());
}

#[test]
fn parse_result_with_empty_utterances() {
    let payload = json!({
        "result": {
            "text": "完整句子",
            "utterances": []
        }
    });
    let frame = make_result_frame(&payload);
    let parsed = crate::asr::doubao::parse_server_response(&frame);

    let r = parsed.unwrap();
    let arr = r["result"]["utterances"].as_array().unwrap();
    assert!(arr.is_empty());
}

#[test]
fn parse_result_with_no_definite_field() {
    // Some server versions may omit the `definite` field entirely.
    let payload = json!({
        "result": {
            "text": "未标记完整性的文本",
            "utterances": [
                {"text": "未标记完整性的文本"}
            ]
        }
    });
    let frame = make_result_frame(&payload);
    let parsed = crate::asr::doubao::parse_server_response(&frame);

    let r = parsed.unwrap();
    let u = &r["result"]["utterances"][0];
    assert!(u.get("definite").is_none());
}

#[test]
fn parse_raw_text_frame() {
    let frame = make_raw_text_frame("原始识别文本");
    let parsed = crate::asr::doubao::parse_server_response(&frame);

    assert!(parsed.is_some());
    let p = parsed.unwrap();
    assert_eq!(p["raw_text"], "原始识别文本");
}

#[test]
fn parse_error_frame() {
    let frame = make_error_frame(45000001, r#"{"message":"invalid parameter"}"#);
    let parsed = crate::asr::doubao::parse_server_response(&frame);

    let p = parsed.unwrap();
    assert_eq!(p["code"], 45000001);
    // Error text is JSON, parse_server_response tries to parse it
    assert!(p.get("message").is_some() || p.get("code").is_some());
}

#[test]
fn parse_error_frame_plain_text() {
    let frame = make_error_frame(20000001, "authentication failed");
    let parsed = crate::asr::doubao::parse_server_response(&frame);

    let p = parsed.unwrap();
    assert_eq!(p["code"], 20000001);
    assert_eq!(p["message"], "authentication failed");
}

#[test]
fn parse_ack_frame_is_none() {
    // Ack frames (message_type 0x09) without result/code/raw_text
    // should produce None or be skipped by the caller.
    // parse_server_response returns a frame — but for 0x09 with empty
    // payload it may return the raw_payload form.
    let frame = make_ack_frame(1, b"");
    let parsed = crate::asr::doubao::parse_server_response(&frame);

    // Ack frame: no serialization/compression, message_type=0x09
    // It will fall through to the else branch (non-JSON) and return raw_payload
    assert!(parsed.is_some());
    let p = parsed.unwrap();
    // The caller (spawn block) checks for result/code/raw_text and skips
    assert!(p.get("result").is_none());
    assert!(p.get("code").is_none());
    assert!(p.get("raw_text").is_none());
}

#[test]
fn parse_buffer_too_short() {
    let short = vec![0u8; 8]; // less than minimum 12 bytes
    let parsed = crate::asr::doubao::parse_server_response(&short);
    assert!(parsed.is_none());
}

#[test]
fn parse_truncated_error_frame() {
    // Error header but not enough data for error code + size
    let mut frame = vec![0x11, 0x0f, 0x00, 0x00]; // message_type = 0x0f
    frame.extend_from_slice(&[0u8; 4]); // only 4 more bytes, need 8
    let parsed = crate::asr::doubao::parse_server_response(&frame);
    assert!(parsed.is_none());
}

// ===========================================================================
// Tests: utterance splitting → final_text / partial_text
// ===========================================================================

#[test]
fn split_mixed_definite_and_streaming() {
    // Simulates mid-speech: one sentence confirmed, one still streaming
    let utterances = json!([
        {"text": "你好。", "definite": true},
        {"text": "今天天气", "definite": false}
    ]);
    let result_text = "你好。今天天气";

    let r = split_utterances_for_display(
        utterances.as_array().unwrap(),
        result_text,
        false, // not committed
        "",    // no accumulated final yet
    );

    // Completed sentence → final (white)
    assert_eq!(r.final_text, "你好。");
    // Streaming part → partial (gray)
    assert_eq!(r.partial_text, "今天天气");
}

#[test]
fn split_all_definite() {
    // Simulates: everything is confirmed
    let utterances = json!([
        {"text": "你好。", "definite": true},
        {"text": "今天天气不错。", "definite": true}
    ]);
    let result_text = "你好。今天天气不错。";

    let r = split_utterances_for_display(utterances.as_array().unwrap(), result_text, false, "");

    assert_eq!(r.final_text, "你好。今天天气不错。");
    assert_eq!(r.partial_text, ""); // nothing streaming → empty partial
}

#[test]
fn split_all_streaming() {
    // Simulates: nothing confirmed yet, all text is streaming
    let utterances = json!([
        {"text": "今天天气怎么", "definite": false}
    ]);
    let result_text = "今天天气怎么";

    let r = split_utterances_for_display(utterances.as_array().unwrap(), result_text, false, "");

    // Nothing definite → final stays empty
    assert_eq!(r.final_text, "");
    // All text is partial → gray
    assert_eq!(r.partial_text, "今天天气怎么");
}

#[test]
fn split_committed_moves_all_to_final() {
    // Simulates: user released hotkey, commit was sent
    let utterances = json!([
        {"text": "你好。", "definite": true},
        {"text": "今天天气", "definite": false}
    ]);
    let result_text = "你好。今天天气";

    let r = split_utterances_for_display(
        utterances.as_array().unwrap(),
        result_text,
        true, // committed
        "",
    );

    // After commit: full result_text → final (white), partial = ""
    assert_eq!(r.final_text, "你好。今天天气");
    assert_eq!(r.partial_text, "");
}

#[test]
fn split_empty_utterances_uses_accumulated() {
    // When no utterances, result_text is treated based on committed flag
    let utterances: Vec<Value> = vec![];
    let result_text = "流式文本";

    let r = split_utterances_for_display(&utterances, result_text, false, "之前已确认的");

    // No utterances + not committed → final keeps accumulated, partial = result_text
    assert_eq!(r.final_text, "之前已确认的");
    assert_eq!(r.partial_text, "流式文本");
}

#[test]
fn split_no_definite_field_treated_as_streaming() {
    // When `definite` is missing, unwrap_or(false) → treated as streaming
    let utterances = json!([
        {"text": "未标记的文本"}
    ]);
    let result_text = "未标记的文本";

    let r = split_utterances_for_display(utterances.as_array().unwrap(), result_text, false, "");

    // No definite=true → final stays empty, all is partial
    assert_eq!(r.final_text, "");
    assert_eq!(r.partial_text, "未标记的文本");
}

#[test]
fn split_definite_false_to_true_transition() {
    // This is THE key test for the color-change behavior.
    //
    // Step 1: first response — utterance is still streaming (gray)
    let u1 = json!([
        {"text": "今天天气真不错", "definite": false}
    ]);
    let r1 = split_utterances_for_display(u1.as_array().unwrap(), "今天天气真不错", false, "");

    assert_eq!(
        r1.final_text, "",
        "step 1: nothing confirmed → no white text"
    );
    assert_eq!(
        r1.partial_text, "今天天气真不错",
        "step 1: all text is gray"
    );

    // Step 2: server confirms the utterance → definite flips to true
    let u2 = json!([
        {"text": "今天天气真不错", "definite": true},
        {"text": "适合出去玩", "definite": false}
    ]);
    let r2 = split_utterances_for_display(
        u2.as_array().unwrap(),
        "今天天气真不错适合出去玩",
        false,
        "今天天气真不错", // accumulated from previous final
    );

    assert_eq!(
        r2.final_text, "今天天气真不错",
        "step 2: confirmed text is now white"
    );
    assert_eq!(
        r2.partial_text, "适合出去玩",
        "step 2: new streaming text is gray"
    );
}

#[test]
fn split_multiple_definite_accumulate() {
    // Sentences accumulate as they become definite
    let utterances = json!([
        {"text": "第一句。", "definite": true},
        {"text": "第二句。", "definite": true},
        {"text": "第三句还没", "definite": false}
    ]);
    let result_text = "第一句。第二句。第三句还没";

    let r = split_utterances_for_display(utterances.as_array().unwrap(), result_text, false, "");

    assert_eq!(r.final_text, "第一句。第二句。"); // white
    assert_eq!(r.partial_text, "第三句还没"); // gray
}

#[test]
fn split_result_text_prefix_stripping() {
    // When result.text = completed + rest, rest is used as partial
    let utterances = json!([
        {"text": "确认部分", "definite": true},
        {"text": "流式部分", "definite": false}
    ]);
    let result_text = "确认部分流式部分";

    let r = split_utterances_for_display(utterances.as_array().unwrap(), result_text, false, "");

    assert_eq!(r.final_text, "确认部分");
    assert_eq!(r.partial_text, "流式部分");
}

#[test]
fn split_result_text_mismatch_fallback() {
    // When result.text does NOT start with the completed text
    // (e.g., server rewrote text due to nostream), fall back to
    // the streaming_partial built from non-definite utterances.
    let utterances = json!([
        {"text": "原始确认文本", "definite": true},
        {"text": "追加内容", "definite": false}
    ]);
    // result.text differs from what utterances contain
    let result_text = "服务器重写的完整文本不同";

    let r = split_utterances_for_display(utterances.as_array().unwrap(), result_text, false, "");

    // completed = "原始确认文本", but result_text doesn't start with it
    // → fallback: streaming_partial = "追加内容"
    assert_eq!(r.final_text, "原始确认文本");
    assert_eq!(r.partial_text, "追加内容");
}

// ===========================================================================
// Tests: round-trip — binary frame → JSON → utterance split
// ===========================================================================

#[test]
fn roundtrip_frame_to_split() {
    // Full integration of parse → split, simulating a real server response.
    let payload = json!({
        "result": {
            "text": "你好世界今天天气不错",
            "utterances": [
                {"text": "你好世界", "definite": true},
                {"text": "今天天气不错", "definite": false}
            ]
        }
    });
    let frame = make_result_frame(&payload);
    let parsed = crate::asr::doubao::parse_server_response(&frame).unwrap();

    let result = &parsed["result"];
    let result_text = result["text"].as_str().unwrap();
    let utterances = result["utterances"].as_array().unwrap();

    let r = split_utterances_for_display(utterances, result_text, false, "");

    assert_eq!(r.final_text, "你好世界");
    assert_eq!(r.partial_text, "今天天气不错");
}

#[test]
fn roundtrip_color_change_simulation() {
    // Simulates the complete color-change flow across 3 server responses.
    let accumulated_final = RefCell::new(String::new());

    // --- Frame 1: first partial result ---
    let p1 = json!({
        "result": {
            "text": "大家",
            "utterances": [{"text": "大家", "definite": false}]
        }
    });
    let f1 = make_result_frame(&p1);
    let r1_raw = crate::asr::doubao::parse_server_response(&f1).unwrap();
    let u1 = r1_raw["result"]["utterances"].as_array().unwrap();
    let s1 = split_utterances_for_display(
        u1,
        r1_raw["result"]["text"].as_str().unwrap(),
        false,
        &accumulated_final.borrow(),
    );
    assert_eq!(s1.final_text, "", "frame 1: no white text");
    assert_eq!(s1.partial_text, "大家", "frame 1: '大家' is gray");

    // --- Frame 2: more streaming, still no definite ---
    let p2 = json!({
        "result": {
            "text": "大家好我是",
            "utterances": [{"text": "大家好我是", "definite": false}]
        }
    });
    let f2 = make_result_frame(&p2);
    let r2_raw = crate::asr::doubao::parse_server_response(&f2).unwrap();
    let u2 = r2_raw["result"]["utterances"].as_array().unwrap();
    let s2 = split_utterances_for_display(
        u2,
        r2_raw["result"]["text"].as_str().unwrap(),
        false,
        &accumulated_final.borrow(),
    );
    assert_eq!(s2.final_text, "", "frame 2: still no white text");
    assert_eq!(s2.partial_text, "大家好我是", "frame 2: all gray");

    // --- Frame 3: first utterance confirmed! ---
    *accumulated_final.borrow_mut() = s2.final_text.clone();
    let p3 = json!({
        "result": {
            "text": "大家好我是语音助手",
            "utterances": [
                {"text": "大家好我是语音助手", "definite": true}
            ]
        }
    });
    let f3 = make_result_frame(&p3);
    let r3_raw = crate::asr::doubao::parse_server_response(&f3).unwrap();
    let u3 = r3_raw["result"]["utterances"].as_array().unwrap();
    let s3 = split_utterances_for_display(
        u3,
        r3_raw["result"]["text"].as_str().unwrap(),
        false,
        &accumulated_final.borrow(),
    );
    assert_eq!(
        s3.final_text, "大家好我是语音助手",
        "frame 3: confirmed → white"
    );
    assert_eq!(s3.partial_text, "", "frame 3: nothing streaming → no gray");
}

#[test]
fn roundtrip_raw_text_without_utterances() {
    // raw_text path (no JSON result, plain text) — used when
    // show_utterances is disabled or server sends legacy format.
    let frame = make_raw_text_frame("流式识别的原始文本");
    let parsed = crate::asr::doubao::parse_server_response(&frame).unwrap();

    let raw = parsed["raw_text"].as_str().unwrap();
    // In raw_text mode: not committed → partial_text = raw, final = accumulated
    // After commit → final_text = raw, partial = ""
    assert_eq!(raw, "流式识别的原始文本");
}

#[test]
fn result_text_empty_utterances_present() {
    // Edge case: result.text could be empty string while utterances exist
    let payload = json!({
        "result": {
            "text": "",
            "utterances": [
                {"text": "", "definite": true}
            ]
        }
    });
    let frame = make_result_frame(&payload);
    let parsed = crate::asr::doubao::parse_server_response(&frame);

    // Should parse without panic
    assert!(parsed.is_some());
    let p = parsed.unwrap();
    assert_eq!(p["result"]["text"], "");
}

// ===========================================================================
// Tests: build_api_request_body — verify critical fields in the request payload
// ===========================================================================

fn make_audio_config() -> AudioConfig {
    AudioConfig {
        format: "pcm".into(),
        rate: 16000,
        bits: 16,
        channel: 1,
    }
}

fn make_request_config() -> RequestConfig {
    RequestConfig {
        model_name: "bigmodel".into(),
        model_version: "400".into(),
        operation: "submit".into(),
        sequence: 0,
        language: None,
        enable_itn: true,
        enable_punc: true,
        enable_ddc: true,
        show_utterances: true,
        result_type: "full".into(),
        end_window_size: None,
        force_to_speech_time: None,
        accelerate_score: Some(10),
        vad_segment_duration: None,
        enable_nonstream: Some(false),
        enable_accelerate_text: Some(true),
        ssd_version: None,
        output_zh_variant: None,
        corpus: None,
    }
}

#[test]
fn request_ssd_version_emitted_when_set() {
    let mut cfg = make_request_config();
    cfg.ssd_version = Some("200".into());
    let body = crate::asr::doubao::build_api_request_body(&make_audio_config(), &cfg, &[]);
    let req = body.get("request").unwrap();
    assert_eq!(req.get("ssd_version").and_then(|v| v.as_str()), Some("200"));
}

#[test]
fn request_ssd_version_omitted_when_unset() {
    let body = crate::asr::doubao::build_api_request_body(
        &make_audio_config(),
        &make_request_config(),
        &[],
    );
    let req = body.get("request").unwrap();
    assert!(req.get("ssd_version").is_none());
}

#[test]
fn request_output_zh_variant_off_is_omitted() {
    let mut cfg = make_request_config();
    cfg.output_zh_variant = Some("off".into());
    let body = crate::asr::doubao::build_api_request_body(&make_audio_config(), &cfg, &[]);
    let req = body.get("request").unwrap();
    assert!(req.get("output_zh_variant").is_none());
}

#[test]
fn request_output_zh_variant_traditional_emitted() {
    let mut cfg = make_request_config();
    cfg.output_zh_variant = Some("traditional".into());
    let body = crate::asr::doubao::build_api_request_body(&make_audio_config(), &cfg, &[]);
    let req = body.get("request").unwrap();
    assert_eq!(
        req.get("output_zh_variant").and_then(|v| v.as_str()),
        Some("traditional")
    );
}

#[test]
fn request_show_utterances_true() {
    let body = crate::asr::doubao::build_api_request_body(
        &make_audio_config(),
        &make_request_config(),
        &[],
    );
    let req = body.get("request").unwrap();
    assert_eq!(
        req.get("show_utterances").and_then(|v| v.as_bool()),
        Some(true)
    );
}

#[test]
fn request_structure_and_key_fields() {
    let body = crate::asr::doubao::build_api_request_body(
        &make_audio_config(),
        &make_request_config(),
        &[],
    );

    // Top-level sections
    let user = body.get("user").unwrap();
    let audio = body.get("audio").unwrap();
    let req = body.get("request").unwrap();

    // User identity
    assert!(user
        .get("uid")
        .and_then(|v| v.as_str())
        .is_some_and(|s| !s.is_empty()));
    assert_eq!(
        user.get("did").and_then(|v| v.as_str()),
        Some("tauri_desktop")
    );

    // Audio config
    assert_eq!(audio.get("format").and_then(|v| v.as_str()), Some("pcm"));
    assert_eq!(audio.get("rate").and_then(|v| v.as_u64()), Some(16000));

    // Request key fields
    assert_eq!(
        req.get("model_name").and_then(|v| v.as_str()),
        Some("bigmodel")
    );
    assert_eq!(
        req.get("result_type").and_then(|v| v.as_str()),
        Some("full")
    );
    assert_eq!(req.get("enable_itn").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(req.get("enable_punc").and_then(|v| v.as_bool()), Some(true));
}

#[test]
fn request_with_hotwords_includes_corpus() {
    let body = crate::asr::doubao::build_api_request_body(
        &make_audio_config(),
        &make_request_config(),
        &["Claude Code".to_string(), "OpenAI".to_string()],
    );
    let corpus = body["request"]["corpus"]
        .as_object()
        .expect("corpus should be present");
    let ctx: Value = serde_json::from_str(corpus["context"].as_str().unwrap()).unwrap();
    let hw = ctx["hotwords"].as_array().unwrap();
    assert_eq!(hw.len(), 2);
    assert_eq!(hw[0]["word"], "Claude Code");
    assert_eq!(hw[1]["word"], "OpenAI");
}

//! StepFun StepAudio ASR engine (HTTP + SSE, one-shot submission).
//!
//! Unlike the streaming Doubao WebSocket engine, this engine submits the entire
//! recording in a single HTTP POST once the user stops, then reads the final
//! transcript from the SSE response. Audio chunks arriving via `append_audio`
//! are buffered until `commit_and_await_final` flushes them in one request. No
//! partial results are produced during recording — the protocol is one-shot, not
//! real-time streaming.

use async_trait::async_trait;
use base64::Engine;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

use super::{AsrEngine, AsrEvent, AsrSession};
use crate::config::StepFunConfig;

/// Convert f32 samples (16kHz mono, [-1.0, 1.0]) to little-endian s16 PCM bytes.
fn pcm_s16le_bytes(samples: &[f32]) -> Vec<u8> {
    samples
        .iter()
        .map(|&s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
        .flat_map(|s| s.to_le_bytes())
        .collect()
}

/// Build the StepFun SSE request body from base64-encoded PCM and config.
fn build_request_body(audio_b64: &str, config: &StepFunConfig, hotwords: &[String]) -> Value {
    // Hotwords may carry a "|weight" suffix from the library; StepFun expects
    // plain words, so strip the weight before sending.
    let clean_hotwords: Vec<String> = hotwords
        .iter()
        .map(|w| crate::hotword::strip_weight(w).to_string())
        .filter(|w| !w.is_empty())
        .collect();
    json!({
        "audio": {
            "data": audio_b64,
            "input": {
                "transcription": {
                    "language": config.language,
                    "hotwords": clean_hotwords,
                    "model": config.model,
                    "enable_itn": config.enable_itn,
                    "enable_timestamp": config.enable_timestamp,
                },
                "format": {
                    "type": "pcm",
                    "codec": "pcm_s16le",
                    "rate": config.rate,
                    "bits": config.bits,
                    "channel": config.channel,
                }
            }
        }
    })
}

/// Normalize transport/HTTP errors into user-friendly messages.
fn normalize_error(error: &str) -> String {
    if error.contains("401") || error.contains("403") {
        return "StepFun ASR 鉴权失败，请检查 API Key".to_string();
    }
    if error.contains("ENOTFOUND") || error.contains("ECONNREFUSED") {
        return "StepFun ASR 网络连接失败".to_string();
    }
    error.to_string()
}

/// Parse one SSE event block (the text between two `\n\n` separators).
///
/// Returns `Ok(Some(text))` for the final `transcript.text.done` event,
/// `Ok(None)` for delta/ignored events, or `Err` for an `error` event / bad JSON.
fn parse_sse_event(event_str: &str) -> Result<Option<String>, String> {
    let data: String = event_str
        .lines()
        .filter_map(|line| line.strip_prefix("data:").map(str::trim))
        .collect::<Vec<_>>()
        .join("\n");
    if data.is_empty() {
        return Ok(None);
    }
    let value: Value =
        serde_json::from_str(&data).map_err(|e| format!("SSE 数据解析失败: {}", e))?;
    match value.get("type").and_then(|t| t.as_str()) {
        Some("transcript.text.done") => {
            let text = value
                .get("text")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            Ok(Some(text))
        }
        Some("error") => {
            let msg = value
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("StepFun ASR 识别失败");
            Err(normalize_error(msg))
        }
        // Delta and any other event types are ignored — the engine is one-shot
        // and only the final transcript matters.
        _ => Ok(None),
    }
}

/// Read the SSE byte stream, returning the final transcript from the `done` event.
async fn parse_sse_stream(response: reqwest::Response) -> Result<String, String> {
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("SSE 读取失败: {}", e))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        // Events are separated by a blank line. Process every complete event now
        // in case several arrived within one chunk.
        while let Some(idx) = buffer.find("\n\n") {
            let event: String = buffer.drain(..idx + 2).collect();
            let event = event.trim_end_matches("\n\n");
            // Log every SSE event (including deltas) with its content so
            // upload-vs-recognition latency can be diagnosed from timestamps.
            log_asr!(debug, "StepFun ASR event: {}", event);
            if let Some(text) = parse_sse_event(event)? {
                return Ok(text);
            }
        }
    }
    Err("StepFun ASR 未返回最终结果".to_string())
}

// ---------------------------------------------------------------------------
// StepFunEngine — AsrEngine implementation
// ---------------------------------------------------------------------------

/// StepFun (Step) ASR engine using HTTP + SSE with one-shot audio submission.
pub struct StepFunEngine {
    config: StepFunConfig,
}

impl StepFunEngine {
    pub fn new(config: StepFunConfig) -> Self {
        Self { config }
    }
}

#[async_trait]
impl AsrEngine for StepFunEngine {
    async fn create_session(
        &self,
        hotwords: &[String],
    ) -> Result<(Box<dyn AsrSession>, mpsc::UnboundedReceiver<AsrEvent>), String> {
        if self.config.url.trim().is_empty() {
            return Err(
                "语音识别模型还未配置，缺少 audio.stepfun-stepaudio-2.5-asr.url".to_string(),
            );
        }
        if self.config.api_key.trim().is_empty() {
            return Err(
                "语音识别模型还未配置，缺少 audio.stepfun-stepaudio-2.5-asr.api_key".to_string(),
            );
        }

        let (event_tx, event_rx) = mpsc::unbounded_channel::<AsrEvent>();

        let session = StepFunSession {
            is_ready: Arc::new(AtomicBool::new(true)),
            is_committed: Arc::new(AtomicBool::new(false)),
            audio_buffer: Arc::new(Mutex::new(Vec::<f32>::new())),
            config: Arc::new(self.config.clone()),
            hotwords: hotwords.to_vec(),
        };

        // HTTP is stateless: the session is ready immediately. No partial results
        // are produced during recording (the engine is one-shot, not streaming).
        let _ = event_tx.send(AsrEvent::Open);
        Ok((Box::new(session), event_rx))
    }
}

// ---------------------------------------------------------------------------
// StepFunSession — AsrSession implementation
// ---------------------------------------------------------------------------

struct StepFunSession {
    is_ready: Arc<AtomicBool>,
    is_committed: Arc<AtomicBool>,
    audio_buffer: Arc<Mutex<Vec<f32>>>,
    config: Arc<StepFunConfig>,
    hotwords: Vec<String>,
}

#[async_trait]
impl AsrSession for StepFunSession {
    fn is_ready(&self) -> bool {
        self.is_ready.load(Ordering::SeqCst)
    }

    fn append_audio(&self, samples: &[f32]) {
        if !self.is_ready() || self.is_committed.load(Ordering::SeqCst) {
            return;
        }
        if let Ok(mut buffer) = self.audio_buffer.lock() {
            buffer.extend_from_slice(samples);
        }
    }

    async fn commit_and_await_final(&self) -> Result<String, String> {
        if !self.is_ready() {
            return Err("ASR 会话已关闭".to_string());
        }
        if self.is_committed.load(Ordering::SeqCst) {
            return Err("录音已结束".to_string());
        }
        self.is_committed.store(true, Ordering::SeqCst);

        // Drain the whole recording in one shot.
        let samples: Vec<f32> = self
            .audio_buffer
            .lock()
            .map_err(|_| "ASR 音频缓冲状态异常".to_string())?
            .clone();

        let pcm = pcm_s16le_bytes(&samples);
        let audio_b64 = base64::engine::general_purpose::STANDARD.encode(&pcm);
        let body = build_request_body(&audio_b64, &self.config, &self.hotwords);

        let audio_seconds = samples.len() as f32 / 16000.0;
        log_asr!(
            info,
            "StepFun ASR submit: {} samples (~{:.1}s), {} bytes PCM, {} bytes base64",
            samples.len(),
            audio_seconds,
            pcm.len(),
            audio_b64.len()
        );
        // Print the REAL request body (audio.data masked) so the structure can be
        // compared directly against the protocol doc.
        let mut debug_body = body.clone();
        debug_body["audio"]["data"] = json!(format!("<base64, {} bytes>", audio_b64.len()));
        log_asr!(
            debug,
            "StepFun ASR request body: {}",
            serde_json::to_string(&debug_body).unwrap_or_default()
        );

        // Timeout scales with audio length: uploading a 1.3 MB+ base64 body plus
        // recognition can exceed a flat 60 s for long recordings.
        let timeout = Duration::from_secs(((audio_seconds * 3.0 + 30.0).max(60.0) as u64).min(300));

        let client = reqwest::Client::builder()
            .build()
            .map_err(|e| format!("HTTP client 构建失败: {}", e))?;
        let request = client
            .post(self.config.url.trim())
            .header(
                "Authorization",
                format!("Bearer {}", self.config.api_key.trim()),
            )
            .header("Accept", "text/event-stream")
            .json(&body);

        let outcome = tokio::time::timeout(timeout, async move {
            log_asr!(debug, "StepFun ASR sending request (uploading body)...");
            let response = request
                .send()
                .await
                .map_err(|e| normalize_error(&e.to_string()))?;
            log_asr!(debug, "StepFun ASR response headers received (upload done)");
            let status = response.status();
            if !status.is_success() {
                let code = status.as_u16();
                let text = response.text().await.unwrap_or_default();
                return Err(normalize_error(&format!("{code} {text}")));
            }
            parse_sse_stream(response).await
        })
        .await;

        self.is_ready.store(false, Ordering::SeqCst);
        match outcome {
            Ok(inner) => {
                log_asr!(info, "StepFun ASR done");
                inner
            }
            Err(_) => Err(format!(
                "StepFun ASR 识别超时（音频 {:.1}s，超时上限 {}s）",
                audio_seconds,
                timeout.as_secs()
            )),
        }
    }

    fn close(&self) {
        self.is_ready.store(false, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::StepFunConfig;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn test_config(url: String) -> StepFunConfig {
        StepFunConfig {
            url,
            api_key: "test-key".to_string(),
            model: "stepaudio-2.5-asr".to_string(),
            language: "zh".to_string(),
            enable_itn: true,
            enable_timestamp: false,
            rate: 16000,
            bits: 16,
            channel: 1,
        }
    }

    #[test]
    fn pcm_conversion_values() {
        let bytes = pcm_s16le_bytes(&[0.0, 1.0, -1.0, 0.5]);
        assert_eq!(bytes.len(), 8); // 4 samples × 2 bytes
        assert_eq!(i16::from_le_bytes([bytes[0], bytes[1]]), 0);
        assert_eq!(i16::from_le_bytes([bytes[2], bytes[3]]), 32767);
        assert_eq!(i16::from_le_bytes([bytes[4], bytes[5]]), -32767);
        assert_eq!(i16::from_le_bytes([bytes[6], bytes[7]]), 16383);
    }

    #[test]
    fn request_body_structure() {
        let config = test_config("https://example.com".to_string());
        let body = build_request_body("QWxwaGE=", &config, &["热词".to_string()]);
        assert_eq!(body["audio"]["data"], "QWxwaGE=");
        assert_eq!(
            body["audio"]["input"]["transcription"]["model"],
            "stepaudio-2.5-asr"
        );
        assert_eq!(body["audio"]["input"]["transcription"]["language"], "zh");
        assert_eq!(
            body["audio"]["input"]["transcription"]["hotwords"][0],
            "热词"
        );
        assert_eq!(body["audio"]["input"]["format"]["codec"], "pcm_s16le");
        assert_eq!(body["audio"]["input"]["format"]["rate"], 16000);
    }

    #[test]
    fn request_body_strips_hotword_weight() {
        let config = test_config("https://example.com".to_string());
        let body = build_request_body(
            "AA==",
            &config,
            &["Claude Code|10".to_string(), "流式".to_string()],
        );
        let hotwords = body["audio"]["input"]["transcription"]["hotwords"]
            .as_array()
            .unwrap();
        assert_eq!(hotwords.len(), 2);
        assert_eq!(hotwords[0], "Claude Code");
        assert_eq!(hotwords[1], "流式");
    }

    #[test]
    fn parse_done_event_returns_text() {
        let event = "data: {\"type\":\"transcript.text.done\",\"text\":\"你好\"}";
        assert_eq!(parse_sse_event(event).unwrap(), Some("你好".to_string()));
    }

    #[test]
    fn parse_delta_event_is_ignored() {
        let event = "data: {\"type\":\"transcript.text.delta\",\"delta\":\"你\"}";
        assert_eq!(parse_sse_event(event).unwrap(), None);
    }

    #[test]
    fn parse_error_event_returns_err() {
        let event = "data: {\"type\":\"error\",\"message\":\"boom\"}";
        assert!(parse_sse_event(event).is_err());
    }

    #[test]
    fn normalize_auth_and_network_errors() {
        assert!(normalize_error("401 unauthorized").contains("鉴权"));
        assert!(normalize_error("403 forbidden").contains("鉴权"));
        assert!(normalize_error("dns error: ENOTFOUND").contains("网络连接"));
        assert_eq!(normalize_error("something else"), "something else");
    }

    #[tokio::test]
    async fn commit_returns_done_text_ignoring_delta() {
        let server = MockServer::start().await;
        let sse = "data: {\"type\":\"transcript.text.delta\",\"delta\":\"局部\"}\n\n\
                   data: {\"type\":\"transcript.text.done\",\"text\":\"最终文字\"}\n\n";
        Mock::given(method("POST"))
            .and(path("/"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(sse),
            )
            .mount(&server)
            .await;

        let engine = StepFunEngine::new(test_config(server.uri()));
        let (session, _rx) = engine.create_session(&[]).await.unwrap();
        session.append_audio(&[0.0, 0.1, 0.2]);
        let text = session.commit_and_await_final().await.unwrap();
        assert_eq!(text, "最终文字");
    }

    #[tokio::test]
    async fn commit_surfaces_error_event() {
        let server = MockServer::start().await;
        let sse = "data: {\"type\":\"error\",\"message\":\"识别失败\"}\n\n";
        Mock::given(method("POST"))
            .and(path("/"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(sse),
            )
            .mount(&server)
            .await;

        let engine = StepFunEngine::new(test_config(server.uri()));
        let (session, _rx) = engine.create_session(&[]).await.unwrap();
        session.append_audio(&[0.0]);
        let err = session.commit_and_await_final().await.unwrap_err();
        assert!(err.contains("识别失败"));
    }

    #[tokio::test]
    async fn commit_normalizes_http_401() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
            .mount(&server)
            .await;

        let engine = StepFunEngine::new(test_config(server.uri()));
        let (session, _rx) = engine.create_session(&[]).await.unwrap();
        session.append_audio(&[0.0]);
        let err = session.commit_and_await_final().await.unwrap_err();
        assert!(err.contains("鉴权"));
    }
}

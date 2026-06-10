use async_trait::async_trait;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
    MaybeTlsStream, WebSocketStream,
};
use uuid::Uuid;

use super::{AsrEngine, AsrEvent, AsrSession};
use crate::config::{AudioConfig, ConnectionConfig, RequestConfig};

// ---------------------------------------------------------------------------
// Binary protocol helpers
// ---------------------------------------------------------------------------

/// Build the 4-byte binary header for the Doubao ASR protocol.
fn build_header(message_type: u8, flags: u8, serialization: u8, compression: u8) -> [u8; 4] {
    [
        0x11,
        (message_type << 4) | (flags & 0x0f),
        (serialization << 4) | (compression & 0x0f),
        0x00,
    ]
}

/// Encode a full client request (initial message with JSON payload, gzip compressed).
fn encode_full_client_request(payload: &Value) -> Vec<u8> {
    let json_str = serde_json::to_string(payload).unwrap_or_default();
    let payload_bytes = json_str.as_bytes();

    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    use std::io::Write;
    encoder.write_all(payload_bytes).unwrap();
    let gzipped = encoder.finish().unwrap_or_default();

    let header = build_header(0x01, 0x00, 0x01, 0x01);
    let payload_size = (gzipped.len() as u32).to_be_bytes();

    let mut result = Vec::with_capacity(4 + 4 + gzipped.len());
    result.extend_from_slice(&header);
    result.extend_from_slice(&payload_size);
    result.extend_from_slice(&gzipped);
    result
}

/// Encode an audio-only request (raw PCM data, no compression).
fn encode_audio_only_request(audio: &[u8], is_last: bool) -> Vec<u8> {
    let flags: u8 = if is_last { 0x02 } else { 0x00 };
    let header = build_header(0x02, flags, 0x00, 0x00);
    let payload_size = (audio.len() as u32).to_be_bytes();

    let mut result = Vec::with_capacity(4 + 4 + audio.len());
    result.extend_from_slice(&header);
    result.extend_from_slice(&payload_size);
    result.extend_from_slice(audio);
    result
}

/// Parse a binary server response frame.
fn parse_server_response(buffer: &[u8]) -> Option<Value> {
    if buffer.len() < 12 {
        return None;
    }

    let header_byte0 = buffer[0];
    let header_byte1 = buffer[1];
    let header_byte2 = buffer[2];
    let message_type = (header_byte1 >> 4) & 0x0f;
    let message_flags = header_byte1 & 0x0f;
    let mut offset = ((header_byte0 & 0x0f) as usize) * 4;

    // Error message type
    if message_type == 0x0f {
        if buffer.len() < offset + 8 {
            return None;
        }

        let error_code = u32::from_be_bytes([
            buffer[offset],
            buffer[offset + 1],
            buffer[offset + 2],
            buffer[offset + 3],
        ]);
        offset += 4;
        let error_size = u32::from_be_bytes([
            buffer[offset],
            buffer[offset + 1],
            buffer[offset + 2],
            buffer[offset + 3],
        ]);
        offset += 4;

        if buffer.len() < offset + error_size as usize {
            return None;
        }

        let error_text = String::from_utf8_lossy(&buffer[offset..offset + error_size as usize])
            .trim()
            .to_string();

        return match serde_json::from_str::<Value>(&error_text) {
            Ok(mut parsed) => {
                parsed.as_object_mut().map(|obj| {
                    obj.insert("code".to_string(), json!(error_code));
                });
                Some(parsed)
            }
            Err(_) => Some(json!({
                "code": error_code,
                "message": error_text,
            })),
        };
    }

    // Ack message type
    if message_type == 0x09 {
        offset += 4;
    } else if message_flags == 0x01 || message_flags == 0x03 {
        offset += 4;
    }

    if buffer.len() < offset + 4 {
        return None;
    }

    let payload_size = u32::from_be_bytes([
        buffer[offset],
        buffer[offset + 1],
        buffer[offset + 2],
        buffer[offset + 3],
    ]);
    offset += 4;

    if buffer.len() < offset + payload_size as usize {
        return None;
    }

    let compression = header_byte2 & 0x0f;
    let serialization = (header_byte2 >> 4) & 0x0f;
    let payload_data = &buffer[offset..offset + payload_size as usize];

    let payload = if compression == 0x01 {
        let mut decoder = GzDecoder::new(payload_data);
        let mut decompressed = Vec::new();
        use std::io::Read;
        if decoder.read_to_end(&mut decompressed).is_ok() {
            decompressed
        } else {
            payload_data.to_vec()
        }
    } else {
        payload_data.to_vec()
    };

    if serialization == 0x01 {
        let text = String::from_utf8_lossy(&payload).trim().to_string();
        if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
            return Some(parsed);
        }

        // Try to extract JSON from the text
        if let Some(start) = text.find('{') {
            if let Some(end) = text.rfind('}') {
                if end > start {
                    if let Ok(parsed) = serde_json::from_str::<Value>(&text[start..=end]) {
                        return Some(parsed);
                    }
                }
            }
        }

        Some(json!({ "raw_text": text }))
    } else {
        Some(json!({
            "messageType": message_type,
            "messageFlags": message_flags,
            "raw_payload": format!("[{} bytes]", payload.len()),
        }))
    }
}

// ---------------------------------------------------------------------------
// Request building helpers
// ---------------------------------------------------------------------------

/// Check if a YAML value is effectively empty.
fn is_empty_yaml_value(value: &serde_norway::Value) -> bool {
    match value {
        serde_norway::Value::Null => true,
        serde_norway::Value::String(text) => text.trim().is_empty(),
        serde_norway::Value::Sequence(items) => items.is_empty(),
        serde_norway::Value::Mapping(items) => items.is_empty(),
        _ => false,
    }
}

fn parse_context_hotwords(value: &serde_norway::Value) -> Vec<Value> {
    match value {
        serde_norway::Value::String(text) => text
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(|word| json!({ "word": word }))
            .collect(),
        serde_norway::Value::Sequence(items) => items
            .iter()
            .filter_map(|item| {
                if let Some(word) = item.as_str().map(str::trim).filter(|word| !word.is_empty()) {
                    return Some(json!({ "word": word }));
                }
                let word = item
                    .as_mapping()
                    .and_then(|map| map.get(serde_norway::Value::String("word".to_string())))
                    .and_then(|word| word.as_str())
                    .map(str::trim)
                    .filter(|word| !word.is_empty())?;
                Some(json!({ "word": word }))
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn build_api_request_body(audio_config: &AudioConfig, request_config: &RequestConfig) -> Value {
    let mut audio = serde_json::Map::new();
    audio.insert("format".to_string(), json!(audio_config.format));
    audio.insert("rate".to_string(), json!(audio_config.rate));
    audio.insert("bits".to_string(), json!(audio_config.bits));
    audio.insert("channel".to_string(), json!(audio_config.channel));

    let mut request = serde_json::Map::new();
    request.insert("model_name".to_string(), json!(request_config.model_name));
    request.insert(
        "model_version".to_string(),
        json!(request_config.model_version),
    );
    request.insert("operation".to_string(), json!(request_config.operation));
    request.insert("sequence".to_string(), json!(request_config.sequence));
    request.insert("enable_itn".to_string(), json!(request_config.enable_itn));
    request.insert("enable_punc".to_string(), json!(request_config.enable_punc));
    request.insert("enable_ddc".to_string(), json!(request_config.enable_ddc));
    request.insert(
        "show_utterances".to_string(),
        json!(request_config.show_utterances),
    );
    request.insert("result_type".to_string(), json!(request_config.result_type));

    if let Some(v) = request_config.end_window_size {
        request.insert("end_window_size".to_string(), json!(v));
    }
    if let Some(v) = request_config.force_to_speech_time {
        request.insert("force_to_speech_time".to_string(), json!(v));
    }
    if let Some(v) = request_config.accelerate_score {
        request.insert("accelerate_score".to_string(), json!(v));
    }
    if let Some(v) = request_config.vad_segment_duration {
        request.insert("vad_segment_duration".to_string(), json!(v));
    }
    if let Some(v) = request_config.enable_nonstream {
        request.insert("enable_nonstream".to_string(), json!(v));
    }
    if let Some(v) = request_config.enable_accelerate_text {
        request.insert("enable_accelerate_text".to_string(), json!(v));
    }
    if let Some(corpus_value) = &request_config.corpus {
        if let Some(corpus) = corpus_value.as_mapping() {
            let mut corpus_json = serde_json::Map::new();
            let mut context_hotwords = Vec::new();

            for (key, value) in corpus {
                let Some(key) = key.as_str() else {
                    continue;
                };
                if key == "context_hotwords" {
                    context_hotwords = parse_context_hotwords(value);
                    continue;
                }
                if is_empty_yaml_value(value) {
                    continue;
                }
                if let Ok(json_value) = serde_json::to_value(value) {
                    if !json_value.is_null() {
                        corpus_json.insert(key.to_string(), json_value);
                    }
                }
            }

            if !context_hotwords.is_empty() {
                corpus_json.insert(
                    "context".to_string(),
                    json!(serde_json::json!({ "hotwords": context_hotwords }).to_string()),
                );
            }

            if !corpus_json.is_empty() {
                request.insert("corpus".to_string(), Value::Object(corpus_json));
            }
        }
    }

    json!({
        "user": {
            "uid": format!("voice_overlay_{}", Uuid::new_v4()),
            "did": "tauri_desktop",
            "platform": if cfg!(target_os = "macos") { "macOS/Tauri" } else { "Windows/Tauri" },
            "sdk_version": "0.1.0",
            "app_version": "0.1.0",
        },
        "audio": audio,
        "request": request,
    })
}

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

/// Clean ASR text: remove extra spaces between CJK characters.
fn clean_asr_text(text: &str) -> String {
    let re = regex::Regex::new(r"([\u{4e00}-\u{9fa5}])\s+([\u{4e00}-\u{9fa5}])").unwrap();
    let mut result = text.to_string();
    loop {
        let next = re.replace_all(&result, "$1$2").to_string();
        if next == result {
            break;
        }
        result = next;
    }
    result
}

/// Check if raw ASR text should be ignored (empty, UUID, or connect ID).
fn is_ignorable_raw_text(text: &str, connect_id: &str) -> bool {
    let normalized = text.trim();
    if normalized.is_empty() {
        return true;
    }
    if normalized == connect_id {
        return true;
    }
    // UUID pattern check
    if Uuid::parse_str(normalized).is_ok() {
        return true;
    }
    false
}

fn normalize_error_message(error: &str) -> String {
    if error.contains("401") || error.contains("403") {
        return "ASR 鉴权失败，请检查 AppID / Token / Resource ID".to_string();
    }
    if error.contains("ENOTFOUND") || error.contains("ECONNREFUSED") {
        return "ASR 网络连接失败".to_string();
    }
    if error.contains("45000001") {
        return "ASR 请求参数无效".to_string();
    }
    if error.contains("45000081") {
        return "ASR 等包超时".to_string();
    }
    error.to_string()
}

// ---------------------------------------------------------------------------
// WebSocket sink type alias
// ---------------------------------------------------------------------------

type WsSink = futures_util::stream::SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;

// ---------------------------------------------------------------------------
// DoubaoEngine — AsrEngine implementation
// ---------------------------------------------------------------------------

/// Doubao (ByteDance) ASR engine using WebSocket binary protocol.
pub struct DoubaoEngine {
    connection: ConnectionConfig,
    audio_config: AudioConfig,
    request_config: RequestConfig,
}

impl DoubaoEngine {
    pub fn new(
        connection: ConnectionConfig,
        audio_config: AudioConfig,
        request_config: RequestConfig,
    ) -> Self {
        Self {
            connection,
            audio_config,
            request_config,
        }
    }
}

#[async_trait]
impl AsrEngine for DoubaoEngine {
    async fn create_session(
        &self,
        _hotwords: &[String],
    ) -> Result<(Box<dyn AsrSession>, mpsc::UnboundedReceiver<AsrEvent>), String> {
        // Validate required fields
        if self.connection.url.is_empty() {
            return Err("语音识别模型还未配置，缺少 connection.url".to_string());
        }
        if self.connection.resource_id.is_empty() {
            return Err("语音识别模型还未配置，缺少 connection.resource_id".to_string());
        }
        if self.connection.app_id.is_empty() {
            return Err("语音识别模型还未配置，缺少 connection.app_id".to_string());
        }
        if self.connection.access_token.is_empty() {
            return Err("语音识别模型还未配置，缺少 connection.access_token".to_string());
        }

        let connect_id = Uuid::new_v4().to_string();

        // Build URL with request_id
        let mut url =
            url::Url::parse(&self.connection.url).map_err(|e| format!("Invalid ASR URL: {}", e))?;
        url.query_pairs_mut().append_pair("request_id", &connect_id);

        // Build request with custom headers
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|e| format!("Failed to create WebSocket request: {}", e))?;

        let headers = request.headers_mut();
        headers.insert("X-Api-App-Key", self.connection.app_id.parse().unwrap());
        headers.insert(
            "X-Api-Access-Key",
            self.connection.access_token.parse().unwrap(),
        );
        headers.insert(
            "X-Api-Resource-Id",
            self.connection.resource_id.parse().unwrap(),
        );
        headers.insert("X-Api-Connect-Id", connect_id.parse().unwrap());

        // Connect
        let (ws_stream, _) = connect_async(request)
            .await
            .map_err(|e| format!("ASR WebSocket connection failed: {}", e))?;

        let (sink, mut stream) = ws_stream.split();

        // Send initial request
        let request_body = build_api_request_body(&self.audio_config, &self.request_config);
        let init_frame = encode_full_client_request(&request_body);
        let mut sink = sink;
        sink.send(Message::Binary(init_frame.into()))
            .await
            .map_err(|e| format!("Failed to send ASR init request: {}", e))?;

        // Create session state
        let is_ready = Arc::new(AtomicBool::new(true));
        let is_committed = Arc::new(AtomicBool::new(false));
        let final_text: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let partial_text: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let latest_result_text: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let sink = Arc::new(Mutex::new(Some(sink)));
        let commit_tx: Arc<Mutex<Option<tokio::sync::oneshot::Sender<String>>>> =
            Arc::new(Mutex::new(None));

        let (event_tx, event_rx) = mpsc::unbounded_channel();

        let session = DoubaoSession {
            is_ready: is_ready.clone(),
            is_committed: is_committed.clone(),
            final_text: final_text.clone(),
            latest_result_text: latest_result_text.clone(),
            sender: sink.clone(),
            commit_tx: commit_tx.clone(),
        };

        // Spawn message handler task
        let event_tx_clone = event_tx.clone();
        tokio::spawn(async move {
            while let Some(msg) = stream.next().await {
                match msg {
                    Ok(Message::Binary(data)) => {
                        let buffer = data.as_ref();
                        if let Some(payload) = parse_server_response(buffer) {
                            // Debug: log non-audio response payloads to diagnose ASR errors
                            if !payload.get("raw_text").is_some() {
                                log_asr!(
                                    debug,
                                    "Server response: {}",
                                    serde_json::to_string(&payload).unwrap_or_default()
                                );
                            }

                            // Handle different response types
                            if payload.get("messageType").is_some()
                                && payload.get("result").is_none()
                                && payload.get("raw_text").is_none()
                                && payload.get("code").is_none()
                            {
                                // Non-result frame, skip
                                continue;
                            }

                            if let Some(raw_text) =
                                payload.get("raw_text").and_then(|v| v.as_str())
                            {
                                let cleaned = clean_asr_text(raw_text.trim());
                                if is_ignorable_raw_text(&cleaned, &connect_id) {
                                    continue;
                                }
                                if !cleaned.is_empty() {
                                    let committed =
                                        is_committed.load(std::sync::atomic::Ordering::SeqCst);
                                    if committed {
                                        *final_text.lock().await = cleaned.to_string();
                                        let _ = event_tx_clone.send(AsrEvent::Transcript {
                                            final_text: cleaned.to_string(),
                                            partial_text: String::new(),
                                        });
                                    } else {
                                        *partial_text.lock().await = cleaned.to_string();
                                        let ft = final_text.lock().await.clone();
                                        let pt = cleaned.to_string();
                                        let _ = event_tx_clone.send(AsrEvent::Transcript {
                                            final_text: ft,
                                            partial_text: pt,
                                        });
                                    }
                                }
                                continue;
                            }

                            // Error response
                            if let Some(code) = payload.get("code").and_then(|v| v.as_u64()) {
                                if code != 20000000 {
                                    log_asr!(
                                        warn,
                                        "Binary response payload: {}",
                                        serde_json::to_string(&payload).unwrap_or_default()
                                    );
                                    let message = payload
                                        .get("message")
                                        .or_else(|| payload.get("msg"))
                                        .or_else(|| payload.get("error"))
                                        .and_then(|v| v.as_str())
                                        .map(|m| format!("ASR error {}: {}", code, m))
                                        .unwrap_or_else(|| format!("ASR error code {}", code));
                                    let _ =
                                        event_tx_clone.send(AsrEvent::Error(message.to_string()));
                                    continue;
                                }
                            }

                            // Result response
                            if let Some(result) = payload.get("result") {
                                let result_text = clean_asr_text(
                                    result
                                        .get("text")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .trim(),
                                );
                                if !result_text.is_empty() {
                                    *latest_result_text.lock().await = result_text.clone();
                                }

                                let committed =
                                    is_committed.load(std::sync::atomic::Ordering::SeqCst);

                                let utterances =
                                    result.get("utterances").and_then(|v| v.as_array());

                                if utterances.map_or(false, |a| !a.is_empty()) {
                                    // Has utterances
                                    if let Some(arr) = utterances.clone() {
                                        let completed: String = arr
                                            .iter()
                                            .filter(|u| {
                                                u.get("definite")
                                                    .and_then(|v| v.as_bool())
                                                    .unwrap_or(false)
                                            })
                                            .filter_map(|u| {
                                                u.get("text")
                                                    .and_then(|v| v.as_str())
                                                    .map(|s| s.trim())
                                            })
                                            .collect::<Vec<&str>>()
                                            .join("");

                                        if !completed.is_empty() {
                                            *final_text.lock().await = completed.to_string();
                                        }

                                        let streaming_partial: String = arr
                                            .iter()
                                            .filter(|u| {
                                                !u.get("definite")
                                                    .and_then(|v| v.as_bool())
                                                    .unwrap_or(false)
                                            })
                                            .filter_map(|u| {
                                                u.get("text")
                                                    .and_then(|v| v.as_str())
                                                    .map(|s| s.trim())
                                            })
                                            .collect::<Vec<&str>>()
                                            .join("");

                                        let next_partial = if completed.is_empty() {
                                            result_text.clone()
                                        } else if let Some(rest) =
                                            result_text.strip_prefix(&completed)
                                        {
                                            rest.trim().to_string()
                                        } else {
                                            streaming_partial
                                        };

                                        if committed {
                                            *partial_text.lock().await = String::new();
                                            let _ = event_tx_clone.send(AsrEvent::Transcript {
                                                final_text: result_text.clone(),
                                                partial_text: String::new(),
                                            });
                                        } else {
                                            *partial_text.lock().await = next_partial;
                                            let ft = final_text.lock().await.clone();
                                            let pt = partial_text.lock().await.clone();
                                            let _ = event_tx_clone.send(AsrEvent::Transcript {
                                                final_text: ft,
                                                partial_text: pt,
                                            });
                                        }
                                    }
                                } else if !result_text.is_empty() {
                                    if committed {
                                        *final_text.lock().await = result_text.clone();
                                        *partial_text.lock().await = String::new();
                                        let _ = event_tx_clone.send(AsrEvent::Transcript {
                                            final_text: result_text.clone(),
                                            partial_text: String::new(),
                                        });
                                    } else {
                                        let ft = final_text.lock().await.clone();
                                        let _ = event_tx_clone.send(AsrEvent::Transcript {
                                            final_text: ft,
                                            partial_text: result_text.clone(),
                                        });
                                    }
                                }

                                // Check for commit resolution
                                if committed {
                                    if let Some(arr) = utterances {
                                        if let Some(last) = arr.last() {
                                            if last
                                                .get("definite")
                                                .and_then(|v| v.as_bool())
                                                .unwrap_or(false)
                                            {
                                                let text =
                                                    latest_result_text.lock().await.clone();
                                                *final_text.lock().await = text.clone();
                                                *partial_text.lock().await = String::new();

                                                if let Some(tx) =
                                                    commit_tx.lock().await.take()
                                                {
                                                    let _ = tx.send(text);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Ok(Message::Text(text)) => {
                        // Handle text messages (error responses)
                        log_asr!(error, "Text message: {}", text);
                        if let Ok(payload) = serde_json::from_str::<Value>(&text) {
                            if payload.get("type").and_then(|v| v.as_str()) == Some("error") {
                                let message = payload
                                    .get("message")
                                    .or_else(|| {
                                        payload.get("error").and_then(|e| e.get("message"))
                                    })
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("ASR 服务异常");
                                let _ =
                                    event_tx_clone.send(AsrEvent::Error(message.to_string()));
                            }
                        }
                    }
                    Ok(Message::Close(frame)) => {
                        is_ready.store(false, Ordering::SeqCst);
                        let code: Option<u16> = frame.as_ref().map(|f| f.code.into());
                        let reason = frame
                            .as_ref()
                            .map(|f| f.reason.to_string())
                            .unwrap_or_default();

                        // Resolve pending commit on close
                        if is_committed.load(Ordering::SeqCst) {
                            let latest = latest_result_text.lock().await.clone();
                            let ft = final_text.lock().await.clone();
                            let text = if latest.is_empty() { ft } else { latest };
                            if let Some(tx) = commit_tx.lock().await.take() {
                                let _ = tx.send(text);
                            }
                        }

                        let _ = event_tx_clone.send(AsrEvent::Close { code, reason });
                        break;
                    }
                    Err(e) => {
                        is_ready.store(false, Ordering::SeqCst);
                        let msg = normalize_error_message(&e.to_string());
                        let _ = event_tx_clone.send(AsrEvent::Error(msg));
                        break;
                    }
                    _ => {}
                }
            }
        });

        let _ = event_tx.send(AsrEvent::Open);
        Ok((Box::new(session), event_rx))
    }

    fn supports_streaming(&self) -> bool {
        true
    }

    fn name(&self) -> &str {
        "doubao"
    }
}

// ---------------------------------------------------------------------------
// DoubaoSession — AsrSession implementation
// ---------------------------------------------------------------------------

/// Doubao ASR session connected via WebSocket.
struct DoubaoSession {
    is_ready: Arc<AtomicBool>,
    is_committed: Arc<AtomicBool>,
    final_text: Arc<Mutex<String>>,
    latest_result_text: Arc<Mutex<String>>,
    sender: Arc<Mutex<Option<WsSink>>>,
    commit_tx: Arc<Mutex<Option<tokio::sync::oneshot::Sender<String>>>>,
}

#[async_trait]
impl AsrSession for DoubaoSession {
    fn is_ready(&self) -> bool {
        self.is_ready.load(Ordering::SeqCst)
    }

    fn append_audio(&self, samples: &[f32]) {
        if !self.is_ready() || self.is_committed.load(Ordering::SeqCst) {
            return;
        }
        // Convert f32 samples to i16 PCM bytes for the binary protocol
        let audio: Vec<u8> = samples
            .iter()
            .map(|&s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
            .flat_map(|s| s.to_le_bytes())
            .collect();
        let frame = encode_audio_only_request(&audio, false);
        let sender = self.sender.clone();
        tokio::spawn(async move {
            if let Some(ref mut sink) = *sender.lock().await {
                let _ = sink.send(Message::Binary(frame.into())).await;
            }
        });
    }

    async fn commit_and_await_final(&self) -> Result<String, String> {
        if !self.is_ready() {
            return Err("ASR 连接已断开，请重新开始".to_string());
        }
        if self.is_committed.load(Ordering::SeqCst) {
            return Err("录音已结束".to_string());
        }
        self.is_committed.store(true, Ordering::SeqCst);

        // Send last-audio frame
        let frame = encode_audio_only_request(&[], true);
        {
            if let Some(ref mut sink) = *self.sender.lock().await {
                let _ = sink.send(Message::Binary(frame.into())).await;
            }
        }

        // Wait for final result with timeout
        let (tx, rx) = tokio::sync::oneshot::channel();
        *self.commit_tx.lock().await = Some(tx);

        match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
            Ok(Ok(text)) => Ok(text),
            _ => {
                // Timeout: use whatever we have
                let latest = self.latest_result_text.lock().await.clone();
                let final_t = self.final_text.lock().await.clone();
                Ok(if latest.is_empty() { final_t } else { latest })
            }
        }
    }

    fn close(&self) {
        self.is_ready.store(false, Ordering::SeqCst);
        let sender = self.sender.clone();
        tokio::spawn(async move {
            if let Some(ref mut sink) = *sender.lock().await {
                let _ = sink.send(Message::Close(None)).await;
            }
        });
    }
}

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
pub(crate) fn parse_server_response(buffer: &[u8]) -> Option<Value> {
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
                if let Some(obj) = parsed.as_object_mut() {
                    obj.insert("code".to_string(), json!(error_code));
                }
                Some(parsed)
            }
            Err(_) => Some(json!({
                "code": error_code,
                "message": error_text,
            })),
        };
    }

    // Ack message type and message flags both skip 4 bytes
    if message_type == 0x09 || message_flags == 0x01 || message_flags == 0x03 {
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

pub(crate) fn build_api_request_body(
    audio_config: &AudioConfig,
    request_config: &RequestConfig,
    hotwords: &[String],
) -> Value {
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
    if let Some(language) = request_config
        .language
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        request.insert("language".to_string(), json!(language));
    }
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
    if let Some(v) = request_config
        .ssd_version
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        request.insert("ssd_version".to_string(), json!(v));
    }
    // "off" means no conversion → omit the field so the server keeps simplified output.
    if let Some(v) = request_config
        .output_zh_variant
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "off")
    {
        request.insert("output_zh_variant".to_string(), json!(v));
    }
    let mut context_hotwords: Vec<Value> = hotwords
        .iter()
        .map(|word| word.trim())
        .filter(|word| !word.is_empty())
        .map(|word| json!({ "word": word }))
        .collect();

    if let Some(corpus_value) = &request_config.corpus {
        if let Some(corpus) = corpus_value.as_mapping() {
            let mut corpus_json = serde_json::Map::new();

            for (key, value) in corpus {
                let Some(key) = key.as_str() else {
                    continue;
                };
                if key == "context_hotwords" {
                    if context_hotwords.is_empty() {
                        context_hotwords = parse_context_hotwords(value);
                    }
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

            if !corpus_json.is_empty() {
                request.insert("corpus".to_string(), Value::Object(corpus_json));
            }
        }
    }

    if !context_hotwords.is_empty() {
        let corpus = request
            .entry("corpus".to_string())
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
        if let Some(corpus_json) = corpus.as_object_mut() {
            corpus_json.insert(
                "context".to_string(),
                json!(serde_json::json!({ "hotwords": context_hotwords }).to_string()),
            );
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

/// Classify a Doubao ASR error code as fatal (unrecoverable by reconnect) or
/// transient. Parameter-invalid errors won't recover by reconnecting; server-side
/// timeouts / busy errors and network drops are transient.
fn is_fatal_asr_code(code: u64) -> bool {
    matches!(code, 45000001 | 45000002)
}

// ---------------------------------------------------------------------------
// WebSocket sink type alias
// ---------------------------------------------------------------------------

type WsSink = futures_util::stream::SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;

/// A frame to write to the WebSocket, serialized through a single writer task.
enum WsWrite {
    /// A non-last audio frame.
    Audio(Vec<u8>),
    /// The last-packet (commit) frame. The writer drops any audio enqueued after
    /// it, so the server never sees a packet past the final one.
    Last(Vec<u8>),
    /// Close the connection.
    Close,
}

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
        hotwords: &[String],
    ) -> Result<(Box<dyn AsrSession>, mpsc::UnboundedReceiver<AsrEvent>), String> {
        // Validate required fields
        if self.connection.url.is_empty() {
            return Err("语音识别模型还未配置，缺少 audio.doubao-streaming.url".to_string());
        }
        if self.connection.resource_id.is_empty() {
            return Err(
                "语音识别模型还未配置，缺少 audio.doubao-streaming.resource_id".to_string(),
            );
        }
        if self.connection.app_id.is_empty() {
            return Err("语音识别模型还未配置，缺少 audio.doubao-streaming.app_id".to_string());
        }
        if self.connection.access_token.is_empty() {
            return Err(
                "语音识别模型还未配置，缺少 audio.doubao-streaming.access_token".to_string(),
            );
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

        // Connect with a bounded timeout. Without it a stalled handshake relies on
        // the OS-level TCP timeout (tens of seconds); the caller retries instead.
        let (ws_stream, _) =
            match tokio::time::timeout(std::time::Duration::from_secs(5), connect_async(request))
                .await
            {
                Ok(Ok(pair)) => pair,
                Ok(Err(e)) => return Err(format!("ASR WebSocket connection failed: {}", e)),
                Err(_) => return Err("ASR WebSocket 连接超时".to_string()),
            };

        let (sink, mut stream) = ws_stream.split();

        // Send initial request
        let request_body =
            build_api_request_body(&self.audio_config, &self.request_config, hotwords);
        log_asr!(
            debug,
            "ASR init request: {}",
            serde_json::to_string_pretty(&request_body).unwrap_or_default()
        );
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
        let commit_tx: Arc<Mutex<Option<tokio::sync::oneshot::Sender<String>>>> =
            Arc::new(Mutex::new(None));

        // Dedicated writer task: a single FIFO consumer of the sink. Keeps frames
        // ordered and drops any audio enqueued after the last packet, so the server
        // never sees a packet past the final one (which it rejects).
        let (writer_tx, mut writer_rx) = mpsc::unbounded_channel::<WsWrite>();
        tokio::spawn(async move {
            let mut sink: WsSink = sink;
            let mut last_sent = false;
            while let Some(msg) = writer_rx.recv().await {
                match msg {
                    WsWrite::Audio(bytes) => {
                        if last_sent {
                            continue;
                        }
                        if sink.send(Message::Binary(bytes.into())).await.is_err() {
                            break;
                        }
                    }
                    WsWrite::Last(bytes) => {
                        if last_sent {
                            continue;
                        }
                        last_sent = true;
                        let _ = sink.send(Message::Binary(bytes.into())).await;
                    }
                    WsWrite::Close => {
                        let _ = sink.send(Message::Close(None)).await;
                        break;
                    }
                }
            }
        });

        let (event_tx, event_rx) = mpsc::unbounded_channel();

        let session = DoubaoSession {
            is_ready: is_ready.clone(),
            is_committed: is_committed.clone(),
            final_text: final_text.clone(),
            latest_result_text: latest_result_text.clone(),
            writer_tx,
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
                            if payload.get("raw_text").is_none() {
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

                            if let Some(raw_text) = payload.get("raw_text").and_then(|v| v.as_str())
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
                                    let _ = event_tx_clone.send(AsrEvent::Error {
                                        message: message.to_string(),
                                        fatal: is_fatal_asr_code(code),
                                    });
                                    // If a commit is waiting, resolve it now with the
                                    // best text we have instead of blocking until the
                                    // 5s timeout (the socket is about to be reset).
                                    if is_committed.load(Ordering::SeqCst) {
                                        if let Some(tx) = commit_tx.lock().await.take() {
                                            let latest = latest_result_text.lock().await.clone();
                                            let ft = final_text.lock().await.clone();
                                            let _ = tx.send(if latest.is_empty() {
                                                ft
                                            } else {
                                                latest
                                            });
                                        }
                                    }
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

                                if utterances.is_some_and(|a| !a.is_empty()) {
                                    // Has utterances
                                    if let Some(arr) = utterances {
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
                                                let text = latest_result_text.lock().await.clone();
                                                *final_text.lock().await = text.clone();
                                                *partial_text.lock().await = String::new();
                                                // Do NOT resolve the commit here: doubao keeps
                                                // emitting final segments after the first
                                                // definite one, only closing with "finish last
                                                // sequence". Resolving on the first definite
                                                // truncates the tail (e.g. "是哪一个？"); the
                                                // close-frame handler resolves with full text.
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
                                    .or_else(|| payload.get("error").and_then(|e| e.get("message")))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("ASR 服务异常");
                                // Unknown text-protocol error: attempt reconnect before giving up.
                                let _ = event_tx_clone.send(AsrEvent::Error {
                                    message: message.to_string(),
                                    fatal: false,
                                });
                            }
                        }
                    }
                    Ok(Message::Close(frame)) => {
                        is_ready.store(false, Ordering::SeqCst);
                        // Lingering audio sends are already prevented: is_ready=false
                        // gates append_audio, and the FIFO writer task drops frames
                        // after the last packet / exits when its send fails.
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
                        // Connection reset without a clean Close: resolve any pending
                        // commit so the caller doesn't wait the full 5s timeout.
                        if is_committed.load(Ordering::SeqCst) {
                            if let Some(tx) = commit_tx.lock().await.take() {
                                let latest = latest_result_text.lock().await.clone();
                                let ft = final_text.lock().await.clone();
                                let _ = tx.send(if latest.is_empty() { ft } else { latest });
                            }
                        }
                        // Transport-level failure (network drop): recoverable by reconnect.
                        let _ = event_tx_clone.send(AsrEvent::Error {
                            message: msg,
                            fatal: false,
                        });
                        break;
                    }
                    _ => {}
                }
            }
        });

        let _ = event_tx.send(AsrEvent::Open);
        Ok((Box::new(session), event_rx))
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
    /// Sends frames to the dedicated writer task. A single FIFO consumer keeps
    /// frames ordered and guarantees the last packet is written after all audio.
    writer_tx: mpsc::UnboundedSender<WsWrite>,
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
        // Hand the frame to the writer task; FIFO order is preserved and the
        // writer drops anything enqueued after the last packet.
        let _ = self.writer_tx.send(WsWrite::Audio(frame));
    }

    async fn commit_and_await_final(&self) -> Result<String, String> {
        if !self.is_ready() {
            return Err("ASR 连接已断开，请重新开始".to_string());
        }
        if self.is_committed.load(Ordering::SeqCst) {
            return Err("录音已结束".to_string());
        }
        // Mark committed (stops further appends) and enqueue the last packet.
        // Because all prior audio was enqueued before this call (the renderer
        // flushes and acks before stop proceeds) and the writer is FIFO, the
        // last packet is guaranteed to be written after every audio frame.
        self.is_committed.store(true, Ordering::SeqCst);
        let frame = encode_audio_only_request(&[], true);
        let _ = self.writer_tx.send(WsWrite::Last(frame));

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
        let _ = self.writer_tx.send(WsWrite::Close);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── build_header tests ────────────────────────────────────────────────

    #[test]
    fn header_structure() {
        let header = build_header(0x01, 0x00, 0x01, 0x01);
        // byte 0: protocol magic 0x11
        assert_eq!(header[0], 0x11);
        // byte 1: (message_type << 4) | (flags & 0x0f) → (0x01 << 4) | 0x00 = 0x10
        assert_eq!(header[1], 0x10);
        // byte 2: (serialization << 4) | (compression & 0x0f) → (0x01 << 4) | 0x01 = 0x11
        assert_eq!(header[2], 0x11);
        // byte 3: reserved, always 0x00
        assert_eq!(header[3], 0x00);
    }

    #[test]
    fn header_message_type_changes_byte1() {
        let header = build_header(0x02, 0x00, 0x00, 0x00);
        assert_eq!(header[0], 0x11);
        assert_eq!(header[1], 0x20); // 0x02 << 4
        assert_eq!(header[2], 0x00);
    }

    // ── encode_full_client_request ────────────────────────────────────────

    #[test]
    fn full_request_has_header_and_size() {
        let payload = json!({"test": "hello"});
        let frame = encode_full_client_request(&payload);
        assert!(frame.len() > 8); // header(4) + size(4) + gzipped payload
                                  // First byte is protocol magic
        assert_eq!(frame[0], 0x11);
        // Bytes 4-7 are the payload size (big-endian)
        let size = u32::from_be_bytes([frame[4], frame[5], frame[6], frame[7]]);
        assert_eq!(size as usize, frame.len() - 8);
    }

    // ── encode_audio_only_request ─────────────────────────────────────────

    #[test]
    fn audio_only_normal_frame() {
        let audio = vec![0u8; 100];
        let frame = encode_audio_only_request(&audio, false);
        assert_eq!(frame[0], 0x11);
        // byte 1: message_type=0x02, flags=0x00 → 0x20
        assert_eq!(frame[1], 0x20);
        let size = u32::from_be_bytes([frame[4], frame[5], frame[6], frame[7]]);
        assert_eq!(size, 100);
    }

    #[test]
    fn audio_only_last_frame_has_flag() {
        let audio = vec![0u8; 50];
        let frame = encode_audio_only_request(&audio, true);
        // byte 1: (0x02 << 4) | 0x02 = 0x22
        assert_eq!(frame[1], 0x22);
    }

    // ── clean_asr_text ────────────────────────────────────────────────────

    #[test]
    fn clean_cjk_removes_spaces_between_chars() {
        assert_eq!(clean_asr_text("语 音 输 入"), "语音输入");
    }

    #[test]
    fn clean_preserves_english_spaces() {
        assert_eq!(clean_asr_text("hello world"), "hello world");
    }

    #[test]
    fn clean_mixed_cjk_english() {
        let input = "使用 Claude Code 和 语 音 识 别";
        let output = clean_asr_text(input);
        // English word spaces preserved, CJK spaces removed
        assert!(output.contains("语音识别"));
        assert!(output.contains("Claude Code"));
    }

    // ── is_ignorable_raw_text ─────────────────────────────────────────────

    #[test]
    fn ignorable_empty_string() {
        assert!(is_ignorable_raw_text("", "conn-123"));
        assert!(is_ignorable_raw_text("   ", "conn-123"));
    }

    #[test]
    fn ignorable_connect_id() {
        assert!(is_ignorable_raw_text("conn-abc", "conn-abc"));
    }

    #[test]
    fn ignorable_uuid() {
        assert!(is_ignorable_raw_text(
            "550e8400-e29b-41d4-a716-446655440000",
            "conn-123"
        ));
    }

    #[test]
    fn not_ignorable_normal_text() {
        assert!(!is_ignorable_raw_text("hello world", "conn-123"));
    }

    // ── normalize_error_message ───────────────────────────────────────────

    #[test]
    fn normalize_error_401_auth() {
        let msg = normalize_error_message("HTTP 401 Unauthorized");
        assert!(msg.contains("鉴权失败"));
    }

    #[test]
    fn normalize_error_403_auth() {
        let msg = normalize_error_message("403 Forbidden");
        assert!(msg.contains("鉴权失败"));
    }

    #[test]
    fn normalize_error_enotfound_network() {
        let msg = normalize_error_message("ENOTFOUND: DNS lookup failed");
        assert!(msg.contains("网络连接失败"));
    }

    #[test]
    fn normalize_error_econnrefused_network() {
        let msg = normalize_error_message("ECONNREFUSED");
        assert!(msg.contains("网络连接失败"));
    }

    #[test]
    fn normalize_error_45000001_invalid_params() {
        let msg = normalize_error_message("Error 45000001");
        assert!(msg.contains("参数无效"));
    }

    #[test]
    fn normalize_error_45000081_timeout() {
        let msg = normalize_error_message("Error 45000081");
        assert!(msg.contains("等包超时"));
    }

    #[test]
    fn normalize_error_unknown_passthrough() {
        let original = "Some random error";
        let msg = normalize_error_message(original);
        assert_eq!(msg, original);
    }

    // ── is_fatal_asr_code ───────────────────────────────────────────────

    #[test]
    fn fatal_param_invalid_codes_are_fatal() {
        // Parameter-invalid codes cannot recover by reconnecting.
        assert!(is_fatal_asr_code(45000001));
        assert!(is_fatal_asr_code(45000002));
    }

    #[test]
    fn transient_codes_are_not_fatal() {
        // Server-side timeout / busy and unknown codes are reconnectable.
        assert!(!is_fatal_asr_code(45000081));
        assert!(!is_fatal_asr_code(0));
        assert!(!is_fatal_asr_code(99999999));
    }

    // ── is_empty_yaml_value ──────────────────────────────────────────────

    #[test]
    fn yaml_null_is_empty() {
        assert!(is_empty_yaml_value(&serde_norway::Value::Null));
    }

    #[test]
    fn yaml_empty_string_is_empty() {
        assert!(is_empty_yaml_value(&serde_norway::Value::String(
            "".to_string()
        )));
    }

    #[test]
    fn yaml_whitespace_string_is_empty() {
        assert!(is_empty_yaml_value(&serde_norway::Value::String(
            "   ".to_string()
        )));
    }

    #[test]
    fn yaml_empty_sequence_is_empty() {
        assert!(is_empty_yaml_value(&serde_norway::Value::Sequence(vec![])));
    }

    #[test]
    fn yaml_non_empty_string_is_not_empty() {
        assert!(!is_empty_yaml_value(&serde_norway::Value::String(
            "hello".to_string()
        )));
    }

    // ── parse_context_hotwords ───────────────────────────────────────────

    #[test]
    fn context_hotwords_comma_separated_string() {
        let value = serde_norway::Value::String("Claude Code,OpenAI,ChatGPT".to_string());
        let words = parse_context_hotwords(&value);
        assert_eq!(words.len(), 3);
        assert_eq!(words[0]["word"], "Claude Code");
        assert_eq!(words[1]["word"], "OpenAI");
        assert_eq!(words[2]["word"], "ChatGPT");
    }

    #[test]
    fn context_hotwords_sequence_format() {
        let value = serde_norway::Value::Sequence(vec![
            serde_norway::Value::String("Claude Code".to_string()),
            serde_norway::Value::String("OpenAI".to_string()),
        ]);
        let words = parse_context_hotwords(&value);
        assert_eq!(words.len(), 2);
    }

    #[test]
    fn context_hotwords_null_returns_empty() {
        let words = parse_context_hotwords(&serde_norway::Value::Null);
        assert!(words.is_empty());
    }
}

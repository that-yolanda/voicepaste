//! ElevenLabs realtime STT. Protocol details stay behind the shared ASR traits.
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::{sleep_until, timeout, Instant};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::Request, Message},
    WebSocketStream,
};

use super::{AsrEngine, AsrEvent, AsrSession};
use crate::config::ElevenLabsRealtimeConfig;

const ENDPOINT: &str = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const FINAL_WINDOW: Duration = Duration::from_secs(10);

pub struct ElevenLabsEngine {
    config: ElevenLabsRealtimeConfig,
}

impl ElevenLabsEngine {
    pub fn new(config: ElevenLabsRealtimeConfig) -> Self {
        Self { config }
    }
}

fn request(
    config: &ElevenLabsRealtimeConfig,
    hotwords: &[String],
    endpoint: &str,
) -> Result<Request<()>, String> {
    config.validate()?;
    if config.api_key.trim().is_empty() {
        return Err("请先填写 ElevenLabs API Key".into());
    }
    let mut url = url::Url::parse(endpoint).map_err(|_| "ElevenLabs 地址无效".to_string())?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("model_id", "scribe_v2_realtime")
            .append_pair("audio_format", "pcm_16000")
            .append_pair("commit_strategy", &config.commit_strategy)
            .append_pair(
                "no_verbatim",
                if config.enable_ddc { "true" } else { "false" },
            )
            .append_pair(
                "filter_background_audio",
                if config.filter_background_audio {
                    "true"
                } else {
                    "false"
                },
            );
        if !config.transcript_edit.trim().is_empty() {
            query.append_pair("transcript_edit", config.transcript_edit.trim());
        }
        if !config.language.trim().is_empty() {
            query.append_pair("language_code", &config.language.trim().to_lowercase());
        }
        for code in config
            .secondary_languages
            .iter()
            .map(|v| v.trim().to_lowercase())
            .filter(|v| !v.is_empty())
            .collect::<BTreeSet<_>>()
        {
            query.append_pair("secondary_languages", &code);
        }
        if config.commit_strategy != "manual" {
            for (key, value) in [
                (
                    "vad_silence_threshold_secs",
                    config.vad_silence_threshold_secs.to_string(),
                ),
                ("vad_threshold", config.vad_threshold.to_string()),
                (
                    "min_speech_duration_ms",
                    config.min_speech_duration_ms.to_string(),
                ),
                (
                    "min_silence_duration_ms",
                    config.min_silence_duration_ms.to_string(),
                ),
            ] {
                query.append_pair(key, &value);
            }
        }
        if config.enable_keyterms {
            let words: BTreeSet<_> = hotwords
                .iter()
                .map(|v| v.trim())
                .filter(|v| !v.is_empty())
                .collect();
            if words.len() > 50 {
                return Err("ElevenLabs 服务端热词最多 50 条，请减少启用词条".into());
            }
            if words.iter().any(|v| v.chars().count() > 20) {
                return Err("ElevenLabs 每条服务端热词最多 20 个字符".into());
            }
            for word in words {
                query.append_pair("keyterms", word);
            }
        }
    }
    let mut req = url
        .as_str()
        .into_client_request()
        .map_err(|_| "ElevenLabs 请求构造失败".to_string())?;
    let mut key = config
        .api_key
        .trim()
        .parse::<tokio_tungstenite::tungstenite::http::HeaderValue>()
        .map_err(|_| "ElevenLabs API Key 格式无效".to_string())?;
    key.set_sensitive(true);
    req.headers_mut().insert("xi-api-key", key);
    Ok(req)
}

fn audio_message(samples: &[f32], commit: bool) -> Message {
    let pcm: Vec<u8> = samples
        .iter()
        .flat_map(|sample| {
            let sample = if sample.is_finite() {
                sample.clamp(-1.0, 1.0)
            } else {
                0.0
            };
            let scaled = sample * if sample < 0.0 { 32768.0 } else { 32767.0 };
            (scaled as i16).to_le_bytes()
        })
        .collect();
    Message::Text(json!({"message_type":"input_audio_chunk", "audio_base_64":STANDARD.encode(pcm), "sample_rate":16000, "commit":commit}).to_string().into())
}

struct ConfirmedSegment {
    original: String,
    edited: Option<String>,
}

#[derive(Default)]
struct Transcript {
    segments: Vec<ConfirmedSegment>,
    partial: String,
    samples: usize,
    barrier_confirmed: bool,
    drain_rejected: bool,
    completed: bool,
}

impl Transcript {
    fn display_text(&self) -> String {
        let mut text = String::new();
        for segment in &self.segments {
            append_segment(
                &mut text,
                segment.edited.as_ref().unwrap_or(&segment.original),
            );
        }
        text
    }
    fn final_text(&self, editing: bool) -> Option<String> {
        if !self.barrier_confirmed || (editing && self.segments.iter().any(|s| s.edited.is_none()))
        {
            return None;
        }
        Some(self.display_text())
    }
}

fn append_segment(text: &mut String, segment: &str) {
    if segment.is_empty() {
        return;
    }
    // Latin/digit word boundaries need spacing; Chinese punctuation and characters do not.
    let word = |c: char| {
        c.is_alphanumeric()
            && !matches!(c as u32, 0x2e80..=0x9fff | 0xac00..=0xd7af | 0xf900..=0xfaff | 0x20000..=0x323af)
    };
    if text.chars().last().is_some_and(word) && segment.chars().next().is_some_and(word) {
        text.push(' ');
    }
    text.push_str(segment);
}

fn server_error(value: &Value, api_key: &str) -> Option<(String, bool)> {
    let kind = value.get("message_type")?.as_str()?;
    let (description, fatal) = match kind {
        "auth_error" => ("API Key 无效或没有语音识别权限", true),
        "quota_exceeded" => ("额度不足，请检查账号余额", true),
        "unaccepted_terms" | "unaccepted_terms_error" => {
            ("请先在 ElevenLabs 控制台接受服务条款", true)
        }
        "invalid_request" | "input_error" | "chunk_size_exceeded" => {
            ("请求参数或音频格式无效", true)
        }
        "commit_throttled" => ("片段提交过于频繁，请稍后重试", false),
        "rate_limited" | "throttled" => ("请求过于频繁，请稍后重试", false),
        "queue_overflow" => ("音频处理队列已满，请重试", false),
        "resource_exhausted" | "transcriber_error" | "error" => {
            ("语音服务暂时不可用，请重试", false)
        }
        "session_time_limit_exceeded" => ("已达到单次会话时长限制", false),
        "insufficient_audio_activity" => ("长时间没有收到有效音频", false),
        _ => return None,
    };
    let detail = safe_detail(value["error"].as_str().unwrap_or(""), api_key);
    let suffix = if detail.is_empty() {
        String::new()
    } else {
        format!("：{detail}")
    };
    Some((
        format!("ElevenLabs：{description}（{kind}）{suffix}"),
        fatal,
    ))
}

fn safe_detail(text: &str, api_key: &str) -> String {
    // Exact-value and credential-shaped redaction live in the shared helper;
    // ElevenLabs messages surface in the overlay, so additionally collapse
    // whitespace (one log line per message) and cap the length.
    crate::logger::redact_credentials(text, &[api_key.trim()])
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(240)
        .collect()
}

/// Setup still crosses the engine boundary as a String; keep the retry decision
/// limited to known transient ElevenLabs failures, not arbitrary server details.
pub(crate) fn retryable_start_error(message: &str) -> bool {
    [
        "连接超时",
        "会话启动超时",
        "连接失败，请检查网络",
        "启动连接失败",
        "启动前断开连接",
        "启动前关闭连接",
        "心跳失败",
    ]
    .iter()
    .any(|kind| message.starts_with(&format!("ElevenLabs {kind}")))
        || [
            "rate_limited",
            "throttled",
            "commit_throttled",
            "queue_overflow",
            "resource_exhausted",
            "transcriber_error",
            "session_time_limit_exceeded",
            "insufficient_audio_activity",
            "error",
        ]
        .iter()
        .any(|kind| {
            message.starts_with("ElevenLabs：")
                && message
                    .split('）')
                    .next()
                    .is_some_and(|v| v.ends_with(&format!("（{kind}")))
        })
        || message
            .strip_prefix("ElevenLabs 连接失败：HTTP ")
            .and_then(|v| v.split('，').next())
            .and_then(|v| v.parse::<u16>().ok())
            .is_some_and(|code| code == 429 || (500..600).contains(&code))
}

fn server_reports_no_uncommitted_audio(value: &Value) -> bool {
    static ZERO_AUDIO: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let pattern = ZERO_AUDIO.get_or_init(|| {
        regex::Regex::new(r"^Commit request ignored: only 0(?:\.0+)?s of uncommitted audio\.")
            .unwrap()
    });
    value["error"]
        .as_str()
        .is_some_and(|message| pattern.is_match(message))
}

struct Runtime {
    ready: AtomicBool,
    finishing: AtomicBool,
    api_key: String,
    editing: bool,
    updates: watch::Sender<u64>,
    transcript: Mutex<Transcript>,
    ended: watch::Sender<Option<String>>,
    events: mpsc::UnboundedSender<AsrEvent>,
}

impl Runtime {
    fn fail(&self, message: String, fatal: bool) {
        self.ready.store(false, Ordering::SeqCst);
        if self.ended.send_if_modified(|value| {
            if value.is_some() {
                return false;
            }
            *value = Some(message.clone());
            true
        }) {
            let _ = self.events.send(AsrEvent::Error { message, fatal });
        }
    }

    /// Returns whether a further no-audio commit is needed to obtain the
    /// server-confirmed empty segment that drains prior VAD confirmations.
    fn transcript(&self, value: &Value) -> bool {
        let kind = value["message_type"].as_str().unwrap_or("");
        let Some(text) = value["text"].as_str() else {
            return false;
        };
        let mut state = self.transcript.lock().unwrap();
        if state.completed {
            return false;
        }
        let mut drain_commit = false;
        match kind {
            "partial_transcript" => {
                // Late interim revisions never modify any confirmed segment.
                if !state.barrier_confirmed {
                    state.partial = text.into();
                }
            }
            "committed_transcript" => {
                if text.is_empty() {
                    if self.finishing.load(Ordering::SeqCst) {
                        state.barrier_confirmed = true;
                    }
                } else {
                    state.segments.push(ConfirmedSegment {
                        original: text.into(),
                        edited: None,
                    });
                    drain_commit = self.finishing.load(Ordering::SeqCst) && !self.editing;
                }
                state.partial.clear();
            }
            "edited_transcript" if self.editing => {
                let Some(edited) = value["edited_text"].as_str() else {
                    return false;
                };
                // The API explicitly uses the original text to correlate edits.
                // This is not similarity deduplication: identical spoken segments
                // retain separate entries and receive one edit each.
                if let Some(segment) = state
                    .segments
                    .iter_mut()
                    .find(|s| s.original == text && s.edited.is_none())
                {
                    segment.edited = Some(edited.into());
                    drain_commit = self.finishing.load(Ordering::SeqCst)
                        && !state.barrier_confirmed
                        && state
                            .segments
                            .iter()
                            .all(|segment| segment.edited.is_some());
                } else {
                    log_asr!(warn, "ElevenLabs edit has no pending confirmed segment");
                    return false;
                }
            }
            _ => return false,
        }
        log_asr!(
            debug,
            "ElevenLabs event={} segments={} finalizing={} barrier={}",
            kind,
            state.segments.len(),
            self.finishing.load(Ordering::SeqCst),
            state.barrier_confirmed
        );
        self.updates.send_modify(|revision| *revision += 1);
        let _ = self.events.send(AsrEvent::Transcript {
            final_text: state.display_text(),
            partial_text: state.partial.clone(),
        });
        drain_commit
    }
}

enum Command {
    Audio(Vec<f32>),
    Finish(oneshot::Sender<usize>),
}

enum Control {
    Pong(tokio_tungstenite::tungstenite::Bytes),
    Commit,
}

struct ElevenLabsSession {
    runtime: Arc<Runtime>,
    sender: Mutex<Option<mpsc::UnboundedSender<Command>>>,
    final_window: Duration,
}

#[async_trait]
impl AsrEngine for ElevenLabsEngine {
    async fn create_session(
        &self,
        hotwords: &[String],
    ) -> Result<(Box<dyn AsrSession>, mpsc::UnboundedReceiver<AsrEvent>), String> {
        let req = request(&self.config, hotwords, ENDPOINT)?;
        connect_session(req, FINAL_WINDOW, self.config.api_key.clone()).await
    }
}

async fn connect_session(
    req: Request<()>,
    final_window: Duration,
    api_key: String,
) -> Result<(Box<dyn AsrSession>, mpsc::UnboundedReceiver<AsrEvent>), String> {
    let editing = url::Url::parse(&req.uri().to_string())
        .ok()
        .is_some_and(|url| {
            url.query_pairs()
                .any(|(key, value)| key == "transcript_edit" && !value.is_empty())
        });
    let (mut socket, _) = timeout(CONNECT_TIMEOUT, connect_async(req))
        .await
        .map_err(|_| "ElevenLabs 连接超时".to_string())?
        .map_err(|e| match e {
            tokio_tungstenite::tungstenite::Error::Http(response) => format!(
                "ElevenLabs 连接失败：HTTP {}，请检查 API Key、权限和余额",
                response.status().as_u16()
            ),
            _ => "ElevenLabs 连接失败，请检查网络".into(),
        })?;
    let mut warnings = Vec::new();
    timeout(CONNECT_TIMEOUT, async {
        while let Some(message) = socket.next().await {
            match message.map_err(|_| "ElevenLabs 启动连接失败".to_string())? {
                Message::Text(text) => {
                    let value: Value = serde_json::from_str(&text)
                        .map_err(|_| "ElevenLabs 返回无效消息".to_string())?;
                    if let Some((message, _)) = server_error(&value, &api_key) {
                        return Err(message);
                    }
                    if value["message_type"] == "warning" {
                        warnings.push(format!(
                            "ElevenLabs：{}",
                            safe_detail(
                                value["warning"].as_str().unwrap_or("服务端警告"),
                                &api_key
                            )
                        ));
                    }
                    if value["message_type"] == "session_started" {
                        return Ok(());
                    }
                }
                Message::Close(_) => return Err("ElevenLabs 在启动前关闭连接".into()),
                Message::Ping(data) => {
                    socket
                        .send(Message::Pong(data))
                        .await
                        .map_err(|_| "ElevenLabs 心跳失败".to_string())?;
                }
                _ => {}
            }
        }
        Err("ElevenLabs 在启动前断开连接".into())
    })
    .await
    .map_err(|_| "ElevenLabs 会话启动超时".to_string())??;
    Ok(start_session(
        socket,
        final_window,
        api_key,
        editing,
        warnings,
    ))
}

fn start_session<S>(
    socket: WebSocketStream<S>,
    final_window: Duration,
    api_key: String,
    editing: bool,
    warnings: Vec<String>,
) -> (Box<dyn AsrSession>, mpsc::UnboundedReceiver<AsrEvent>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (events, event_rx) = mpsc::unbounded_channel();
    let (ended, _) = watch::channel(None);
    let runtime = Arc::new(Runtime {
        ready: AtomicBool::new(true),
        finishing: AtomicBool::new(false),
        api_key,
        editing,
        updates: watch::channel(0).0,
        transcript: Mutex::new(Transcript::default()),
        ended,
        events,
    });
    let _ = runtime.events.send(AsrEvent::Open);
    for message in warnings {
        let _ = runtime.events.send(AsrEvent::Warning { message });
    }
    let (mut sink, mut stream) = socket.split();
    let (sender, mut commands) = mpsc::unbounded_channel();
    let (control_tx, mut controls) = mpsc::unbounded_channel();
    let writer = Arc::clone(&runtime);
    let mut writer_end = runtime.ended.subscribe();
    tokio::spawn(async move {
        let mut next_audio = Instant::now();
        let mut next_commit = Instant::now();
        let mut finished = false;
        loop {
            tokio::select! {
                biased;
                _ = writer_end.changed() => { let _ = timeout(CONNECT_TIMEOUT, sink.close()).await; break; }
                Some(control) = controls.recv() => {
                    let message = match control {
                        Control::Pong(data) => Message::Pong(data),
                        Control::Commit => {
                            if !finished || {
                                let state = writer.transcript.lock().unwrap();
                                state.barrier_confirmed || state.drain_rejected
                                    || (writer.editing && state.segments.iter().any(|segment| segment.edited.is_none()))
                            } { continue; }
                            // Submission pacing is not a completion heuristic.
                            tokio::select! { _ = writer_end.changed() => break, _ = sleep_until(next_commit.max(Instant::now() + Duration::from_millis(500))) => {} }
                            next_commit = Instant::now() + Duration::from_millis(500);
                            audio_message(&[], true)
                        }
                    };
                    let sent = tokio::select! {
                        _ = writer_end.changed() => break,
                        result = timeout(CONNECT_TIMEOUT, sink.send(message)) => result,
                    };
                    if !matches!(sent, Ok(Ok(()))) { writer.fail("ElevenLabs 控制消息发送失败，请检查网络".into(), false); break; }
                }
                command = commands.recv(), if !finished => {
                    let Some(command) = command else { break; };
                    tokio::select! { _ = writer_end.changed() => break, _ = sleep_until(next_audio) => {} }
                    let (message, duration, ack, samples) = match command {
                        Command::Audio(samples) => (audio_message(&samples, false), Duration::from_secs_f64(samples.len() as f64 / 16000.0), None, samples.len()),
                        Command::Finish(ack) => {
                            let samples = writer.transcript.lock().unwrap().samples;
                            if samples == 0 { finished = true; let _ = ack.send(0); continue; }
                            writer.finishing.store(true, Ordering::SeqCst);
                            if writer.editing && writer.transcript.lock().unwrap().segments.iter().any(|segment| segment.edited.is_none()) {
                                // An empty commit may close the connection. Preserve the
                                // transport until all existing edit events have arrived.
                                finished = true;
                                let _ = ack.send(samples);
                                continue;
                            }
                            next_commit = Instant::now() + Duration::from_millis(500);
                            log_asr!(debug, "ElevenLabs final commit sent after {} samples", samples);
                            (audio_message(&[], true), Duration::ZERO, Some(ack), 0)
                        }
                    };
                    let sent = tokio::select! {
                        _ = writer_end.changed() => break,
                        result = timeout(CONNECT_TIMEOUT, sink.send(message)) => result,
                    };
                    if !matches!(sent, Ok(Ok(()))) { writer.fail("ElevenLabs 音频发送失败，请检查网络".into(), false); break; }
                    let sent_samples = {
                        let mut state = writer.transcript.lock().unwrap();
                        state.samples += samples;
                        state.samples
                    };
                    next_audio = Instant::now() + duration;
                    if let Some(ack) = ack { finished = true; let _ = ack.send(sent_samples); }
                }
            }
        }
    });
    let reader = Arc::clone(&runtime);
    let mut reader_end = runtime.ended.subscribe();
    tokio::spawn(async move {
        let mut retries = 0;
        loop {
            tokio::select! {
                biased;
                _ = reader_end.changed() => break,
                message = stream.next() => {
                    match message {
                        Some(Ok(Message::Text(text))) => {
                            let value: Value = match serde_json::from_str(&text) {
                                Ok(value) => value,
                                Err(_) => { reader.fail("ElevenLabs 返回无效消息".into(), true); break; }
                            };
                            if value["message_type"] == "commit_throttled"
                                && reader.finishing.load(Ordering::SeqCst)
                                && server_reports_no_uncommitted_audio(&value) {
                                // Live API: probing an already drained manual segment returns
                                // this explicit server-side duration and closes with code 1000.
                                // Wait for that close, collecting any preceding final/edit frames.
                                reader.transcript.lock().unwrap().drain_rejected = true;
                                log_asr!(debug, "ElevenLabs reports zero uncommitted audio; awaiting server close");
                                continue;
                            }
                            if let Some((message, fatal)) = server_error(&value, &reader.api_key) {
                                if value["message_type"] == "commit_throttled" && reader.finishing.load(Ordering::SeqCst) && retries < 3 {
                                    retries += 1;
                                    let _ = reader.events.send(AsrEvent::Warning { message });
                                    let _ = control_tx.send(Control::Commit);
                                    continue;
                                }
                                reader.fail(message, fatal); break;
                            }
                            if value["message_type"] == "warning" {
                                let message = format!("ElevenLabs：{}", safe_detail(value["warning"].as_str().unwrap_or("服务端警告"), &reader.api_key));
                                log_asr!(warn, "{}", message);
                                let _ = reader.events.send(AsrEvent::Warning { message });
                            }
                            if reader.transcript(&value) { let _ = control_tx.send(Control::Commit); }
                        }
                        Some(Ok(Message::Ping(data))) => { let _ = control_tx.send(Control::Pong(data)); }
                        Some(Ok(Message::Close(frame))) => {
                            let code = frame.as_ref().map(|f| u16::from(f.code));
                            let reason = frame.as_ref().map(|f| safe_detail(&f.reason, &reader.api_key)).unwrap_or_default();
                            {
                                let mut state = reader.transcript.lock().unwrap();
                                if state.drain_rejected && code == Some(1000) && reason == "commit_throttled" {
                                    state.barrier_confirmed = true;
                                    reader.updates.send_modify(|revision| *revision += 1);
                                }
                            }
                            // A bare normal close is insufficient; the server must first
                            // confirm the empty segment or explicitly report zero pending audio.
                            if reader.transcript.lock().unwrap().final_text(reader.editing).is_none() {
                                let code = frame.as_ref().map(|f| u16::from(f.code));
                                let reason = frame.as_ref().map(|f| safe_detail(&f.reason, &reader.api_key)).unwrap_or_default();
                                reader.fail(format!("ElevenLabs 在最终确认前关闭连接（{}）{}", code.map(|c| c.to_string()).unwrap_or_else(|| "无状态码".into()), reason), false);
                            }
                            break;
                        }
                        None | Some(Err(_)) => { reader.fail("ElevenLabs 连接中断，请检查网络后重试".into(), false); break; }
                        _ => {}
                    }
                }
            }
        }
    });
    (
        Box::new(ElevenLabsSession {
            runtime,
            sender: Mutex::new(Some(sender)),
            final_window,
        }),
        event_rx,
    )
}

#[async_trait]
impl AsrSession for ElevenLabsSession {
    fn is_ready(&self) -> bool {
        self.runtime.ready.load(Ordering::SeqCst)
    }
    fn append_audio(&self, samples: &[f32]) {
        if samples.is_empty() || !self.is_ready() {
            return;
        }
        if let Some(sender) = self.sender.lock().unwrap().as_ref() {
            for chunk in samples.chunks(1600) {
                let _ = sender.send(Command::Audio(chunk.to_vec()));
            }
        }
    }
    async fn commit_and_await_final(&self) -> Result<String, String> {
        let mut ended = self.runtime.ended.subscribe();
        let mut updates = self.runtime.updates.subscribe();
        if let Some(error) = ended.borrow().clone() {
            return Err(error);
        }
        let (ack, sent) = oneshot::channel();
        self.sender
            .lock()
            .unwrap()
            .take()
            .ok_or("ElevenLabs 录音已结束")?
            .send(Command::Finish(ack))
            .map_err(|_| "ElevenLabs 发送队列已关闭")?;
        let samples = tokio::select! {
            biased;
            result = sent => result.map_err(|_| "ElevenLabs 最终提交失败")?,
            _ = ended.changed() => return Err(ended.borrow().clone().unwrap_or_else(|| "ElevenLabs 会话已结束".into())),
        };
        if samples == 0 {
            return Ok(String::new());
        }
        let deadline = Instant::now() + self.final_window;
        loop {
            if let Some(error) = ended.borrow().clone() {
                return Err(error);
            }
            {
                let mut state = self.runtime.transcript.lock().unwrap();
                if let Some(text) = state.final_text(self.runtime.editing) {
                    state.completed = true;
                    return Ok(text);
                }
            }
            tokio::select! {
                biased;
                _ = ended.changed() => {},
                _ = updates.changed() => {},
                _ = sleep_until(deadline) => {
                    let editing = self.runtime.editing && self.runtime.transcript.lock().unwrap().segments.iter().any(|segment| segment.edited.is_none());
                    return Err(if editing { "ElevenLabs 转写编辑未完成，请重试" } else { "ElevenLabs 最终确认超时，请重试" }.into());
                }
            }
        }
    }
    fn close(&self) {
        self.runtime.ready.store(false, Ordering::SeqCst);
        self.sender.lock().unwrap().take();
        self.runtime
            .ended
            .send_replace(Some("ElevenLabs 会话已取消".into()));
    }
}

impl Drop for ElevenLabsSession {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::{TcpListener, TcpStream};
    use tokio_tungstenite::accept_async;

    fn config() -> ElevenLabsRealtimeConfig {
        ElevenLabsRealtimeConfig {
            api_key: "test-secret".into(),
            ..Default::default()
        }
    }

    fn params(config: &ElevenLabsRealtimeConfig, words: &[String]) -> Vec<(String, String)> {
        let req = request(config, words, ENDPOINT).unwrap();
        url::Url::parse(&req.uri().to_string())
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect()
    }

    #[test]
    fn request_maps_shared_fields_and_keeps_key_out_of_url() {
        let mut config = config();
        config.language = " ZH ".into();
        config.secondary_languages = vec![" EN ".into(), "en".into(), "".into()];
        config.enable_ddc = true;
        let req = request(&config, &[], ENDPOINT).unwrap();
        assert_eq!(req.headers()["xi-api-key"], "test-secret");
        assert!(req.headers()["xi-api-key"].is_sensitive());
        assert!(!req.uri().to_string().contains("test-secret"));
        let pairs = params(&config, &[]);
        assert!(pairs.contains(&("language_code".into(), "zh".into())));
        assert!(pairs.contains(&("no_verbatim".into(), "true".into())));
        assert_eq!(
            pairs
                .iter()
                .filter(|(k, _)| k == "secondary_languages")
                .count(),
            1
        );
        assert!(!params(&self::config(), &[])
            .iter()
            .any(|(k, _)| k == "language_code"));
    }

    #[test]
    fn defaults_and_validation_do_not_silently_fall_back() {
        let config: ElevenLabsRealtimeConfig = serde_json::from_value(json!({})).unwrap();
        assert_eq!(config.commit_strategy, "vad");
        assert_eq!(config.vad_threshold, 0.4);
        assert!(!config.enable_keyterms);
        assert!(config.enable_ddc);
        let user: ElevenLabsRealtimeConfig =
            serde_json::from_value(json!({"enable_ddc":false})).unwrap();
        assert!(!user.enable_ddc);
        assert!(params(&self::config(), &[]).contains(&("no_verbatim".into(), "true".into())));
        assert!(params(
            &ElevenLabsRealtimeConfig {
                api_key: "test-secret".into(),
                ..user
            },
            &[]
        )
        .contains(&("no_verbatim".into(), "false".into())));
        for patch in [
            json!({"vad_threshold":0.0}),
            json!({"vad_silence_threshold_secs":3.1}),
            json!({"min_speech_duration_ms":49}),
            json!({"min_silence_duration_ms":2001}),
            json!({"language":"zh-CN"}),
            json!({"commit_strategy":"auto"}),
        ] {
            let bad: ElevenLabsRealtimeConfig = serde_json::from_value(patch).unwrap();
            assert!(bad.validate().is_err());
        }
        assert!(serde_json::from_value::<ElevenLabsRealtimeConfig>(
            json!({"min_speech_duration_ms":100.5})
        )
        .is_err());
        assert!(serde_json::from_value::<ElevenLabsRealtimeConfig>(
            json!({"secondary_languages":"en"})
        )
        .is_err());
    }

    #[test]
    fn keyterms_are_opt_in_deduplicated_and_bounded() {
        let mut config = config();
        let words: Vec<_> = (0..51).map(|i| format!("word{i}")).collect();
        assert!(!params(&config, &words).iter().any(|(k, _)| k == "keyterms"));
        config.enable_keyterms = true;
        assert!(request(&config, &words, ENDPOINT).is_err());
        assert!(request(&config, &["x".repeat(21)], ENDPOINT).is_err());
        let pairs = params(&config, &[" A&B ".into(), "A&B".into(), "中文".into()]);
        assert_eq!(pairs.iter().filter(|(k, _)| k == "keyterms").count(), 2);
        assert!(pairs.contains(&("keyterms".into(), "A&B".into())));
        config.commit_strategy = "manual".into();
        assert!(!params(&config, &[])
            .iter()
            .any(|(k, _)| k.starts_with("vad_") || k.ends_with("_duration_ms")));
    }

    #[test]
    fn pcm_encoding_clamps_and_handles_invalid_samples() {
        let message = audio_message(&[-2.0, 0.0, 2.0, f32::NAN], false);
        let value: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
        let bytes = STANDARD
            .decode(value["audio_base_64"].as_str().unwrap())
            .unwrap();
        assert_eq!(bytes, [0, 128, 0, 0, 255, 127, 0, 0]);
        assert_eq!(value["sample_rate"], 16000);
        assert_eq!(value["commit"], false);
    }

    #[test]
    fn segments_keep_language_boundaries_and_existing_whitespace() {
        for (segments, expected) in [
            (vec!["hello", "world", "!"], "hello world!"),
            (vec!["你好", "世界", "。"], "你好世界。"),
            (vec!["hello ", " world"], "hello  world"),
            (vec!["Zażółć", "gęślą"], "Zażółć gęślą"),
        ] {
            let mut text = String::new();
            for segment in segments {
                append_segment(&mut text, segment);
            }
            assert_eq!(text, expected);
        }
    }

    #[test]
    fn errors_are_classified_without_echoing_secrets() {
        for (kind, fatal) in [
            ("auth_error", true),
            ("quota_exceeded", true),
            ("invalid_request", true),
            ("rate_limited", false),
            ("queue_overflow", false),
            ("session_time_limit_exceeded", false),
        ] {
            let (message, actual) = server_error(
                &json!({"message_type":kind,"error":"test-secret"}),
                "test-secret",
            )
            .unwrap();
            assert_eq!(actual, fatal);
            assert!(!message.contains("test-secret"));
        }
        assert!(server_error(&json!({"message_type":"warning"}), "test-secret").is_none());
    }

    #[test]
    fn editing_parameters_and_supported_strategies_follow_the_protocol() {
        let mut config = config();
        assert!(!params(&config, &[])
            .iter()
            .any(|(key, _)| key == "transcript_edit"));
        config.transcript_edit = "Use digits.\nKeep names & dates.".into();
        assert!(params(&config, &[])
            .contains(&("transcript_edit".into(), config.transcript_edit.clone())));
        config.transcript_edit = "x".repeat(2001);
        assert!(config.validate().is_err());
        config.transcript_edit.clear();
        config.commit_strategy = "turn_prediction".into();
        assert!(config.validate().is_err());
        config.commit_strategy = "vad".into();
        assert!(config.validate().is_ok());
        assert!(params(&config, &[])
            .iter()
            .any(|(key, _)| key == "vad_threshold"));
        config.commit_strategy = "manual".into();
        assert!(config.validate().is_ok());
        assert!(!params(&config, &[])
            .iter()
            .any(|(key, _)| key == "vad_threshold"));
    }

    type Server = WebSocketStream<TcpStream>;
    async fn mock() -> (String, tokio::task::JoinHandle<Server>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}/realtime", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            accept_async(tcp).await.unwrap()
        });
        (endpoint, server)
    }
    async fn send(server: &mut Server, kind: &str, text: &str) {
        server
            .send(Message::Text(
                json!({"message_type":kind,"text":text}).to_string().into(),
            ))
            .await
            .unwrap();
    }
    async fn session_with_edit(
        editing: bool,
    ) -> (
        Arc<dyn AsrSession>,
        mpsc::UnboundedReceiver<AsrEvent>,
        Server,
    ) {
        let (endpoint, server) = mock().await;
        let mut config = config();
        if editing {
            config.transcript_edit = "Use digits".into();
        }
        let client = tokio::spawn(connect_session(
            request(&config, &[], &endpoint).unwrap(),
            Duration::from_secs(2),
            config.api_key,
        ));
        let mut server = server.await.unwrap();
        send(&mut server, "session_started", "").await;
        let (session, events) = client.await.unwrap().unwrap();
        (Arc::from(session), events, server)
    }
    async fn session() -> (
        Arc<dyn AsrSession>,
        mpsc::UnboundedReceiver<AsrEvent>,
        Server,
    ) {
        session_with_edit(false).await
    }
    async fn next_audio(server: &mut Server) -> Value {
        timeout(Duration::from_secs(3), async {
            while let Some(message) = server.next().await {
                if let Ok(Message::Text(text)) = message {
                    return serde_json::from_str(&text).unwrap();
                }
            }
            panic!("server stream ended before expected request")
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn waits_for_session_started_and_rejects_startup_error() {
        let (endpoint, server) = mock().await;
        let client = tokio::spawn(connect_session(
            request(&config(), &[], &endpoint).unwrap(),
            Duration::ZERO,
            "test-secret".into(),
        ));
        let mut server = server.await.unwrap();
        assert!(!client.is_finished());
        send(&mut server, "auth_error", "").await;
        assert!(client.await.unwrap().err().unwrap().contains("API Key"));
    }

    #[tokio::test]
    async fn final_confirmation_ignores_interim_revision_instead_of_pasting_twice() {
        let (session, _events, mut server) = session().await;
        session.append_audio(&[0.1; 1600]);
        let copy = Arc::clone(&session);
        let result = tokio::spawn(async move { copy.commit_and_await_final().await });
        assert_eq!(next_audio(&mut server).await["commit"], false);
        assert_eq!(next_audio(&mut server).await["commit"], true);
        send(&mut server, "committed_transcript", "返回两遍嘛。").await;
        send(&mut server, "partial_transcript", "返回两遍吗？").await;
        assert_eq!(next_audio(&mut server).await["commit"], true);
        assert!(!result.is_finished());
        let confirmed_at = Instant::now();
        send(&mut server, "committed_transcript", "").await;
        assert_eq!(
            timeout(Duration::from_millis(150), result)
                .await
                .unwrap()
                .unwrap()
                .unwrap(),
            "返回两遍嘛。"
        );
        assert!(confirmed_at.elapsed() < Duration::from_millis(150));
        session.close();
    }

    #[tokio::test]
    async fn old_vad_commit_does_not_finish_before_the_actual_tail() {
        let (session, _events, mut server) = session().await;
        session.append_audio(&[0.1; 3200]);
        let copy = Arc::clone(&session);
        let result = tokio::spawn(async move { copy.commit_and_await_final().await });
        next_audio(&mut server).await;
        let first_at = Instant::now();
        next_audio(&mut server).await;
        assert!(first_at.elapsed() >= Duration::from_millis(85));
        next_audio(&mut server).await;
        send(&mut server, "committed_transcript", "first").await;
        send(&mut server, "partial_transcript", "second").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!result.is_finished());
        send(&mut server, "committed_transcript", "second").await;
        next_audio(&mut server).await;
        send(&mut server, "committed_transcript", "").await;
        assert_eq!(result.await.unwrap().unwrap(), "first second");
        session.close();
    }

    #[tokio::test]
    async fn identical_spoken_segments_are_preserved_without_text_deduplication() {
        let (session, mut events, mut server) = session().await;
        events.recv().await;
        session.append_audio(&[0.1; 1600]);
        next_audio(&mut server).await;
        send(&mut server, "committed_transcript", "再说一遍。").await;
        events.recv().await;
        session.append_audio(&[0.1; 1600]);
        let copy = Arc::clone(&session);
        let result = tokio::spawn(async move { copy.commit_and_await_final().await });
        next_audio(&mut server).await;
        next_audio(&mut server).await;
        send(&mut server, "committed_transcript", "再说一遍。").await;
        next_audio(&mut server).await;
        send(&mut server, "committed_transcript", "").await;
        assert_eq!(result.await.unwrap().unwrap(), "再说一遍。再说一遍。");
        session.close();
    }

    #[tokio::test]
    async fn silence_requires_server_confirmation_and_no_audio_returns_empty() {
        let (session, _events, mut server) = session().await;
        session.append_audio(&[0.0; 1600]);
        let copy = Arc::clone(&session);
        let result = tokio::spawn(async move { copy.commit_and_await_final().await });
        next_audio(&mut server).await;
        next_audio(&mut server).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!result.is_finished());
        send(&mut server, "committed_transcript", "").await;
        assert_eq!(result.await.unwrap().unwrap(), "");
        session.close();
        let (empty, _events, _server) = self::session().await;
        assert_eq!(
            timeout(Duration::from_millis(100), empty.commit_and_await_final())
                .await
                .unwrap()
                .unwrap(),
            ""
        );
        empty.close();
    }

    #[tokio::test]
    async fn timeout_or_error_never_returns_a_partial_as_final() {
        let (session, _events, mut server) = session().await;
        session.append_audio(&[0.1; 1600]);
        let copy = Arc::clone(&session);
        let result = tokio::spawn(async move { copy.commit_and_await_final().await });
        next_audio(&mut server).await;
        next_audio(&mut server).await;
        send(&mut server, "partial_transcript", "unconfirmed").await;
        assert!(result.await.unwrap().is_err());
        session.close();
    }

    #[tokio::test]
    async fn cancellation_interrupts_wait_and_repeated_stop_cannot_output_again() {
        let (session, _events, mut server) = session().await;
        session.append_audio(&[0.1; 1600]);
        let copy = Arc::clone(&session);
        let result = tokio::spawn(async move { copy.commit_and_await_final().await });
        next_audio(&mut server).await;
        next_audio(&mut server).await;
        assert!(session.commit_and_await_final().await.is_err());
        session.close();
        assert!(timeout(Duration::from_millis(100), result)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        assert!(!session.is_ready());
    }

    #[tokio::test]
    async fn normal_socket_close_does_not_replace_a_final_confirmation() {
        let (session, _events, mut server) = session().await;
        session.append_audio(&[0.1; 1600]);
        let copy = Arc::clone(&session);
        let result = tokio::spawn(async move { copy.commit_and_await_final().await });
        next_audio(&mut server).await;
        next_audio(&mut server).await;
        send(&mut server, "committed_transcript", "some text").await;
        server
            .close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
                code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Normal,
                reason: "Finished".into(),
            }))
            .await
            .unwrap();
        assert!(result.await.unwrap().is_err());
        session.close();
    }

    #[tokio::test]
    async fn edits_are_matched_out_of_order_and_never_append_the_original_twice() {
        let (session, _events, mut server) = session_with_edit(true).await;
        session.append_audio(&[0.1; 1600]);
        let copy = Arc::clone(&session);
        let result = tokio::spawn(async move { copy.commit_and_await_final().await });
        next_audio(&mut server).await;
        next_audio(&mut server).await;
        send(&mut server, "committed_transcript", "one").await;
        send(&mut server, "committed_transcript", "two").await;
        server
            .send(Message::Text(
                json!({"message_type":"edited_transcript","text":"two","edited_text":"2"})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        send(&mut server, "committed_transcript", "").await;
        assert!(!result.is_finished());
        server
            .send(Message::Text(
                json!({"message_type":"edited_transcript","text":"one","edited_text":"1"})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        assert_eq!(result.await.unwrap().unwrap(), "1 2");
        session.close();
    }

    #[tokio::test]
    async fn missing_edit_fails_instead_of_silently_using_the_original() {
        let (session, _events, mut server) = session_with_edit(true).await;
        session.append_audio(&[0.1; 1600]);
        let copy = Arc::clone(&session);
        let result = tokio::spawn(async move { copy.commit_and_await_final().await });
        next_audio(&mut server).await;
        next_audio(&mut server).await;
        send(&mut server, "committed_transcript", "one").await;
        send(&mut server, "committed_transcript", "").await;
        assert!(result.await.unwrap().unwrap_err().contains("转写编辑"));
        session.close();
    }

    #[tokio::test]
    async fn throttled_commit_retries_on_the_same_connection() {
        let (session, mut events, mut server) = session().await;
        events.recv().await;
        session.append_audio(&[0.1; 1600]);
        let copy = Arc::clone(&session);
        let result = tokio::spawn(async move { copy.commit_and_await_final().await });
        next_audio(&mut server).await;
        next_audio(&mut server).await;
        server
            .send(Message::Text(
                json!({"message_type":"commit_throttled","error":"Please commit less often"})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        assert!(matches!(
            events.recv().await,
            Some(AsrEvent::Warning { .. })
        ));
        assert!(session.is_ready());
        assert_eq!(next_audio(&mut server).await["commit"], true);
        send(&mut server, "committed_transcript", "").await;
        assert_eq!(result.await.unwrap().unwrap(), "");
        session.close();
    }

    #[tokio::test]
    async fn warning_is_visible_and_does_not_end_the_session() {
        let (session, mut events, mut server) = session().await;
        events.recv().await;
        server
            .send(Message::Text(
                json!({"message_type":"warning","warning":"test-secret not retained"})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let Some(AsrEvent::Warning { message }) = events.recv().await else {
            panic!("expected warning")
        };
        assert!(!message.contains("test-secret"));
        assert!(message.contains("not retained"));
        assert!(session.is_ready());
        session.close();
    }

    #[test]
    fn all_protocol_errors_keep_safe_reasons_and_setup_retry_policy() {
        for (kind, fatal) in [
            ("error", false),
            ("auth_error", true),
            ("quota_exceeded", true),
            ("commit_throttled", false),
            ("unaccepted_terms", true),
            ("rate_limited", false),
            ("queue_overflow", false),
            ("resource_exhausted", false),
            ("session_time_limit_exceeded", false),
            ("input_error", true),
            ("invalid_request", true),
            ("chunk_size_exceeded", true),
            ("insufficient_audio_activity", false),
            ("transcriber_error", false),
        ] {
            let (message, actual) = server_error(&json!({"message_type":kind,"error":"specific reason; xi-api-key=test-secret; token=other-secret"}), "test-secret").unwrap();
            assert_eq!(actual, fatal);
            assert!(message.contains("specific reason"));
            assert!(!message.contains("test-secret"));
            assert!(!message.contains("other-secret"));
            assert_eq!(retryable_start_error(&message), !fatal);
        }
        for message in [
            "请先填写 ElevenLabs API Key",
            "ElevenLabs 参数格式错误，请检查模型配置",
            "ElevenLabs 连接失败：HTTP 401，请检查 API Key、权限和余额",
        ] {
            assert!(!retryable_start_error(message));
        }
        for message in [
            "ElevenLabs 连接超时",
            "ElevenLabs 会话启动超时",
            "ElevenLabs 连接失败：HTTP 503，请检查 API Key、权限和余额",
        ] {
            assert!(retryable_start_error(message));
        }
    }

    #[test]
    fn only_an_explicit_zero_pending_audio_report_can_drain_the_session() {
        for duration in ["0", "0.00", "0.000"] {
            assert!(server_reports_no_uncommitted_audio(
                &json!({"error":format!("Commit request ignored: only {duration}s of uncommitted audio. You need at least 0.3s.")})
            ));
        }
        for duration in ["0.01", "0.20", "1.00"] {
            assert!(!server_reports_no_uncommitted_audio(
                &json!({"error":format!("Commit request ignored: only {duration}s of uncommitted audio. You need at least 0.3s.")})
            ));
        }
        assert!(!server_reports_no_uncommitted_audio(
            &json!({"error":"Please commit less often"})
        ));
    }

    #[tokio::test]
    async fn zero_pending_report_waits_for_the_server_close_and_does_not_paste_interim_text() {
        let (session, _events, mut server) = session().await;
        session.append_audio(&[0.1; 1600]);
        let copy = Arc::clone(&session);
        let result = tokio::spawn(async move { copy.commit_and_await_final().await });
        next_audio(&mut server).await;
        next_audio(&mut server).await;
        send(&mut server, "committed_transcript", "confirmed").await;
        send(&mut server, "partial_transcript", "confirmed but revised").await;
        assert_eq!(next_audio(&mut server).await["audio_base_64"], "");
        server.send(Message::Text(json!({"message_type":"commit_throttled","error":"Commit request ignored: only 0.00s of uncommitted audio. You need at least 0.3s of uncommitted audio before committing."}).to_string().into())).await.unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!result.is_finished());
        server
            .close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
                code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Normal,
                reason: "commit_throttled".into(),
            }))
            .await
            .unwrap();
        assert_eq!(result.await.unwrap().unwrap(), "confirmed");
        session.close();
    }

    #[tokio::test]
    async fn nonzero_pending_audio_is_a_failure_not_a_successful_drain() {
        let (session, _events, mut server) = session().await;
        session.append_audio(&[0.1; 1600]);
        let copy = Arc::clone(&session);
        let result = tokio::spawn(async move { copy.commit_and_await_final().await });
        next_audio(&mut server).await;
        next_audio(&mut server).await;
        server.send(Message::Text(json!({"message_type":"commit_throttled","error":"Commit request ignored: only 0.20s of uncommitted audio. You need at least 0.3s."}).to_string().into())).await.unwrap();
        server
            .close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
                code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Normal,
                reason: "commit_throttled".into(),
            }))
            .await
            .unwrap();
        assert!(result.await.unwrap().is_err());
        session.close();
    }

    #[tokio::test]
    async fn finish_rejects_further_audio_and_waits_for_server_confirmation() {
        let (session, _events, mut server) = session().await;
        session.append_audio(&[0.1; 1600]);
        let copy = Arc::clone(&session);
        let result = tokio::spawn(async move { copy.commit_and_await_final().await });
        next_audio(&mut server).await;
        next_audio(&mut server).await;
        session.append_audio(&[0.9; 1600]);
        send(&mut server, "committed_transcript", "only original audio").await;
        let request = next_audio(&mut server).await;
        assert_eq!(request["commit"], true);
        assert_eq!(request["audio_base_64"], "");
        send(&mut server, "committed_transcript", "").await;
        assert_eq!(result.await.unwrap().unwrap(), "only original audio");
        session.close();
    }

    /// Explicit opt-in: repository fixture only, paid keyterms/editing disabled.
    #[tokio::test]
    #[ignore = "requires ELEVENLABS_TEST_CONFIG and a paid API connection"]
    async fn live_vad_stop_protocol_trace() {
        let path = std::env::var("ELEVENLABS_TEST_CONFIG").expect("set config path");
        let root: serde_norway::Value =
            serde_norway::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let raw = root
            .get("audio")
            .and_then(|v| v.get("elevenlabs-realtime"))
            .expect("ElevenLabs config missing");
        let mut config: ElevenLabsRealtimeConfig =
            serde_norway::from_value(raw.clone()).unwrap_or_else(|_| panic!("invalid config"));
        assert!(!config.api_key.trim().is_empty(), "ElevenLabs key missing");
        config.commit_strategy = "vad".into();
        config.enable_keyterms = false;
        config.transcript_edit.clear();
        let wav = include_bytes!("../tests/fixtures/test-audio-short.wav");
        let mut offset = 12;
        let pcm = loop {
            let size = u32::from_le_bytes(wav[offset + 4..offset + 8].try_into().unwrap()) as usize;
            if &wav[offset..offset + 4] == b"data" {
                break &wav[offset + 8..offset + 8 + size];
            }
            offset += 8 + size + (size % 2);
        };
        let samples: Vec<f32> = pcm
            .chunks_exact(2)
            .map(|v| i16::from_le_bytes([v[0], v[1]]) as f32 / 32768.0)
            .collect();
        for silence_ms in [0_u64, 2500] {
            let (socket, _) = connect_async(request(&config, &[], ENDPOINT).unwrap())
                .await
                .expect("connect failed");
            let (mut sink, mut stream) = socket.split();
            let start = Instant::now();
            let reader = tokio::spawn(async move {
                let mut results = Vec::new();
                while let Some(Ok(message)) = stream.next().await {
                    if let Message::Text(text) = message {
                        let value: Value = serde_json::from_str(&text).unwrap();
                        eprintln!(
                            "TRACE +{}ms kind={} chars={} keys={:?}",
                            start.elapsed().as_millis(),
                            value["message_type"],
                            value["text"].as_str().unwrap_or("").chars().count(),
                            value.as_object().unwrap().keys().collect::<Vec<_>>()
                        );
                        results.push(value);
                    }
                }
                results
            });
            for chunk in samples.chunks(1600) {
                sink.send(audio_message(chunk, false)).await.unwrap();
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            for _ in 0..silence_ms / 100 {
                sink.send(audio_message(&[0.0; 1600], false)).await.unwrap();
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            eprintln!(
                "FINAL COMMIT +{}ms (silence {}ms)",
                start.elapsed().as_millis(),
                silence_ms
            );
            sink.send(audio_message(&[], true)).await.unwrap();
            tokio::time::sleep(Duration::from_secs(5)).await;
            sink.close().await.unwrap();
            let values = timeout(Duration::from_secs(2), reader)
                .await
                .unwrap()
                .unwrap();
            assert!(
                values
                    .iter()
                    .any(|v| v["message_type"] == "committed_transcript"),
                "no committed results"
            );
        }
    }
    #[tokio::test]
    #[ignore = "requires explicit paid API access via ELEVENLABS_TEST_CONFIG"]
    async fn live_vad_final_output() {
        let path = std::env::var("ELEVENLABS_TEST_CONFIG").expect("set config path");
        let root: serde_norway::Value =
            serde_norway::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let raw = root
            .get("audio")
            .and_then(|v| v.get("elevenlabs-realtime"))
            .expect("ElevenLabs config missing");
        let base: ElevenLabsRealtimeConfig =
            serde_norway::from_value(raw.clone()).unwrap_or_else(|_| panic!("invalid config"));
        assert!(!base.api_key.trim().is_empty(), "ElevenLabs key missing");
        let wav = include_bytes!("../tests/fixtures/test-audio-short.wav");
        let mut offset = 12;
        let pcm = loop {
            let size = u32::from_le_bytes(wav[offset + 4..offset + 8].try_into().unwrap()) as usize;
            if &wav[offset..offset + 4] == b"data" {
                break &wav[offset + 8..offset + 8 + size];
            }
            offset += 8 + size + (size % 2);
        };
        let samples: Vec<f32> = pcm
            .chunks_exact(2)
            .map(|v| i16::from_le_bytes([v[0], v[1]]) as f32 / 32768.0)
            .collect();
        let mut cases = vec![(0_u64, false), (2500, false)];
        if std::env::var("ELEVENLABS_TEST_EDITING").as_deref() == Ok("1") {
            cases.push((0, true));
        }
        if std::env::var("ELEVENLABS_TEST_SINGLE").as_deref() == Ok("1") {
            cases.truncate(1);
        }
        for (silence, editing) in cases {
            let mut config = base.clone();
            config.commit_strategy = "vad".into();
            config.enable_keyterms = false;
            config.transcript_edit = if editing {
                "保留原始语言和专有名词，将最后的问号改为句号。".into()
            } else {
                String::new()
            };
            let (session, mut events) = connect_session(
                request(&config, &[], ENDPOINT).unwrap(),
                FINAL_WINDOW,
                config.api_key.clone(),
            )
            .await
            .unwrap_or_else(|error| panic!("{}", safe_detail(&error, &config.api_key)));
            for chunk in samples.chunks(1600) {
                session.append_audio(chunk);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            for _ in 0..silence / 100 {
                session.append_audio(&[0.0; 1600]);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            let stopped = Instant::now();
            let result = timeout(Duration::from_secs(12), session.commit_and_await_final())
                .await
                .unwrap();
            if result.is_err() {
                while let Ok(event) = events.try_recv() {
                    if let AsrEvent::Warning { message } | AsrEvent::Error { message, .. } = event {
                        eprintln!("LIVE detail: {}", safe_detail(&message, &config.api_key));
                    }
                }
            }
            let text = result.unwrap();
            eprintln!(
                "LIVE final: silence={}ms editing={} stop_to_final={}ms chars={}",
                silence,
                editing,
                stopped.elapsed().as_millis(),
                text.chars().count()
            );
            assert!(!text.trim().is_empty());
            assert!(text.chars().count() < 100, "fixture appears duplicated");
            if editing {
                assert!(text.ends_with('。'));
            }
            session.close();
            while let Ok(event) = events.try_recv() {
                assert!(
                    !matches!(event, AsrEvent::Error { .. }),
                    "unexpected error event"
                );
            }
        }
    }
}

//! Qwen ASR over the shared DashScope WebSocket protocol.
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio::time::{sleep_until, timeout, Instant};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{client::IntoClientRequest, Message},
};

use super::{AsrEngine, AsrEvent, AsrSession};
use crate::errors::{AppError, AppErrorCode};

pub const DEFAULT_URL: &str = "wss://maas.qianwenaiapi.com/api-ws/v1/inference";
pub const MESSAGE_ID: &str = "qwen-asr-message";
pub const STREAMING_ID: &str = "qwen-asr-streaming";
const IO_TIMEOUT: Duration = Duration::from_secs(5);
// A quiet service times out quickly; active finalization gets a bounded grace period.
const FINAL_TIMEOUT: Duration = Duration::from_secs(10);
const FINAL_MAX_WAIT: Duration = Duration::from_secs(60);
const LANGUAGES: &[&str] = &[
    "zh", "en", "ja", "ko", "vi", "th", "id", "ms", "tl", "hi", "ar", "fr", "de", "es", "pt", "ru",
    "it", "nl", "sv", "da", "fi", "no", "el", "pl", "cs", "hu", "ro", "bg", "hr", "sk",
];

pub fn is_qwen_model(id: &str) -> bool {
    matches!(id, MESSAGE_ID | STREAMING_ID)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct QwenConfig {
    pub api_key: String,
    pub url: String,
    pub intermediate_result_enabled: bool,
    #[serde(alias = "disfluency_removal_enabled")]
    pub enable_ddc: bool,
    pub keep_dialect: bool,
    pub vad_model: String,
    pub max_sentence_silence: u32,
    pub heartbeat: bool,
    pub speech_noise_threshold: Option<f64>,
    pub language_hints: Vec<String>,
    pub multi_threshold_mode_enabled: bool,
}

impl Default for QwenConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            url: DEFAULT_URL.into(),
            intermediate_result_enabled: true,
            enable_ddc: true,
            keep_dialect: false,
            vad_model: "near_meeting_16k".into(),
            max_sentence_silence: 800,
            heartbeat: true,
            speech_noise_threshold: None,
            language_hints: vec![],
            multi_threshold_mode_enabled: false,
        }
    }
}

/// Normalize the first Qwen settings version before layering user overrides.
pub fn normalize_settings(fields: &mut Map<String, Value>) {
    if let Some(legacy) = fields.remove("disfluency_removal_enabled") {
        fields.entry("enable_ddc").or_insert(legacy);
    }
}

impl QwenConfig {
    pub fn endpoint(&self) -> &str {
        if self.url.trim().is_empty() {
            DEFAULT_URL
        } else {
            self.url.trim()
        }
    }

    pub fn validate(&self) -> Result<(), AppError> {
        let invalid = |field: &str| {
            AppError::new(AppErrorCode::AsrConfigFieldInvalid).with_param("field", field)
        };
        let endpoint = self.endpoint();
        let url = url::Url::parse(endpoint).map_err(|_| invalid("url"))?;
        if url.scheme() != "wss"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || endpoint.contains(['{', '}'])
            || endpoint.to_ascii_lowercase().contains("%7b")
            || endpoint.to_ascii_lowercase().contains("%7d")
        {
            return Err(invalid("url"));
        }
        if !matches!(
            self.vad_model.as_str(),
            "near_meeting_16k" | "far_field_meeting_16k"
        ) {
            return Err(invalid("vad_model"));
        }
        if !(200..=6000).contains(&self.max_sentence_silence) {
            return Err(invalid("max_sentence_silence"));
        }
        if self
            .speech_noise_threshold
            .is_some_and(|v| !v.is_finite() || !(-1.0..=1.0).contains(&v))
        {
            return Err(invalid("speech_noise_threshold"));
        }
        if self.language_hints.len() > 4
            || self
                .language_hints
                .iter()
                .any(|s| !LANGUAGES.contains(&s.as_str()))
        {
            return Err(invalid("language_hints"));
        }
        Ok(())
    }

    fn parameters(&self, message: bool, words: &[String]) -> (Value, usize) {
        let mut params = json!({"format":"pcm", "sample_rate":16000, "keep_dialect":self.keep_dialect,
            "vad_model":self.vad_model, "max_sentence_silence":self.max_sentence_silence, "heartbeat":self.heartbeat});
        if let Some(value) = self.speech_noise_threshold {
            params["speech_noise_threshold"] = json!(value);
        }
        if message {
            params["intermediate_result_enabled"] = json!(self.intermediate_result_enabled);
            params["disfluency_removal_enabled"] = json!(self.enable_ddc);
        } else {
            params["multi_threshold_mode_enabled"] = json!(self.multi_threshold_mode_enabled);
            if !self.language_hints.is_empty() {
                params["language_hints"] = json!(self.language_hints);
            }
        }
        let mut seen = BTreeSet::new();
        let mut vocabulary = Map::new();
        let mut skipped = 0;
        for word in words {
            let word = crate::hotword::strip_weight(word);
            if !seen.insert(word) {
                continue;
            }
            let valid = !word.is_empty()
                && if word.is_ascii() {
                    word.split(' ').filter(|s| !s.is_empty()).count() <= 7
                } else {
                    word.chars().count() <= 15
                };
            if !valid || vocabulary.len() == 2000 {
                skipped += 1;
                continue;
            }
            vocabulary.insert(word.into(), json!(4));
        }
        if !vocabulary.is_empty() {
            params["vocabulary"] = Value::Object(vocabulary);
        }
        (params, skipped)
    }
}

pub struct QwenEngine {
    config: QwenConfig,
    message: bool,
}
impl QwenEngine {
    pub fn new(config: QwenConfig, model_id: &str) -> Result<Self, AppError> {
        if !is_qwen_model(model_id) {
            return Err(AppError::new(AppErrorCode::AsrConfigInvalid));
        }
        Ok(Self {
            config,
            message: model_id == MESSAGE_ID,
        })
    }
}

fn needs_space(left: &str, right: &str) -> bool {
    left.chars()
        .last()
        .is_some_and(|c| c.is_ascii_alphanumeric() || ".!?,;:)\"".contains(c))
        && right
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
}

fn append_text(target: &mut String, text: &str) {
    if needs_space(target, text) {
        target.push(' ');
    }
    target.push_str(text);
}

#[derive(Default)]
struct Transcript {
    sentences: BTreeMap<u64, (String, bool)>,
    stash: Option<(u64, String)>,
}
impl Transcript {
    fn update(&mut self, sentence: &Value) -> Result<(), AppError> {
        if sentence["heartbeat"].as_bool() == Some(true) {
            return Ok(());
        }
        let text = sentence["text"].as_str().unwrap_or("");
        let Some(id) = sentence["sentence_id"].as_u64().filter(|v| *v > 0) else {
            return if text.is_empty() {
                Ok(())
            } else {
                Err(AppError::new(AppErrorCode::AsrProtocolError)
                    .with_detail("Qwen result is missing a positive sentence_id"))
            };
        };
        let finalized = sentence["sentence_end"].as_bool() == Some(true);
        if self
            .stash
            .as_ref()
            .is_some_and(|(stash_id, _)| *stash_id == id)
        {
            self.stash = None;
        }
        // A late partial must not undo an already finalized sentence.
        if !self
            .sentences
            .get(&id)
            .is_some_and(|(_, done)| *done && !finalized)
        {
            self.sentences.insert(id, (text.into(), finalized));
        }
        if let Some(stash) = sentence.get("stash") {
            if let (Some(id), Some(text)) = (stash["sentence_id"].as_u64(), stash["text"].as_str())
            {
                if id > 0 && !text.is_empty() && !self.sentences.contains_key(&id) {
                    self.stash = Some((id, text.into()));
                }
            }
        }
        Ok(())
    }
    fn display(&self) -> (String, String) {
        let mut final_text = String::new();
        let mut partial = BTreeMap::new();
        for (id, (text, done)) in &self.sentences {
            if *done {
                append_text(&mut final_text, text);
            } else {
                partial.insert(*id, text.as_str());
            }
        }
        if let Some((id, text)) = &self.stash {
            partial.entry(*id).or_insert(text);
        }
        let mut partial_text = String::new();
        for text in partial.values() {
            append_text(&mut partial_text, text);
        }
        if needs_space(&final_text, &partial_text) {
            partial_text.insert(0, ' ');
        }
        (final_text, partial_text)
    }
    fn finish(&self) -> Result<String, AppError> {
        let (text, partial) = self.display();
        if !partial.trim().is_empty() {
            Err(AppError::new(AppErrorCode::AsrNoFinalResult))
        } else {
            Ok(text)
        }
    }
}

#[derive(Default)]
struct State {
    transcript: Transcript,
    finishing: bool,
    finish_sent: Option<Instant>,
    last_result: Option<Instant>,
    result: Option<Result<String, AppError>>,
}
struct Runtime {
    state: Mutex<State>,
    changes: watch::Sender<u64>,
    cancel: watch::Sender<bool>,
    events: mpsc::UnboundedSender<AsrEvent>,
}
impl Runtime {
    fn changed(&self) {
        self.changes.send_modify(|v| *v = v.wrapping_add(1));
    }
    fn fail(&self, error: AppError) {
        let mut state = self.state.lock().unwrap();
        if state.result.is_some() {
            return;
        }
        state.result = Some(Err(error.clone()));
        drop(state);
        let _ = self.events.send(AsrEvent::Error { error, fatal: true });
        self.changed();
        let _ = self.cancel.send(true);
    }
}
enum Command {
    Audio(Vec<f32>),
    Finish,
}
struct QwenSession {
    runtime: Arc<Runtime>,
    commands: mpsc::UnboundedSender<Command>,
}

fn server_error(code: &str, message: &str) -> AppError {
    // Classify provider prose without retaining or displaying it.
    let code = format!("{code} {message}").to_ascii_lowercase();
    let mapped = if code.contains("auth")
        || code.contains("apikey")
        || code.contains("api_key")
        || code.contains("accessdenied")
        || code.contains("access_denied")
        || code.contains("permission")
    {
        AppErrorCode::AsrQwenAuth
    } else if code.contains("quota")
        || code.contains("balance")
        || code.contains("payment")
        || code.contains("arrear")
    {
        AppErrorCode::AsrQwenQuota
    } else if code.contains("limit") || code.contains("throttl") {
        AppErrorCode::AsrQwenRateLimited
    } else if code.contains("timeout") || code.contains("timed out") {
        AppErrorCode::AsrTimeout
    } else if code.contains("invalid")
        || code.contains("client_error")
        || code.contains("unsupported")
    {
        AppErrorCode::AsrRequestInvalid
    } else {
        AppErrorCode::AsrServerError
    };
    AppError::new(mapped)
}

#[async_trait]
impl AsrEngine for QwenEngine {
    async fn create_session(
        &self,
        words: &[String],
    ) -> Result<(Box<dyn AsrSession>, mpsc::UnboundedReceiver<AsrEvent>), AppError> {
        self.config.validate()?;
        if self.config.api_key.trim().is_empty() {
            return Err(
                AppError::new(AppErrorCode::AsrConfigMissing).with_param("field", "API Key")
            );
        }
        let mut request = self
            .config
            .endpoint()
            .into_client_request()
            .map_err(|_| AppError::new(AppErrorCode::AsrConfigInvalid))?;
        request.headers_mut().insert(
            "Authorization",
            format!("Bearer {}", self.config.api_key.trim())
                .parse()
                .map_err(|_| AppError::new(AppErrorCode::AsrConfigInvalid))?,
        );
        let (socket, _) = timeout(IO_TIMEOUT, connect_async_with_config(request, None, true))
            .await
            .map_err(|_| AppError::new(AppErrorCode::AsrTimeout))?
            .map_err(|e| match e {
                tokio_tungstenite::tungstenite::Error::Http(response) => {
                    match response.status().as_u16() {
                        401 | 403 => AppError::new(AppErrorCode::AsrQwenAuth),
                        402 => AppError::new(AppErrorCode::AsrQwenQuota),
                        429 => AppError::new(AppErrorCode::AsrQwenRateLimited),
                        400..=499 => AppError::new(AppErrorCode::AsrRequestInvalid),
                        _ => AppError::new(AppErrorCode::AsrServerError),
                    }
                }
                _ => AppError::new(AppErrorCode::AsrNetwork),
            })?;
        setup_session(socket, &self.config, self.message, words).await
    }
}

async fn setup_session<S>(
    mut socket: tokio_tungstenite::WebSocketStream<S>,
    config: &QwenConfig,
    message: bool,
    words: &[String],
) -> Result<(Box<dyn AsrSession>, mpsc::UnboundedReceiver<AsrEvent>), AppError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let task_id = uuid::Uuid::new_v4().to_string();
    let (parameters, skipped) = config.parameters(message, words);
    let model = if message {
        "qwen-audio-3.1-asr-flash-message"
    } else {
        "qwen-audio-3.1-asr-flash-streaming"
    };
    let run = json!({"header":{"action":"run-task", "task_id":task_id, "streaming":"duplex"},
            "payload":{"task_group":"audio", "task":"asr", "function":"recognition", "model":model, "parameters":parameters, "input":{}}});
    timeout(
        IO_TIMEOUT,
        socket.send(Message::Text(run.to_string().into())),
    )
    .await
    .map_err(|_| AppError::new(AppErrorCode::AsrTimeout))?
    .map_err(|_| AppError::new(AppErrorCode::AsrNetwork))?;
    timeout(IO_TIMEOUT, async {
        loop {
            match socket.next().await {
                Some(Ok(Message::Text(text))) => {
                    let value: Value = serde_json::from_str(&text)
                        .map_err(|_| AppError::new(AppErrorCode::AsrRecognizeFailed))?;
                    if value["header"]["task_id"].as_str() != Some(task_id.as_str()) {
                        log_asr!(
                            debug,
                            "Qwen ignored event={} task_id_matches=false",
                            value["header"]["event"].as_str().unwrap_or("unknown")
                        );
                        continue;
                    }
                    match value["header"]["event"].as_str() {
                        Some("task-started") => return Ok(()),
                        Some("task-failed") => {
                            return Err(server_error(
                                value["header"]["error_code"].as_str().unwrap_or(""),
                                value["header"]["error_message"].as_str().unwrap_or(""),
                            ))
                        }
                        _ => {}
                    }
                }
                Some(Ok(Message::Ping(data))) => {
                    socket
                        .send(Message::Pong(data))
                        .await
                        .map_err(|_| AppError::new(AppErrorCode::AsrNetwork))?;
                }
                Some(Ok(Message::Close(_))) | None => {
                    return Err(AppError::new(AppErrorCode::AsrConnectClosed))
                }
                Some(Err(_)) => return Err(AppError::new(AppErrorCode::AsrNetwork)),
                _ => {}
            }
        }
    })
    .await
    .map_err(|_| AppError::new(AppErrorCode::AsrTimeout))??;
    Ok(start_session(socket, task_id, skipped))
}

fn start_session<S>(
    socket: tokio_tungstenite::WebSocketStream<S>,
    task_id: String,
    skipped: usize,
) -> (Box<dyn AsrSession>, mpsc::UnboundedReceiver<AsrEvent>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (events, receiver) = mpsc::unbounded_channel();
    let runtime = Arc::new(Runtime {
        state: Mutex::new(State::default()),
        changes: watch::channel(0).0,
        cancel: watch::channel(false).0,
        events,
    });
    let _ = runtime.events.send(AsrEvent::Open);
    if skipped > 0 {
        let _ = runtime.events.send(AsrEvent::Warning {
            error: AppError::new(AppErrorCode::AsrQwenHotwordsSkipped)
                .with_param("count", skipped.to_string()),
        });
    }
    let (commands, mut incoming) = mpsc::unbounded_channel();
    let (mut sink, mut source) = socket.split();
    let writer_task_id = task_id.clone();
    let (pongs, mut pong_rx) = mpsc::unbounded_channel();
    let writer = runtime.clone();
    let mut writer_cancel = runtime.cancel.subscribe();
    tokio::spawn(async move {
        let work = async {
            let mut next_audio = Instant::now();
            let mut buffered = VecDeque::new();
            let mut finishing = false;
            let mut finished = false;
            let mut sent_samples = 0usize;
            loop {
                if finishing && buffered.is_empty() && !finished {
                    writer.state.lock().unwrap().finish_sent = Some(Instant::now());
                    writer.changed();
                    let finish = json!({"header":{"action":"finish-task", "task_id":writer_task_id, "streaming":"duplex"}, "payload":{"input":{}}});
                    timeout(
                        IO_TIMEOUT,
                        sink.send(Message::Text(finish.to_string().into())),
                    )
                    .await
                    .map_err(|_| AppError::new(AppErrorCode::AsrTimeout))?
                    .map_err(|_| AppError::new(AppErrorCode::AsrNetwork))?;
                    log_asr!(
                        debug,
                        "Qwen finish-task sent task={} audio_ms={}",
                        writer_task_id,
                        sent_samples * 1000 / 16000
                    );
                    finished = true;
                }
                let packet = tokio::select! {
                    pong = pong_rx.recv() => match pong { Some(data) => Some(Message::Pong(data)), None => break },
                    command = incoming.recv(), if !finishing => match command {
                        Some(Command::Audio(samples)) => { buffered.extend(samples); None },
                        Some(Command::Finish) => {
                            log_asr!(debug, "Qwen draining task={} queued_audio_ms={}", writer_task_id, buffered.len() * 1000 / 16000);
                            finishing = true; None
                        },
                        None => break,
                    },
                    _ = sleep_until(next_audio), if !buffered.is_empty() => {
                        // Coalesce a backlog within the documented 16 KB frame recommendation.
                        let count = if buffered.len() >= 8000 { 8000 } else { buffered.len().min(1600) };
                        sent_samples += count;
                        let bytes: Vec<u8> = buffered.drain(..count).flat_map(|v: f32| ((v.clamp(-1.0, 1.0) * 32768.0).clamp(-32768.0, 32767.0) as i16).to_le_bytes()).collect();
                        // Anchor pacing to the audio clock so slow writes do not accumulate drift.
                        next_audio += Duration::from_secs_f64(count as f64 / 16000.0);
                        Some(Message::Binary(bytes.into()))
                    }
                };
                if let Some(packet) = packet {
                    timeout(IO_TIMEOUT, sink.send(packet))
                        .await
                        .map_err(|_| AppError::new(AppErrorCode::AsrTimeout))?
                        .map_err(|_| AppError::new(AppErrorCode::AsrNetwork))?;
                }
            }
            Ok::<(), AppError>(())
        };
        tokio::select! {
            result = work => if let Err(error) = result { writer.fail(error); },
            _ = writer_cancel.changed() => {},
        }
        let _ = timeout(IO_TIMEOUT, sink.close()).await;
    });
    let reader = runtime.clone();
    let mut reader_cancel = runtime.cancel.subscribe();
    tokio::spawn(async move {
        loop {
            let next = tokio::select! { _ = reader_cancel.changed() => break, next = source.next() => next };
            match next {
                Some(Ok(Message::Text(text))) => {
                    let Ok(value) = serde_json::from_str::<Value>(&text) else {
                        reader.fail(AppError::new(AppErrorCode::AsrRecognizeFailed));
                        break;
                    };
                    if value["header"]["task_id"].as_str() != Some(task_id.as_str()) {
                        log_asr!(
                            debug,
                            "Qwen ignored event={} task_id_matches=false",
                            value["header"]["event"].as_str().unwrap_or("unknown")
                        );
                        continue;
                    }
                    log_asr!(
                        debug,
                        "Qwen event={} task={} input_tokens={} output_tokens={} sentence_id={} sentence_end={}",
                        value["header"]["event"].as_str().unwrap_or("unknown"),
                        task_id,
                        value["payload"]["usage"]["input_tokens"]
                            .as_u64()
                            .unwrap_or(0),
                        value["payload"]["usage"]["output_tokens"]
                            .as_u64()
                            .unwrap_or(0),
                        value["payload"]["output"]["sentence"]["sentence_id"].as_u64().unwrap_or(0),
                        value["payload"]["output"]["sentence"]["sentence_end"].as_bool().unwrap_or(false)
                    );
                    match value["header"]["event"].as_str() {
                        Some("result-generated") => {
                            let mut state = reader.state.lock().unwrap();
                            if let Err(error) = state
                                .transcript
                                .update(&value["payload"]["output"]["sentence"])
                            {
                                drop(state);
                                reader.fail(error);
                                break;
                            }
                            let sentence = &value["payload"]["output"]["sentence"];
                            if sentence["heartbeat"].as_bool() != Some(true)
                                && sentence["text"]
                                    .as_str()
                                    .is_some_and(|text| !text.trim().is_empty())
                            {
                                state.last_result = Some(Instant::now());
                            }
                            let (final_text, partial_text) = state.transcript.display();
                            drop(state);
                            reader.changed();
                            let _ = reader.events.send(AsrEvent::Transcript {
                                final_text,
                                partial_text,
                            });
                        }
                        Some("task-finished") => {
                            let mut state = reader.state.lock().unwrap();
                            let result = if state.finish_sent.is_some() {
                                state.transcript.finish()
                            } else {
                                Err(AppError::new(AppErrorCode::AsrNoFinalResult))
                            };
                            let error = result.as_ref().err().cloned();
                            if state.result.is_none() {
                                state.result = Some(result);
                            }
                            drop(state);
                            reader.changed();
                            if let Some(error) = error {
                                let _ = reader.events.send(AsrEvent::Error { error, fatal: true });
                            }
                            let _ = reader.cancel.send(true);
                            break;
                        }
                        Some("task-failed") => {
                            reader.fail(server_error(
                                value["header"]["error_code"].as_str().unwrap_or(""),
                                value["header"]["error_message"].as_str().unwrap_or(""),
                            ));
                            break;
                        }
                        _ => {}
                    }
                }
                Some(Ok(Message::Ping(data))) => {
                    let _ = pongs.send(data);
                }
                Some(Ok(Message::Close(_))) | None => {
                    reader.fail(AppError::new(AppErrorCode::AsrConnectClosed));
                    break;
                }
                Some(Err(_)) => {
                    reader.fail(AppError::new(AppErrorCode::AsrNetwork));
                    break;
                }
                _ => {}
            }
        }
    });
    (Box::new(QwenSession { runtime, commands }), receiver)
}

#[async_trait]
impl AsrSession for QwenSession {
    fn is_ready(&self) -> bool {
        let state = self.runtime.state.lock().unwrap();
        !state.finishing && state.result.is_none()
    }
    fn append_audio(&self, samples: &[f32]) {
        let state = self.runtime.state.lock().unwrap();
        if state.finishing || state.result.is_some() || samples.is_empty() {
            return;
        }
        let failed = self
            .commands
            .send(Command::Audio(samples.to_vec()))
            .is_err();
        drop(state);
        if failed {
            self.runtime
                .fail(AppError::new(AppErrorCode::AsrSessionClosed));
        }
    }
    async fn commit_and_await_final(&self) -> Result<String, AppError> {
        let mut changed = self.runtime.changes.subscribe();
        {
            let mut state = self.runtime.state.lock().unwrap();
            if state.finishing {
                return Err(AppError::new(AppErrorCode::AsrSessionClosed));
            }
            state.finishing = true;
            if let Some(result) = &state.result {
                return result.clone();
            }
            self.commands
                .send(Command::Finish)
                .map_err(|_| AppError::new(AppErrorCode::AsrSessionClosed))?;
        }
        loop {
            let deadline = {
                let state = self.runtime.state.lock().unwrap();
                if let Some(result) = &state.result {
                    return result.clone();
                }
                state.finish_sent.map(|sent| {
                    let progress = state.last_result.unwrap_or(sent).max(sent);
                    (progress + FINAL_TIMEOUT).min(sent + FINAL_MAX_WAIT)
                })
            };
            if let Some(deadline) = deadline {
                tokio::select! {
                    _ = sleep_until(deadline) => {
                        self.runtime.fail(AppError::new(AppErrorCode::AsrFinalTimeout));
                    },
                    _ = changed.changed() => {},
                }
            } else {
                let _ = changed.changed().await;
            }
        }
    }
    fn close(&self) {
        let mut state = self.runtime.state.lock().unwrap();
        if state.result.is_none() {
            state.result = Some(Err(AppError::new(AppErrorCode::Cancelled)));
        }
        drop(state);
        self.runtime.changed();
        let _ = self.runtime.cancel.send(true);
    }
}
impl Drop for QwenSession {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::DuplexStream;
    use tokio_tungstenite::{tungstenite::protocol::Role, WebSocketStream};

    async fn sockets() -> (WebSocketStream<DuplexStream>, WebSocketStream<DuplexStream>) {
        let (a, b) = tokio::io::duplex(64 * 1024);
        tokio::join!(
            WebSocketStream::from_raw_socket(a, Role::Client, None),
            WebSocketStream::from_raw_socket(b, Role::Server, None)
        )
    }
    async fn send(
        server: &mut WebSocketStream<DuplexStream>,
        id: &str,
        event: &str,
        sentence: Value,
    ) {
        let value = json!({"header":{"task_id":id,"event":event},"payload":{"output":{"sentence":sentence}}});
        server
            .send(Message::Text(value.to_string().into()))
            .await
            .unwrap();
    }
    fn sentence(id: u64, text: &str, done: bool) -> Value {
        json!({"sentence_id":id,"text":text,"sentence_end":done})
    }
    async fn finish_request(server: &mut WebSocketStream<DuplexStream>) -> Value {
        loop {
            if let Some(Ok(Message::Text(text))) = server.next().await {
                return serde_json::from_str(&text).unwrap();
            }
        }
    }

    #[test]
    fn malformed_sentence_reports_protocol_error_without_discarding_previous_text() {
        let mut transcript = Transcript::default();
        transcript.update(&sentence(1, "Hello", true)).unwrap();
        let error = transcript.update(&json!({"text":"world"})).unwrap_err();
        assert_eq!(error.code, AppErrorCode::AsrProtocolError);
        assert_eq!(transcript.finish().unwrap(), "Hello");
        transcript
            .update(&json!({"heartbeat":true,"sentence_id":0}))
            .unwrap();
    }

    #[test]
    fn failures_have_safe_distinct_codes() {
        for (code, message, expected) in [
            ("InvalidApiKey", "", AppErrorCode::AsrQwenAuth),
            (
                "CLIENT_ERROR",
                "insufficient balance",
                AppErrorCode::AsrQwenQuota,
            ),
            ("Throttling", "", AppErrorCode::AsrQwenRateLimited),
            (
                "CLIENT_ERROR",
                "request timeout after 23 seconds",
                AppErrorCode::AsrTimeout,
            ),
            (
                "CLIENT_ERROR",
                "invalid parameter",
                AppErrorCode::AsrRequestInvalid,
            ),
            ("SERVER_ERROR", "", AppErrorCode::AsrServerError),
        ] {
            let error = server_error(code, message);
            assert_eq!(error.code, expected);
            assert!(error.detail.is_none());
        }
    }

    #[test]
    fn endpoints_and_parameters_are_validated_without_domain_routing() {
        let mut config = QwenConfig::default();
        config.url = "  ".into();
        assert_eq!(config.endpoint(), DEFAULT_URL);
        for url in [
            "wss://gateway.example/asr",
            "wss://space.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference",
        ] {
            config.url = url.into();
            config.validate().unwrap();
            assert_eq!(config.endpoint(), url);
        }
        for url in [
            "https://example.com",
            "wss://{WorkspaceId}.example.com/asr",
            "wss://example.com/%7BWorkspaceId%7D",
            "wss://user@example.com",
        ] {
            config.url = url.into();
            assert!(config.validate().is_err(), "{url}");
        }
        config.url = DEFAULT_URL.into();
        config.max_sentence_silence = 199;
        assert!(config.validate().is_err());
        config.max_sentence_silence = 800;
        config.speech_noise_threshold = Some(1.1);
        assert!(config.validate().is_err());
        config.speech_noise_threshold = None;
        config.language_hints = vec!["xx".into()];
        assert!(config.validate().is_err());
        config.language_hints = vec!["zh".into(); 5];
        assert!(config.validate().is_err());
        assert!(serde_json::from_value::<QwenConfig>(json!({"heartbeat":"true"})).is_err());
    }

    #[test]
    fn canonical_smoothing_overrides_legacy_and_only_wire_name_is_sent() {
        assert_eq!(QwenConfig::default().vad_model, "near_meeting_16k");
        let mut fields = json!({"enable_ddc":false,"disfluency_removal_enabled":true})
            .as_object()
            .unwrap()
            .clone();
        normalize_settings(&mut fields);
        let config: QwenConfig = serde_json::from_value(Value::Object(fields)).unwrap();
        let params = config.parameters(true, &[]).0;
        assert_eq!(params["disfluency_removal_enabled"], false);
        assert!(params.get("enable_ddc").is_none());
    }

    #[test]
    fn supported_parameters_are_explicit_and_user_overrides_win() {
        let config: QwenConfig = serde_json::from_value(json!({"intermediate_result_enabled":false,"disfluency_removal_enabled":false,"language_hints":["zh","en"],"speech_noise_threshold":0.2,"format":"mp3","platform":"anything"})).unwrap();
        let (message, _) = config.parameters(true, &[]);
        assert_eq!(message["format"], "pcm");
        assert_eq!(message["sample_rate"], 16000);
        assert_eq!(message["intermediate_result_enabled"], false);
        assert_eq!(message["disfluency_removal_enabled"], false);
        assert_eq!(message["speech_noise_threshold"], 0.2);
        assert!(message.get("language_hints").is_none());
        assert!(message.get("platform").is_none());
        let (streaming, _) = config.parameters(false, &[]);
        assert_eq!(streaming["language_hints"], json!(["zh", "en"]));
        assert!(streaming.get("intermediate_result_enabled").is_none());
        assert!(streaming.get("disfluency_removal_enabled").is_none());
        assert!(QwenConfig::default()
            .parameters(true, &[])
            .0
            .get("speech_noise_threshold")
            .is_none());
    }

    #[test]
    fn hotwords_are_deduplicated_validated_and_capped_stably() {
        let mut words = vec![
            "VoicePaste|8".into(),
            " VoicePaste ".into(),
            "".into(),
            "中".repeat(16),
            "one two three four five six seven eight".into(),
        ];
        words.extend((0..2000).map(|i| format!("term{i}")));
        let (params, skipped) = QwenConfig::default().parameters(true, &words);
        let vocabulary = params["vocabulary"].as_object().unwrap();
        assert_eq!(vocabulary.len(), 2000);
        assert_eq!(vocabulary["VoicePaste"], 4);
        assert!(!vocabulary.contains_key("VoicePaste|8"));
        assert!(vocabulary.contains_key("term1998"));
        assert!(!vocabulary.contains_key("term1999"));
        assert_eq!(skipped, 4);
    }

    #[test]
    fn sentence_boundaries_preserve_english_spacing_and_chinese_text() {
        let mut transcript = Transcript::default();
        transcript.update(&sentence(1, "Hello.", true)).unwrap();
        transcript.update(&sentence(2, "Next", false)).unwrap();
        assert_eq!(transcript.display(), ("Hello.".into(), " Next".into()));
        transcript
            .update(&sentence(2, "Next sentence.", true))
            .unwrap();
        assert_eq!(transcript.finish().unwrap(), "Hello. Next sentence.");
        let mut transcript = Transcript::default();
        transcript.update(&sentence(1, "第一句。", true)).unwrap();
        transcript.update(&sentence(2, "第二句。", true)).unwrap();
        assert_eq!(transcript.finish().unwrap(), "第一句。第二句。");
    }

    #[test]
    fn transcript_replaces_revisions_and_stash_without_duplication() {
        let mut transcript = Transcript::default();
        transcript.update(&sentence(1, "我呃想", false)).unwrap();
        transcript.update(&sentence(1, "我想", false)).unwrap();
        let mut first = sentence(1, "我想试试。", true);
        first["stash"] = sentence(2, "下一句", false);
        transcript.update(&first).unwrap();
        transcript.update(&first).unwrap();
        assert_eq!(transcript.display(), ("我想试试。".into(), "下一句".into()));
        assert!(transcript.finish().is_err());
        transcript.update(&sentence(2, "下一句。", true)).unwrap();
        transcript
            .update(&sentence(1, "旧的临时文本", false))
            .unwrap();
        transcript
            .update(&json!({"heartbeat":true,"text":"ignored"}))
            .unwrap();
        transcript.update(&sentence(3, "", false)).unwrap();
        assert_eq!(transcript.finish().unwrap(), "我想试试。下一句。");
    }

    #[tokio::test]
    async fn setup_waits_for_started_and_sends_only_supported_parameters() {
        let (client, mut server) = sockets().await;
        let setup =
            tokio::spawn(
                async move { setup_session(client, &QwenConfig::default(), true, &[]).await },
            );
        let run = finish_request(&mut server).await;
        assert_eq!(run["header"]["action"], "run-task");
        assert_eq!(run["payload"]["model"], "qwen-audio-3.1-asr-flash-message");
        assert_eq!(
            run["payload"]["parameters"]["intermediate_result_enabled"],
            true
        );
        assert!(!setup.is_finished());
        assert!(timeout(Duration::from_millis(20), server.next())
            .await
            .is_err());
        send(
            &mut server,
            run["header"]["task_id"].as_str().unwrap(),
            "task-started",
            Value::Null,
        )
        .await;
        let (session, _) = setup.await.unwrap().unwrap();
        assert!(session.is_ready());
        session.close();
    }

    #[tokio::test]
    async fn finish_drains_audio_then_waits_for_tail_and_confirmation() {
        let (client, mut server) = sockets().await;
        let (session, _) = start_session(client, "test".into(), 0);
        let session: Arc<dyn AsrSession> = Arc::from(session);
        session.append_audio(&vec![0.5; 3201]);
        let copy = session.clone();
        let result = tokio::spawn(async move { copy.commit_and_await_final().await });
        let started = Instant::now();
        let mut sizes = vec![];
        loop {
            match server.next().await.unwrap().unwrap() {
                Message::Binary(bytes) => {
                    sizes.push(bytes.len());
                    assert_eq!(&bytes[..2], &16384_i16.to_le_bytes());
                }
                Message::Text(text) => {
                    assert_eq!(
                        serde_json::from_str::<Value>(&text).unwrap()["header"]["action"],
                        "finish-task"
                    );
                    break;
                }
                _ => {}
            }
        }
        assert_eq!(sizes, vec![3200, 3200, 2]);
        assert!(started.elapsed() >= Duration::from_millis(180));
        send(
            &mut server,
            "test",
            "result-generated",
            sentence(1, "尾句", false),
        )
        .await;
        assert!(!result.is_finished());
        send(
            &mut server,
            "test",
            "result-generated",
            sentence(1, "尾句。", true),
        )
        .await;
        assert!(!result.is_finished());
        send(&mut server, "test", "task-finished", Value::Null).await;
        assert_eq!(result.await.unwrap().unwrap(), "尾句。");
        assert!(session.commit_and_await_final().await.is_err());
        session.append_audio(&[0.5; 1600]);
        session.close();
    }

    #[tokio::test]
    async fn final_only_mode_accepts_multiple_final_sentences_and_ignores_other_tasks() {
        let (client, mut server) = sockets().await;
        let (session, mut events) = start_session(client, "test".into(), 1);
        assert!(matches!(events.recv().await, Some(AsrEvent::Open)));
        assert!(matches!(
            events.recv().await,
            Some(AsrEvent::Warning { .. })
        ));
        let result = tokio::spawn(async move { session.commit_and_await_final().await });
        finish_request(&mut server).await;
        send(
            &mut server,
            "other-task",
            "result-generated",
            sentence(1, "wrong", true),
        )
        .await;
        send(
            &mut server,
            "test",
            "result-generated",
            sentence(1, "第一句。", true),
        )
        .await;
        send(
            &mut server,
            "test",
            "result-generated",
            sentence(2, "第二句。", true),
        )
        .await;
        send(&mut server, "test", "task-finished", Value::Null).await;
        assert_eq!(result.await.unwrap().unwrap(), "第一句。第二句。");
    }

    #[tokio::test]
    async fn incomplete_tail_or_early_close_never_returns_partial_as_final() {
        for close in [false, true] {
            let (client, mut server) = sockets().await;
            let (session, _) = start_session(client, "test".into(), 0);
            let result = tokio::spawn(async move { session.commit_and_await_final().await });
            finish_request(&mut server).await;
            send(
                &mut server,
                "test",
                "result-generated",
                sentence(1, "已确认", true),
            )
            .await;
            send(
                &mut server,
                "test",
                "result-generated",
                sentence(2, "未确认", false),
            )
            .await;
            if close {
                server.close(None).await.unwrap();
            } else {
                send(&mut server, "test", "task-finished", Value::Null).await;
            }
            assert!(result.await.unwrap().is_err());
        }
    }

    #[tokio::test]
    async fn cancellation_interrupts_final_wait() {
        let (client, mut server) = sockets().await;
        let (session, _) = start_session(client, "test".into(), 0);
        let session: Arc<dyn AsrSession> = Arc::from(session);
        let copy = session.clone();
        let result = tokio::spawn(async move { copy.commit_and_await_final().await });
        finish_request(&mut server).await;
        session.close();
        assert_eq!(
            timeout(Duration::from_millis(200), result)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err()
                .code,
            AppErrorCode::Cancelled
        );
    }

    #[tokio::test]
    async fn empty_recording_finishes_without_inventing_text() {
        let (client, mut server) = sockets().await;
        let (session, _) = start_session(client, "test".into(), 0);
        let result = tokio::spawn(async move { session.commit_and_await_final().await });
        finish_request(&mut server).await;
        send(&mut server, "test", "task-finished", Value::Null).await;
        assert_eq!(result.await.unwrap().unwrap(), "");
    }

    #[tokio::test]
    async fn pings_are_answered_while_waiting_for_final_confirmation() {
        let (client, mut server) = sockets().await;
        let (session, _) = start_session(client, "test".into(), 0);
        let result = tokio::spawn(async move { session.commit_and_await_final().await });
        finish_request(&mut server).await;
        server.send(Message::Ping(vec![1, 2].into())).await.unwrap();
        let pong = timeout(Duration::from_millis(300), server.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(matches!(pong, Message::Pong(_)));
        send(&mut server, "test", "task-finished", Value::Null).await;
        assert!(result.await.unwrap().is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn ongoing_results_extend_final_wait_until_task_finished() {
        let (client, mut server) = sockets().await;
        let (session, _) = start_session(client, "test".into(), 0);
        let result = tokio::spawn(async move { session.commit_and_await_final().await });
        finish_request(&mut server).await;
        for _ in 0..4 {
            tokio::time::sleep(Duration::from_secs(9)).await;
            send(
                &mut server,
                "test",
                "result-generated",
                sentence(1, "still processing", false),
            )
            .await;
            tokio::task::yield_now().await;
            assert!(
                !result.is_finished(),
                "active results must not hit a fixed 10s timeout"
            );
        }
        send(
            &mut server,
            "test",
            "result-generated",
            sentence(1, "Confirmed.", true),
        )
        .await;
        send(&mut server, "test", "task-finished", Value::Null).await;
        assert_eq!(result.await.unwrap().unwrap(), "Confirmed.");
    }

    #[tokio::test(start_paused = true)]
    async fn ongoing_results_cannot_extend_final_wait_forever() {
        let (client, mut server) = sockets().await;
        let (session, _) = start_session(client, "test".into(), 0);
        let result = tokio::spawn(async move { session.commit_and_await_final().await });
        finish_request(&mut server).await;
        for _ in 0..6 {
            tokio::time::sleep(Duration::from_secs(9)).await;
            send(
                &mut server,
                "test",
                "result-generated",
                sentence(1, "still processing", false),
            )
            .await;
            tokio::task::yield_now().await;
        }
        tokio::time::sleep(Duration::from_secs(7)).await;
        assert_eq!(
            result.await.unwrap().unwrap_err().code,
            AppErrorCode::AsrFinalTimeout
        );
    }

    #[tokio::test(start_paused = true)]
    async fn heartbeat_does_not_extend_final_wait() {
        let (client, mut server) = sockets().await;
        let (session, _) = start_session(client, "test".into(), 0);
        let result = tokio::spawn(async move { session.commit_and_await_final().await });
        finish_request(&mut server).await;
        tokio::time::sleep(Duration::from_secs(9)).await;
        send(
            &mut server,
            "test",
            "result-generated",
            json!({"heartbeat":true,"text":"heartbeat"}),
        )
        .await;
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(
            result.await.unwrap().unwrap_err().code,
            AppErrorCode::AsrFinalTimeout
        );
    }

    #[tokio::test(start_paused = true)]
    async fn startup_backlog_is_coalesced_into_bounded_pcm_frames() {
        let (client, mut server) = sockets().await;
        let (session, _) = start_session(client, "test".into(), 0);
        let mut samples = vec![0.25; 8000];
        samples.push(0.75);
        session.append_audio(&samples);
        let result = tokio::spawn(async move { session.commit_and_await_final().await });
        let Some(Ok(Message::Binary(first))) = server.next().await else {
            panic!("expected audio");
        };
        assert_eq!(first.len(), 16000);
        assert!(first.chunks_exact(2).all(|v| v == 8192_i16.to_le_bytes()));
        let Some(Ok(Message::Binary(tail))) = server.next().await else {
            panic!("expected tail");
        };
        assert_eq!(&tail[..], &24576_i16.to_le_bytes());
        assert_eq!(
            finish_request(&mut server).await["header"]["action"],
            "finish-task"
        );
        send(&mut server, "test", "task-finished", Value::Null).await;
        assert!(result.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn final_confirmation_timeout_is_an_error() {
        let (client, mut server) = sockets().await;
        let (session, _) = start_session(client, "test".into(), 0);
        let result = tokio::spawn(async move { session.commit_and_await_final().await });
        finish_request(&mut server).await;
        send(
            &mut server,
            "test",
            "result-generated",
            sentence(1, "confirmed sentence", true),
        )
        .await;
        assert_eq!(
            timeout(FINAL_TIMEOUT + Duration::from_secs(1), result)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err()
                .code,
            AppErrorCode::AsrFinalTimeout
        );
    }

    #[tokio::test]
    async fn setup_rejection_and_timeout_are_not_success() {
        for reject in [true, false] {
            let (client, mut server) = sockets().await;
            let setup = tokio::spawn(async move {
                setup_session(client, &QwenConfig::default(), false, &[]).await
            });
            let run = finish_request(&mut server).await;
            if reject {
                server.send(Message::Text(json!({"header":{"task_id":run["header"]["task_id"],"event":"task-failed","error_code":"InvalidApiKey"}}).to_string().into())).await.unwrap();
            }
            let error = match setup.await.unwrap() {
                Err(e) => e,
                Ok(_) => panic!("unexpected setup success"),
            };
            assert_eq!(
                error.code,
                if reject {
                    AppErrorCode::AsrQwenAuth
                } else {
                    AppErrorCode::AsrTimeout
                }
            );
        }
    }
    fn active_test_hotwords(config_path: &str) -> Vec<String> {
        let path = std::path::Path::new(config_path)
            .parent()
            .expect("config directory")
            .join("hotwords.json");
        let text = std::fs::read_to_string(path).expect("read local hotword library");
        let data: crate::hotword::HotwordData =
            serde_json::from_str(&text).unwrap_or_else(|_| panic!("invalid hotword library"));
        data.groups
            .into_iter()
            .find(|group| group.id == data.active_group)
            .map(|group| group.words)
            .unwrap_or_default()
    }

    /// Opt-in real-service smoke test; only the repository speech fixture is uploaded.
    #[tokio::test]
    #[ignore = "requires QWEN_TEST_CONFIG and a paid API connection"]
    async fn live_final_confirmation() {
        struct Trace;
        impl log::Log for Trace {
            fn enabled(&self, meta: &log::Metadata) -> bool {
                meta.target() == "ASR"
            }
            fn log(&self, record: &log::Record) {
                if self.enabled(record.metadata()) {
                    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
                    eprintln!(
                        "+{}ms {}",
                        START.get_or_init(Instant::now).elapsed().as_millis(),
                        record.args()
                    );
                }
            }
            fn flush(&self) {}
        }
        static TRACE: Trace = Trace;
        let _ = log::set_logger(&TRACE);
        log::set_max_level(log::LevelFilter::Debug);
        let path = std::env::var("QWEN_TEST_CONFIG").expect("set QWEN_TEST_CONFIG");
        let text = std::fs::read_to_string(&path).expect("read local config");
        let config: crate::config::AppConfig =
            serde_norway::from_str(&text).unwrap_or_else(|_| panic!("invalid local config"));
        let registry = serde_json::from_str(include_str!("../../../registry.json")).unwrap();
        let id = config.audio_provider();
        assert!(is_qwen_model(id), "select a Qwen ASR model first");
        let merged = crate::config::AppConfig::resolve_model_config(&registry, id, &config.audio);
        let params: QwenConfig =
            serde_json::from_value(merged).unwrap_or_else(|_| panic!("invalid Qwen config"));
        eprintln!(
            "LIVE model={} near_field={}",
            id,
            params.vad_model == "near_meeting_16k"
        );
        let engine = QwenEngine::new(params, id).unwrap_or_else(|_| panic!("invalid model"));
        let words = active_test_hotwords(&path);
        let (session, mut events) = engine
            .create_session(&words)
            .await
            .unwrap_or_else(|e| panic!("setup failed: {}", e.code));
        let reader = tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                if let AsrEvent::Error { error, .. } = event {
                    eprintln!("LIVE error={}", error.code);
                }
            }
        });
        let repeats: usize = std::env::var("QWEN_TEST_REPEATS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(1);
        let buffered_ms: usize = std::env::var("QWEN_TEST_BUFFER_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        session.append_audio(&vec![0.0; buffered_ms * 16]);
        let fixture = include_bytes!("test-speech.pcm").repeat(repeats);
        for chunk in fixture.chunks(3200) {
            let samples: Vec<f32> = chunk
                .chunks_exact(2)
                .map(|v| i16::from_le_bytes([v[0], v[1]]) as f32 / 32768.0)
                .collect();
            session.append_audio(&samples);
            tokio::time::sleep(Duration::from_secs_f64(samples.len() as f64 / 16000.0)).await;
        }
        let stopped = Instant::now();
        let result = session.commit_and_await_final().await;
        eprintln!(
            "LIVE stop_to_result_ms={} success={}",
            stopped.elapsed().as_millis(),
            result.is_ok()
        );
        session.close();
        reader.abort();
        assert!(
            result.is_ok(),
            "final confirmation failed: {}",
            result.err().unwrap().code
        );
    }
    /// Controlled latency comparisons without changing the user's saved settings.
    #[tokio::test]
    #[ignore = "requires QWEN_TEST_CONFIG and six paid API requests"]
    async fn live_latency_comparison() {
        struct Trace {
            records: Mutex<Vec<(Instant, String)>>,
        }
        impl log::Log for Trace {
            fn enabled(&self, meta: &log::Metadata) -> bool {
                meta.target() == "ASR"
            }
            fn log(&self, record: &log::Record) {
                if self.enabled(record.metadata()) {
                    self.records
                        .lock()
                        .unwrap()
                        .push((Instant::now(), record.args().to_string()));
                }
            }
            fn flush(&self) {}
        }
        static TRACE: Trace = Trace {
            records: Mutex::new(Vec::new()),
        };
        let _ = log::set_logger(&TRACE);
        log::set_max_level(log::LevelFilter::Debug);
        let path = std::env::var("QWEN_TEST_CONFIG").expect("set QWEN_TEST_CONFIG");
        let text = std::fs::read_to_string(&path).expect("read local config");
        let config: crate::config::AppConfig =
            serde_norway::from_str(&text).unwrap_or_else(|_| panic!("invalid local config"));
        assert!(
            is_qwen_model(config.audio_provider()),
            "select a Qwen model first"
        );
        let registry = serde_json::from_str(include_str!("../../../registry.json")).unwrap();
        let merged = crate::config::AppConfig::resolve_model_config(
            &registry,
            config.audio_provider(),
            &config.audio,
        );
        let base: QwenConfig =
            serde_json::from_value(merged).unwrap_or_else(|_| panic!("invalid Qwen config"));
        let words = active_test_hotwords(&path);
        let wav = include_bytes!("../tests/fixtures/test-audio-number.wav");
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
        eprintln!("QWEN_LATENCY_CONFIG near_field={} silence_ms={} intermediate={} heartbeat={} words={} audio_ms={}",
            base.vad_model == "near_meeting_16k", base.max_sentence_silence, base.intermediate_result_enabled, base.heartbeat, words.len(),samples.len()*1000/16000);
        let cases = [
            (
                "message_polish_on_buffered",
                MESSAGE_ID,
                true,
                true,
                1000usize,
            ),
            ("message_polish_off_buffered", MESSAGE_ID, false, true, 1000),
            (
                "message_no_hotwords_buffered",
                MESSAGE_ID,
                true,
                false,
                1000,
            ),
            ("streaming_buffered", STREAMING_ID, false, true, 1000),
            ("message_no_buffer", MESSAGE_ID, true, true, 0),
            ("message_baseline_repeat", MESSAGE_ID, true, true, 1000),
        ];
        let mut report = Vec::new();
        for (name, model, polish, hotwords, buffer_ms) in cases {
            TRACE.records.lock().unwrap().clear();
            let mut params = base.clone();
            params.enable_ddc = polish;
            let engine = QwenEngine::new(params, model).unwrap_or_else(|_| panic!("invalid model"));
            let connecting = Instant::now();
            let session_result = engine
                .create_session(if hotwords { &words } else { &[] })
                .await;
            let (session, mut events) = match session_result {
                Ok(session) => session,
                Err(error) => {
                    let row = json!({"case":name,"success":false,"error":error.code.as_str(),"stage":"setup"});
                    eprintln!("QWEN_LATENCY {}", row);
                    report.push(row);
                    continue;
                }
            };
            let ready = Instant::now();
            let first_text = Arc::new(Mutex::new(None));
            let observed = first_text.clone();
            let reader = tokio::spawn(async move {
                while let Some(event) = events.recv().await {
                    if let AsrEvent::Transcript {
                        final_text,
                        partial_text,
                    } = event
                    {
                        if !final_text.is_empty() || !partial_text.is_empty() {
                            observed.lock().unwrap().get_or_insert_with(Instant::now);
                        }
                    }
                }
            });
            let prefill = (buffer_ms * 16).min(samples.len());
            session.append_audio(&samples[..prefill]);
            for chunk in samples[prefill..].chunks(1600) {
                session.append_audio(chunk);
                tokio::time::sleep(Duration::from_secs_f64(chunk.len() as f64 / 16000.0)).await;
            }
            let stopped = Instant::now();
            let result = session.commit_and_await_final().await;
            let completed = Instant::now();
            tokio::task::yield_now().await;
            session.close();
            reader.abort();
            let records = TRACE.records.lock().unwrap();
            let finish_sent = records
                .iter()
                .find(|(_, m)| m.starts_with("Qwen finish-task sent"))
                .map(|(t, _)| *t);
            let final_sentence = records
                .iter()
                .rev()
                .find(|(_, m)| {
                    m.starts_with("Qwen event=result-generated") && m.contains("sentence_end=true")
                })
                .map(|(t, _)| *t);
            let task_finished = records
                .iter()
                .find(|(_, m)| m.starts_with("Qwen event=task-finished"))
                .map(|(t, _)| *t);
            let signed_ms = |t: Instant, base: Instant| -> i64 {
                if t >= base {
                    t.duration_since(base).as_millis() as i64
                } else {
                    -(base.duration_since(t).as_millis() as i64)
                }
            };
            let row = json!({
                "case":name,"success":result.is_ok(),"setup_ms":ready.duration_since(connecting).as_millis(),
                "stop_to_finish_ms":finish_sent.map(|t|signed_ms(t,stopped)),
                "stop_to_sentence_ms":final_sentence.map(|t|signed_ms(t,stopped)),
                "sentence_to_task_ms":final_sentence.zip(task_finished).map(|(s,t)|signed_ms(t,s)),
                "stop_to_task_ms":task_finished.map(|t|signed_ms(t,stopped)),
                "stop_to_result_ms":completed.duration_since(stopped).as_millis(),
                "first_text_after_ready_ms":first_text.lock().unwrap().map(|t|signed_ms(t,ready)),
                "result_chars":result.as_ref().ok().map(|text|text.chars().count()),
                "error":result.as_ref().err().map(|error|error.code.as_str()),
            });
            eprintln!("QWEN_LATENCY {}", row);
            report.push(row);
        }
        if let Ok(path) = std::env::var("QWEN_LATENCY_REPORT") {
            std::fs::write(path, serde_json::to_string_pretty(&report).unwrap())
                .expect("write sanitized report");
        }
        assert!(
            report.iter().all(|row| row["success"] == true),
            "one or more requests failed; inspect sanitized report"
        );
    }
    /// Compare the wire protocol directly, bypassing the application send queue.
    #[tokio::test]
    #[ignore = "requires QWEN_TEST_CONFIG and four paid API requests"]
    async fn live_frame_size_comparison() {
        let path = std::env::var("QWEN_TEST_CONFIG").expect("set QWEN_TEST_CONFIG");
        let text = std::fs::read_to_string(&path).expect("read local config");
        let config: crate::config::AppConfig =
            serde_norway::from_str(&text).unwrap_or_else(|_| panic!("invalid local config"));
        let registry = serde_json::from_str(include_str!("../../../registry.json")).unwrap();
        let merged =
            crate::config::AppConfig::resolve_model_config(&registry, MESSAGE_ID, &config.audio);
        let params: QwenConfig =
            serde_json::from_value(merged).unwrap_or_else(|_| panic!("invalid Qwen config"));
        params.validate().unwrap();
        let words = active_test_hotwords(&path);
        let wav = include_bytes!("../tests/fixtures/test-audio-number.wav");
        let mut offset = 12;
        let pcm = loop {
            let size = u32::from_le_bytes(wav[offset + 4..offset + 8].try_into().unwrap()) as usize;
            if &wav[offset..offset + 4] == b"data" {
                break &wav[offset + 8..offset + 8 + size];
            }
            offset += 8 + size + (size % 2);
        };
        let mut report = Vec::new();
        let cases = if std::env::var_os("QWEN_NETWORK_PROBE").is_some() {
            vec![
                ("raw_polish_on_ping", 3200usize, 0u64, true),
                ("raw_polish_off_ping", 3200, 0, false),
            ]
        } else {
            vec![
                ("raw_100ms_buffered", 3200, 1000, params.enable_ddc),
                ("raw_500ms_buffered", 16000, 1000, params.enable_ddc),
                ("raw_100ms_no_buffer", 3200, 0, params.enable_ddc),
                ("raw_500ms_buffered_repeat", 16000, 1000, params.enable_ddc),
            ]
        };
        for (name, frame_bytes, buffer_ms, polish) in cases {
            let mut case_params = params.clone();
            case_params.enable_ddc = polish;
            let mut request = params.endpoint().into_client_request().unwrap();
            request.headers_mut().insert(
                "Authorization",
                format!("Bearer {}", params.api_key.trim()).parse().unwrap(),
            );
            let connecting = Instant::now();
            let (mut socket, _) =
                timeout(IO_TIMEOUT, connect_async_with_config(request, None, true))
                    .await
                    .expect("handshake timeout")
                    .unwrap_or_else(|_| panic!("handshake failed"));
            let connected = Instant::now();
            let task = uuid::Uuid::new_v4().to_string();
            let run = json!({"header":{"action":"run-task","task_id":task,"streaming":"duplex"},"payload":{"task_group":"audio","task":"asr","function":"recognition","model":"qwen-audio-3.1-asr-flash-message","parameters":case_params.parameters(true,&words).0,"input":{}}});
            socket
                .send(Message::Text(run.to_string().into()))
                .await
                .unwrap_or_else(|_| panic!("run-task send failed"));
            timeout(IO_TIMEOUT, async {
                loop {
                    if let Some(Ok(Message::Text(text))) = socket.next().await {
                        let value: Value =
                            serde_json::from_str(&text).unwrap_or_else(|_| panic!("invalid event"));
                        if value["header"]["event"] == "task-started" {
                            break;
                        }
                        assert!(
                            value["header"]["event"] != "task-failed",
                            "task failed during startup"
                        );
                    }
                }
            })
            .await
            .expect("task startup timeout");
            let ready = Instant::now();
            let (mut sink, mut source) = socket.split();
            let (done_tx, mut done_rx) = tokio::sync::oneshot::channel();
            let (pongs, mut pong_rx) = mpsc::unbounded_channel();
            let probes = Arc::new(Mutex::new(
                BTreeMap::<String, (Instant, Option<u128>)>::new(),
            ));
            let observed_probes = probes.clone();
            let reader = tokio::spawn(async move {
                let mut last_sentence = None;
                let mut first_text = None;
                while let Some(message) = source.next().await {
                    match message {
                        Ok(Message::Text(text)) => {
                            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                                continue;
                            };
                            let now = Instant::now();
                            let sentence = &value["payload"]["output"]["sentence"];
                            if sentence["text"].as_str().is_some_and(|s| !s.is_empty()) {
                                first_text.get_or_insert(now);
                            }
                            if sentence["sentence_end"].as_bool() == Some(true) {
                                last_sentence = Some(now);
                            }
                            if value["header"]["event"] == "task-finished" {
                                let _ = done_tx.send(Ok((
                                    now,
                                    last_sentence,
                                    first_text,
                                    value["payload"]["usage"].clone(),
                                )));
                                return;
                            }
                            if value["header"]["event"] == "task-failed" {
                                let _ = done_tx.send(Err(server_error(
                                    value["header"]["error_code"].as_str().unwrap_or(""),
                                    value["header"]["error_message"].as_str().unwrap_or(""),
                                )
                                .code));
                                return;
                            }
                        }
                        Ok(Message::Pong(data)) => {
                            if let Ok(key) = std::str::from_utf8(&data) {
                                if let Some((sent, elapsed)) =
                                    observed_probes.lock().unwrap().get_mut(key)
                                {
                                    *elapsed = Some(sent.elapsed().as_millis());
                                }
                            }
                        }
                        Ok(Message::Ping(data)) => {
                            let _ = pongs.send(data);
                        }
                        Ok(Message::Close(_)) | Err(_) => break,
                        _ => {}
                    }
                }
                let _ = done_tx.send(Err(AppErrorCode::AsrConnectClosed));
            });
            probes
                .lock()
                .unwrap()
                .insert("start".into(), (Instant::now(), None));
            sink.send(Message::Ping(b"start".to_vec().into()))
                .await
                .unwrap_or_else(|_| panic!("probe failed"));
            let began = Instant::now();
            let stopped = began + Duration::from_secs_f64(pcm.len() as f64 / 32000.0)
                - Duration::from_millis(buffer_ms);
            let mut offset = 0;
            let mut max_write_ms = 0;
            for chunk in pcm.chunks(frame_bytes) {
                sleep_until(began + Duration::from_secs_f64(offset as f64 / 32000.0)).await;
                let write = Instant::now();
                sink.send(Message::Binary(chunk.to_vec().into()))
                    .await
                    .unwrap_or_else(|_| panic!("audio send failed"));
                max_write_ms = max_write_ms.max(write.elapsed().as_millis());
                offset += chunk.len();
            }
            let finish = json!({"header":{"action":"finish-task","task_id":task,"streaming":"duplex"},"payload":{"input":{}}});
            sink.send(Message::Text(finish.to_string().into()))
                .await
                .unwrap_or_else(|_| panic!("finish-task send failed"));
            let finish_sent = Instant::now();
            probes
                .lock()
                .unwrap()
                .insert("finish".into(), (Instant::now(), None));
            sink.send(Message::Ping(b"finish".to_vec().into()))
                .await
                .unwrap_or_else(|_| panic!("probe failed"));
            let final_deadline = Instant::now() + FINAL_MAX_WAIT;
            let result = loop {
                tokio::select! {
                    result=&mut done_rx => break result.expect("reader ended"),
                    Some(data)=pong_rx.recv() => {sink.send(Message::Pong(data)).await.unwrap_or_else(|_|panic!("pong failed"));},
                    _=sleep_until(final_deadline)=>break Err(AppErrorCode::AsrFinalTimeout),
                }
            };
            let ms = |t: Instant, base: Instant| -> i64 {
                if t >= base {
                    t.duration_since(base).as_millis() as i64
                } else {
                    -(base.duration_since(t).as_millis() as i64)
                }
            };
            let ping_ms: BTreeMap<_, _> = probes
                .lock()
                .unwrap()
                .iter()
                .map(|(key, (_, elapsed))| (key.clone(), *elapsed))
                .collect();
            let row = match result {
                Ok((finished, sentence, first, usage)) => {
                    json!({"case":name,"polish":polish,"endpoint_is_default":params.endpoint()==DEFAULT_URL,"ping_ms":ping_ms,"handshake_ms":ms(connected,connecting),"task_start_ms":ms(ready,connected),"first_text_after_ready_ms":first.map(|t|ms(t,ready)),"stop_to_finish_ms":ms(finish_sent,stopped),"stop_to_sentence_ms":sentence.map(|t|ms(t,stopped)),"sentence_to_task_ms":sentence.map(|t|ms(finished,t)),"stop_to_task_ms":ms(finished,stopped),"max_audio_write_ms":max_write_ms,"usage":usage,"success":true})
                }
                Err(error) => json!({"case":name,"success":false,"error":error.as_str()}),
            };
            eprintln!("QWEN_FRAME_LATENCY {}", row);
            report.push(row);
            let _ = timeout(IO_TIMEOUT, sink.close()).await;
            reader.abort();
        }
        if let Ok(path) = std::env::var("QWEN_LATENCY_REPORT") {
            std::fs::write(path, serde_json::to_string_pretty(&report).unwrap())
                .expect("write sanitized report");
        }
        assert!(
            report.iter().all(|row| row["success"] == true),
            "protocol comparison failed"
        );
    }
}

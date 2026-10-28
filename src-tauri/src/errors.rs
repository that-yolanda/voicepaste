//! Unified error codes crossing the IPC boundary.
//!
//! Errors are serialized as `AppError { code, params, detail }`. The `code` is
//! a dotted `domain.reason` string (e.g. `llm.auth_invalid`); rendering into
//! user-facing text happens on the receiving side — the frontend WebViews use
//! i18next (`web/src/locales/*.json`, key `errors.<code>`), while the native
//! macOS overlay renders from a compile-time exhaustive table
//! ([`AppErrorCode::render_headline`]). `detail` carries provider/technical
//! context only and must never be logged or persisted as prose because it can
//! echo user transcripts.

use std::collections::BTreeMap;
use std::fmt;

use crate::lang::Language;

/// Single source for the code enum: variant list, dotted code and the serde
/// rename are all generated from one table so they cannot drift.
macro_rules! app_error_codes {
    ($( $variant:ident => $code:literal ),+ $(,)?) => {
        /// Machine-readable error code.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
        pub enum AppErrorCode {
            $(
                #[serde(rename = $code)]
                $variant,
            )+
        }

        impl AppErrorCode {
            pub fn as_str(self) -> &'static str {
                match self {
                    $(AppErrorCode::$variant => $code),+
                }
            }
        }

        #[cfg(test)]
        impl AppErrorCode {
            /// Every code, for the locale-coverage test. Test-only (and
            /// compiled out of release builds) so it needs no producer.
            pub const ALL: &'static [AppErrorCode] = &[$(AppErrorCode::$variant),+];
        }
    };
}

app_error_codes! {
    // common — fallbacks for domains not yet migrated to typed codes
    Unexpected => "common.unexpected",
    InvalidConfig => "common.invalid_config",
    Cancelled => "common.cancelled",
    // feedback — previously plain string codes rejected by feedback commands
    FeedbackInvalidFields => "feedback.invalid_fields",
    FeedbackInvalidFiles => "feedback.invalid_files",
    FeedbackTooLarge => "feedback.too_large",
    FeedbackForbidden => "feedback.forbidden",
    FeedbackUnavailable => "feedback.unavailable",
    FeedbackSendFailed => "feedback.send_failed",
    FeedbackRateLimited => "feedback.rate_limited",
    FeedbackLogUnavailable => "feedback.log_unavailable",
    // llm — text polishing (mapped 1:1 from the old PolishErrorKind)
    LlmConfigIncomplete => "llm.config_incomplete",
    LlmAuthInvalid => "llm.auth_invalid",
    LlmModelNotFound => "llm.model_not_found",
    LlmRequestRejected => "llm.request_rejected",
    LlmRateLimited => "llm.rate_limited",
    LlmServerError => "llm.server_error",
    LlmTimeout => "llm.timeout",
    LlmNetwork => "llm.network",
    LlmUrlNotFound => "llm.url_not_found",
    LlmReasoningTruncated => "llm.reasoning_truncated",
    LlmEmptyResponse => "llm.empty_response",
    LlmParseFailed => "llm.parse_failed",
    LlmPromptMissing => "llm.prompt_missing",
    LlmPromptUnavailable => "llm.prompt_unavailable",
    // stats — history entry operations
    StatsEntryNotFound => "stats.entry_not_found",
    StatsEntryNotPolishable => "stats.entry_not_polishable",
    StatsNoPolishText => "stats.no_polish_text",
    StatsUpdateFailed => "stats.update_failed",
    StatsNoRetryableRecording => "stats.no_retryable_recording",
    StatsEmptyRecording => "stats.empty_recording",
    StatsNoRecordingKept => "stats.no_recording_kept",
    StatsInvalidWav => "stats.invalid_wav",
    // asr — speech recognition (engine-agnostic)
    AsrConfigMissing => "asr.config_missing",
    AsrConfigInvalid => "asr.config_invalid",
    AsrAuthFailed => "asr.auth_failed",
    AsrNetwork => "asr.network",
    AsrTimeout => "asr.timeout",
    AsrRequestInvalid => "asr.request_invalid",
    AsrServerError => "asr.server_error",
    AsrConnectClosed => "asr.connect_closed",
    AsrFinalTimeout => "asr.final_timeout",
    AsrSessionClosed => "asr.session_closed",
    AsrRecognizeFailed => "asr.recognize_failed",
    AsrThreadStartFailed => "asr.thread_start_failed",
    AsrWorkerClosed => "asr.worker_closed",
    AsrWorkerAborted => "asr.worker_aborted",
    AsrNoFinalResult => "asr.no_final_result",
    AsrModelFileMissing => "asr.model_file_missing",
    AsrModelNotDownloaded => "asr.model_not_downloaded",
    AsrModelNotInRegistry => "asr.model_not_in_registry",
    AsrVadMissing => "asr.vad_missing",
    AsrRecognizerCreateFailed => "asr.recognizer_create_failed",
    AsrHotwordsOverLimit => "asr.hotwords_over_limit",
    AsrHotwordTooLong => "asr.hotword_too_long",
    // asr — elevenlabs-specific failures and server mappings
    AsrElAuth => "asr.el_auth",
    AsrElQuotaExhausted => "asr.el_quota_exhausted",
    AsrElTermsNotAccepted => "asr.el_terms_not_accepted",
    AsrElInvalidRequest => "asr.el_invalid_request",
    AsrElRateLimited => "asr.el_rate_limited",
    AsrElQueueFull => "asr.el_queue_full",
    AsrElUnavailable => "asr.el_unavailable",
    AsrElSessionLimit => "asr.el_session_limit",
    AsrElIdleTimeout => "asr.el_idle_timeout",
    AsrElWarning => "asr.el_warning",
    AsrElConnectTimeout => "asr.el_connect_timeout",
    AsrElConnectHttpError => "asr.el_connect_http_error",
    AsrElProtocolError => "asr.el_protocol_error",
    AsrElClosedEarly => "asr.el_closed_early",
    AsrElSendFailed => "asr.el_send_failed",
    AsrElFinalizeFailed => "asr.el_finalize_failed",
    // asr — recording-layer composites (connect orchestration, reconnect UX)
    AsrConnectFailed => "asr.connect_failed",
    AsrConnectTaskEnded => "asr.connect_task_ended",
    AsrConnectTimeoutHint => "asr.connect_timeout_hint",
    AsrFinalizeIncomplete => "asr.finalize_incomplete",
    AsrEmptyResult => "asr.empty_result",
    AsrReconnecting => "asr.reconnecting",
    AsrReconnected => "asr.reconnected",
    // config — configuration file / validation
    ConfigInvalid => "config.invalid",
    ConfigIoRead => "config.io_read",
    ConfigIoWrite => "config.io_write",
    // hotkey — binding validation
    HotkeyUnrecognized => "hotkey.unrecognized",
    HotkeyNeedsModifier => "hotkey.needs_modifier",
    HotkeyConflict => "hotkey.conflict",
    HotkeyConflictStopped => "hotkey.conflict_stopped",
    HotkeyMainKeyModifier => "hotkey.main_key_first_modifier",
    // audio — microphone capture
    AudioThreadStartFailed => "audio.thread_start_failed",
    AudioThreadExited => "audio.thread_exited",
    AudioDeviceNotFound => "audio.device_not_found",
    AudioDeviceConfigFailed => "audio.device_config_failed",
    AudioStreamStartFailed => "audio.stream_start_failed",
    AudioUnsupportedFormat => "audio.unsupported_format",
    AudioStreamAborted => "audio.stream_aborted",
    // paste — clipboard / simulated paste output
    PasteSimulationFailed => "paste.simulation_failed",
    PasteClipboardWriteFailed => "paste.clipboard_write_failed",
    // model — download / delete
    ModelNotInRegistry => "model.not_in_registry",
    ModelNoDownloadUrl => "model.no_download_url",
    ModelMkdirFailed => "model.mkdir_failed",
    ModelDownloadFailed => "model.download_failed",
    ModelDownloadCancelled => "model.download_cancelled",
    ModelExtractFailed => "model.extract_failed",
    ModelSaveFailed => "model.save_failed",
    ModelChecksumFailed => "model.checksum_failed",
    ModelDeleteFailed => "model.delete_failed",
}

impl AppErrorCode {
    /// Whether another attempt could plausibly succeed without the user
    /// changing anything. Config/auth/model errors are permanent until fixed.
    pub fn is_retryable(self) -> bool {
        matches!(
            self,
            AppErrorCode::LlmRateLimited
                | AppErrorCode::LlmServerError
                | AppErrorCode::LlmTimeout
                | AppErrorCode::LlmNetwork
                | AppErrorCode::LlmEmptyResponse
        )
    }

    /// Render the headline for the native macOS overlay. Compile-time
    /// exhaustive over the `llm.*` codes that can reach the overlay pill;
    /// duplicates the strings in the locale files by design — keep them in
    /// sync (the locale-coverage test enforces the JSON side).
    /// `{{param}}` placeholders are interpolated from `params` here so
    /// callers never see raw template syntax.
    pub fn render_headline(self, lang: Language, params: &BTreeMap<String, String>) -> String {
        use Language::{En, ZhCn};
        let template = match (lang, self) {
            (ZhCn, Self::LlmConfigIncomplete) => "润色模型还未配置，缺少 {{field}}",
            (En, Self::LlmConfigIncomplete) => {
                "Polishing model is not configured: missing {{field}}"
            }
            (ZhCn, Self::LlmAuthInvalid) => "API Key 无效或已过期，请在设置中更新",
            (En, Self::LlmAuthInvalid) => "API key is invalid or expired. Update it in Settings",
            (ZhCn, Self::LlmModelNotFound) => "模型不存在或已下线，请在设置中更新模型名称",
            (En, Self::LlmModelNotFound) => {
                "Model not found or retired. Update the model name in Settings"
            }
            (ZhCn, Self::LlmRequestRejected) => "请求被模型服务拒绝",
            (En, Self::LlmRequestRejected) => "The model service rejected the request",
            (ZhCn, Self::LlmRateLimited) => "请求过于频繁或余额不足，请稍后再试",
            (En, Self::LlmRateLimited) => {
                "Too many requests or insufficient balance. Try again later"
            }
            (ZhCn, Self::LlmServerError) => "模型服务暂时不可用，请稍后再试",
            (En, Self::LlmServerError) => {
                "The model service is temporarily unavailable. Try again later"
            }
            (ZhCn, Self::LlmTimeout) => "模型响应超时",
            (En, Self::LlmTimeout) => "The model timed out",
            (ZhCn, Self::LlmNetwork) => "无法连接模型服务，请检查网络或服务地址",
            (En, Self::LlmNetwork) => {
                "Cannot reach the model service. Check the network or service URL"
            }
            (ZhCn, Self::LlmUrlNotFound) => "服务地址不正确或不存在（404），请检查服务地址",
            (En, Self::LlmUrlNotFound) => {
                "Service URL is wrong or missing (404). Check it in Settings"
            }
            (ZhCn, Self::LlmReasoningTruncated) => "模型思考占满了输出长度，未能写出正文",
            (En, Self::LlmReasoningTruncated) => {
                "The model spent its output budget thinking and wrote no text"
            }
            (ZhCn, Self::LlmEmptyResponse) => "模型没有返回任何内容",
            (En, Self::LlmEmptyResponse) => "The model returned no content",
            (ZhCn, Self::LlmParseFailed) => "无法解析模型返回内容",
            (En, Self::LlmParseFailed) => "Could not parse the model response",
            (ZhCn, Self::LlmPromptMissing) => "请选择润色模板",
            (En, Self::LlmPromptMissing) => "Choose a polish template first",
            (ZhCn, Self::LlmPromptUnavailable) => "润色模板不可用，请检查模板设置",
            (En, Self::LlmPromptUnavailable) => {
                "Polish template unavailable. Check template settings"
            }
            // asr — engine-agnostic
            (ZhCn, Self::AsrConfigMissing) => "语音识别模型还未配置，缺少 {{field}}",
            (En, Self::AsrConfigMissing) => "Speech model is not configured: missing {{field}}",
            (ZhCn, Self::AsrConfigInvalid) => "ElevenLabs 参数格式错误，请检查模型配置",
            (En, Self::AsrConfigInvalid) => {
                "Invalid ElevenLabs parameters. Check the model configuration"
            }
            (ZhCn, Self::AsrAuthFailed) => "ASR 鉴权失败，请检查 AppID / Token / Resource ID",
            (En, Self::AsrAuthFailed) => {
                "ASR authentication failed. Check the App ID / Token / Resource ID"
            }
            (ZhCn, Self::AsrNetwork) => "ASR 网络连接失败",
            (En, Self::AsrNetwork) => "ASR network connection failed",
            (ZhCn, Self::AsrTimeout) => "ASR 连接超时",
            (En, Self::AsrTimeout) => "ASR connection timed out",
            (ZhCn, Self::AsrRequestInvalid) => "ASR 请求参数无效",
            (En, Self::AsrRequestInvalid) => "Invalid ASR request parameters",
            (ZhCn, Self::AsrServerError) => "ASR 服务异常",
            (En, Self::AsrServerError) => "ASR service error",
            (ZhCn, Self::AsrConnectClosed) => "ASR 连接已断开，请重新开始",
            (En, Self::AsrConnectClosed) => "ASR connection closed. Please start again",
            (ZhCn, Self::AsrFinalTimeout) => "ASR 最终结果超时，请检查网络连接",
            (En, Self::AsrFinalTimeout) => {
                "Timed out waiting for the final result. Check the network"
            }
            (ZhCn, Self::AsrSessionClosed) => "录音已结束",
            (En, Self::AsrSessionClosed) => "Recording already ended",
            (ZhCn, Self::AsrRecognizeFailed) => "识别失败",
            (En, Self::AsrRecognizeFailed) => "Recognition failed",
            (ZhCn, Self::AsrThreadStartFailed) => "启动识别线程失败",
            (En, Self::AsrThreadStartFailed) => "Failed to start the recognition thread",
            (ZhCn, Self::AsrWorkerClosed) => "ASR worker 已关闭",
            (En, Self::AsrWorkerClosed) => "The ASR worker has shut down",
            (ZhCn, Self::AsrWorkerAborted) => "ASR worker 状态异常",
            (En, Self::AsrWorkerAborted) => "The ASR worker is in an invalid state",
            (ZhCn, Self::AsrNoFinalResult) => "ASR worker 未返回最终结果",
            (En, Self::AsrNoFinalResult) => "The ASR worker returned no final result",
            (ZhCn, Self::AsrModelFileMissing) => "模型 {{model}} 缺少 {{file}} 文件",
            (En, Self::AsrModelFileMissing) => "Model {{model}} is missing its {{file}} file",
            (ZhCn, Self::AsrModelNotDownloaded) => "模型 {{model}} 尚未下载，请先在设置中下载",
            (En, Self::AsrModelNotDownloaded) => {
                "Model {{model}} is not downloaded yet. Download it in Settings first"
            }
            (ZhCn, Self::AsrModelNotInRegistry) => "模型 {{model}} 未在注册表中找到",
            (En, Self::AsrModelNotInRegistry) => "Model {{model}} was not found in the registry",
            (ZhCn, Self::AsrVadMissing) => "VAD 模型缺失或不可用",
            (En, Self::AsrVadMissing) => "The VAD model is missing or unusable",
            (ZhCn, Self::AsrRecognizerCreateFailed) => "创建识别器失败",
            (En, Self::AsrRecognizerCreateFailed) => "Failed to create the recognizer",
            (ZhCn, Self::AsrHotwordsOverLimit) => "服务端热词最多 50 条，请减少启用词条",
            (En, Self::AsrHotwordsOverLimit) => "Server-side hotwords are limited to 50 entries",
            (ZhCn, Self::AsrHotwordTooLong) => "每条服务端热词最多 20 个字符",
            (En, Self::AsrHotwordTooLong) => "Each server-side hotword is limited to 20 characters",
            // asr — elevenlabs-specific
            (ZhCn, Self::AsrElAuth) => "API Key 无效或没有语音识别权限",
            (En, Self::AsrElAuth) => "API key is invalid or lacks speech recognition access",
            (ZhCn, Self::AsrElQuotaExhausted) => "额度不足，请检查账号余额",
            (En, Self::AsrElQuotaExhausted) => "Quota exhausted. Check the account balance",
            (ZhCn, Self::AsrElTermsNotAccepted) => "请先在 ElevenLabs 控制台接受服务条款",
            (En, Self::AsrElTermsNotAccepted) => {
                "Accept the terms of service in the ElevenLabs console first"
            }
            (ZhCn, Self::AsrElInvalidRequest) => "请求参数或音频格式无效",
            (En, Self::AsrElInvalidRequest) => "Invalid request parameters or audio format",
            (ZhCn, Self::AsrElRateLimited) => "请求过于频繁，请稍后重试",
            (En, Self::AsrElRateLimited) => "Too many requests. Please retry later",
            (ZhCn, Self::AsrElQueueFull) => "音频处理队列已满，请重试",
            (En, Self::AsrElQueueFull) => "The audio processing queue is full. Please retry",
            (ZhCn, Self::AsrElUnavailable) => "语音服务暂时不可用，请重试",
            (En, Self::AsrElUnavailable) => {
                "The speech service is temporarily unavailable. Please retry"
            }
            (ZhCn, Self::AsrElSessionLimit) => "已达到单次会话时长限制",
            (En, Self::AsrElSessionLimit) => "The single-session duration limit was reached",
            (ZhCn, Self::AsrElIdleTimeout) => "长时间没有收到有效音频",
            (En, Self::AsrElIdleTimeout) => "No valid audio was received for too long",
            (ZhCn, Self::AsrElWarning) => "服务端警告",
            (En, Self::AsrElWarning) => "Server warning",
            (ZhCn, Self::AsrElConnectTimeout) => "连接超时",
            (En, Self::AsrElConnectTimeout) => "Connection timed out",
            (ZhCn, Self::AsrElConnectHttpError) => {
                "连接失败（HTTP {{status}}），请检查 API Key、权限和余额"
            }
            (En, Self::AsrElConnectHttpError) => {
                "Connection failed (HTTP {{status}}). Check the API key, access, and balance"
            }
            (ZhCn, Self::AsrElProtocolError) => "返回了无效消息",
            (En, Self::AsrElProtocolError) => "The server returned an invalid message",
            (ZhCn, Self::AsrElClosedEarly) => "连接在就绪前被关闭",
            (En, Self::AsrElClosedEarly) => "The connection closed before it was ready",
            (ZhCn, Self::AsrElSendFailed) => "消息发送失败，请检查网络",
            (En, Self::AsrElSendFailed) => "Failed to send a message. Check the network",
            (ZhCn, Self::AsrElFinalizeFailed) => "最终确认未完成，请重试",
            (En, Self::AsrElFinalizeFailed) => "Final confirmation did not complete. Please retry",
            // asr — recording-layer composites
            (ZhCn, Self::AsrConnectFailed) => "ASR 连接失败",
            (En, Self::AsrConnectFailed) => "Failed to connect to the ASR service",
            (ZhCn, Self::AsrConnectTaskEnded) => "语音连接任务已结束，请重试",
            (En, Self::AsrConnectTaskEnded) => "The connection task ended. Please retry",
            (ZhCn, Self::AsrConnectTimeoutHint) => "语音服务连接超时，请重试",
            (En, Self::AsrConnectTimeoutHint) => {
                "The speech service connection timed out. Please retry"
            }
            (ZhCn, Self::AsrFinalizeIncomplete) => "语音服务未能完成最终确认，请重试",
            (En, Self::AsrFinalizeIncomplete) => {
                "The speech service could not finish recognition. Please retry"
            }
            (ZhCn, Self::AsrEmptyResult) => "没有得到转写文本，请检查网络连接",
            (En, Self::AsrEmptyResult) => "No transcript text came back. Check the network",
            (ZhCn, Self::AsrReconnecting) => "正在重连…",
            (En, Self::AsrReconnecting) => "Reconnecting…",
            (ZhCn, Self::AsrReconnected) => "已重连",
            (En, Self::AsrReconnected) => "Reconnected",
            // common — fallback surfaces
            (ZhCn, Self::Cancelled) => "已取消",
            (En, Self::Cancelled) => "Cancelled",
            // stats — surfaces via the overlay retry hint / history list
            (ZhCn, Self::StatsNoRetryableRecording) => "没有可重试的失败录音",
            (En, Self::StatsNoRetryableRecording) => "No failed recording available to retry",
            (ZhCn, Self::StatsEmptyRecording) => "录音文件为空，无法重试",
            (En, Self::StatsEmptyRecording) => "The recording file is empty",
            (ZhCn, Self::StatsNoRecordingKept) => {
                "这条记录没有保留的录音（重新生成需开启保留录音）"
            }
            (En, Self::StatsNoRecordingKept) => {
                "This entry kept no recording (regenerate requires \"keep recordings\")"
            }
            (ZhCn, Self::StatsInvalidWav) => "录音文件无效",
            (En, Self::StatsInvalidWav) => "The recording file is invalid",
            // config / audio / paste — surfaces via the overlay restart/output hints
            (ZhCn, Self::ConfigInvalid) => "配置格式错误",
            (En, Self::ConfigInvalid) => "Invalid configuration",
            (ZhCn, Self::ConfigIoRead) => "读取配置失败",
            (En, Self::ConfigIoRead) => "Failed to read the configuration",
            (ZhCn, Self::ConfigIoWrite) => "写入配置失败",
            (En, Self::ConfigIoWrite) => "Failed to write the configuration",
            (ZhCn, Self::AudioThreadStartFailed) => "启动录音线程失败",
            (En, Self::AudioThreadStartFailed) => "Failed to start the recording thread",
            (ZhCn, Self::AudioThreadExited) => "录音线程提前退出",
            (En, Self::AudioThreadExited) => "The recording thread exited early",
            (ZhCn, Self::AudioDeviceNotFound) => "未找到默认麦克风输入设备",
            (En, Self::AudioDeviceNotFound) => "No default microphone input found",
            (ZhCn, Self::AudioDeviceConfigFailed) => "读取麦克风配置失败",
            (En, Self::AudioDeviceConfigFailed) => "Failed to read the microphone configuration",
            (ZhCn, Self::AudioStreamStartFailed) => "启动麦克风输入流失败",
            (En, Self::AudioStreamStartFailed) => "Failed to start the microphone input stream",
            (ZhCn, Self::AudioUnsupportedFormat) => "不支持的采样格式",
            (En, Self::AudioUnsupportedFormat) => "Unsupported sample format",
            (ZhCn, Self::AudioStreamAborted) => "麦克风输入流已中断",
            (En, Self::AudioStreamAborted) => "The microphone input stream aborted",
            (ZhCn, Self::PasteSimulationFailed) => "模拟粘贴失败，请检查当前焦点位置",
            (En, Self::PasteSimulationFailed) => "Paste simulation failed. Check the focused input",
            (ZhCn, Self::PasteClipboardWriteFailed) => "剪贴板写入失败",
            (En, Self::PasteClipboardWriteFailed) => "Failed to write to the clipboard",
            // Codes that never reach a natively rendered surface (stats,
            // feedback, common) fall back to the machine code; the frontend
            // locale files own their user-facing text.
            _ => return self.as_str().to_string(),
        };
        let mut text = template.to_string();
        for (key, value) in params {
            text = text.replace(&format!("{{{{{key}}}}}"), value);
        }
        text
    }
}

impl fmt::Display for AppErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Structured error crossing the IPC boundary.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct AppError {
    pub code: AppErrorCode,
    /// Interpolation parameters for the translated headline (e.g. `field`).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, String>,
    /// Provider/technical context. Never logged or persisted as prose.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl AppError {
    pub fn new(code: AppErrorCode) -> Self {
        Self {
            code,
            params: BTreeMap::new(),
            detail: None,
        }
    }

    pub fn with_param(mut self, key: &str, value: impl Into<String>) -> Self {
        self.params.insert(key.to_string(), value.into());
        self
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Intentionally code-only: `detail` may echo user transcripts and must
        // not leak into logs.
        f.write_str(self.code.as_str())
    }
}

impl std::error::Error for AppError {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn serde_uses_dotted_code() {
        assert_eq!(
            serde_json::to_value(AppErrorCode::FeedbackTooLarge).unwrap(),
            Value::String("feedback.too_large".into())
        );
        let back: AppErrorCode =
            serde_json::from_value(Value::String("feedback.too_large".into())).unwrap();
        assert_eq!(back, AppErrorCode::FeedbackTooLarge);
    }

    #[test]
    fn app_error_omits_empty_params_and_detail() {
        let value = serde_json::to_value(AppError::new(AppErrorCode::Unexpected)).unwrap();
        assert_eq!(value["code"], "common.unexpected");
        assert!(value.get("params").is_none());
        assert!(value.get("detail").is_none());
    }

    #[test]
    fn app_error_keeps_params_and_detail() {
        let error = AppError::new(AppErrorCode::LlmConfigIncomplete)
            .with_param("field", "llm.openai.model")
            .with_detail("boom");
        let value = serde_json::to_value(error).unwrap();
        assert_eq!(value["code"], "llm.config_incomplete");
        assert_eq!(value["params"]["field"], "llm.openai.model");
        assert_eq!(value["detail"], "boom");
    }

    #[test]
    fn display_never_leaks_detail() {
        let error = AppError::new(AppErrorCode::Unexpected).with_detail("secret transcript");
        assert_eq!(error.to_string(), "common.unexpected");
    }

    #[test]
    fn retryable_set_matches_the_transient_llm_kinds() {
        let retryable = [
            AppErrorCode::LlmRateLimited,
            AppErrorCode::LlmServerError,
            AppErrorCode::LlmTimeout,
            AppErrorCode::LlmNetwork,
            AppErrorCode::LlmEmptyResponse,
        ];
        for code in AppErrorCode::ALL {
            assert_eq!(code.is_retryable(), retryable.contains(code), "{code:?}");
        }
    }

    #[test]
    fn render_headline_interpolates_params() {
        let params = BTreeMap::from([("field".to_string(), "llm.openai.api_key".to_string())]);
        assert_eq!(
            AppErrorCode::LlmConfigIncomplete.render_headline(Language::ZhCn, &params),
            "润色模型还未配置，缺少 llm.openai.api_key"
        );
        assert_eq!(
            AppErrorCode::LlmConfigIncomplete.render_headline(Language::En, &params),
            "Polishing model is not configured: missing llm.openai.api_key"
        );
        // Without params the placeholder stays visible — callers that use a
        // templated code must pass its params.
        assert!(AppErrorCode::LlmConfigIncomplete
            .render_headline(Language::En, &BTreeMap::new())
            .contains("{{field}}"));
    }

    #[test]
    fn render_headline_covers_every_translated_code_in_both_languages() {
        for code in AppErrorCode::ALL {
            let domain = code.as_str().split('.').next().unwrap();
            if !matches!(domain, "llm" | "asr") {
                continue;
            }
            let empty = BTreeMap::new();
            assert_ne!(
                code.render_headline(Language::ZhCn, &empty),
                code.as_str(),
                "missing zh headline for {}",
                code.as_str()
            );
            assert_ne!(
                code.render_headline(Language::En, &empty),
                code.as_str(),
                "missing en headline for {}",
                code.as_str()
            );
        }
    }

    /// Every code must have an entry under `errors.<domain>.<reason>` in both
    /// locale files, otherwise the frontend `errText` falls back to the raw
    /// code string. Keeps `web/src/locales/*.json` in sync with this enum.
    #[test]
    fn every_code_has_translations_in_both_locales() {
        for (name, raw) in [
            ("zh-CN", include_str!("../../web/src/locales/zh-CN.json")),
            ("en", include_str!("../../web/src/locales/en.json")),
        ] {
            let locale: Value = serde_json::from_str(raw)
                .unwrap_or_else(|e| panic!("{name} locale is not valid JSON: {e}"));
            let errors = &locale["errors"];
            assert!(errors.is_object(), "{name} locale has no `errors` section");
            for code in AppErrorCode::ALL {
                let (domain, reason) = code.as_str().split_once('.').expect("dotted code");
                assert!(
                    errors[domain][reason].is_string(),
                    "{name} locale is missing errors.{}",
                    code.as_str()
                );
            }
        }
    }
}

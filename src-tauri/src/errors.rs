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
    fn render_headline_covers_every_llm_code_in_both_languages() {
        for code in AppErrorCode::ALL {
            if !code.as_str().starts_with("llm.") {
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

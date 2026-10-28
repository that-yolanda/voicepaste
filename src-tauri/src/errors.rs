//! Unified error codes crossing the IPC boundary.
//!
//! Errors are serialized as `AppError { code, params, detail }`. The `code` is
//! a dotted `domain.reason` string (e.g. `llm.auth_invalid`); rendering into
//! user-facing text happens on the receiving side — the frontend WebViews use
//! i18next (`web/src/locales/*.json`, key `errors.<code>`), while the native
//! macOS overlay renders from a compile-time exhaustive table. `detail` carries
//! provider/technical context only and must never be logged or persisted as
//! prose because it can echo user transcripts.

use std::collections::BTreeMap;
use std::fmt;

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
    fn display_never_leaks_detail() {
        let error = AppError::new(AppErrorCode::Unexpected);
        assert_eq!(error.to_string(), "common.unexpected");
    }
}

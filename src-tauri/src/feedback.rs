use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::State;

use crate::app_state::AppHandle as AppState;
use crate::errors::{AppError, AppErrorCode};

const ENDPOINT: &str = "https://voicepaste.dev/api/feedback/app";
const LOG_LIMIT: usize = 512 * 1024;
const IMAGE_LIMIT: usize = 2 * 1024 * 1024;
const ATTACHMENT_LIMIT: usize = 3 * 1024 * 1024;

#[derive(Default)]
pub struct FeedbackWindowState(pub AtomicBool);

#[tauri::command]
pub fn set_feedback_draft_active(state: State<'_, FeedbackWindowState>, active: bool) {
    state.0.store(active, Ordering::Relaxed);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackEnvironment {
    app_version: String,
    system: String,
}

#[tauri::command]
pub async fn get_feedback_environment() -> FeedbackEnvironment {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = tokio::process::Command::new("/usr/bin/sw_vers");
        command.arg("-productVersion");
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = tokio::process::Command::new("cmd");
        command.args(["/C", "ver"]).creation_flags(0x08000000);
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = {
        let mut command = tokio::process::Command::new("uname");
        command.arg("-r");
        command
    };
    command.kill_on_drop(true);
    let version = match tokio::time::timeout(Duration::from_secs(3), command.output()).await {
        Ok(Ok(output)) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        _ => String::new(),
    };
    FeedbackEnvironment {
        app_version: env!("CARGO_PKG_VERSION").into(),
        system: format!(
            "{} {} ({})",
            std::env::consts::OS,
            version,
            std::env::consts::ARCH
        ),
    }
}

fn read_log(path: &Path) -> Result<String, AppError> {
    let unavailable = || AppError::new(AppErrorCode::FeedbackLogUnavailable);
    let mut file = std::fs::File::open(path).map_err(|_| unavailable())?;
    let size = file.metadata().map_err(|_| unavailable())?.len();
    let start = size.saturating_sub(LOG_LIMIT as u64);
    file.seek(SeekFrom::Start(start))
        .map_err(|_| unavailable())?;
    let mut bytes = Vec::new();
    file.take(LOG_LIMIT as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| unavailable())?;
    // The tail may begin inside a UTF-8 character or an unfinished line.
    if start > 0 {
        let first_line = bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or_else(unavailable)?;
        bytes.drain(..=first_line);
    }
    if bytes.is_empty() {
        return Err(unavailable());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub async fn get_feedback_log(state: State<'_, AppState>) -> Result<String, AppError> {
    let path = state.log_path.clone();
    tokio::task::spawn_blocking(move || {
        log::logger().flush();
        read_log(&path)
    })
    .await
    .map_err(|_| AppError::new(AppErrorCode::FeedbackLogUnavailable))?
}

#[derive(Deserialize)]
pub struct Screenshot {
    name: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackPayload {
    #[serde(rename = "type")]
    kind: String,
    category: String,
    title: String,
    description: String,
    email: String,
    wechat: String,
    app_version: String,
    system: String,
    submission_id: String,
    log: Option<String>,
    screenshots: Vec<Screenshot>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackReceipt {
    ok: bool,
    submission_id: String,
}

fn prepare_form(payload: &FeedbackPayload) -> Result<Form, AppError> {
    let invalid_fields = || AppError::new(AppErrorCode::FeedbackInvalidFields);
    let id = uuid::Uuid::parse_str(&payload.submission_id).map_err(|_| invalid_fields())?;
    if id.get_version_num() != 4 || !["bug", "feature", "other"].contains(&payload.kind.as_str()) {
        return Err(invalid_fields());
    }
    for (value, limit, required) in [
        (&payload.title, 120, true),
        (&payload.description, 10_000, true),
        (&payload.system, 200, true),
        (&payload.app_version, 100, true),
        (&payload.category, 64, false),
        (&payload.email, 254, false),
        (&payload.wechat, 254, false),
    ] {
        if (required && value.trim().is_empty()) || value.encode_utf16().count() > limit {
            return Err(invalid_fields());
        }
    }
    if payload.screenshots.len() > 4 {
        return Err(AppError::new(AppErrorCode::FeedbackInvalidFiles));
    }
    let mut form = Form::new()
        .text("type", payload.kind.clone())
        .text("category", payload.category.clone())
        .text("title", payload.title.clone())
        .text("description", payload.description.clone())
        .text("email", payload.email.clone())
        .text("wechat", payload.wechat.clone())
        .text("appVersion", payload.app_version.clone())
        .text("system", payload.system.clone())
        .text("submissionId", payload.submission_id.clone());
    let mut total = 0;
    if let Some(log) = &payload.log {
        if log.is_empty() {
            return Err(AppError::new(AppErrorCode::FeedbackInvalidFiles));
        }
        if log.len() > LOG_LIMIT {
            return Err(AppError::new(AppErrorCode::FeedbackTooLarge));
        }
        total += log.len();
        form = form.part(
            "log",
            Part::bytes(log.as_bytes().to_vec()).file_name("voicepaste.log"),
        );
    }
    for (index, image) in payload.screenshots.iter().enumerate() {
        if image.content.len() > IMAGE_LIMIT.div_ceil(3) * 4 {
            return Err(AppError::new(AppErrorCode::FeedbackTooLarge));
        }
        let bytes = STANDARD
            .decode(&image.content)
            .map_err(|_| AppError::new(AppErrorCode::FeedbackInvalidFiles))?;
        if bytes.len() > IMAGE_LIMIT {
            return Err(AppError::new(AppErrorCode::FeedbackTooLarge));
        }
        total += bytes.len();
        if total > ATTACHMENT_LIMIT {
            return Err(AppError::new(AppErrorCode::FeedbackTooLarge));
        }
        let name = image.name.to_ascii_lowercase();
        let extension = if name.ends_with(".png") && bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            "png"
        } else if (name.ends_with(".jpg") || name.ends_with(".jpeg"))
            && bytes.starts_with(&[0xff, 0xd8, 0xff])
        {
            "jpg"
        } else {
            return Err(AppError::new(AppErrorCode::FeedbackInvalidFiles));
        };
        form = form.part(
            "screenshots",
            Part::bytes(bytes).file_name(format!("screenshot-{}.{}", index + 1, extension)),
        );
    }
    Ok(form)
}

/// Map the shared API's error codes onto [`AppErrorCode`]. Only the whitelist
/// crosses; everything else (including unexpected bodies) collapses to a
/// generic send failure.
fn platform_feedback_code(code: &str) -> AppErrorCode {
    match code {
        "invalid_fields" => AppErrorCode::FeedbackInvalidFields,
        "invalid_files" => AppErrorCode::FeedbackInvalidFiles,
        "too_large" => AppErrorCode::FeedbackTooLarge,
        "forbidden" => AppErrorCode::FeedbackForbidden,
        "unavailable" => AppErrorCode::FeedbackUnavailable,
        "rate_limited" => AppErrorCode::FeedbackRateLimited,
        _ => AppErrorCode::FeedbackSendFailed,
    }
}

async fn send_feedback(
    payload: FeedbackPayload,
    endpoint: &str,
) -> Result<FeedbackReceipt, AppError> {
    let send_failed = || AppError::new(AppErrorCode::FeedbackSendFailed);
    let form = prepare_form(&payload)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| send_failed())?;
    let response = client
        .post(endpoint)
        .header(
            reqwest::header::USER_AGENT,
            concat!("VoicePaste/", env!("CARGO_PKG_VERSION")),
        )
        .multipart(form)
        .send()
        .await
        .map_err(|_| send_failed())?;
    match response.status().as_u16() {
        413 => return Err(AppError::new(AppErrorCode::FeedbackTooLarge)),
        429 => return Err(AppError::new(AppErrorCode::FeedbackRateLimited)),
        200..=299 => {}
        _ => {
            let body: serde_json::Value = response.json().await.unwrap_or_default();
            let code = body["error"].as_str().unwrap_or("send_failed");
            return Err(AppError::new(platform_feedback_code(code)));
        }
    }
    let receipt: FeedbackReceipt = response.json().await.map_err(|_| send_failed())?;
    if !receipt.ok || receipt.submission_id != payload.submission_id {
        return Err(send_failed());
    }
    Ok(receipt)
}

#[tauri::command]
pub async fn submit_feedback(payload: FeedbackPayload) -> Result<FeedbackReceipt, AppError> {
    send_feedback(payload, ENDPOINT).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn payload() -> FeedbackPayload {
        serde_json::from_value(json!({
            "type":"bug", "category":"", "title":"Recording failed", "description":"Steps to reproduce",
            "email":"", "wechat":"", "appVersion":"2.1.4", "system":"Windows 11", "submissionId":uuid::Uuid::new_v4().to_string(),
            "log":null,"screenshots":[]
        })).unwrap()
    }

    #[test]
    fn attachment_count_and_size_are_bounded() {
        let mut report = payload();
        report.log = Some("x".repeat(LOG_LIMIT + 1));
        assert_eq!(
            prepare_form(&report).err().unwrap().code,
            AppErrorCode::FeedbackTooLarge
        );
        report.log = None;
        report.screenshots = (0..5)
            .map(|_| Screenshot {
                name: "x.png".into(),
                content: STANDARD.encode(b"\x89PNG\r\n\x1a\n"),
            })
            .collect();
        assert_eq!(
            prepare_form(&report).err().unwrap().code,
            AppErrorCode::FeedbackInvalidFiles
        );
        report.screenshots = vec![Screenshot {
            name: "x.png".into(),
            content: STANDARD.encode("not an image"),
        }];
        assert_eq!(
            prepare_form(&report).err().unwrap().code,
            AppErrorCode::FeedbackInvalidFiles
        );
    }

    #[test]
    fn log_collection_only_reads_a_bounded_tail() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("voicepaste.log");
        std::fs::write(
            &path,
            format!("{}\nlatest error\n", "日志\n".repeat(LOG_LIMIT)),
        )
        .unwrap();
        let text = read_log(&path).unwrap();
        assert!(text.len() <= LOG_LIMIT);
        assert!(text.ends_with("latest error\n"));
        assert!(!text.contains('\u{fffd}'));
    }

    #[tokio::test]
    async fn native_multipart_reaches_the_shared_api_contract() {
        use wiremock::{matchers::method, Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        let mut report = payload();
        report.log = Some("[App][ERROR] Microphone unavailable".into());
        report.screenshots.push(Screenshot {
            name: "screen.png".into(),
            content: STANDARD.encode(b"\x89PNG\r\n\x1a\n"),
        });
        let id = report.submission_id.clone();
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(202).set_body_json(json!({"ok":true,"submissionId":id})),
            )
            .mount(&server)
            .await;
        let receipt = send_feedback(report, &server.uri()).await.unwrap();
        assert_eq!(receipt.submission_id, id);
        let requests = server.received_requests().await.unwrap();
        let body = String::from_utf8_lossy(&requests[0].body);
        assert!(body.contains("name=\"log\""));
        assert!(body.contains("name=\"screenshots\""));
        assert!(body.contains("name=\"appVersion\""));
        assert!(body.contains("name=\"appVersion\"\r\n\r\n2.1.4\r\n"));
        assert!(body.contains("name=\"system\"\r\n\r\nWindows 11\r\n"));
    }

    #[tokio::test]
    async fn platform_html_errors_are_mapped_without_json() {
        use wiremock::{Mock, MockServer, ResponseTemplate};
        for (status, code) in [
            (413, AppErrorCode::FeedbackTooLarge),
            (429, AppErrorCode::FeedbackRateLimited),
        ] {
            let server = MockServer::start().await;
            Mock::given(wiremock::matchers::method("POST"))
                .respond_with(
                    ResponseTemplate::new(status).set_body_string("<html>Platform error</html>"),
                )
                .mount(&server)
                .await;
            assert_eq!(
                send_feedback(payload(), &server.uri())
                    .await
                    .err()
                    .unwrap()
                    .code,
                code
            );
        }
    }
}

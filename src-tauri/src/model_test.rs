use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

use crate::asr::{AsrEvent, AsrSession};
use crate::config::AppConfig;
use crate::errors::{AppError, AppErrorCode};
use crate::model::{ModelCategory, ModelRegistry};

const TIMEOUT: Duration = Duration::from_secs(45);
const SPEECH: &[u8] = include_bytes!("asr/test-speech.pcm");

enum TestState {
    Active(Option<oneshot::Sender<()>>),
    Cancelled(Instant),
}

fn tests() -> &'static Mutex<HashMap<String, TestState>> {
    static TESTS: OnceLock<Mutex<HashMap<String, TestState>>> = OnceLock::new();
    TESTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_test(test_id: &str) -> Result<(Registration, oneshot::Receiver<()>), AppError> {
    let mut active = tests().lock().unwrap();
    active.retain(|_, state| !matches!(state, TestState::Cancelled(at) if at.elapsed() > Duration::from_secs(60)));
    match active.remove(test_id) {
        Some(TestState::Cancelled(_)) => return Err(AppError::new(AppErrorCode::Cancelled)),
        Some(state) => {
            active.insert(test_id.to_string(), state);
            return Err(
                AppError::new(AppErrorCode::InvalidConfig).with_detail("Test ID already active")
            );
        }
        None => {}
    }
    let (tx, rx) = oneshot::channel();
    active.insert(test_id.to_string(), TestState::Active(Some(tx)));
    Ok((Registration(test_id.to_string()), rx))
}

#[derive(Serialize)]
pub struct ModelTestResult {
    output: String,
    elapsed_ms: u64,
}

struct Registration(String);
impl Drop for Registration {
    fn drop(&mut self) {
        tests().lock().unwrap().remove(&self.0);
    }
}

struct SessionGuard(Box<dyn AsrSession>);
impl Drop for SessionGuard {
    fn drop(&mut self) {
        self.0.close();
    }
}

fn select_asr_model(
    config: &AppConfig,
    registry: &ModelRegistry,
    provider: &str,
    model: &str,
) -> Result<AppConfig, AppError> {
    if provider.trim().is_empty()
        || model.trim().is_empty()
        || !registry.models.iter().any(|entry| {
            entry.id == model
                && entry.provider.as_deref() == Some(provider)
                && entry.category == ModelCategory::Asr
        })
    {
        return Err(AppError::new(AppErrorCode::AsrModelNotInRegistry).with_param("model", model));
    }
    let mut selected = config.clone();
    selected
        .audio
        .insert("provider".into(), serde_norway::Value::String(model.into()));
    Ok(selected)
}

async fn run_asr(
    config: AppConfig,
    registry: &ModelRegistry,
    data_dir: std::path::PathBuf,
    resource_dir: std::path::PathBuf,
) -> Result<String, AppError> {
    let (session, events, _) =
        crate::asr::create_engine_session(&config, registry, data_dir, resource_dir, &[]).await?;
    run_asr_session(session, events, SPEECH).await
}

async fn run_asr_session(
    session: Box<dyn AsrSession>,
    mut events: tokio::sync::mpsc::UnboundedReceiver<AsrEvent>,
    speech: &[u8],
) -> Result<String, AppError> {
    let session = SessionGuard(session);
    if speech.is_empty() || !speech.len().is_multiple_of(2) {
        return Err(AppError::new(AppErrorCode::AsrTestFailed).with_detail("Invalid test audio"));
    }
    let committing = std::sync::atomic::AtomicBool::new(false);
    let audio = async {
        for chunk in speech.chunks(3200) {
            let samples: Vec<f32> = chunk
                .as_chunks::<2>()
                .0
                .iter()
                .map(|bytes| i16::from_le_bytes(*bytes) as f32 / 32768.0)
                .collect();
            session.0.append_audio(&samples);
            tokio::time::sleep(Duration::from_secs_f64(samples.len() as f64 / 16000.0)).await;
        }
        committing.store(true, std::sync::atomic::Ordering::Relaxed);
        session.0.commit_and_await_final().await
    };
    tokio::pin!(audio);
    let mut events_open = true;
    let output = loop {
        tokio::select! {
            biased;
            event = events.recv(), if events_open => match event {
                Some(AsrEvent::Error { error, .. }) => break Err(error),
                Some(AsrEvent::Close { code, reason }) if !committing.load(std::sync::atomic::Ordering::Relaxed) => break Err(AppError::new(AppErrorCode::AsrTestFailed).with_detail(format!("Session closed: {code:?} {reason}"))),
                // The engine may close after delivering the final result; let
                // commit decide whether finalization succeeded.
                Some(AsrEvent::Close { .. }) => {},
                None => events_open = false,
                _ => {}
            },
            result = &mut audio => {
                // Errors can already be queued when the final result arrives.
                let mut pending_error = None;
                while let Ok(event) = events.try_recv() {
                    if let AsrEvent::Error { error, .. } = event { pending_error = Some(error); break; }
                }
                break match pending_error { Some(error) => Err(error), None => result };
            }
        }
    }?;
    if output.trim().is_empty() {
        return Err(AppError::new(AppErrorCode::AsrTestFailed).with_detail("Empty transcription"));
    }
    Ok(output)
}

#[tauri::command]
pub async fn test_model(
    app: AppHandle,
    config: AppConfig,
    provider_id: String,
    model_id: String,
    capability: String,
    test_id: String,
) -> Result<ModelTestResult, AppError> {
    if test_id.trim().is_empty()
        || provider_id.trim().is_empty()
        || model_id.trim().is_empty()
        || !matches!(capability.as_str(), "asr" | "llm")
    {
        return Err(
            AppError::new(AppErrorCode::InvalidConfig).with_detail("Invalid model test input")
        );
    }
    let (_registration, rx) = register_test(&test_id)?;
    let start = Instant::now();
    let work = async {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| AppError::new(AppErrorCode::Unexpected).with_detail(e.to_string()))?;
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| AppError::new(AppErrorCode::Unexpected).with_detail(e.to_string()))?;
        let registry = crate::model::load_registry(&data_dir, &resource_dir);
        if capability == "llm" {
            let selected =
                crate::llm::select_test_model(&config.llm, &registry, &provider_id, &model_id)?;
            crate::llm::validate_llm_config(&selected, &registry)?;
            crate::llm::call_llm_once(
                &selected,
                &registry,
                "Hello",
                "Reply briefly to the greeting.",
            )
            .await
        } else {
            let selected = select_asr_model(&config, &registry, &provider_id, &model_id)?;
            run_asr(selected, &registry, data_dir, resource_dir).await
        }
    };
    let output = tokio::select! {
        biased;
        _ = rx => return Err(AppError::new(AppErrorCode::Cancelled)),
        result = tokio::time::timeout(TIMEOUT, work) => match result {
            Ok(result) => result,
            Err(_) => Err(AppError::new(if capability == "llm" { AppErrorCode::LlmTimeout } else { AppErrorCode::AsrTestFailed }).with_detail("Model test timed out")),
        },
    }.map_err(|error| {
        if error.code == AppErrorCode::AsrTestFailed {
            error.with_param("provider", &provider_id)
        } else {
            error
        }
    })?;
    Ok(ModelTestResult {
        output,
        elapsed_ms: start.elapsed().as_millis().min(u64::MAX as u128) as u64,
    })
}

#[tauri::command]
pub fn cancel_model_test(test_id: String) {
    if test_id.trim().is_empty() {
        return;
    }
    let mut active = tests().lock().unwrap();
    active.retain(|_, state| !matches!(state, TestState::Cancelled(at) if at.elapsed() > Duration::from_secs(60)));
    match active.get_mut(&test_id) {
        Some(TestState::Active(sender)) => {
            if let Some(sender) = sender.take() {
                let _ = sender.send(());
            }
        }
        Some(TestState::Cancelled(_)) => {}
        None => {
            // Bound cancellation records for IDs whose test never arrives.
            if active
                .values()
                .filter(|state| matches!(state, TestState::Cancelled(_)))
                .count()
                < 1024
            {
                active.insert(test_id, TestState::Cancelled(Instant::now()));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{LlmModelEntry, LlmModelParams, ProviderConfig};

    fn registry() -> ModelRegistry {
        serde_json::from_str(include_str!("../../registry.json")).unwrap()
    }

    #[test]
    fn accepts_json_config_snapshot() {
        let mut config = AppConfig::default();
        config.audio.insert(
            "provider".into(),
            serde_norway::Value::String("example".into()),
        );
        let json = serde_json::to_value(&config).unwrap();
        let decoded: AppConfig = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), json);
    }

    #[test]
    fn asr_selection_is_exact_and_does_not_change_snapshot() {
        let config = AppConfig::default();
        let before = serde_json::to_value(&config).unwrap();
        let registry = registry();
        let entry = registry
            .models
            .iter()
            .find(|entry| entry.category == ModelCategory::Asr && entry.provider.is_some())
            .unwrap();
        let provider = entry.provider.as_deref().unwrap();
        let selected = select_asr_model(&config, &registry, provider, &entry.id).unwrap();
        assert_eq!(selected.audio_provider(), entry.id);
        assert_eq!(serde_json::to_value(&config).unwrap(), before);
        assert!(select_asr_model(&config, &registry, "wrong-provider", &entry.id).is_err());
        assert!(select_asr_model(&config, &registry, provider, "missing").is_err());
    }

    #[test]
    fn cancellation_before_registration_is_honored() {
        let id = "model-test-early-cancel";
        cancel_model_test(id.into());
        assert!(matches!(register_test(id), Err(error) if error.code == AppErrorCode::Cancelled));
        assert!(register_test(id).is_ok());
    }

    #[derive(Default)]
    struct MockAsrState {
        samples: Mutex<Vec<f32>>,
        closed: std::sync::atomic::AtomicBool,
        committed: std::sync::atomic::AtomicBool,
    }

    enum MockFinal {
        Text(&'static str),
        CloseThenText,
        ErrorThenText,
        Pending,
    }

    struct MockSession {
        state: std::sync::Arc<MockAsrState>,
        events: tokio::sync::mpsc::UnboundedSender<AsrEvent>,
        outcome: MockFinal,
    }

    #[async_trait::async_trait]
    impl AsrSession for MockSession {
        fn is_ready(&self) -> bool {
            true
        }
        fn append_audio(&self, samples: &[f32]) {
            self.state
                .samples
                .lock()
                .unwrap()
                .extend_from_slice(samples);
        }
        async fn commit_and_await_final(&self) -> Result<String, AppError> {
            self.state
                .committed
                .store(true, std::sync::atomic::Ordering::SeqCst);
            match self.outcome {
                MockFinal::Text(text) => Ok(text.into()),
                MockFinal::CloseThenText => {
                    self.events
                        .send(AsrEvent::Close {
                            code: Some(1000),
                            reason: "Finished".into(),
                        })
                        .unwrap();
                    tokio::task::yield_now().await;
                    Ok("recognized".into())
                }
                MockFinal::ErrorThenText => {
                    self.events
                        .send(AsrEvent::Error {
                            error: AppError::new(AppErrorCode::AsrNetwork),
                            fatal: true,
                        })
                        .unwrap();
                    Ok("recognized".into())
                }
                MockFinal::Pending => std::future::pending().await,
            }
        }
        fn close(&self) {
            self.state
                .closed
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    fn mock_session(
        outcome: MockFinal,
    ) -> (
        Box<dyn AsrSession>,
        tokio::sync::mpsc::UnboundedReceiver<AsrEvent>,
        std::sync::Arc<MockAsrState>,
    ) {
        let state = std::sync::Arc::new(MockAsrState::default());
        let (events, receiver) = tokio::sync::mpsc::unbounded_channel();
        (
            Box::new(MockSession {
                state: state.clone(),
                events,
                outcome,
            }),
            receiver,
            state,
        )
    }

    #[tokio::test]
    async fn asr_workflow_appends_pcm_and_accepts_final_after_close() {
        use std::sync::atomic::Ordering;
        let (session, events, state) = mock_session(MockFinal::CloseThenText);
        let result = run_asr_session(session, events, &[0, 64, 0, 192])
            .await
            .unwrap();
        assert_eq!(result, "recognized");
        assert_eq!(*state.samples.lock().unwrap(), vec![0.5, -0.5]);
        assert!(state.committed.load(Ordering::SeqCst));
        assert!(state.closed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn asr_workflow_rejects_empty_final_and_queued_error() {
        use std::sync::atomic::Ordering;
        for (outcome, expected) in [
            (MockFinal::Text("  "), AppErrorCode::AsrTestFailed),
            (MockFinal::ErrorThenText, AppErrorCode::AsrNetwork),
        ] {
            let (session, events, state) = mock_session(outcome);
            let error = run_asr_session(session, events, &[0, 64])
                .await
                .unwrap_err();
            assert_eq!(error.code, expected);
            assert!(state.committed.load(Ordering::SeqCst));
            assert!(state.closed.load(Ordering::SeqCst));
        }
    }

    #[tokio::test]
    async fn asr_close_before_commit_fails_and_closes_session() {
        use std::sync::atomic::Ordering;
        let (session, events, state) = mock_session(MockFinal::Pending);
        // A close while audio is still being sent cannot confirm a final result.
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        sender
            .send(AsrEvent::Close {
                code: None,
                reason: "early".into(),
            })
            .unwrap();
        drop(events);
        let error = run_asr_session(session, receiver, &[0, 64])
            .await
            .unwrap_err();
        assert_eq!(error.code, AppErrorCode::AsrTestFailed);
        assert!(!state.committed.load(Ordering::SeqCst));
        assert!(state.closed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn cancelling_asr_workflow_closes_session() {
        use std::sync::atomic::Ordering;
        let id = "model-test-cancel-workflow";
        let (registration, rx) = register_test(id).unwrap();
        let (session, events, state) = mock_session(MockFinal::Pending);
        let task = tokio::spawn(async move {
            let _registration = registration;
            tokio::select! {
                _ = rx => Err(AppError::new(AppErrorCode::Cancelled)),
                result = run_asr_session(session, events, &[0, 64]) => result,
            }
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !state.committed.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        cancel_model_test(id.into());
        assert_eq!(
            task.await.unwrap().unwrap_err().code,
            AppErrorCode::Cancelled
        );
        assert!(state.closed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn llm_test_targets_model_and_parses_real_response() {
        use wiremock::{
            matchers::{body_partial_json, method},
            Mock, MockServer, ResponseTemplate,
        };
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(body_partial_json(serde_json::json!({"model":"vendor-target", "temperature":0.3, "max_tokens":42})))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"choices":[{"message":{"content":"Hello there"},"finish_reason":"stop"}]})))
            .expect(1).mount(&server).await;
        let mut config = AppConfig::default();
        config.llm.provider = "deepseek".into();
        config.llm.default_model = Some("other".into());
        config.llm.openai = Some(ProviderConfig {
            url: server.uri(),
            api_key: "test-key".into(),
            model: String::new(),
            models: Some(vec![LlmModelEntry {
                id: "target".into(),
                model_id: Some("vendor-target".into()),
                params: Some(LlmModelParams {
                    temperature: Some(0.3),
                    max_tokens: Some(42),
                    top_p: None,
                }),
                ..Default::default()
            }]),
        });
        let before = serde_json::to_value(&config).unwrap();
        let registry = registry();
        let selected =
            crate::llm::select_test_model(&config.llm, &registry, "openai", "target").unwrap();
        let output = crate::llm::call_llm_once(&selected, &registry, "Hello", "Reply briefly")
            .await
            .unwrap();
        assert_eq!(output, "Hello there");
        assert_eq!(serde_json::to_value(&config).unwrap(), before);
        assert!(
            crate::llm::select_test_model(&config.llm, &registry, "deepseek", "target").is_err()
        );
        assert!(
            crate::llm::select_test_model(&config.llm, &registry, "openai", "missing").is_err()
        );
    }
}

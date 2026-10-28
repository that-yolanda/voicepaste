//! Deferred-polish decision window.
//!
//! When an LLM polish fails, the recognized text is deliberately NOT pasted.
//! Instead it is parked here while the overlay explains why polishing failed and
//! offers three ways out:
//!
//! - the main hotkey runs the polish again,
//! - ESC discards the text — nothing is pasted and nothing is recorded,
//! - Enter pastes the raw text immediately, without polishing,
//! - doing nothing pastes the raw text once the decision window lapses.
//!
//! While a retry is in flight the same keys interrupt it: ESC aborts the
//! request and discards the text, Enter aborts it and pastes the raw text.
//!
//! This mirrors the ASR failure affordance, except the timer *delivers* the text
//! rather than discarding it: the user should never lose a transcript because
//! polishing was down.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::app_state::{self, set_app_state, PendingPolish, PolishRetryCommand};
use crate::errors::{AppError, AppErrorCode};
use crate::overlay;

use super::emit_hint;
use super::finalize;

/// How long the user has to retry before the raw text is pasted automatically.
const POLISH_DECISION_WINDOW: Duration = Duration::from_secs(5);

/// Park a failed polish and show the reason, arming the retry affordance and the
/// auto-deliver timer. The caller must not hide the overlay afterwards.
pub(super) async fn arm_pending_polish(
    app_handle: &AppHandle,
    app_inner: &Arc<app_state::AppInner>,
    raw_text: String,
    prompt_id: &str,
    error: &AppError,
) {
    log_rec!(
        warn,
        "LLM polishing failed: {}; holding text for retry",
        error
    );

    let epoch = app_inner.polish_epoch.fetch_add(1, Ordering::SeqCst) + 1;
    *app_inner.pending_polish.lock().await = Some(PendingPolish {
        raw_text,
        prompt_id: prompt_id.to_string(),
    });

    // Settle to Idle first: that is the state the hotkey and ESC routing look
    // for, and it must land before the decision keys are re-armed because the
    // transition turns ESC off on its way through.
    set_app_state(app_handle, app_inner, app_state::AppState::Idle).await;
    overlay::set_decision_keys_enabled(app_handle, true);

    overlay::emit_polish_decision_hint(app_handle, app_inner, error).await;
    // The keyboard-only decision window stays click-through.
    let app_handle = app_handle.clone();
    let app_inner = Arc::clone(app_inner);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(POLISH_DECISION_WINDOW).await;
        // A retry, ESC or Enter in the meantime bumped the epoch; stand down.
        if app_inner.polish_epoch.load(Ordering::SeqCst) != epoch {
            return;
        }
        deliver_raw(&app_handle, &app_inner, "decision window lapsed").await;
    });
}

/// Whether a failed polish is currently waiting on the user.
pub(crate) async fn has_pending_polish(app_inner: &Arc<app_state::AppInner>) -> bool {
    app_inner.pending_polish.lock().await.is_some()
}

/// Claim the pending polish, bumping the epoch so any armed timer stands down.
async fn take_pending(app_inner: &Arc<app_state::AppInner>) -> Option<PendingPolish> {
    let pending = app_inner.pending_polish.lock().await.take();
    if pending.is_some() {
        app_inner.polish_epoch.fetch_add(1, Ordering::SeqCst);
    }
    pending
}

/// ESC on the decision window: discard the parked text. Nothing is pasted and
/// nothing is written to history — the user explicitly cancelled.
pub(crate) async fn cancel_pending(app_handle: &AppHandle, app_inner: &Arc<app_state::AppInner>) {
    let Some(pending) = take_pending(app_inner).await else {
        return;
    };
    log_rec!(
        info,
        "Discarding pending polish ({} chars) via ESC",
        pending.raw_text.chars().count()
    );
    overlay::hide(app_handle);
    dismiss_overlay(app_handle, app_inner).await;
}

/// Whether a polish retry is currently in flight. Hotkey routing consults this
/// to ignore presses and stray stops while the retry runs.
pub(crate) fn is_retry_active(app_inner: &Arc<app_state::AppInner>) -> bool {
    app_inner.polish_retry_active.load(Ordering::SeqCst)
}

/// Send an interruption to the in-flight polish retry, if any. The receiver is
/// owned by the retry task, so a command arriving after it finished is dropped
/// together with that task's channel.
pub(crate) async fn interrupt_retry(
    app_inner: &Arc<app_state::AppInner>,
    command: PolishRetryCommand,
) {
    let tx = app_inner.polish_retry_cmd_tx.lock().await.clone();
    if let Some(tx) = tx {
        let _ = tx.send(command);
    }
}

/// Give up on polishing and paste the recognized text unchanged.
pub(crate) async fn deliver_raw(
    app_handle: &AppHandle,
    app_inner: &Arc<app_state::AppInner>,
    reason: &str,
) {
    let Some(pending) = take_pending(app_inner).await else {
        return;
    };
    log_rec!(
        info,
        "Pasting unpolished text ({} chars): {}",
        pending.raw_text.chars().count(),
        reason
    );
    let config = app_inner.config_manager.load_config().ok();
    // No raw_text: the delivered text *is* the raw transcript. The prompt id is
    // kept so the entry can still be polished later from the history list.
    let polish = crate::stats::PolishRecord {
        prompt_id: Some(pending.prompt_id.clone()),
        raw_text: None,
    };
    finalize::deliver_text(
        app_handle,
        app_inner,
        &pending.raw_text,
        config.as_ref(),
        polish,
    )
    .await;
    dismiss_overlay(app_handle, app_inner).await;
}

/// Run the failed polish again with the same prompt. On success the polished
/// text is pasted; on another failure the decision window is re-armed with the
/// new reason, so the user can keep retrying or let it fall through. ESC
/// interrupts the request and discards the text; Enter interrupts it and pastes
/// the raw text.
/// Returns false when nothing was pending or a retry is already in flight.
pub(crate) async fn retry_pending_polish(app_handle: AppHandle) -> bool {
    let app_inner = Arc::clone(&app_handle.state::<Arc<app_state::AppInner>>());
    // Re-entry guard: the retry button and the hotkey can race; the loser must
    // not start a second concurrent polish over the same text.
    if is_retry_active(&app_inner) {
        return false;
    }
    let Some(pending) = take_pending(&app_inner).await else {
        return false;
    };
    app_inner.polish_retry_active.store(true, Ordering::SeqCst);
    let (cmd_tx, mut cmd_rx) = tokio::sync::mpsc::unbounded_channel();
    *app_inner.polish_retry_cmd_tx.lock().await = Some(cmd_tx);

    // Stop the countdown ring and the click target while the request is in flight.
    // Back to Finishing: the overlay only spins its indicator while connecting or
    // finishing, so a retry left in Idle would show a dead dot instead of the
    // same spinner the first polish shows.
    set_app_state(&app_handle, &app_inner, app_state::AppState::Finishing).await;
    // Decision keys stay live across the retry: ESC aborts and discards, Enter
    // aborts and pastes the raw text.
    overlay::set_decision_keys_enabled(&app_handle, true);
    emit_hint(&app_handle, "润色中", "info", "progress");

    // What ended the polish call: its own outcome, or an ESC/Enter interruption.
    enum Step {
        Outcome(crate::llm::PolishOutcome),
        Interrupted(PolishRetryCommand),
    }

    let config = app_inner.config_manager.load_config().ok();
    let step = if let Some(config) = config.as_ref() {
        let prompts = app_inner.config_manager.load_prompts();
        let hotwords = app_inner.hotword_manager.active_words();
        let registry = load_registry(&app_handle);
        tokio::select! {
            outcome = crate::llm::polish_transcript(
                config,
                &prompts,
                Some(pending.prompt_id.as_str()),
                &hotwords,
                &registry,
                &pending.raw_text,
            ) => Step::Outcome(outcome),
            // `None` (no senders left) is unreachable while this task's sender
            // sits in AppInner; treat it as a cancel all the same.
            cmd = cmd_rx.recv() => {
                Step::Interrupted(cmd.unwrap_or(PolishRetryCommand::Cancel))
            }
        }
    } else {
        log_rec!(warn, "Config unavailable on polish retry; pasting raw text");
        Step::Outcome(crate::llm::PolishOutcome::NotPolished)
    };

    match step {
        Step::Interrupted(PolishRetryCommand::Cancel) => {
            log_rec!(
                info,
                "Polish retry aborted with ESC; discarding text ({} chars)",
                pending.raw_text.chars().count()
            );
            dismiss_overlay(&app_handle, &app_inner).await;
        }
        Step::Interrupted(PolishRetryCommand::DeliverRaw) => {
            log_rec!(info, "Polish retry aborted with Enter; pasting raw text");
            // Not deliver_raw: the pending entry was already taken above, so
            // paste from the local copy directly.
            let polish = crate::stats::PolishRecord {
                prompt_id: Some(pending.prompt_id.clone()),
                raw_text: None,
            };
            finalize::deliver_text(
                &app_handle,
                &app_inner,
                &pending.raw_text,
                config.as_ref(),
                polish,
            )
            .await;
            dismiss_overlay(&app_handle, &app_inner).await;
        }
        Step::Outcome(crate::llm::PolishOutcome::Polished(text)) => {
            log_rec!(
                info,
                "LLM polishing retry succeeded ({} chars)",
                text.chars().count()
            );
            let polish = crate::stats::PolishRecord {
                prompt_id: Some(pending.prompt_id.clone()),
                raw_text: Some(pending.raw_text.clone()),
            };
            finalize::deliver_text(&app_handle, &app_inner, &text, config.as_ref(), polish).await;
            dismiss_overlay(&app_handle, &app_inner).await;
        }
        Step::Outcome(crate::llm::PolishOutcome::NotPolished) => {
            let polish = crate::stats::PolishRecord {
                prompt_id: Some(pending.prompt_id.clone()),
                raw_text: None,
            };
            finalize::deliver_text(
                &app_handle,
                &app_inner,
                &pending.raw_text,
                config.as_ref(),
                polish,
            )
            .await;
            dismiss_overlay(&app_handle, &app_inner).await;
        }
        Step::Outcome(crate::llm::PolishOutcome::Failed(error)) => {
            arm_pending_polish(
                &app_handle,
                &app_inner,
                pending.raw_text,
                &pending.prompt_id,
                &error,
            )
            .await;
        }
    }

    // Single cleanup tail: drop the command channel and clear the flag. This
    // must NOT touch the decision-key gates — a Failed outcome re-armed them
    // in arm_pending_polish just above, and this tail runs after it.
    *app_inner.polish_retry_cmd_tx.lock().await = None;
    app_inner.polish_retry_active.store(false, Ordering::SeqCst);
    true
}

/// Tear down the decision window: the decision keys (ESC/Enter) and the retry
/// affordance go away and the overlay hides, leaving the app idle.
async fn dismiss_overlay(app_handle: &AppHandle, app_inner: &Arc<app_state::AppInner>) {
    if !app_inner.feedback_visible.load(Ordering::SeqCst) {
        overlay::set_decision_keys_enabled(app_handle, false);
        overlay::hide(app_handle);
        set_app_state(app_handle, app_inner, app_state::AppState::Idle).await;
    }
}

/// Load the model registry from the app's resource and data directories.
fn load_registry(app_handle: &AppHandle) -> crate::model::ModelRegistry {
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    crate::model::load_registry(&data_dir, &resource_dir)
}

/// Re-run polishing on a history entry and rewrite its text in place. Runs
/// silently: no overlay, no clipboard, no paste — the settings history list owns
/// the feedback. Polishes from the stored raw transcript when there is one, so
/// repeated attempts never compound on already-polished prose.
///
/// `prompt_id` picks the template; when omitted the entry's own template is
/// reused. Entries delivered by the main hotkey have none, so the caller must
/// pick one for them — that is how a forgotten polish gets a second chance.
pub(crate) async fn repolish_history_entry(
    app_handle: AppHandle,
    ts: String,
    prompt_id: Option<String>,
) -> Result<serde_json::Value, AppError> {
    let app_inner = app_handle.state::<Arc<app_state::AppInner>>();

    let entry = {
        let stats = app_inner.stats.lock().await;
        stats
            .find_history(&ts)
            .ok_or_else(|| AppError::new(AppErrorCode::StatsEntryNotFound))?
    };
    if entry.status != "success" {
        return Err(AppError::new(AppErrorCode::StatsEntryNotPolishable));
    }
    let prompt_id = prompt_id
        .filter(|id| !id.is_empty())
        .or(entry.prompt_id)
        .ok_or_else(|| AppError::new(AppErrorCode::LlmPromptMissing))?;
    let source = entry.raw_text.unwrap_or(entry.text);
    if source.trim().is_empty() {
        return Err(AppError::new(AppErrorCode::StatsNoPolishText));
    }

    let config = app_inner
        .config_manager
        .load_config()
        .map_err(|_| AppError::new(AppErrorCode::InvalidConfig))?;
    crate::llm::validate_llm_config(&config.llm)?;

    let prompts = app_inner.config_manager.load_prompts();
    let hotwords = app_inner.hotword_manager.active_words();
    let registry = load_registry(&app_handle);

    let polished = match crate::llm::polish_transcript(
        &config,
        &prompts,
        Some(prompt_id.as_str()),
        &hotwords,
        &registry,
        &source,
    )
    .await
    {
        crate::llm::PolishOutcome::Polished(text) => text,
        crate::llm::PolishOutcome::NotPolished => {
            return Err(AppError::new(AppErrorCode::LlmPromptUnavailable))
        }
        crate::llm::PolishOutcome::Failed(error) => return Err(error),
    };

    let updated = app_inner
        .stats
        .lock()
        .await
        .update_history_polished_text(&ts, &polished, &source, &prompt_id);
    if !updated {
        return Err(AppError::new(AppErrorCode::StatsUpdateFailed));
    }

    log_rec!(
        info,
        "Re-polished history entry ({} chars)",
        polished.chars().count()
    );
    Ok(serde_json::json!({ "ok": true, "text": polished, "promptId": prompt_id }))
}

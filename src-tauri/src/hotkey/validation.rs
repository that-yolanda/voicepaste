//! One binding compiler for startup, saves, runtime reloads and settings warnings.
use std::collections::{BTreeMap, HashSet};

use serde::Serialize;

use super::{parse_hotkey_string, recorder, HotkeyBinding, HotkeyMode};
use crate::config::{AppSettings, PromptItem};
use crate::errors::{AppError, AppErrorCode};

/// A binding problem, surfaced either as a passive settings warning (the
/// `hotkeyIssues` payload) or as a blocking save error. The `code` + `params`
/// are rendered by the frontend through the locale files; `title` params carry
/// either the reserved ids `main`/`voice` (localized on the frontend) or a
/// prompt template's user-editable title verbatim.
#[derive(Debug, Clone, Serialize)]
pub struct BindingIssue {
    pub id: String,
    pub code: AppErrorCode,
    pub params: BTreeMap<String, String>,
    #[serde(skip)]
    fingerprint: String,
}

impl BindingIssue {
    fn new(
        id: String,
        code: AppErrorCode,
        params: BTreeMap<String, String>,
        fingerprint: String,
    ) -> Self {
        Self {
            id,
            code,
            params,
            fingerprint,
        }
    }

    /// Render as a blocking `AppError` for save-time validation, swapping the
    /// passive "conflict stopped" wording for the imperative variant when the
    /// caller is blocking a save.
    fn to_error(&self, blocking: bool) -> AppError {
        let code = if self.code == AppErrorCode::HotkeyConflict && blocking {
            AppErrorCode::HotkeyConflictStopped
        } else {
            self.code
        };
        AppError {
            code,
            params: self.params.clone(),
            detail: None,
        }
    }
}

pub fn compile_bindings(
    app: &AppSettings,
    prompts: &[PromptItem],
) -> (Vec<HotkeyBinding>, Vec<BindingIssue>) {
    let main = app.hotkey.as_str().unwrap_or("");
    let voice = app
        .voice_hotkey
        .as_deref()
        .unwrap_or(if app.hotkey_mode == "hold" { "" } else { main });
    let mut specs = vec![
        (
            "main".to_string(),
            "main".to_string(),
            main,
            "toggle",
            None,
            true,
        ),
        (
            "voice".to_string(),
            "voice".to_string(),
            voice,
            app.hotkey_mode.as_str(),
            None,
            false,
        ),
    ];
    for prompt in prompts {
        specs.push((
            format!("prompt:{}", prompt.id),
            prompt.title.clone(),
            &prompt.hotkey,
            &prompt.hotkey_mode,
            Some(prompt.id.clone()),
            false,
        ));
    }
    let mut candidates = Vec::new();
    let mut issues = Vec::new();
    for (id, title, text, mode, prompt_id, wake_only) in specs {
        if text.is_empty() {
            continue;
        }
        let Some(keys) = parse_hotkey_string(text) else {
            let mut params = BTreeMap::new();
            params.insert("title".to_string(), title);
            params.insert("key".to_string(), text.to_string());
            issues.push(BindingIssue::new(
                id,
                AppErrorCode::HotkeyUnrecognized,
                params,
                format!("invalid:{text}"),
            ));
            continue;
        };
        let mode = HotkeyMode::from_str(mode);
        if (wake_only || mode == HotkeyMode::Hold)
            && !keys.iter().any(|k| recorder::is_valid_main_first_key(*k))
        {
            let mut params = BTreeMap::new();
            params.insert("title".to_string(), title);
            issues.push(BindingIssue::new(
                id,
                AppErrorCode::HotkeyNeedsModifier,
                params,
                format!("first-key:{keys:?}"),
            ));
            continue;
        }
        candidates.push((
            id,
            title,
            text.to_string(),
            HotkeyBinding {
                keys,
                mode,
                prompt_id,
                wake_only,
            },
        ));
    }
    let main_keys = candidates
        .iter()
        .find(|(_, _, _, b)| b.wake_only)
        .map(|(_, _, _, b)| b.keys.clone());
    let protected = |b: &HotkeyBinding| {
        b.wake_only
            || (b.mode == HotkeyMode::Toggle
                && b.prompt_id.is_none()
                && Some(&b.keys) == main_keys.as_ref())
    };
    let mut disabled = HashSet::new();
    for i in 0..candidates.len() {
        for j in i + 1..candidates.len() {
            let (id_a, title_a, text_a, a) = &candidates[i];
            let (id_b, title_b, text_b, b) = &candidates[j];
            let same = a.keys == b.keys;
            // Only the raw toggle stop is allowed to share the global wake key.
            if same && a.wake_only && b.prompt_id.is_none() && b.mode == HotkeyMode::Toggle {
                continue;
            }
            let contains_hold = (a.mode == HotkeyMode::Hold || b.mode == HotkeyMode::Hold)
                && (a.keys.is_subset(&b.keys) || b.keys.is_subset(&a.keys));
            if same || contains_hold {
                let params = |title: &str, text: &str, other_title: &str, other_text: &str| {
                    let mut params = BTreeMap::new();
                    params.insert("aTitle".to_string(), title.to_string());
                    params.insert("aKey".to_string(), text.to_string());
                    params.insert("bTitle".to_string(), other_title.to_string());
                    params.insert("bKey".to_string(), other_text.to_string());
                    params
                };
                let fingerprint = format!("conflict:{id_a}:{:?}:{id_b}:{:?}", a.keys, b.keys);
                if !protected(a) {
                    disabled.insert(i);
                    issues.push(BindingIssue::new(
                        id_a.clone(),
                        AppErrorCode::HotkeyConflict,
                        params(title_a, text_a, title_b, text_b),
                        fingerprint.clone(),
                    ));
                }
                if !protected(b) {
                    disabled.insert(j);
                    issues.push(BindingIssue::new(
                        id_b.clone(),
                        AppErrorCode::HotkeyConflict,
                        params(title_b, text_b, title_a, text_a),
                        fingerprint,
                    ));
                }
            }
        }
    }
    let bindings: Vec<HotkeyBinding> = candidates
        .into_iter()
        .enumerate()
        .filter_map(|(i, (_, _, _, b))| (!disabled.contains(&i)).then_some(b))
        .collect();
    (bindings, issues)
}

/// A mode switch must clear an invalid target even if the same conflict was
/// already present in an older configuration. Unrelated legacy issues remain.
pub fn validate_target(
    app: &AppSettings,
    prompts: &[PromptItem],
    target: &str,
) -> Result<(), AppError> {
    if let Some(issue) = compile_bindings(app, prompts)
        .1
        .into_iter()
        .find(|issue| issue.id == target)
    {
        return Err(issue.to_error(true));
    }
    Ok(())
}

/// Existing invalid bindings must not prevent unrelated settings from being saved.
pub fn validate_change(
    app: &AppSettings,
    prompts: &[PromptItem],
    previous: &AppSettings,
    previous_prompts: &[PromptItem],
) -> Result<(), AppError> {
    let (_, old) = compile_bindings(previous, previous_prompts);
    let (_, new) = compile_bindings(app, prompts);
    if let Some(issue) = new.iter().find(|issue| {
        !old.iter()
            .any(|old| old.id == issue.id && old.fingerprint == issue.fingerprint)
    }) {
        return Err(issue.to_error(true));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AppConfig;
    fn prompt(key: &str, mode: &str) -> PromptItem {
        serde_json::from_value(
            serde_json::json!({"id":"p","title":"润色","hotkey":key,"hotkey_mode":mode}),
        )
        .unwrap()
    }
    #[test]
    fn raw_stop_may_share_global_but_prompt_may_not() {
        let c = AppConfig::default();
        assert!(compile_bindings(&c.app, &[]).1.is_empty());
        let (bindings, issues) =
            compile_bindings(&c.app, &[prompt(crate::config::DEFAULT_HOTKEY, "toggle")]);
        assert!(!issues.is_empty());
        assert!(bindings.iter().any(|b| b.wake_only));
        assert!(!bindings.iter().any(|b| b.prompt_id.is_some()));
    }
    #[test]
    fn hold_containment_is_checked_in_both_directions() {
        for (global, hold_key) in [
            ("ControlLeft", "ControlLeft+C"),
            ("ControlLeft+C", "ControlLeft"),
        ] {
            let mut c = AppConfig::default();
            c.app.hotkey = global.into();
            c.app.voice_hotkey = Some(global.into());
            let (bindings, issues) = compile_bindings(&c.app, &[prompt(hold_key, "hold")]);
            assert!(!issues.is_empty());
            assert!(bindings.iter().any(|b| b.wake_only));
            assert!(!bindings.iter().any(|b| b.mode == HotkeyMode::Hold));
        }
    }
    #[test]
    fn toggle_containment_is_allowed() {
        let mut c = AppConfig::default();
        c.app.hotkey = "ControlLeft".into();
        c.app.voice_hotkey = Some("ControlLeft".into());
        assert!(
            compile_bindings(&c.app, &[prompt("ControlLeft+ShiftLeft", "toggle")])
                .1
                .is_empty()
        );
    }
    #[test]
    fn plain_typing_hold_is_disabled_but_typing_toggle_stop_is_allowed() {
        let c = AppConfig::default();
        assert!(!compile_bindings(&c.app, &[prompt("C", "hold")])
            .1
            .is_empty());
        assert!(compile_bindings(&c.app, &[prompt("C", "toggle")])
            .1
            .is_empty());
    }
    #[test]
    fn existing_conflicts_do_not_block_unrelated_saves_but_new_ones_do() {
        let c = AppConfig::default();
        let p = vec![prompt(crate::config::DEFAULT_HOTKEY, "toggle")];
        assert!(validate_change(&c.app, &p, &c.app, &p).is_ok());
        assert!(validate_change(&c.app, &p, &c.app, &[]).is_err());
    }
    #[test]
    fn global_raw_stop_alias_is_preserved_when_a_legacy_hold_conflicts() {
        let mut c = AppConfig::default();
        c.app.hotkey = "ControlLeft".into();
        c.app.voice_hotkey = Some("ControlLeft".into());
        let (bindings, issues) = compile_bindings(&c.app, &[prompt("ControlLeft+C", "hold")]);
        assert!(!issues.is_empty());
        assert_eq!(bindings.len(), 2);
        assert!(bindings.iter().all(|b| b.prompt_id.is_none()));
    }
    #[test]
    fn renaming_an_existing_conflicting_prompt_is_not_a_new_conflict() {
        let c = AppConfig::default();
        let old = vec![prompt(crate::config::DEFAULT_HOTKEY, "toggle")];
        let mut new = old.clone();
        new[0].title = "新标题".into();
        assert!(validate_change(&c.app, &new, &c.app, &old).is_ok());
        new[0].hotkey = format!("{}+ShiftLeft", crate::config::DEFAULT_HOTKEY);
        new[0].hotkey_mode = "hold".into();
        assert!(validate_change(&c.app, &new, &c.app, &old).is_err());
    }
    #[test]
    fn hold_only_configuration_is_valid_without_a_hands_free_stop() {
        let previous = AppConfig::default();
        let mut changed = previous.clone();
        changed.app.hotkey_mode = "hold".into();
        changed.app.voice_hotkey = Some("F2".into());
        assert!(validate_change(&changed.app, &[], &previous.app, &[]).is_ok());
        let (bindings, issues) = compile_bindings(&changed.app, &[]);
        assert!(bindings.iter().any(|b| b.wake_only));
        assert!(!bindings
            .iter()
            .any(|b| !b.wake_only && b.mode == HotkeyMode::Toggle));
        assert!(issues.is_empty());
    }
    #[test]
    fn mode_switch_checks_the_target_even_if_legacy_conflict_is_unchanged() {
        let c = AppConfig::default();
        let mut prompts = vec![prompt(crate::config::DEFAULT_HOTKEY, "toggle")];
        assert!(validate_change(&c.app, &prompts, &c.app, &prompts).is_ok());
        assert!(validate_target(&c.app, &prompts, "prompt:p").is_err());
        prompts[0].hotkey.clear();
        assert!(validate_target(&c.app, &prompts, "prompt:p").is_ok());
    }
    #[test]
    fn clearing_a_hold_key_is_a_valid_disabled_state_without_a_warning() {
        let mut c = AppConfig::default();
        c.app.hotkey_mode = "hold".into();
        c.app.voice_hotkey = Some(String::new());
        assert!(compile_bindings(&c.app, &[]).1.is_empty());
        assert!(validate_target(&c.app, &[], "voice").is_ok());
    }
}

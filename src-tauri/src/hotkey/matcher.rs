//! Hotkey chord-matching state machine over the raw keytap event stream.

use keytap::{EventKind, Key};
use std::collections::HashSet;

use super::{HotkeyBinding, HotkeyMode};

/// Actions emitted by [`MatcherState::process`]. The listener spawns these on
/// the async runtime; lib.rs decides whether a `StartRecording` actually
/// records (or is diverted to a retry) and resets the matcher when it doesn't.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HotkeyAction {
    /// Begin a neutral recording — the prompt is decided later, on stop.
    /// `is_main` is true when the triggering chord is the main hotkey
    /// (prompt_id `None`), which gates the "press main hotkey to retry the
    /// last failure" shortcut.
    StartRecording { is_main: bool },
    /// End the recording and finalize with the given prompt (`None` = raw
    /// paste, no polishing).
    StopRecording { prompt_id: Option<String> },
}

/// Pure state machine over the raw keytap event stream.
///
/// Resolves chord conflicts without any timeout/pending:
/// - A **hold** chord starts recording the instant its keys are all pressed
///   (keydown) — zero latency, prompt undecided.
/// - A **toggle** chord starts/stops on completion of a press cycle (the held
///   set empties at keyup); the prompt is the longest chord reached in that
///   stop cycle.
/// - Recording always starts *neutral*; the prompt is fixed only when it ends,
///   from the longest chord held during the hold (peak) or the stop cycle.
///   The chord is fully known at that point, so prefix conflicts like `Ctrl`
///   vs `Ctrl+Shift` resolve correctly with no waiting.
#[derive(Debug, Default)]
pub struct MatcherState {
    /// Currently physically held keys.
    pub(super) held: HashSet<Key>,
    /// Longest binding matched during the current press cycle / hold (peak).
    cycle_best: Option<usize>,
    /// What the matcher believes is recording, if anything. Authoritative on
    /// the hotkey side; lib.rs resets it via [`MatcherState::reset_recording`]
    /// when a start is diverted to retry or fails, or when recording cancels.
    recording: Option<HotkeyMode>,
    /// For hold: the binding that started the session — its keys leaving the
    /// held set ends the session.
    active_hold: Option<usize>,
}

impl MatcherState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Clear all matcher-side state after the app ended a recording out-of-band.
    pub fn reset_recording(&mut self) {
        self.held.clear();
        self.recording = None;
        self.cycle_best = None;
        self.active_hold = None;
    }

    /// Advance the machine one event. Returns the actions to dispatch.
    ///
    /// The caller (the listener) filters out events for keys that are not part
    /// of any binding via [`is_relevant_hotkey_event`], so `held` only ever
    /// tracks hotkey-relevant keys.
    pub fn process(&mut self, kind: EventKind, bindings: &[HotkeyBinding]) -> Vec<HotkeyAction> {
        let mut actions = Vec::new();
        match kind {
            EventKind::KeyDown(k) => {
                self.held.insert(k);
                self.update_cycle_best(bindings);
                // Hold starts on keydown the moment its chord completes.
                if self.recording.is_none() {
                    if let Some(idx) = longest_match(&self.held, bindings) {
                        if bindings[idx].mode == HotkeyMode::Hold {
                            let is_main = bindings[idx].prompt_id.is_none();
                            self.recording = Some(HotkeyMode::Hold);
                            self.active_hold = Some(idx);
                            actions.push(HotkeyAction::StartRecording { is_main });
                        }
                    }
                }
            }
            EventKind::KeyUp(k) => {
                self.held.remove(&k);
                // No update_cycle_best here: cycle_best only grows, and a KeyUp
                // shrinks `held`, so it could never produce a longer match — the
                // call was a guaranteed no-op.
                match self.recording {
                    Some(HotkeyMode::Hold) => {
                        // End when the active hold chord is no longer fully held.
                        let still_held = self
                            .active_hold
                            .map(|i| bindings[i].keys.iter().all(|key| self.held.contains(key)))
                            .unwrap_or(false);
                        if !still_held {
                            let prompt_id = self
                                .cycle_best
                                .and_then(|i| bindings.get(i))
                                .and_then(|b| b.prompt_id.clone());
                            self.reset_recording();
                            actions.push(HotkeyAction::StopRecording { prompt_id });
                        }
                    }
                    Some(HotkeyMode::Toggle) => {
                        if self.held.is_empty() {
                            // Stop only if this cycle reached a toggle chord.
                            if let Some(i) = self
                                .cycle_best
                                .filter(|&i| bindings[i].mode == HotkeyMode::Toggle)
                            {
                                let prompt_id = bindings.get(i).and_then(|b| b.prompt_id.clone());
                                self.reset_recording();
                                actions.push(HotkeyAction::StopRecording { prompt_id });
                            } else {
                                // Only irrelevant keys pressed — keep recording,
                                // begin a fresh stop cycle.
                                self.cycle_best = None;
                            }
                        }
                    }
                    None => {
                        if self.held.is_empty() {
                            // Start cycle: begin only if it reached a toggle chord.
                            if let Some(i) = self
                                .cycle_best
                                .filter(|&i| bindings[i].mode == HotkeyMode::Toggle)
                            {
                                let is_main = bindings[i].prompt_id.is_none();
                                self.recording = Some(HotkeyMode::Toggle);
                                actions.push(HotkeyAction::StartRecording { is_main });
                            }
                            self.cycle_best = None;
                        }
                    }
                }
            }
            EventKind::KeyRepeat(_) => {}
        }
        actions
    }

    /// Track the longest binding matched since the cycle/hold began. Only grows
    /// (strictly longer) so it holds the peak across a hold.
    fn update_cycle_best(&mut self, bindings: &[HotkeyBinding]) {
        if let Some(idx) = longest_match(&self.held, bindings) {
            let take = self
                .cycle_best
                .map(|prev| bindings[idx].keys.len() > bindings[prev].keys.len())
                .unwrap_or(true);
            if take {
                self.cycle_best = Some(idx);
            }
        }
    }

    /// Reclaim `held` keys stuck down by a lost keyup. The listener calls this
    /// from its idle tick, and only while idle (`recording` is None), so it
    /// never interferes with an active recording — hold-to-talk or a toggle
    /// session mid-pause are both left untouched.
    pub fn clear_stale_held(&mut self) {
        if self.recording.is_none() && !self.held.is_empty() {
            self.held.clear();
            self.cycle_best = None;
        }
    }
}

/// Longest-match resolution: of all bindings whose keys are a subset of `held`,
/// the one with the most keys wins; ties are broken by registration order
/// (earlier wins). Replaces the old first-subset-match that let a bare `Ctrl`
/// steal `Ctrl+Shift`.
pub fn longest_match(held: &HashSet<Key>, bindings: &[HotkeyBinding]) -> Option<usize> {
    let mut best: Option<(usize, usize)> = None;
    for (i, b) in bindings.iter().enumerate() {
        if !b.keys.is_empty() && b.keys.iter().all(|k| held.contains(k)) {
            let len = b.keys.len();
            let take = match best {
                None => true,
                Some((_, best_len)) => len > best_len,
            };
            if take {
                best = Some((i, len));
            }
        }
    }
    best.map(|(i, _)| i)
}

fn hotkey_event_key(kind: EventKind) -> Option<Key> {
    match kind {
        EventKind::KeyDown(key) | EventKind::KeyUp(key) | EventKind::KeyRepeat(key) => Some(key),
    }
}

fn key_is_registered_hotkey_part(key: Key, bindings: &[HotkeyBinding]) -> bool {
    bindings.iter().any(|binding| binding.keys.contains(&key))
}

/// Whether an event concerns a key that is part of some registered hotkey
/// binding. The listener drops everything else at the boundary so keys like
/// CapsLock or NumLock — whose keyup the OS often fails to deliver — can never
/// enter the matcher's `held` set and jam the toggle cycle.
pub(super) fn is_relevant_hotkey_event(kind: EventKind, bindings: &[HotkeyBinding]) -> bool {
    hotkey_event_key(kind)
        .map(|k| key_is_registered_hotkey_part(k, bindings))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use keytap::{EventKind, Key};

    fn down(k: Key) -> EventKind {
        EventKind::KeyDown(k)
    }
    fn up(k: Key) -> EventKind {
        EventKind::KeyUp(k)
    }

    /// Drive the matcher through an event sequence, collecting emitted actions.
    fn run_matcher(bindings: &[HotkeyBinding], events: &[EventKind]) -> Vec<HotkeyAction> {
        let mut m = MatcherState::new();
        run_matcher_from(&mut m, bindings, events)
    }

    fn run_matcher_from(
        matcher: &mut MatcherState,
        bindings: &[HotkeyBinding],
        events: &[EventKind],
    ) -> Vec<HotkeyAction> {
        let mut out = Vec::new();
        for e in events {
            out.extend(matcher.process(*e, bindings));
        }
        out
    }

    fn binding(keys: &[Key], mode: &str, prompt_id: Option<&str>) -> HotkeyBinding {
        HotkeyBinding {
            keys: keys.iter().copied().collect(),
            mode: HotkeyMode::from_str(mode),
            prompt_id: prompt_id.map(str::to_string),
        }
    }

    #[test]
    fn toggle_main_cycle_starts_neutral_then_stops_raw() {
        let bindings = [binding(&[Key::ControlLeft], "toggle", None)];
        let actions = run_matcher(
            &bindings,
            &[
                down(Key::ControlLeft),
                up(Key::ControlLeft),
                down(Key::ControlLeft),
                up(Key::ControlLeft),
            ],
        );
        assert_eq!(
            actions,
            vec![
                HotkeyAction::StartRecording { is_main: true },
                HotkeyAction::StopRecording { prompt_id: None },
            ]
        );
    }

    #[test]
    fn toggle_prefix_conflict_stop_chord_decides_prompt() {
        let bindings = [
            binding(&[Key::ControlLeft], "toggle", None),
            binding(
                &[Key::ControlLeft, Key::ShiftLeft],
                "toggle",
                Some("polish"),
            ),
        ];
        let actions = run_matcher(
            &bindings,
            &[
                down(Key::ControlLeft),
                up(Key::ControlLeft),
                down(Key::ControlLeft),
                down(Key::ShiftLeft),
                up(Key::ShiftLeft),
                up(Key::ControlLeft),
            ],
        );
        assert_eq!(
            actions,
            vec![
                HotkeyAction::StartRecording { is_main: true },
                HotkeyAction::StopRecording {
                    prompt_id: Some("polish".to_string())
                },
            ]
        );
    }

    #[test]
    fn toggle_start_long_stop_short_follows_stop_cycle() {
        let bindings = [
            binding(&[Key::ControlLeft], "toggle", None),
            binding(
                &[Key::ControlLeft, Key::ShiftLeft],
                "toggle",
                Some("polish"),
            ),
        ];
        let actions = run_matcher(
            &bindings,
            &[
                down(Key::ControlLeft),
                down(Key::ShiftLeft),
                up(Key::ShiftLeft),
                up(Key::ControlLeft),
                down(Key::ControlLeft),
                up(Key::ControlLeft),
            ],
        );
        assert_eq!(
            actions,
            vec![
                HotkeyAction::StartRecording { is_main: false },
                HotkeyAction::StopRecording { prompt_id: None },
            ]
        );
    }

    #[test]
    fn hold_starts_on_keydown_stops_on_release() {
        let bindings = [binding(&[Key::ControlLeft], "hold", None)];
        let actions = run_matcher(&bindings, &[down(Key::ControlLeft), up(Key::ControlLeft)]);
        assert_eq!(
            actions,
            vec![
                HotkeyAction::StartRecording { is_main: true },
                HotkeyAction::StopRecording { prompt_id: None },
            ]
        );
    }

    #[test]
    fn hold_prefix_conflict_uses_peak_for_prompt() {
        let bindings = [
            binding(&[Key::ControlLeft], "hold", None),
            binding(&[Key::ControlLeft, Key::ShiftLeft], "hold", Some("polish")),
        ];
        let actions = run_matcher(
            &bindings,
            &[
                down(Key::ControlLeft),
                down(Key::ShiftLeft),
                up(Key::ShiftLeft),
                up(Key::ControlLeft),
            ],
        );
        assert_eq!(
            actions,
            vec![
                HotkeyAction::StartRecording { is_main: true },
                HotkeyAction::StopRecording {
                    prompt_id: Some("polish".to_string())
                },
            ]
        );
    }

    #[test]
    fn hold_short_only_yields_raw_prompt() {
        let bindings = [
            binding(&[Key::ControlLeft], "hold", None),
            binding(&[Key::ControlLeft, Key::ShiftLeft], "hold", Some("polish")),
        ];
        let actions = run_matcher(&bindings, &[down(Key::ControlLeft), up(Key::ControlLeft)]);
        assert_eq!(
            actions,
            vec![
                HotkeyAction::StartRecording { is_main: true },
                HotkeyAction::StopRecording { prompt_id: None },
            ]
        );
    }

    #[test]
    fn mixed_toggle_short_hold_long_no_conflict() {
        let bindings = [
            binding(&[Key::ControlLeft], "toggle", None),
            binding(&[Key::ControlLeft, Key::ShiftLeft], "hold", Some("polish")),
        ];
        let actions = run_matcher(
            &bindings,
            &[
                down(Key::ControlLeft),
                down(Key::ShiftLeft),
                up(Key::ShiftLeft),
                up(Key::ControlLeft),
            ],
        );
        assert_eq!(
            actions,
            vec![
                HotkeyAction::StartRecording { is_main: false },
                HotkeyAction::StopRecording {
                    prompt_id: Some("polish".to_string())
                },
            ]
        );
    }

    #[test]
    fn toggle_irrelevant_key_during_recording_does_not_stop() {
        let bindings = [binding(&[Key::F13], "toggle", None)];
        let actions = run_matcher(
            &bindings,
            &[
                down(Key::F13),
                up(Key::F13),
                down(Key::Space),
                up(Key::Space),
                down(Key::F13),
                up(Key::F13),
            ],
        );
        assert_eq!(
            actions,
            vec![
                HotkeyAction::StartRecording { is_main: true },
                HotkeyAction::StopRecording { prompt_id: None },
            ]
        );
    }

    #[test]
    fn longest_match_prefers_more_keys_then_registration_order() {
        let bindings = [
            binding(&[Key::A], "toggle", None),         // idx 0, len 1
            binding(&[Key::A, Key::B], "toggle", None), // idx 1, len 2
            binding(&[Key::A, Key::C], "toggle", None), // idx 2, len 2 (tie with 1)
        ];
        // A+B and A+C both match with len 2; earlier registration (idx 1) wins.
        let held: HashSet<Key> = [Key::A, Key::B, Key::C].into_iter().collect();
        assert_eq!(longest_match(&held, &bindings), Some(1));

        let held: HashSet<Key> = [Key::A, Key::C].into_iter().collect();
        assert_eq!(longest_match(&held, &bindings), Some(2));

        let held: HashSet<Key> = [Key::A].into_iter().collect();
        assert_eq!(longest_match(&held, &bindings), Some(0));
    }

    #[test]
    fn reset_recording_clears_session_tracking() {
        let bindings = [binding(&[Key::F13], "hold", None)];
        let mut m = MatcherState::new();
        let started = m.process(down(Key::F13), &bindings);
        assert_eq!(started.len(), 1); // StartRecording emitted → session active
        m.reset_recording();
        // After reset, releasing the key must not emit a stray StopRecording
        // (the session was cancelled out-of-band).
        let actions = m.process(up(Key::F13), &bindings);
        assert!(actions.is_empty());
    }

    #[test]
    fn reset_recording_clears_stale_held_keys() {
        let bindings = [binding(&[Key::F13], "toggle", None)];
        let mut m = MatcherState::new();

        // Simulate a lost keyup for an unrelated key. If reset leaves physical
        // held state behind, the next toggle cycle never sees held.is_empty().
        assert!(m.process(down(Key::Space), &bindings).is_empty());
        assert!(m
            .process(down(Key::F13), &bindings)
            .into_iter()
            .chain(m.process(up(Key::F13), &bindings))
            .collect::<Vec<_>>()
            .is_empty());

        m.reset_recording();
        let actions = run_matcher_from(&mut m, &bindings, &[down(Key::F13), up(Key::F13)]);
        assert_eq!(
            actions,
            vec![HotkeyAction::StartRecording { is_main: true }]
        );
    }

    #[test]
    fn allowlist_drops_events_for_unregistered_keys() {
        // Only keys that are part of a registered binding are relevant; anything
        // else (CapsLock, NumLock, plain typing) is dropped at the listener
        // boundary so it can never jam the matcher's held set.
        let bindings = [binding(&[Key::Function], "toggle", None)];
        assert!(!is_relevant_hotkey_event(down(Key::CapsLock), &bindings));
        assert!(!is_relevant_hotkey_event(down(Key::NumLock), &bindings));
        assert!(!is_relevant_hotkey_event(down(Key::Space), &bindings));
        assert!(is_relevant_hotkey_event(down(Key::Function), &bindings));
        assert!(is_relevant_hotkey_event(up(Key::Function), &bindings));
    }

    #[test]
    fn clear_stale_held_only_while_idle() {
        let bindings = [binding(&[Key::Function], "hold", None)];
        let mut m = MatcherState::new();

        // Start a hold session: Function is held and the matcher is recording.
        assert_eq!(
            m.process(down(Key::Function), &bindings),
            vec![HotkeyAction::StartRecording { is_main: true }]
        );
        // While recording, stale reclaim must NOT touch held.
        m.clear_stale_held();
        assert_eq!(
            m.process(up(Key::Function), &bindings),
            vec![HotkeyAction::StopRecording { prompt_id: None }]
        );

        // Idle again with a stuck key (a lost keyup): reclaim clears it.
        m.held.insert(Key::Function);
        m.clear_stale_held();
        assert!(m.held.is_empty());
    }
}

# Native Overlay, Retry, and Recording Asset Design

- Date: 2026-06-21
- Status: Approved
- Branch: `codex/native-cpal-capture`

## Goal

Make the macOS recording main path independent of WebView control logic, then make ASR failure and late-result behavior recoverable by using saved WAV recordings as retryable transcription assets.

The user-visible behavior outside recording, overlay feedback, retry, and history playback should remain unchanged.

## Execution Order

1. Native overlay and native cue playback.
2. Fix late ASR result handling.
3. Add recording asset, history playback, retry, and retention policy.

## Phase 1: Native Main Path

On macOS, the recording main path should no longer depend on WebView for recording lifecycle control or cue playback.

The existing native overlay remains the visual surface. It should handle actionable failure states directly, including a retry icon button. The retry control must be visually subtle and fit the current glass pill style. Its maximum visual footprint must not exceed the current recording waveform element, so the control remains refined rather than dominant.

Failure overlay behavior:

- Show the existing failure text style.
- Show a refresh-style icon button only, without text.
- Display a 5-second countdown affordance around the retry button.
- If the user does not click within 5 seconds, hide the overlay.
- The failed transcription attempt remains available in input history when a WAV exists.

Cue playback should move to native playback on macOS so start/end cues do not depend on the overlay WebView. Windows can keep the current WebView path unless the native implementation is naturally cross-platform.

## Phase 2: Late ASR Result Handling

The current Doubao flow can return a partial result when `commit_and_await_final` times out after 5 seconds, while the server may continue sending a more complete result afterward. This causes premature paste of incomplete text.

The fix should prefer correctness over premature paste:

- Do not paste a partial result merely because the 5-second commit wait elapsed.
- If the session has not produced a reliable final result by the deadline, mark the attempt as failed or retryable instead of pasting known-incomplete text.
- If a definite final result or terminal close arrives within the accepted completion window, paste normally.
- The saved WAV should make manual retry cheap, so retryable failure is better than silently pasting partial text.

## Phase 3: Recording Assets and Retry

Each transcription attempt should have a durable record that can represent success or failure.

History entries should support:

- `status`: success or failed.
- `text`: successful final text, or a short failure description.
- `audioPath`: saved WAV path when available.
- `error`: failure reason when applicable.
- `retryOf`: optional original entry timestamp or ID.

Successful entries continue to count toward usage statistics. Failed entries should appear in input history but should not increase total session or character counts.

Retry behavior:

- Retry uses the saved WAV, not the microphone.
- Retry can be triggered from the native failure overlay within 5 seconds.
- Retry can also be triggered from Settings home input history.
- A successful retry creates or updates a successful history record and follows the normal paste/clipboard/statistics path.
- If recording retention is disabled, the failed WAV is deleted after a retry succeeds.

History UI behavior:

- Successful rows show play, copy, and delete icon buttons.
- Failed rows show play, retry, and delete icon buttons.
- Buttons must match the current input-record action style: orange solid rounded-square icon buttons with white line icons.

## Recording Retention Setting

Add an app setting for whether to retain recordings.

Default: disabled.

When enabled:

- Keep successful and failed recordings for the most recent 1 month.
- Prune older recordings and references.

When disabled:

- Keep only recordings needed for failed retryable entries.
- Delete recordings after successful transcription or successful retry.

## Testing

Backend:

- Unit tests for history serialization/backward compatibility.
- Unit tests for retention pruning decisions.
- Tests for retrying a WAV through the same ASR path where practical.
- Tests for Doubao commit timeout behavior so partial text is not treated as successful final output.

Frontend/settings:

- Tests for history rows with success and failure states.
- Tests for play/retry button bridge calls.

Manual:

- Network timeout creates a failed history entry with WAV.
- Native overlay retry starts a transcription attempt from WAV.
- Settings history retry works after overlay disappears.
- Successful retry removes failed-only WAV when retention is disabled.

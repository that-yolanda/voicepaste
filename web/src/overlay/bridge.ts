/**
 * Overlay bridge — typed API for the overlay renderer.
 * Audio capture and cue playback are handled entirely in the backend (cpal +
 * rodio), so this only exposes event listening, config, and the retry action.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface OverlayEvent {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Listen for overlay events from the backend.
 * Returns a cleanup function that unregisters the listener.
 */
export function onOverlayEvent(listener: (event: OverlayEvent) => void): () => void {
  let active = true;
  const unlisten = listen<OverlayEvent>("overlay:event", (event) => {
    if (active && listener) {
      listener(event.payload);
    }
  });
  return () => {
    active = false;
    unlisten.then((fn) => fn());
  };
}

/** Retry the latest failed recording directly from the overlay. */
export async function retryLatestFailedTranscription(): Promise<void> {
  await invoke("retry_latest_failed_transcription");
}

/** Layout constants shared with the macOS native renderer (`overlay::shared`).
 * Fetched once at startup so the Windows pill sizes identically to the macOS
 * native pill (text width is still measured in the DOM). Field names match the
 * Rust struct (serde snake_case). */
export interface OverlayLayoutMetrics {
  pad_left: number;
  pad_right: number;
  indicator_w: number;
  gap: number;
  pill_h_single: number;
  single_line_limit: number;
  multi_line_width: number;
  min_pill_w: number;
  text_slack: number;
  wave_area_w: number;
  wave_gap_left: number;
  retry_size: number;
  retry_gap_left: number;
}

/** Fetch the shared overlay layout constants (single source of truth with Rust). */
export async function getOverlayLayoutMetrics(): Promise<OverlayLayoutMetrics> {
  return invoke("get_overlay_layout_metrics");
}

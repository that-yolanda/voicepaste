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

export interface OverlayAppConfig {
  platform?: string;
  overlayStyle?: string;
  theme?: string;
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

/** Get the current app configuration. */
export async function getConfig(): Promise<OverlayAppConfig> {
  return invoke("get_app_config");
}

/** Retry the latest failed recording directly from the overlay. */
export async function retryLatestFailedTranscription(): Promise<void> {
  await invoke("retry_latest_failed_transcription");
}

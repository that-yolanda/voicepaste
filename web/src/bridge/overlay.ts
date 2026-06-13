/**
 * Overlay bridge — typed API replacing window.voiceOverlay.
 * Uses @tauri-apps/api for IPC (invoke + listen).
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface OverlayEvent {
  type: string;
  payload: Record<string, unknown>;
}

export interface OverlayAudioChunkResult {
  ok: boolean;
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

/** Send a base64-encoded audio chunk to the backend ASR session. */
export async function sendAudioChunk(base64Chunk: string): Promise<OverlayAudioChunkResult> {
  return invoke("send_audio_chunk", { base64Chunk });
}

/** Send a diagnostic message from the renderer. */
export async function sendDiagnostic(payload: unknown): Promise<void> {
  return invoke("send_diagnostic", { payload });
}

/** Notify the backend that audio capture has stopped. */
export async function notifyAudioStopped(): Promise<void> {
  return invoke("audio_stopped");
}

/** Notify the backend that audio warmup is ready. */
export async function sendAudioWarmupReady(): Promise<void> {
  return invoke("audio_warmup_ready");
}

/** Notify the backend that audio warmup failed. */
export async function sendAudioWarmupFailed(payload: { message?: string } = {}): Promise<void> {
  return invoke("audio_warmup_failed", { message: payload.message || "" });
}

/** Get the current app configuration. */
export async function getConfig(): Promise<OverlayAppConfig> {
  return invoke("get_app_config");
}

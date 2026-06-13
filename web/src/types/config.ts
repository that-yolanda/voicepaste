/** Full application config shape (maps to config.yaml structure). */

export interface AppConfig {
  hotkey?: string;
  hotkeyMode?: "toggle" | "hold";
  removeTrailingPeriod?: boolean;
  keepClipboard?: boolean;
  simulatedStreaming?: boolean;
  overlayStyle?: "liquid" | "liquid-standard" | "vibrancy";
  autoLaunch?: boolean;
  preferBeta?: boolean;
}

export interface AudioConfig {
  provider?: string;
  [modelId: string]: unknown; // per-model config blocks
}

export interface LlmConfig {
  provider?: string;
  apiUrl?: string;
  apiKey?: string;
  model?: string;
}

export interface SoundConfig {
  enabled?: boolean;
  startSound?: string;
  endSound?: string;
}

export interface ParsedConfig {
  app?: AppConfig;
  audio?: AudioConfig;
  llm?: LlmConfig;
  sound?: SoundConfig;
  [key: string]: unknown;
}

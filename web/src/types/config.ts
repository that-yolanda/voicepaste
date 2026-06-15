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
  asr_defaults?: {
    rate?: number;
    channel?: number;
    stream_simulate?: boolean;
    hotword_llm_mode?: "auto" | "disabled" | "force";
    hotword_replace?: boolean;
    num_threads?: number;
    provider?: "cpu" | "cuda" | "coreml";
    punctuation_mode?: "auto" | "disabled" | "force";
    vad?: {
      threshold?: number;
      min_silence_duration?: number;
      min_speech_duration?: number;
      max_speech_duration?: number;
    };
  };
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

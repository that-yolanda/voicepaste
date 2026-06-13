/** ASR model registry types. */

export interface RegistryModel {
  id: string;
  name: string;
  type: "online" | "offline";
  category?: "vad" | "asr" | "punctuation";
  description?: string;
  mem_size?: number;
  file_size?: number;
  languages?: string[];
  capabilities?: Record<string, boolean>;
  default_config?: Record<string, unknown>;
  architecture?: string;
  streaming?: boolean;
}

export interface ModelRegistry extends Array<RegistryModel> {}

export interface DownloadedModel {
  id: string;
}

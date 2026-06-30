/** ASR model registry types. */

export interface RegistryModel {
  id: string;
  name: string;
  type: "online" | "offline";
  category?: "vad" | "asr" | "punctuation";
  engine?: string;
  description?: string;
  tags?: string[];
  mem_size?: number;
  file_size?: number;
  capabilities?: Record<string, boolean>;
  default_config?: Record<string, unknown>;
  architecture?: string;
  streaming?: boolean;
}

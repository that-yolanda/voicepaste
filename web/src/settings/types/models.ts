/** ASR model registry types. */

export interface RegistryModel {
  id: string;
  name: string;
  /** English fallbacks; rendered when the UI language is English. */
  name_en?: string;
  type: "online" | "offline";
  category?: "vad" | "asr" | "punctuation";
  engine?: string;
  description?: string;
  description_en?: string;
  tags?: string[];
  tags_en?: string[];
  mem_size?: number;
  file_size?: number;
  capabilities?: Record<string, boolean>;
  default_config?: Record<string, unknown>;
  architecture?: string;
  streaming?: boolean;
}

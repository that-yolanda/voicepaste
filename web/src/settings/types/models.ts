/** ASR/LLM model registry types (registry.json v21). */

export type ModelCategory = "asr" | "vad" | "punctuation" | "llm";

export interface RegistryModel {
  id: string;
  /** Owning provider id (see RegistryProvider.id). Absent in legacy data. */
  provider?: string;
  name: string;
  /** English fallbacks; rendered when the UI language is English. */
  name_en?: string;
  type: "online" | "offline";
  category?: ModelCategory;
  engine?: string;
  description?: string;
  description_en?: string;
  languages?: string[];
  mem_size?: number;
  file_size?: number;
  capabilities?: Record<string, boolean>;
  default_config?: Record<string, unknown>;
  architecture?: string;
  streaming?: boolean;
}

/** Capability a provider offers. */
export type CapabilityKind = "asr" | "llm";

/** One credential input declared by the registry for a scope. */
export interface CredentialField {
  key: string;
  type?: "text" | "password";
}

/** Credential fields for one scope. */
export interface CredentialSpec {
  fields: CredentialField[];
}

/** Provider entry: display metadata, capabilities and credential declarations. */
export interface RegistryProvider {
  id: string;
  name: string;
  name_en?: string;
  kind: "online" | "local";
  capabilities: CapabilityKind[];
  /** Default chat-completions endpoint (LLM capability). */
  default_llm_url?: string;
  docs_url?: string;
  /** Scope-keyed declarations: shared (provider-wide) | asr | llm. */
  credentials?: Partial<Record<"shared" | "asr" | "llm", CredentialSpec>>;
}

/** Per-model LLM inference parameter overrides (only user-set values). */
export interface LlmModelParams {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
}

/** One entry of a provider's positive LLM model list in config.yaml. */
export interface LlmModelEntry {
  id: string;
  name?: string;
  /** Overrides the request model string for preset entries. */
  model_id?: string;
  params?: LlmModelParams;
}

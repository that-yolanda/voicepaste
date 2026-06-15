// Integration tests that require external resources (models, API keys).
// These are gated behind Cargo features so they don't run in CI.
//
// Run with:
//   cargo test --features asr-integration  (needs sherpa-onnx models)
//   cargo test --features llm-integration  (needs LLM API keys)

#[cfg(feature = "asr-integration")]
mod asr_integration;

#[cfg(feature = "asr-integration")]
mod asr_zipformer_zh_en;

#[cfg(feature = "llm-integration")]
mod llm_integration;

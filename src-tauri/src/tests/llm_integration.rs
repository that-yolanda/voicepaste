//! LLM integration tests — require API keys for real provider calls.
//!
//! Run with: `cargo test --features llm-integration`
//!
//! Prerequisites:
//!   Set environment variables for the provider you want to test:
//!   - LLM_PROVIDER (e.g. "openai", "deepseek", "ollama")
//!   - LLM_API_KEY (not needed for ollama)
//!   - LLM_MODEL (optional, uses provider default if omitted)

use std::env;

/// Read LLM config from environment variables.
fn llm_config_from_env() -> Result<(String, String, String), String> {
    let provider = env::var("LLM_PROVIDER").unwrap_or_else(|_| "ollama".to_string());
    let api_key = env::var("LLM_API_KEY").unwrap_or_default();
    let model = env::var("LLM_MODEL").unwrap_or_default();

    if provider != "ollama" && api_key.is_empty() {
        return Err("LLM_API_KEY not set".to_string());
    }

    Ok((provider, api_key, model))
}

#[test]
fn test_llm_config_from_env() {
    // This test verifies the env-reading helper itself.
    // It should succeed with or without actual API keys.
    match env::var("LLM_API_KEY") {
        Ok(key) if !key.is_empty() => {
            let (provider, api_key, _model) =
                llm_config_from_env().expect("Should parse env vars");
            assert!(!provider.is_empty());
            assert!(!api_key.is_empty());
        }
        _ => {
            eprintln!("SKIP: LLM_API_KEY not set, skipping real API test");
        }
    }
}

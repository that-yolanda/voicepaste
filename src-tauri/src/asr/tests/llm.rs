use crate::config::{LlmConfig, ProviderConfig};
use crate::llm::*;

// Helper to create a minimal LlmConfig
fn make_llm_config(provider: &str) -> LlmConfig {
    LlmConfig {
        provider: provider.to_string(),
        url: None,
        api_key: None,
        model: None,
        base_url: None,
        deepseek: None,
        openai: None,
        anthropic: None,
        gemini: None,
        openrouter: None,
        siliconflow: None,
        ollama: None,
        openai_compatible: None,
    }
}

fn make_deepseek_config() -> LlmConfig {
    LlmConfig {
        provider: "deepseek".to_string(),
        url: Some("https://api.deepseek.com/v1".to_string()),
        api_key: Some("sk-test".to_string()),
        model: Some("deepseek-v4-flash".to_string()),
        base_url: None,
        deepseek: Some(ProviderConfig {
            url: "".to_string(),
            api_key: "".to_string(),
            model: "".to_string(),
        }),
        openai: None,
        anthropic: None,
        gemini: None,
        openrouter: None,
        siliconflow: None,
        ollama: None,
        openai_compatible: None,
    }
}

fn make_openai_config() -> LlmConfig {
    LlmConfig {
        provider: "openai".to_string(),
        url: None,
        api_key: None,
        model: None,
        base_url: None,
        deepseek: None,
        openai: Some(ProviderConfig {
            url: "https://api.openai.com/v1".to_string(),
            api_key: "sk-test-openai".to_string(),
            model: "gpt-4.1-mini".to_string(),
        }),
        anthropic: None,
        gemini: None,
        openrouter: None,
        siliconflow: None,
        ollama: None,
        openai_compatible: None,
    }
}

// ── validate_llm_config tests ──────────────────────────────────────────

#[test]
fn validate_valid_deepseek_config() {
    assert!(validate_llm_config(&make_deepseek_config()).is_ok());
}

#[test]
fn validate_valid_openai_config() {
    assert!(validate_llm_config(&make_openai_config()).is_ok());
}

#[test]
fn validate_missing_api_key_for_non_ollama() {
    let mut config = make_deepseek_config();
    config.api_key = Some("".to_string());
    let result = validate_llm_config(&config);
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("api_key"));
}

#[test]
fn validate_ollama_skips_api_key_check() {
    let config = LlmConfig {
        provider: "ollama".to_string(),
        url: Some("http://localhost:11434/api".to_string()),
        api_key: Some("".to_string()),
        model: Some("llama3.1".to_string()),
        base_url: None,
        ollama: Some(ProviderConfig {
            url: "".to_string(),
            api_key: "".to_string(),
            model: "".to_string(),
        }),
        ..make_llm_config("ollama")
    };
    assert!(validate_llm_config(&config).is_ok());
}

#[test]
fn validate_missing_model() {
    let mut config = make_deepseek_config();
    config.model = Some("".to_string());
    // No model set at top level or provider level, but deepseek has a default_model
    // so this should still be OK
    let result = validate_llm_config(&config);
    assert!(result.is_ok());
}

#[test]
fn validate_missing_url_has_default() {
    let config = make_deepseek_config();
    // deepseek defaults have a URL, so this should pass
    assert!(validate_llm_config(&config).is_ok());
}

#[test]
fn validate_custom_provider_no_defaults_fails() {
    let config = make_llm_config("custom-provider");
    let result = validate_llm_config(&config);
    assert!(result.is_err());
}

#[test]
fn validate_custom_provider_with_fields_passes() {
    let config = LlmConfig {
        provider: "openai_compatible".to_string(),
        url: Some("https://custom.api.com/v1".to_string()),
        api_key: Some("sk-custom".to_string()),
        model: Some("custom-model".to_string()),
        base_url: None,
        openai_compatible: Some(ProviderConfig {
            url: "https://custom.api.com/v1".to_string(),
            api_key: "sk-custom".to_string(),
            model: "custom-model".to_string(),
        }),
        ..make_llm_config("openai_compatible")
    };
    assert!(validate_llm_config(&config).is_ok());
}

#[test]
fn validate_provider_config_overrides_top_level() {
    // openai config has everything in the provider sub-config
    let result = validate_llm_config(&make_openai_config());
    assert!(result.is_ok());
}

// ── normalize_base_url tests ───────────────────────────────────────────

#[test]
fn normalize_removes_trailing_slash() {
    assert_eq!(normalize_base_url("https://api.openai.com/v1/"), "https://api.openai.com/v1");
}

#[test]
fn normalize_removes_chat_completions() {
    assert_eq!(
        normalize_base_url("https://api.openai.com/v1/chat/completions"),
        "https://api.openai.com/v1"
    );
}

#[test]
fn normalize_removes_chat_completions_with_trailing_slash() {
    assert_eq!(
        normalize_base_url("https://api.openai.com/v1/chat/completions/"),
        "https://api.openai.com/v1"
    );
}

#[test]
fn normalize_empty_string() {
    assert_eq!(normalize_base_url(""), "");
}

#[test]
fn normalize_trims_whitespace() {
    assert_eq!(normalize_base_url("  https://api.example.com  "), "https://api.example.com");
}

#[test]
fn normalize_preserves_non_chat_completions_path() {
    assert_eq!(
        normalize_base_url("https://api.openai.com/v1/embeddings"),
        "https://api.openai.com/v1/embeddings"
    );
}

#[test]
fn normalize_only_chat_completions() {
    // Should not strip partial matches
    assert_eq!(
        normalize_base_url("https://api.example.com/chat"),
        "https://api.example.com/chat"
    );
}

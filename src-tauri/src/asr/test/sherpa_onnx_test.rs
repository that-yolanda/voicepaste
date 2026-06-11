use super::{
    filter_valid_hotwords, hotword_tokens_for_validation, parse_token_line, restore_hotword_case,
};
use std::collections::HashSet;

// ── restore_hotword_case tests ──────────────────────────────────────────

#[test]
fn restore_case_mixed() {
    let r = restore_hotword_case("CLAUDE CODE", &["Claude Code".to_string()]);
    assert_eq!(r, "Claude Code");
}

#[test]
fn restore_case_lowercase_model_output() {
    let r = restore_hotword_case("claude code", &["Claude Code".to_string()]);
    assert_eq!(r, "Claude Code");
}

#[test]
fn restore_punctuation_stripped() {
    let r = restore_hotword_case("AGENTSMD", &["AGENTS.md".to_string()]);
    assert_eq!(r, "AGENTS.md");
}

#[test]
fn restore_punctuation_with_space() {
    let r = restore_hotword_case("AGENTS MD", &["AGENTS.md".to_string()]);
    assert_eq!(r, "AGENTS.md");
}

#[test]
fn no_change_for_chinese() {
    let r = restore_hotword_case("流式输出", &["流式输出".to_string()]);
    assert_eq!(r, "流式输出");
}

#[test]
fn restore_with_weight_format() {
    let r = restore_hotword_case("CLAUDE CODE", &["Claude Code|10".to_string()]);
    assert_eq!(r, "Claude Code");
}

#[test]
fn restore_single_hotword() {
    let r = restore_hotword_case(
        "使用 CLAUDE CODE 和 OPENAI",
        &["Claude Code".to_string()],
    );
    assert_eq!(r, "使用 Claude Code 和 OPENAI");
}

#[test]
fn restore_multiple_in_sentence() {
    let r = restore_hotword_case(
        "使用 CLAUDE CODE 和 OPENAI",
        &["Claude Code".to_string(), "OpenAI".to_string()],
    );
    assert_eq!(r, "使用 Claude Code 和 OpenAI");
}

// ── vocabulary validation tests ─────────────────────────────────────────

#[test]
fn parses_first_column_from_tokens_file() {
    assert_eq!(parse_token_line("你 42").as_deref(), Some("你"));
    assert_eq!(parse_token_line("<blk> 0").as_deref(), Some("<blk>"));
    assert_eq!(parse_token_line("   ").as_deref(), None);
}

#[test]
fn validates_cjk_hotwords_by_character_token() {
    let vocab = ["语", "音", "输", "入"]
        .into_iter()
        .map(str::to_string)
        .collect::<HashSet<_>>();
    let hotwords = vec!["语音输入".to_string(), "语音转写".to_string()];

    assert_eq!(
        hotword_tokens_for_validation("语音输入"),
        vec!["语", "音", "输", "入"]
    );
    assert_eq!(
        filter_valid_hotwords(&hotwords, Some(&vocab)),
        vec!["语音输入"]
    );
}

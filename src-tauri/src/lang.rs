//! UI language resolution for user-facing text.

/// The two UI languages VoicePaste ships. The default is English so any
/// unrecognized preference or system locale falls back to a language every
/// locale file fully covers, instead of producing a mixed-language UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Language {
    ZhCn,
    #[default]
    En,
}

impl Language {
    /// Locale code shared with the frontend i18next resources and the
    /// `appearance` event payload. Must match the resource keys registered in
    /// `web/src/i18n/index.ts`.
    pub fn code(self) -> &'static str {
        match self {
            Self::ZhCn => "zh-CN",
            Self::En => "en",
        }
    }

    /// Parse a stored `app.language` preference, tolerating common variants
    /// (`zh`, `zh-CN`, `ZH_CN`, `zh-Hans`); anything else maps to English.
    pub fn from_pref(pref: &str) -> Self {
        match pref.trim().to_ascii_lowercase().as_str() {
            "zh" | "zh-cn" | "zh_cn" | "zh-hans" => Self::ZhCn,
            _ => Self::En,
        }
    }

    /// Resolve the `auto | zh-CN | en` config value. `auto` (and an empty
    /// value, e.g. from an old config) follows the OS locale; anything
    /// unrecognized falls back to English.
    pub fn resolve(pref: &str) -> Self {
        match pref.trim().to_ascii_lowercase().as_str() {
            "auto" | "" => match sys_locale::get_locale() {
                Some(locale) if locale.to_ascii_lowercase().starts_with("zh") => Self::ZhCn,
                _ => Self::En,
            },
            _ => Self::from_pref(pref),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_pref_accepts_zh_variants() {
        assert_eq!(Language::from_pref("zh-CN"), Language::ZhCn);
        assert_eq!(Language::from_pref("zh"), Language::ZhCn);
        assert_eq!(Language::from_pref(" ZH_cn "), Language::ZhCn);
        assert_eq!(Language::from_pref("zh-Hans"), Language::ZhCn);
        assert_eq!(Language::from_pref("en"), Language::En);
        assert_eq!(Language::from_pref("ja"), Language::En);
    }

    #[test]
    fn resolve_maps_explicit_values_without_touching_the_os() {
        // Only deterministic paths: `auto` depends on the host locale and is
        // intentionally not asserted here.
        assert_eq!(Language::resolve("zh-CN"), Language::ZhCn);
        assert_eq!(Language::resolve("en"), Language::En);
        assert_eq!(Language::resolve("nonsense"), Language::En);
    }

    #[test]
    fn code_matches_frontend_i18n_resource_keys() {
        assert_eq!(Language::ZhCn.code(), "zh-CN");
        assert_eq!(Language::En.code(), "en");
    }
}

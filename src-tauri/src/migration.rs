//! One-time migration from VoicePaste 1.x (Electron) to 2.x (Tauri).
//!
//! ## Background
//! The app bundle changed from the Electron data dir name `voicepaste` to the
//! Tauri identifier `com.yolanda.voicepaste`, so Tauri resolves a brand-new
//! `app_data_dir()` and never sees the legacy config. Without this migration a
//! 1.x user upgrading to 2.0.0 would lose their ASR credentials, hotkeys,
//! prompt templates, hotwords and usage statistics.
//!
//! ## Design
//! - Runs **once** on first launch, *before* `ConfigManager::new` (which would
//!   otherwise copy the empty example template over the migrated file).
//! - Idempotent via a `.migration_state` marker: once written, the probe never
//!   runs again — zero per-launch overhead.
//! - Self-contained: all migration logic lives here; `lib.rs` calls a single
//!   `run()` entry point, so main business code stays clean.
//! - Versioned marker (`from_version`/`to_version`) so future 2.x → 3.x
//!   schema changes can add new steps under the same one-shot mechanism.

use crate::hotword::HotwordManager;
use serde::Serialize;
use serde_norway::{Mapping, Value};
use std::fs;
use std::path::{Path, PathBuf};

/// Target version recorded in the migration marker.
const TARGET_VERSION: &str = "2.0.0";
/// Fallback main hotkey when the legacy evdev keycode cannot be mapped.
const DEFAULT_HOTKEY: &str = "F13";

/// Persisted after migration (or after deciding none is needed) so the probe
/// never repeats. Also the hook point for future versioned migrations.
#[derive(Serialize)]
struct MigrationState {
    from_version: String,
    to_version: String,
    migrated_at: String,
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Run the 1.x → 2.x migration exactly once.
///
/// Must be called **before** `ConfigManager::new` so the migrated `config.yaml`
/// is in place before the empty example would be copied.
///
/// Returns `Ok(true)` if a migration was performed, `Ok(false)` if skipped
/// (already migrated, 2.x already configured, or no legacy install found).
/// `Err` means migration failed; the caller should log and continue so the app
/// still launches (falling back to the empty example).
pub fn run(data_dir: &Path, resource_dir: &Path) -> Result<bool, String> {
    let marker = data_dir.join(".migration_state");

    // Already handled on a previous launch — never probe again.
    if marker.exists() {
        log_migration!(debug, "marker present, skipping");
        return Ok(false);
    }

    // 2.x already configured (dev machine / reinstall) — never clobber it.
    if data_dir.join("config.yaml").exists() {
        log_migration!(info, "2.x config already exists, skipping migration");
        write_marker(&marker, "existing", TARGET_VERSION);
        return Ok(false);
    }

    // No legacy install → fresh 2.x user, nothing to port.
    let Some(legacy_dir) = detect_legacy_dir() else {
        log_migration!(info, "no 1.x install found (fresh install)");
        write_marker(&marker, "none", TARGET_VERSION);
        return Ok(false);
    };

    log_migration!(info, "migrating from 1.x: {}", legacy_dir.display());
    match migrate_all(&legacy_dir, data_dir, resource_dir) {
        Ok(()) => {
            write_marker(&marker, "1.x", TARGET_VERSION);
            log_migration!(info, "migration complete");
            Ok(true)
        }
        Err(e) => {
            log_migration!(warn, "migration failed: {e}");
            Err(e)
        }
    }
}

fn write_marker(marker: &Path, from: &str, to: &str) {
    let state = MigrationState {
        from_version: from.to_string(),
        to_version: to.to_string(),
        migrated_at: chrono::Utc::now().to_rfc3339(),
    };
    if let Ok(json) = serde_json::to_string_pretty(&state) {
        let _ = fs::write(marker, json);
    }
}

/// Locate the legacy Electron data directory.
///
/// - macOS: `~/Library/Application Support/voicepaste/` (Electron `app.name`,
///   not the `com.yolanda.voicepaste` appId).
/// - Windows: `%APPDATA%\VoicePaste\` (electron-builder `productName`); the
///   lowercase `voicepaste` is tried as a fallback for case-sensitive volumes.
fn detect_legacy_dir() -> Option<PathBuf> {
    let candidates: Vec<PathBuf> = if cfg!(target_os = "macos") {
        vec![dirs::home_dir()?.join("Library/Application Support/voicepaste")]
    } else if cfg!(target_os = "windows") {
        let base = dirs::config_dir()?;
        vec![base.join("VoicePaste"), base.join("voicepaste")]
    } else {
        return None;
    };
    candidates
        .into_iter()
        .find(|p| p.join("config.yaml").exists())
}

// ---------------------------------------------------------------------------
// Migration steps
// ---------------------------------------------------------------------------

/// Run every migration step. `legacy` is guaranteed (by `detect_legacy_dir`)
/// to contain a `config.yaml`; the other artifacts are optional.
fn migrate_all(legacy: &Path, data_dir: &Path, resource_dir: &Path) -> Result<(), String> {
    migrate_config(
        &legacy.join("config.yaml"),
        &data_dir.join("config.yaml"),
        resource_dir,
    )?;
    migrate_prompts(&legacy.join("prompts.json"), &data_dir.join("prompts.json"))?;
    migrate_hotwords(&legacy.join("config.yaml"), data_dir, resource_dir);
    migrate_stats(&legacy.join("stats.json"), &data_dir.join("stats.json"));
    migrate_history(&legacy.join("history"), &data_dir.join("history"));
    Ok(())
}

/// Migrate `config.yaml`: remap `connection.*` → `audio.doubao-streaming.*`,
/// copy app preferences/LLM, and convert the evdev hotkey to an accelerator.
fn migrate_config(src: &Path, dst: &Path, resource_dir: &Path) -> Result<(), String> {
    let legacy_text = fs::read_to_string(src).map_err(|e| format!("read legacy config: {e}"))?;
    let legacy: Value =
        serde_norway::from_str(&legacy_text).map_err(|e| format!("parse legacy config: {e}"))?;

    // Start from the 2.x example template so new-only fields (beta_updates,
    // asr_defaults, etc.) already exist with their defaults.
    let mut out = load_template(resource_dir);
    if !out.is_mapping() {
        out = Value::Mapping(Mapping::new());
    }

    // app section
    {
        let legacy_app = legacy.get("app").and_then(Value::as_mapping);
        let out_map = out.as_mapping_mut().expect("template is a mapping");
        migrate_app_section(legacy_app, ensure_child(out_map, "app"));
    }
    // audio section: connection.* → audio.doubao-streaming.*
    {
        let legacy_conn = legacy.get("connection").and_then(Value::as_mapping);
        let out_map = out.as_mapping_mut().expect("template is a mapping");
        migrate_audio_section(legacy_conn, ensure_child(out_map, "audio"));
    }
    // llm section: copy verbatim, dropping the obsolete `enabled` flag
    {
        let legacy_llm = legacy.get("llm").and_then(Value::as_mapping).cloned();
        if let Some(out_map) = out.as_mapping_mut() {
            migrate_llm_section(legacy_llm, out_map);
        }
    }

    let yaml = serde_norway::to_string(&out).map_err(|e| format!("serialize config: {e}"))?;
    fs::write(dst, yaml).map_err(|e| format!("write config: {e}"))?;
    log_migration!(info, "migrated config.yaml");
    Ok(())
}

fn migrate_app_section(legacy_app: Option<&Mapping>, app: &mut Mapping) {
    // hotkey: evdev array (or rare string) → accelerator string
    let hotkey = legacy_app
        .and_then(|m| m.get(kv("hotkey")))
        .and_then(convert_hotkey_value);
    put_str(app, "hotkey", hotkey.as_deref().unwrap_or(DEFAULT_HOTKEY));

    copy_str(legacy_app, app, "hotkey_mode");
    copy_str(legacy_app, app, "theme");
    copy_str(legacy_app, app, "overlay_style");
    copy_str(legacy_app, app, "overlay_glass_mode");
    copy_bool(legacy_app, app, "remove_trailing_period");
    copy_bool(legacy_app, app, "keep_clipboard");

    if let Some(sound) = legacy_app
        .and_then(|m| m.get(kv("sound")))
        .and_then(Value::as_mapping)
    {
        let app_sound = ensure_child(app, "sound");
        copy_str(Some(sound), app_sound, "start_sound");
        copy_str(Some(sound), app_sound, "end_sound");
        copy_bool(Some(sound), app_sound, "enabled");
    }
}

fn migrate_audio_section(legacy_conn: Option<&Mapping>, audio: &mut Mapping) {
    // 1.x only shipped the Doubao streaming engine.
    put_str(audio, "provider", "doubao-streaming");
    if let Some(conn) = legacy_conn {
        let ds = ensure_child(audio, "doubao-streaming");
        copy_str(Some(conn), ds, "url");
        copy_str(Some(conn), ds, "app_id");
        copy_str(Some(conn), ds, "access_token");
        copy_str(Some(conn), ds, "resource_id");
        // secret_key is intentionally not migrated: it was a dead field the ASR
        // client never sent. auth_mode defaults to "legacy" via serde, so upgraded
        // 1.x users keep using App ID + Access Token without any change.
    }
}

fn migrate_llm_section(legacy_llm: Option<Mapping>, out: &mut Mapping) {
    let Some(mut llm) = legacy_llm else {
        return;
    };
    if llm.is_empty() {
        return;
    }
    llm.remove(kv("enabled")); // 2.x dropped this flag
    out.insert(kv("llm"), Value::Mapping(llm));
}

/// Migrate `prompts.json`: structure is unchanged, only each template's hotkey
/// (evdev int array) is converted to the 2.x string-array form. Unbound or
/// unmappable → empty array.
fn migrate_prompts(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    let text = fs::read_to_string(src).map_err(|e| format!("read legacy prompts: {e}"))?;
    let arr: Vec<serde_json::Value> =
        serde_json::from_str(&text).map_err(|e| format!("parse legacy prompts: {e}"))?;
    let migrated: Vec<serde_json::Value> = arr
        .into_iter()
        .map(|p| match p {
            serde_json::Value::Object(mut obj) => {
                if obj.contains_key("hotkey") {
                    obj.insert("hotkey".to_string(), convert_json_hotkey(&obj["hotkey"]));
                }
                serde_json::Value::Object(obj)
            }
            other => other,
        })
        .collect();
    let json =
        serde_json::to_string_pretty(&migrated).map_err(|e| format!("serialize prompts: {e}"))?;
    fs::write(dst, json).map_err(|e| format!("write prompts: {e}"))?;
    log_migration!(info, "migrated prompts.json");
    Ok(())
}

/// Import `request.corpus.context_hotwords` (comma-separated) into
/// `hotwords.json` via the existing `HotwordManager::import_from_legacy`
/// (dedup-safe). Best-effort: never blocks migration.
fn migrate_hotwords(legacy_config: &Path, data_dir: &Path, resource_dir: &Path) {
    let Ok(text) = fs::read_to_string(legacy_config) else {
        return;
    };
    let Ok(cfg) = serde_norway::from_str::<Value>(&text) else {
        return;
    };
    let Some(hw) = cfg
        .get("request")
        .and_then(Value::as_mapping)
        .and_then(|m| m.get("corpus"))
        .and_then(Value::as_mapping)
        .and_then(|m| m.get("context_hotwords"))
        .and_then(Value::as_str)
    else {
        return;
    };
    if hw.trim().is_empty() {
        return;
    }
    let hm = HotwordManager::new(data_dir, resource_dir);
    match hm.import_from_legacy(hw) {
        Ok(()) => log_migration!(info, "migrated hotwords"),
        Err(e) => log_migration!(warn, "hotword migration failed: {e}"),
    }
}

/// Copy `stats.json` verbatim — the 2.x schema uses identical camelCase field
/// names (see `stats.rs` serde renames), so no transformation is needed.
fn migrate_stats(src: &Path, dst: &Path) {
    if !src.exists() || dst.exists() {
        return;
    }
    match fs::copy(src, dst) {
        Ok(_) => log_migration!(info, "migrated stats.json"),
        Err(e) => log_migration!(warn, "stats copy failed: {e}"),
    }
}

/// Copy every `history/*.jsonl` file — line schema `{ts,text,chars}` is
/// identical between versions.
fn migrate_history(src_dir: &Path, dst_dir: &Path) {
    let Ok(entries) = fs::read_dir(src_dir) else {
        return;
    };
    let _ = fs::create_dir_all(dst_dir);
    let mut count = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let dst = dst_dir.join(entry.file_name());
        if !dst.exists() && fs::copy(&path, &dst).is_ok() {
            count += 1;
        }
    }
    if count > 0 {
        log_migration!(info, "migrated {count} history file(s)");
    }
}

// ---------------------------------------------------------------------------
// Hotkey conversion: evdev keycode → accelerator string
// ---------------------------------------------------------------------------

/// Convert a legacy hotkey YAML value (evdev keycode array, or rarely an
/// already-string accelerator) into a single accelerator string.
///
/// Returns `None` for unbound (empty) or unmappable combos so the caller can
/// decide on a fallback (main hotkey → `DEFAULT_HOTKEY`, prompt → empty array).
fn convert_hotkey_value(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Sequence(seq) => {
            let codes: Vec<u32> = seq
                .iter()
                .filter_map(|n| n.as_u64().map(|x| x as u32))
                .collect();
            if codes.is_empty() {
                return None;
            }
            evdev_to_accelerator(&codes)
        }
        _ => None,
    }
}

/// Convert a 1.x prompt hotkey JSON value (evdev int array) into the 2.x
/// string-array form. Unbound or unmappable → empty array.
fn convert_json_hotkey(v: &serde_json::Value) -> serde_json::Value {
    let codes: Vec<u32> = match v {
        serde_json::Value::Array(a) => a
            .iter()
            .filter_map(|n| n.as_u64().map(|x| x as u32))
            .collect(),
        _ => return serde_json::Value::Array(Vec::new()),
    };
    match evdev_to_accelerator(&codes) {
        Some(s) => serde_json::Value::Array(vec![serde_json::Value::String(s)]),
        None => serde_json::Value::Array(Vec::new()),
    }
}

/// Convert a 1.x uIOhook keycode array (Linux evdev `input-event-codes`) into a
/// keytap accelerator string such as `"Control+Space"`.
///
/// Returns `None` when any keycode is unsupported, or when the combo does not
/// contain exactly one non-modifier key.
fn evdev_to_accelerator(keycodes: &[u32]) -> Option<String> {
    let mut mods: Vec<&str> = Vec::new();
    let mut normal: Option<&str> = None;
    for &kc in keycodes {
        match evdev_key(kc) {
            Some((name, true)) => {
                if !mods.contains(&name) {
                    mods.push(name);
                }
            }
            Some((name, false)) => {
                if normal.is_some() {
                    return None; // more than one non-modifier key
                }
                normal = Some(name);
            }
            None => {
                log_migration!(
                    warn,
                    "unsupported legacy hotkey keycode {kc}, skipping binding"
                );
                return None;
            }
        }
    }
    let normal = normal?; // need exactly one non-modifier key
    mods.push(normal);
    Some(mods.join("+"))
}

/// Map a single evdev keycode to `(accelerator token, is_modifier)`.
///
/// 1.x stored uIOhook keycodes, which follow the Linux evdev numbering
/// (e.g. `29`=LeftCtrl, `57`=Space). This is a *different* numbering from the
/// `keycode_to_key` table in `hotkey.rs` (which mixes HID/scancode values), so
/// the mapping is duplicated here intentionally rather than reused.
fn evdev_key(kc: u32) -> Option<(&'static str, bool)> {
    const MOD: bool = true;
    const NORM: bool = false;
    Some(match kc {
        // Modifiers (left/right collapse to the same token)
        29 | 97 => ("Control", MOD), // Left/Right Ctrl
        42 | 54 => ("Shift", MOD),   // Left/Right Shift
        56 | 100 => ("Alt", MOD),    // Left/Right Alt
        125 | 126 => ("Meta", MOD),  // Left/Right Meta
        // Special keys
        57 => ("Space", NORM),
        28 => ("Enter", NORM),
        15 => ("Tab", NORM),
        14 => ("Backspace", NORM),
        1 => ("Escape", NORM),
        // Arrow keys
        103 => ("Up", NORM),
        108 => ("Down", NORM),
        105 => ("Left", NORM),
        106 => ("Right", NORM),
        // Digits (KEY_0=11, KEY_1=2 .. KEY_9=10)
        2 => ("1", NORM),
        3 => ("2", NORM),
        4 => ("3", NORM),
        5 => ("4", NORM),
        6 => ("5", NORM),
        7 => ("6", NORM),
        8 => ("7", NORM),
        9 => ("8", NORM),
        10 => ("9", NORM),
        11 => ("0", NORM),
        // Function keys
        59 => ("F1", NORM),
        60 => ("F2", NORM),
        61 => ("F3", NORM),
        62 => ("F4", NORM),
        63 => ("F5", NORM),
        64 => ("F6", NORM),
        65 => ("F7", NORM),
        66 => ("F8", NORM),
        67 => ("F9", NORM),
        68 => ("F10", NORM),
        87 => ("F11", NORM),
        88 => ("F12", NORM),
        // F13-F24 are non-contiguous (evdev 183-194)
        183 => ("F13", NORM),
        184 => ("F14", NORM),
        185 => ("F15", NORM),
        186 => ("F16", NORM),
        187 => ("F17", NORM),
        188 => ("F18", NORM),
        189 => ("F19", NORM),
        190 => ("F20", NORM),
        191 => ("F21", NORM),
        192 => ("F22", NORM),
        193 => ("F23", NORM),
        194 => ("F24", NORM),
        // Letters (evdev keycodes follow the physical QWERTY layout, not the alphabet)
        30 => ("A", NORM),
        48 => ("B", NORM),
        46 => ("C", NORM),
        32 => ("D", NORM),
        18 => ("E", NORM),
        33 => ("F", NORM),
        34 => ("G", NORM),
        35 => ("H", NORM),
        23 => ("I", NORM),
        36 => ("J", NORM),
        37 => ("K", NORM),
        38 => ("L", NORM),
        50 => ("M", NORM),
        49 => ("N", NORM),
        24 => ("O", NORM),
        25 => ("P", NORM),
        16 => ("Q", NORM),
        19 => ("R", NORM),
        31 => ("S", NORM),
        20 => ("T", NORM),
        22 => ("U", NORM),
        47 => ("V", NORM),
        17 => ("W", NORM),
        45 => ("X", NORM),
        21 => ("Y", NORM),
        44 => ("Z", NORM),
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// YAML helpers
// ---------------------------------------------------------------------------

fn kv(key: &str) -> Value {
    Value::String(key.to_string())
}

fn put_str(m: &mut Mapping, key: &str, val: &str) {
    m.insert(kv(key), Value::String(val.to_string()));
}

fn copy_str(src: Option<&Mapping>, dst: &mut Mapping, key: &str) {
    if let Some(v) = src.and_then(|m| m.get(kv(key))) {
        if v.as_str().is_some() {
            dst.insert(kv(key), v.clone());
        }
    }
}

fn copy_bool(src: Option<&Mapping>, dst: &mut Mapping, key: &str) {
    if let Some(v) = src.and_then(|m| m.get(kv(key))) {
        if v.as_bool().is_some() {
            dst.insert(kv(key), v.clone());
        }
    }
}

/// Borrow the child mapping under `key` (creating an empty one if missing),
/// for in-place mutation.
fn ensure_child<'a>(parent: &'a mut Mapping, key: &str) -> &'a mut Mapping {
    let k = kv(key);
    let needs_create = !parent.contains_key(&k) || !parent.get(&k).is_some_and(|v| v.is_mapping());
    if needs_create {
        parent.insert(k.clone(), Value::Mapping(Mapping::new()));
    }
    parent
        .get_mut(&k)
        .and_then(|v| v.as_mapping_mut())
        .expect("child must be a mapping")
}

fn load_template(resource_dir: &Path) -> Value {
    fs::read_to_string(resource_dir.join("config.yaml.example"))
        .ok()
        .and_then(|t| serde_norway::from_str(&t).ok())
        .unwrap_or_else(|| Value::Mapping(Mapping::new()))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_norway::Value;
    use tempfile::TempDir;

    const LEGACY_CONFIG: &str = "\
app:
  hotkey: [29, 57]
  remove_trailing_period: false
  keep_clipboard: false
  theme: light
  hotkey_mode: toggle
  overlay_style: liquid
  overlay_glass_mode: auto
  sound:
    enabled: true
    start_sound: \"\"
    end_sound: \"\"
connection:
  url: wss://example.com/api
  app_id: \"111\"
  access_token: tok
  secret_key: sec
  resource_id: volc.x
request:
  corpus:
    context_hotwords: \"Claude Code, Claude, mermaid\"
llm:
  enabled: false
  provider: deepseek
  deepseek:
    api_key: k
    model: m
";

    /// Build an isolated fixture: `legacy/` (1.x data) + `res/` (bundled 2.x
    /// resources) and return `(legacy_dir, data_dir, resource_dir)`.
    fn fixture() -> (PathBuf, PathBuf, PathBuf) {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_path_buf();
        let legacy = root.join("legacy");
        let data = root.join("data");
        let res = root.join("res");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&res).unwrap();
        fs::write(legacy.join("config.yaml"), LEGACY_CONFIG).unwrap();
        fs::write(
            res.join("config.yaml.example"),
            "app:\n  hotkey: F13\naudio:\n  provider: doubao-streaming\nllm:\n  provider: deepseek\n",
        )
        .unwrap();
        // Leak the TempDir so the paths survive the test — tests are short-lived.
        std::mem::forget(tmp);
        (legacy, data, res)
    }

    // ---- evdev_to_accelerator ----

    #[test]
    fn evdev_ctrl_space() {
        assert_eq!(
            evdev_to_accelerator(&[29, 57]).as_deref(),
            Some("Control+Space")
        );
    }

    #[test]
    fn evdev_ctrl_a() {
        assert_eq!(
            evdev_to_accelerator(&[29, 30]).as_deref(),
            Some("Control+A")
        );
    }

    #[test]
    fn evdev_ctrl_shift_s() {
        assert_eq!(
            evdev_to_accelerator(&[29, 42, 31]).as_deref(),
            Some("Control+Shift+S")
        );
    }

    #[test]
    fn evdev_f13() {
        // evdev KEY_F13 = 183 (F-keys are non-contiguous)
        assert_eq!(evdev_to_accelerator(&[183]).as_deref(), Some("F13"));
    }

    #[test]
    fn evdev_modifiers_only_is_none() {
        // Ctrl+Shift with no normal key → invalid
        assert_eq!(evdev_to_accelerator(&[29, 42]), None);
    }

    #[test]
    fn evdev_two_normal_keys_is_none() {
        assert_eq!(evdev_to_accelerator(&[29, 30, 31]), None); // Ctrl+A+B
    }

    #[test]
    fn evdev_unknown_keycode_is_none() {
        assert_eq!(evdev_to_accelerator(&[9999]), None);
    }

    #[test]
    fn evdev_dedups_repeated_modifier() {
        // Left+Right Ctrl should collapse to a single Control
        assert_eq!(
            evdev_to_accelerator(&[29, 97, 57]).as_deref(),
            Some("Control+Space")
        );
    }

    // ---- migrate_config ----

    #[test]
    fn migrate_config_maps_credentials_and_hotkey() {
        let (legacy, data, res) = fixture();
        migrate_config(&legacy.join("config.yaml"), &data.join("config.yaml"), &res).unwrap();

        let v: Value =
            serde_norway::from_str(&fs::read_to_string(data.join("config.yaml")).unwrap()).unwrap();

        // hotkey converted
        assert_eq!(
            v.get("app").unwrap().get("hotkey").unwrap().as_str(),
            Some("Control+Space")
        );
        // app prefs copied
        assert_eq!(
            v.get("app").unwrap().get("theme").unwrap().as_str(),
            Some("light")
        );
        assert_eq!(
            v.get("app")
                .unwrap()
                .get("remove_trailing_period")
                .unwrap()
                .as_bool(),
            Some(false)
        );
        assert_eq!(
            v.get("app").unwrap().get("hotkey_mode").unwrap().as_str(),
            Some("toggle")
        );
        // connection → audio.doubao-streaming
        let ds = v.get("audio").unwrap().get("doubao-streaming").unwrap();
        assert_eq!(ds.get("app_id").unwrap().as_str(), Some("111"));
        assert_eq!(ds.get("access_token").unwrap().as_str(), Some("tok"));
        // secret_key is dropped during migration (dead field, never sent to ASR).
        assert!(ds.get("secret_key").is_none());
        assert_eq!(
            ds.get("url").unwrap().as_str(),
            Some("wss://example.com/api")
        );
        assert_eq!(
            v.get("audio").unwrap().get("provider").unwrap().as_str(),
            Some("doubao-streaming")
        );
        // llm copied, `enabled` dropped
        let llm = v.get("llm").unwrap().as_mapping().unwrap();
        assert!(llm.get(kv("enabled")).is_none());
        assert_eq!(llm.get(kv("provider")).unwrap().as_str(), Some("deepseek"));
    }

    #[test]
    fn migrate_config_falls_back_to_default_hotkey_when_unmappable() {
        let (legacy, data, res) = fixture();
        // Replace hotkey with a modifiers-only combo → conversion fails → fallback.
        let cfg = LEGACY_CONFIG.replace("hotkey: [29, 57]", "hotkey: [29, 42]");
        fs::write(legacy.join("config.yaml"), cfg).unwrap();

        migrate_config(&legacy.join("config.yaml"), &data.join("config.yaml"), &res).unwrap();

        let v: Value =
            serde_norway::from_str(&fs::read_to_string(data.join("config.yaml")).unwrap()).unwrap();
        assert_eq!(
            v.get("app").unwrap().get("hotkey").unwrap().as_str(),
            Some(DEFAULT_HOTKEY)
        );
    }

    // ---- migrate_prompts ----

    #[test]
    fn migrate_prompts_converts_hotkey_arrays() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("prompts.json");
        let dst = tmp.path().join("out.json");
        // [29, 30] = Ctrl+A → ["Control+A"]; [] stays []; [29,42] (no normal) → []
        fs::write(
            &src,
            r#"[
              {"id":"a","title":"A","hotkey":[29,30],"hotkey_mode":"toggle","prompt":"x"},
              {"id":"b","title":"B","hotkey":[],"hotkey_mode":"toggle","prompt":"y"},
              {"id":"c","title":"C","hotkey":[29,42],"hotkey_mode":"toggle","prompt":"z"}
            ]"#,
        )
        .unwrap();

        migrate_prompts(&src, &dst).unwrap();

        let arr: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&dst).unwrap()).unwrap();
        let arr = arr.as_array().unwrap();
        assert_eq!(arr[0]["hotkey"], serde_json::json!(["Control+A"]));
        assert_eq!(arr[1]["hotkey"], serde_json::json!([]));
        assert_eq!(arr[2]["hotkey"], serde_json::json!([]));
    }

    #[test]
    fn migrate_prompts_skips_when_absent() {
        let tmp = TempDir::new().unwrap();
        // Source missing → Ok, no destination written.
        assert!(
            migrate_prompts(&tmp.path().join("nope.json"), &tmp.path().join("out.json")).is_ok()
        );
        assert!(!tmp.path().join("out.json").exists());
    }

    // ---- migrate_stats / migrate_history ----

    #[test]
    fn migrate_stats_copies_verbatim() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("stats.json");
        let dst = tmp.path().join("out.json");
        fs::write(&src, r#"{"firstUsedAt":"2026-01-01","totalSessions":5,"totalCharacters":99,"dailyCounts":{}}"#).unwrap();
        migrate_stats(&src, &dst);
        assert_eq!(
            fs::read_to_string(&dst).unwrap(),
            fs::read_to_string(&src).unwrap()
        );
    }

    #[test]
    fn migrate_history_copies_jsonl_files() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("history");
        let dst = tmp.path().join("history");
        fs::create_dir_all(&src).unwrap();
        fs::write(
            src.join("2026-06-01.jsonl"),
            "{\"ts\":\"x\",\"text\":\"a\",\"chars\":1}\n",
        )
        .unwrap();
        fs::write(
            src.join("2026-06-02.jsonl"),
            "{\"ts\":\"y\",\"text\":\"b\",\"chars\":1}\n",
        )
        .unwrap();

        migrate_history(&src, &dst);

        assert!(dst.join("2026-06-01.jsonl").exists());
        assert!(dst.join("2026-06-02.jsonl").exists());
    }

    // ---- run() skip branches (do not depend on the real home dir) ----

    #[test]
    fn run_skips_when_marker_exists() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join(".migration_state"), "{}").unwrap();
        assert!(!run(tmp.path(), tmp.path()).unwrap());
    }

    #[test]
    fn run_skips_when_target_config_exists() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("config.yaml"), "app: {}").unwrap();
        // Probe ordering: target-config check happens before legacy detection,
        // so the real home dir never matters here.
        assert!(!run(tmp.path(), tmp.path()).unwrap());
        assert!(tmp.path().join(".migration_state").exists());
    }

    // ---- migrate_all end-to-end ----

    #[test]
    fn migrate_all_ports_every_artifact() {
        let (legacy, data, res) = fixture();
        // prompts.json + stats.json + history/
        fs::write(
            legacy.join("prompts.json"),
            r#"[{"id":"p","title":"P","hotkey":[29,30],"hotkey_mode":"toggle","prompt":"hi"}]"#,
        )
        .unwrap();
        fs::write(legacy.join("stats.json"), r#"{"firstUsedAt":"2026-01-01","totalSessions":1,"totalCharacters":2,"dailyCounts":{}}"#).unwrap();
        fs::create_dir_all(legacy.join("history")).unwrap();
        fs::write(
            legacy.join("history").join("2026-06-16.jsonl"),
            "{\"ts\":\"t\",\"text\":\"x\",\"chars\":1}\n",
        )
        .unwrap();

        migrate_all(&legacy, &data, &res).unwrap();

        assert!(data.join("config.yaml").exists());
        assert!(data.join("prompts.json").exists());
        assert!(data.join("stats.json").exists());
        assert!(data.join("history").join("2026-06-16.jsonl").exists());
        // hotwords imported into hotwords.json
        let hw = fs::read_to_string(data.join("hotwords.json")).unwrap();
        assert!(hw.contains("Claude Code"));

        // config.yaml carries the credentials
        let cfg = fs::read_to_string(data.join("config.yaml")).unwrap();
        assert!(cfg.contains("wss://example.com/api"));
        assert!(cfg.contains("Control+Space"));
    }

    // ---- real-data smoke test (run locally; ignored in CI) ----

    /// Migrates the *actual* 1.x install on this machine into a temp dir and
    /// verifies the outcome. Run with:
    ///   `cargo test --lib -- --ignored migrate_real --nocapture`
    /// Ignored by default because it depends on a real legacy install existing
    /// on the host (and must never touch the live 2.x data dir).
    #[test]
    #[ignore]
    fn migrate_real_legacy_install() {
        let Some(legacy) = detect_legacy_dir() else {
            eprintln!("[skip] no 1.x install on this machine");
            return;
        };
        let tmp = TempDir::new().unwrap();
        let data = tmp.path().to_path_buf();
        // The repo root holds config.yaml.example / hotwords.json (which a real
        // build bundles into the resource dir).
        let resource = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");

        migrate_all(&legacy, &data, &resource).unwrap();

        let cfg: Value =
            serde_norway::from_str(&fs::read_to_string(data.join("config.yaml")).unwrap()).unwrap();
        let hotkey = cfg
            .get("app")
            .and_then(|a| a.get("hotkey"))
            .and_then(Value::as_str)
            .unwrap_or("?");
        let creds_present = cfg
            .get("audio")
            .and_then(|a| a.get("doubao-streaming"))
            .and_then(Value::as_mapping)
            .map(|m| {
                m.contains_key(kv("app_id"))
                    && m.contains_key(kv("access_token"))
                    && !m.contains_key(kv("secret_key"))
            })
            .unwrap_or(false);

        println!("legacy dir           : {}", legacy.display());
        println!("app.hotkey           : {hotkey}");
        println!("doubao-streaming creds present : {creds_present}");
        println!(
            "prompts.json migrated: {}",
            data.join("prompts.json").exists()
        );
        println!(
            "stats.json migrated  : {}",
            data.join("stats.json").exists()
        );
        println!(
            "hotwords.json migrated: {}",
            data.join("hotwords.json").exists()
        );
        let history_count = fs::read_dir(data.join("history"))
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .filter(|e| e.path().is_file())
                    .count()
            })
            .unwrap_or(0);
        println!("history files migrated: {history_count}");

        // The real 1.x main hotkey [29,57] must convert to Control+Space, and
        // the Doubao credentials must port across.
        assert_eq!(hotkey, "Control+Space");
        assert!(creds_present);
        assert!(history_count > 0);
    }
}

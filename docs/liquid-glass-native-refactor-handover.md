# Handover: Native AppKit Overlay Refactor for True Liquid Glass

> Audience: a fresh Claude Code session with no prior context. Read this fully
> before doing anything. The goal here is a **large, optional refactor** — not a
> bug fix. The overlay already works today; this is about elevating it.

## 1. TL;DR of the objective

Rewrite the **macOS overlay UI** from HTML/CSS/JS (rendered in a transparent
WKWebView) into **native AppKit views rendered _inside_ an `NSGlassEffectView`**,
so that the overlay text gets macOS's **built-in, automatic, content-aware
legibility** (the "vibrant" treatment) — i.e. the text color adapts to whatever
window is behind the overlay, **with no Screen Recording permission**, because
the OS does the sampling/compositing internally.

This is impossible with the current hybrid (web text on top of a native glass
layer) because the OS does not see the web text — the webview composites
separately. Only **native content placed inside the glass** receives the
automatic adaptation.

## 2. Background / current state (what already shipped)

- App: **VoicePaste**, Tauri v2 (Rust backend + vanilla-JS webview frontend).
  Voice-to-text via global hotkey; a floating overlay "pill" shows ASR results.
- Active codebase line is **Tauri** (branch `master` / tag `v2.0.0`). There is an
  older **Electron** line on `main` — ignore it; it's legacy.
- A fix was just merged-pending in **PR that-yolanda/voicepaste#16** (branch
  `fix/overlay-not-showing`, also now the local `local-main`). That PR:
  - Made the overlay **visible** on macOS by rendering the glass body with a
    **native AppKit view behind the transparent webview**, tracked to the pill's
    rectangle via IPC. `NSGlassEffectView` (style `Clear`) on macOS 26+, falling
    back to `NSVisualEffectView` for older systems / the `vibrancy` style.
  - Fixed overlay positioning (primary monitor work area, logical units).
  - Light/dark via `NSAppearance`; live appearance switching on config save.
- **This refactor supersedes the "native view behind the webview" hybrid** with
  "native content inside the glass". Treat PR #16 as the current baseline.

### Why the current hybrid can't do adaptive text
- The pill's text/indicator/waveform live in the **WKWebView** (web layer).
- The glass body is a **separate native `NSGlassEffectView`** sitting *behind*
  the transparent webview.
- macOS vibrancy / Liquid Glass auto-adapts the color of **native content drawn
  inside the effect view** — it has no knowledge of the web text on top.
- Detecting the backdrop ourselves would need **Screen Recording permission**,
  which the user explicitly declined.

## 3. Decisions already made (do not relitigate)

- **No Screen Recording permission.** The user rejected screen-sampling.
- **Real Apple Liquid Glass is the goal**, not a CSS frosted imitation.
- A CSS/text outline/halo/tint to fake legibility was tried and **rejected as
  ugly** — do not bring those back.
- The user is **willing to do a large refactor** to get native adaptive text.
- macOS target is **26.x (Tahoe)**, which has `NSGlassEffectView`. Must still
  degrade gracefully on < 26 (no `NSGlassEffectView`).

## 4. What the refactor must preserve (functional parity)

The overlay's behavior/feature set must keep working:

- **States**: `idle → connecting → recording → finishing → idle`. Visual states:
  connecting (spinner "准备中…"), recording (green dot + live waveform), finishing
  (spinner "思考中…" when LLM polishing), error hints, transcript display.
- **Text**: streaming **partial** (dimmer) + **final** text; single-line that
  grows horizontally, then **multi-line wrap** (up to ~3 lines, top fades) when
  long. Pill width hugs content; bottom-center on the primary screen.
- **Waveform**: 4 bars animated from mic level during recording.
- **Show/hide** tied to the recording lifecycle; **click-through** (ignore mouse).
- **Hotkey-driven** start/stop (toggle & hold modes) — unchanged, lives in Rust.
- **Cross-platform**: Windows overlay currently uses the **same web overlay**.
  The refactor is **macOS-only**; Windows must keep working (either keep the web
  overlay for Windows, or branch by platform). Do not break Windows.
- **Settings**: `overlay_style` = `liquid` | `vibrancy`; `overlay_glass_mode` =
  `auto` | `light` | `dark`. With native adaptive text, `auto` could become
  "follow backdrop automatically" (the whole point), but keep light/dark
  overrides working.

## 5. Current architecture map (files & responsibilities)

### Frontend (web/) — the overlay UI to be reimplemented natively on macOS
- `web/index.html` — overlay markup: `.stage > .bubble.pill` containing
  `.indicator`, `.body > .transcript (.final-text/.partial-text) + .hint`, and
  `.wave > .status-bars`.
- `web/app.js` — the real logic to port:
  - `state` machine + `updateView()`; `applyAppearance({platform, overlayStyle,
    glass})`; `resolvedGlassVariant()` (auto→`matchMedia`).
  - `scheduleResize()` — measures text via a hidden `.measure-text` node and
    computes pill width / single-vs-multi wrap. **This sizing logic is the
    fiddly part** to reproduce natively.
  - `syncGlassRect()` — sends the pill rect + radius + style + variant to Rust
    via `updateGlassRect` (this is the IPC the refactor removes).
  - Mic capture + 16 kHz PCM downsample + `sendAudioChunk` (ASR). **Audio capture
    uses `getUserMedia` in the webview** — if you go fully native you must either
    keep a hidden webview for audio, or move capture to Rust. Decide early.
  - Waveform animation from an `AnalyserNode`.
- `web/styles.css` — pill styling. macOS pill background is transparent so the
  native glass shows through (`.pill.platform-mac:not(.is-vibrancy)`); `.is-light`
  variant for light mode; `.is-vibrancy` for the frosted style.
- `web/tauri-bridge.js` — `window.voiceOverlay` API: `onEvent`, `sendAudioChunk`,
  `updateGlassRect`, `getConfig`, etc.

### Backend (src-tauri/src/)
- `lib.rs`:
  - `mod glass` — **the existing native glass code** (good reference for objc2
    usage): `GlassView` enum (Liquid/Vibrancy), `sync(ns_window_ptr, rect, style,
    variant)`, `apply_appearance(view, variant)` (sets `NSAppearance` Aqua/
    DarkAqua), `liquid_glass_available()` (runtime `NSGlassEffectView` class
    probe). Uses `MainThreadMarker`, `objc2`, `objc2-app-kit`, `objc2-foundation`.
  - `update_overlay_glass` command (registered in `invoke_handler!`).
  - `position_overlay()` — bottom-center on primary monitor work area (logical).
  - `start_recording()` / stop flow — calls `overlay.show()/hide()`, emits
    `overlay:event` (reset/state/recording:start/transcript/hint/...).
  - `set_dock_visible()` — existing `MainThreadMarker` + `objc2-app-kit` pattern
    to copy.
- `commands.rs` — `get_app_config` (returns platform/overlayStyle/glass),
  `save_config*` emit an `appearance` `overlay:event`.
- `config.rs` — `overlay_style`, `overlay_glass_mode` defaults.
- `tauri.conf.json` — overlay window: `transparent:true, decorations:false,
  visible:false, alwaysOnTop:true, focusable:false, shadow:false`,
  `macOSPrivateApi:true`.

## 6. Proposed approach (native overlay)

Two viable shapes — pick during planning:

**Option 1 — Fully native overlay (highest fidelity).**
Replace the macOS overlay webview with a native `NSWindow` whose content is an
`NSGlassEffectView` containing native subviews: an `NSTextField`/`NSTextView`
for transcript (using **vibrant / `labelColor`-style colors** so the OS adapts
it), an indicator view, and a custom waveform view. Reimplement `scheduleResize`
sizing in native code (size the window/glass to content, keep bottom-center).
Audio: keep a tiny hidden webview just for `getUserMedia`, **or** move capture
to Rust (e.g. `cpal`) — capturing in Rust is cleaner long-term but is extra work.

**Option 2 — Native glass + native text overlaid, web only for waveform/audio.**
Keep the webview for audio + waveform but render **only the text** as a native
vibrant label inside the glass, aligned to the pill. Less rewrite, but aligning
native text with web-laid-out chrome is fiddly and partly reintroduces the
two-layer sync problem. Option 1 is cleaner.

Recommendation: **Option 1**, macOS-only, keeping the existing web overlay for
Windows (branch the overlay creation by `cfg!(target_os)`).

### Key native API notes
- `NSGlassEffectView` (objc2-app-kit 0.3.2): `setStyle(NSGlassEffectViewStyle::
  Clear|Regular)` — **Clear** is the transparent refractive look; `setTintColor`,
  `setCornerRadius`, and a `contentView` you set to your content. Place your text
  inside (as `contentView` or subviews) so it gets the glass's adaptive treatment.
- Vibrant text: native `NSTextField` with `labelColor`/`secondaryLabelColor`
  inside a vibrancy/glass context auto-adapts to the backdrop. Verify the
  partial/final color mapping (final = primary label, partial = secondary).
- Fallback < macOS 26: `NSVisualEffectView` (BehindWindow, Active, a material),
  with the same native vibrant text — vibrancy also auto-adapts text legibility.
- Threading: all AppKit calls on the main thread (`MainThreadMarker`,
  `app.run_on_main_thread`). See `set_dock_visible`/`mod glass` for the pattern.
- Deps already present: `objc2`, `objc2-app-kit`, `objc2-foundation`.

## 7. Risks / open questions to resolve in planning
- **Audio capture** currently depends on the webview (`getUserMedia`). Going
  fully native forces a decision (hidden webview vs Rust capture). Resolve first.
- Reproducing `scheduleResize` (text measurement, single↔multi wrap, max width,
  ellipsis/overflow correction) natively is non-trivial — budget for it.
- Window sizing/animation: the web pill animates width via layout; a native
  window resize per partial may need debouncing/animation to feel smooth.
- Verify `NSGlassEffectView` adaptive text actually solves the
  light-text-on-light-window / dark-on-dark legibility case (the original ask).
  Prototype this in isolation before committing to the full rewrite.
- Keep Windows overlay (web) working; don't regress it.

## 8. How to verify
- `pnpm tauri dev` on macOS 26.x. Trigger recording (global hotkey), speak.
- Place the overlay over **both a light and a dark window** and confirm text
  stays legible automatically (the core goal).
- Check states, multi-line wrap, waveform, hide-on-finish, bottom-center.
- `cargo check` (zero warnings) and `pnpm check` (Biome) must pass.
- Compare side-by-side with the current `local-main` overlay.

## 9. Pointers
- Baseline branch: `local-main` (== PR #16 head). Old Electron backup tag:
  `backup/electron-local-main`.
- Known separate, unrelated bug to NOT conflate: **dropped/garbled characters
  and extra/irrelevant text in transcripts** — suspected `asr.rs` partial/final
  assembly or `llm.rs` polishing; out of scope for this refactor.

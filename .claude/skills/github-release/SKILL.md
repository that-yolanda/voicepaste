---
name: github-release
description: Publish validated VoicePaste releases from this repository. Use when the user wants to prepare a release, verify release readiness, create or update a GitHub Release, upload installers and update metadata, or generate release notes. Triggers on any mention of releasing, publishing, version bumps, or shipping a new version of VoicePaste.
---

# GitHub Release

Use this skill for project-specific GitHub release work in this repository. Follow the release gates in `AGENTS.md` and keep the process explicit: do not push, publish, or upload artifacts until the user confirms validation is complete.

## Options

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview changes without executing |
| `--major` | Force major version bump |
| `--minor` | Force minor version bump |
| `--patch` | Force patch version bump |
| `--beta` | Build and release as beta (prerelease) |

## Version Location

**Single source of truth: `package.json` → `"version"`**

Only change version in `package.json`. The pack script (`scripts/pack.ts`) automatically syncs it to `Cargo.toml` before building. `tauri.conf.json` omits the `version` field entirely — Tauri reads from `Cargo.toml` at build time.

| File | Field | How it stays in sync |
|------|-------|---------------------|
| `package.json` | `"version"` | ✏️ **Only file to edit manually** |
| `src-tauri/Cargo.toml` | `version = "..."` | Auto-synced by `pack.ts` before build |
| `src-tauri/tauri.conf.json` | *(omitted)* | Falls back to `Cargo.toml` |

When updating the version, only modify `package.json`:
```bash
node -e "const p=require('./package.json'); p.version='1.4.0'; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2)+'\n')"
```

## Workflow

### Step 1: Detect Current State

```bash
# Current version
node -e "console.log(require('./package.json').version)"

# Last tag
LAST_TAG=$(git tag --sort=-v:refname | head -1)

# If no tag, use initial commit
if [ -z "$LAST_TAG" ]; then
  LAST_TAG=$(git rev-list --max-parents=0 HEAD)
fi

# Commits since last tag
git log ${LAST_TAG}..HEAD --oneline
```

### Step 2: Categorize Changes

Classify commits by conventional commit type:

| Type | Description | Changelog Section |
|------|-------------|-------------------|
| `feat` | New features | Features |
| `fix` | Bug fixes | Fixes |
| `docs` | Documentation | Documentation |
| `refactor` | Code refactoring | Refactor |
| `perf` | Performance | Performance |
| `style` | Formatting | (skip in changelog) |
| `test` | Tests | (skip in changelog) |
| `chore` | Maintenance | (skip in changelog) |

**Breaking change detection**:
- Commit message starts with `BREAKING CHANGE`
- Commit body contains `BREAKING CHANGE:`
- Removed public APIs, renamed exports, changed interfaces

If breaking changes detected, warn: "Breaking changes detected. Consider major version bump (--major)."

### Step 3: Determine Version Bump

Rules (priority order):
1. User flag `--major/--minor/--patch` → Use specified
2. BREAKING CHANGE detected → Major bump
3. `feat:` commits present → Minor bump
4. Otherwise → Patch bump

Display: `1.0.8 → 1.1.0`

After user confirms the version, update `package.json` with the new version number.

### Step 4: Verify Release Docs

Check that the following files reference the correct version number:
- `CHANGELOG.md`
- `CHANGELOG.zh.md`
- `README.md`
- `README.zh.md`

If any file is missing the new version entry, flag this to the user before continuing.

### Step 5: Quality Gate

Run `pnpm check` — this project requires Biome lint + format to pass before any commit. Fix all errors and warnings before proceeding.

### Step 6: Build Artifacts (cross-machine)

mac and Windows targets are built on separate hosts and merged into one `dist/`. Each host's `latest.json` only lists the platforms it built, so the manifest must be rebuilt at the end — see "Cross-Machine Build & `latest.json` Merge" below.

```bash
# 1. macOS host — signed + notarized (both arches; dmg is notarized too)
pnpm run pack -s
#   (single arch: pnpm run pack -s -p apple_aarch64)

# 2. Windows host — unsigned (updater sig still comes from .env TAURI_SIGNING_PRIVATE_KEY)
pnpm run pack

# 3. Copy Windows artifacts into the mac dist/:
#      VoicePaste_<version>_x64-setup.exe, .exe.sig, _x64_en-US.msi

# 4. macOS host — MUST run: rebuild latest.json from the merged dist/
pnpm run pack --gen-json
```

`pack -s` notarizes + staples the dmg as well (Tauri only notarizes the .app). Verify before uploading:

```bash
spctl -a -vvv -t install dist/VoicePaste_<version>_aarch64.dmg   # expect: source=Notarized Developer ID
```

Validate the full artifact set:

```bash
.claude/skills/github-release/scripts/collect-release-artifacts.sh <version>
```

### Step 7: User Confirmation

Before pushing or publishing, present a summary:

- Version change: `X.Y.Z → A.B.C`
- Categorized changes grouped by type
- Artifacts that will be uploaded
- Commits to be pushed

Require explicit user confirmation ("yes" / "go ahead") before any push or publish action.

### Step 8: Commit, Tag, Push

```bash
git add package.json CHANGELOG.md CHANGELOG.zh.md
git commit -m "chore: release v<version>"
git tag -a v<version> -m "Release v<version>"
git push origin main
git push origin v<version>
```

### Step 9: Create GitHub Release

```bash
# Render release notes
.claude/skills/github-release/scripts/render-release-notes.sh <version>

# Stable release
gh release create v<version> --title "v<version>" --notes-file <temp>

# Beta release (prerelease keeps it off /releases/latest/ so stable users never resolve it)
gh release create v<version> --prerelease --title "v<version>" --notes-file <temp>
```

Consider using `--draft` first for safety, then publish after the user approves the release notes.

### Beta Release Flow

> **Important**: Beta metadata (`latest-beta.json`) must be uploaded to the **latest stable release** (not just the prerelease) because `/releases/latest/` skips prerelease releases. See "Update Channels" section below for the full architecture.

1. Set version in `package.json` to `x.y.z-beta` (e.g., `1.3.1-beta`). Each beta increments the patch version — `1.3.1-beta`, `1.3.2-beta`, etc.
2. Pack script auto-syncs version to `Cargo.toml` (`version = "..."`). `tauri.conf.json` omits the `version` field entirely.
3. Build: `pnpm run pack -s --beta -p apple_aarch64`
4. Artifacts in `dist/` will contain `latest-beta.json` (multi-platform JSON with `platforms` map)
5. Create prerelease: `gh release create vx.y.z-beta --prerelease`
6. Upload beta artifacts (installers + tar.gz + sig) to the prerelease release
7. **Upload `latest-beta.json` to the latest stable release** (so beta users can discover the update via `/releases/latest/download/latest-beta.json`):
   ```bash
   # Find the latest stable release tag
   STABLE_TAG=$(gh release list --limit 10 --json tagName,isPrerelease --jq '.[] | select(.isPrerelease == false) | .tagName' | head -1)
   gh release upload "$STABLE_TAG" dist/latest-beta.json --clobber
   ```
8. Users with `beta_updates: true` in config will receive this update
9. When ready for stable: set version to `x.y.z` (no suffix), build without `--beta`, create non-prerelease release as usual

### Step 10: Upload Artifacts

Upload all validated artifacts to the GitHub Release:

```bash
gh release upload v<version> <artifact-files...>
```

## Release Notes Style

Mirror the historical GitHub Release style:

```md
## What's New

- **Title** — user-facing benefit
- **Title** — user-facing benefit

## Downloads

- `VoicePaste_<version>_aarch64.dmg` — macOS (Apple Silicon)
- `VoicePaste_<version>_x64.dmg` — macOS (Intel)
- `VoicePaste_<version>_x64-setup.exe` — Windows (x64 NSIS installer)
- `VoicePaste_<version>_x64_en-US.msi` — Windows (x64 MSI)

**Full Changelog**: https://github.com/that-yolanda/voicepaste/compare/v<previous>...v<version>
```

- Keep the list concise: usually 3-6 bullets.
- Rewrite release notes for users. Do not paste file-level implementation details.
- If the release is mostly fixes, `## What's Changed` is also acceptable.

## Update Channels

VoicePaste uses two update channels served from the same GitHub repository. The key constraint is that **GitHub's `/releases/latest/` URL only resolves to the latest non-prerelease release** — there is no equivalent URL for prerelease releases.

### Architecture

```
Stable Release (v1.3.0, --latest)
├── latest.json                         ← stable metadata (multi-platform)
├── latest-beta.json                    ← beta metadata (platforms point to beta release assets)
├── VoicePaste_1.3.0_aarch64.dmg
└── ...

Beta Release (v1.3.1-beta, --prerelease)
├── VoicePaste_1.3.1-beta_aarch64.dmg
├── VoicePaste_1.3.1-beta_aarch64.app.tar.gz
└── VoicePaste_1.3.1-beta_aarch64.app.tar.gz.sig
```

### Endpoint URLs

| Channel | URL Pattern |
|---------|-------------|
| Stable | `.../releases/latest/download/latest.json` |
| Beta | `.../releases/latest/download/latest-beta.json` |

Both URLs resolve from the **stable release** because `/releases/latest/` skips prerelease. The updater JSON uses a `platforms` map — each platform entry's `url` points to the actual download in the corresponding release.

### Release Sequence

1. **Stable release**: Create with `--latest`, upload stable artifacts + `latest.json`
2. **Beta release**: Create with `--prerelease`, upload beta artifacts. Then upload `latest-beta.json` to the latest stable release via `gh release upload <stable-tag> latest-beta.json --clobber`
3. **Beta → Stable**: Create a new stable release as usual. The old `latest-beta.json` stays in the previous stable release but is no longer reachable (the new stable release becomes `/releases/latest/`). If a new beta is needed, upload a new `latest-beta.json` to the new stable release.

### Why This Approach

- GitHub has no static URL for "latest prerelease" — must use REST API (requires auth, not suitable for desktop apps)
- Tauri has no native multi-channel updater support ([tauri-apps/tauri#2595](https://github.com/tauri-apps/tauri/issues/2595))
- `--prerelease` keeps the beta off `/releases/latest/`, so stable users (who fetch `latest.json`) never resolve it; beta users fetch `latest-beta.json` instead
- SemVer guarantees `1.3.1-beta < 1.3.1`, so stable users are never offered beta updates

## Cross-Machine Build & `latest.json` Merge

Because macOS and Windows are built on different hosts, neither host sees the other's artifacts. The updater manifest (`latest.json` / `latest-beta.json`) is therefore generated per-host and **must be rebuilt once `dist/` holds artifacts from every platform**:

```bash
# After every platform's artifacts are collected in dist/ (including Windows
# artifacts copied over from the Windows host), run on any host:
pnpm run pack --gen-json
```

`--gen-json` skips the build entirely and rebuilds the manifest from whatever currently lives in `dist/` — each `platforms` entry's URL and signature are derived from the actual artifact files, so it can never point at a missing file or a wrong signature. **This step is mandatory** in the cross-machine workflow; without it the published manifest will be missing platforms or carry stale/incorrect signatures.

## Artifact Rules

Always upload the platform installers and update metadata files required by `tauri-plugin-updater`:

- **Updater metadata** (one file for all platforms):
  - `latest.json` (stable) or `latest-beta.json` (beta) — multi-platform JSON with `platforms` map
- macOS (Apple Silicon):
  - `VoicePaste_<version>_aarch64.dmg`
  - `VoicePaste_<version>_aarch64.app.tar.gz`
  - `VoicePaste_<version>_aarch64.app.tar.gz.sig`
- macOS (Intel):
  - `VoicePaste_<version>_x64.dmg`
  - `VoicePaste_<version>_x64.app.tar.gz`
  - `VoicePaste_<version>_x64.app.tar.gz.sig`
- Windows (x64):
  - `VoicePaste_<version>_x64-setup.exe` (NSIS installer; also the updater payload)
  - `VoicePaste_<version>_x64-setup.exe.sig`
  - `VoicePaste_<version>_x64_en-US.msi`
- Keep all assets for the same version in the same GitHub Release.

## Commands

```bash
pnpm check
pnpm run pack -s
git status --short
git log --oneline origin/master..HEAD
git push origin main
git tag -a v<version> -m "Release v<version>"
git push origin v<version>
gh release view v<version>
gh release create v<version> --draft ...
```

For artifact validation:

```bash
.claude/skills/github-release/scripts/collect-release-artifacts.sh <version>
.claude/skills/github-release/scripts/collect-release-artifacts.sh <version> --platforms mac-arm64,win-x64
```

For release-notes draft:

```bash
.claude/skills/github-release/scripts/render-release-notes.sh <version>
.claude/skills/github-release/scripts/render-release-notes.sh <version> <previous-version>
```

## Example Usage

```
/github-release              # Auto-detect version bump
/github-release --dry-run    # Preview only
/github-release --minor      # Force minor bump
/github-release --patch      # Force patch bump
```

## Resources

### scripts/

- `collect-release-artifacts.sh`
  - Validates required release artifacts in `dist/`
  - Supports `--platforms` flag for partial validation
  - Prints the exact files that should be uploaded
- `render-release-notes.sh`
  - Produces a release-notes draft in the preferred VoicePaste GitHub Release format
  - Auto-detects previous version from git tags
  - Groups commits by conventional commit type

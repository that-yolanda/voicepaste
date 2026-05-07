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

## Version Location

| Item | File | Field |
|------|------|-------|
| Version | `package.json` | `version` |

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

### Step 6: Build Artifacts

```bash
pnpm pack -s
```

This builds all platforms with signing and notarization. Validate artifacts:

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

# Create release with notes
gh release create v<version> --title "v<version>" --notes-file <temp>
```

Consider using `--draft` first for safety, then publish after the user approves the release notes.

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

- `VoicePaste-<version>-arm64.zip` — macOS (Apple Silicon)
- `VoicePaste-<version>-x64.zip` — macOS (Intel)
- `VoicePaste-<version>-win-x64.exe` — Windows (x64 NSIS installer)

**Full Changelog**: https://github.com/that-yolanda/voicepaste/compare/v<previous>...v<version>
```

- Keep the list concise: usually 3-6 bullets.
- Rewrite release notes for users. Do not paste file-level implementation details.
- If the release is mostly fixes, `## What's Changed` is also acceptable.

## Artifact Rules

Always upload the platform installers and update metadata files required by `electron-updater`:

- macOS:
  - `VoicePaste-<version>-arm64.zip`
  - `VoicePaste-<version>-x64.zip`
  - `latest-mac.yml`
- Windows:
  - `VoicePaste-<version>-win-x64.exe`
  - `latest.yml`
- Upload matching `*.blockmap` files when present.
- Keep all assets for the same version in the same GitHub Release.

## Commands

```bash
pnpm check
pnpm pack -s
git status --short
git log --oneline origin/main..HEAD
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

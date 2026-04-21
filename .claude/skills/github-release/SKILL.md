---
name: github-release
description: Publish validated VoicePaste releases from this repository. Use when the user wants to prepare a release, verify release readiness, create or update a GitHub Release, upload installers and update metadata, or generate release notes. Triggers on any mention of releasing, publishing, version bumps, or shipping a new version of VoicePaste.
---

# GitHub Release

Use this skill for project-specific GitHub release work in this repository. Follow the release gates in `AGENTS.md` and keep the process explicit: do not push, publish, or upload artifacts until the user confirms validation is complete.

## Workflow

1. **Read target version** from `package.json` (`version` field).
2. **Run `pnpm check`** — this project requires Biome lint + format to pass before any commit. Fix all errors and warnings before proceeding.
3. **Verify release docs are updated** for the target version:
   - `README.md`
   - `README.zh.md`
   - `CHANGELOG.md`
   - `CHANGELOG.zh.md`
   Check that each file references the correct version number. If any file is missing the new version entry, flag this to the user before continuing.
4. **Check `git status`** and confirm whether remaining changes should be committed. Follow the commit rules below.
5. **Validate release artifacts** in `dist/` by running the collection script (see Commands below). This checks that all required installers and update metadata files exist for the target version.
6. **Confirm user validation** — before pushing or publishing, present a summary to the user:
   - The commit(s) to be pushed (show `git log --oneline origin/main..HEAD` or equivalent)
   - The version being released
   - The artifacts that will be uploaded
   Require explicit user confirmation ("yes" / "go ahead") before any push or publish action.
7. **Push the target branch** only after user confirmation.
8. **Create and push the release tag**:
   ```bash
   git tag -a v<version> -m "Release v<version>"
   git push origin v<version>
   ```
   Using an annotated tag (`-a`) ensures the tag has a message and author info, and is visible in GitHub's tag list. Push it explicitly so the local and remote stay in sync.
9. **Create the GitHub Release** from the tag. Consider using `--draft` first for safety, then publish after the user approves the release notes.
10. **Upload artifacts**: installers, `latest.yml`, `latest-mac.yml`, and any matching `*.blockmap` files from the same version.

## Commit Rules

- Follow the repository commit convention from `AGENTS.md`.
- Use prefixes such as `fix:` or `feat:`, optionally with scope like `fix(update):`.
- Explain why, not just what.

## Release Notes Style

Mirror the historical GitHub Release style used in `v1.0.4` and `v1.0.5`:

- Prefer a short, user-facing summary rather than a raw changelog dump.
- Use this structure by default:

```md
## What's New

- **Title** — user-facing benefit
- **Title** — user-facing benefit
- **Title** — user-facing benefit

## Downloads

- `VoicePaste-<version>-arm64.zip` — macOS (Apple Silicon)
- `VoicePaste-<version>-win-x64.exe` — Windows (x64 NSIS installer)

**Full Changelog**: https://github.com/that-yolanda/voicepaste/compare/v<previous>...v<version>
```

- Keep the list concise: usually 3-6 bullets.
- Rewrite release notes for users. Do not paste file-level implementation details.
- If the release is mostly fixes, `## What's Changed` is also acceptable, but keep the same concise style.

## Artifact Rules

Always upload the platform installers and update metadata files required by `electron-updater`:

- macOS:
  - `VoicePaste-<version>-arm64.zip`
  - `latest-mac.yml`
- Windows:
  - `VoicePaste-<version>-win-x64.exe`
  - `latest.yml`
- Upload matching `*.blockmap` files when present.
- Keep all assets for the same version in the same GitHub Release.

## Commands

Use these commands as the baseline release workflow:

```bash
pnpm check
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
```

For a release-notes draft with changelog and git log extraction:

```bash
.claude/skills/github-release/scripts/render-release-notes.sh <version> <previous-version>
```

## Resources

### scripts/

- `collect-release-artifacts.sh`
  - Validates required release artifacts in `dist/`
  - Prints the exact files that should be uploaded
- `render-release-notes.sh`
  - Produces a release-notes draft in the preferred VoicePaste GitHub Release format
  - Extracts content from CHANGELOG.md when available, falls back to git log between versions
  - Uses the target version and previous version to generate the compare link

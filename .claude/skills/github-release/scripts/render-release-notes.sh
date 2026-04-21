#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <version> <previous-version>" >&2
  exit 1
fi

version="$1"
previous="$2"
compare_url="https://github.com/that-yolanda/voicepaste/compare/v${previous}...v${version}"

# Try to extract changelog section for this version
changelog_file=""
for f in CHANGELOG.md CHANGELOG.zh.md; do
  if [[ -f "$f" ]]; then
    changelog_file="$f"
    break
  fi
done

if [[ -n "$changelog_file" ]]; then
  # Extract the section between the target version header and the next version header
  section=$(awk -v ver="$version" '
    tolower($0) ~ "##.*" ver { found=1; next }
    found && tolower($0) ~ /^## / { exit }
    found { print }
  ' "$changelog_file" | sed '/^$/d; /^$/d')
fi

# Extract commit log between versions
if git rev-parse "v${previous}" >/dev/null 2>&1; then
  commit_log=$(git log "v${previous}..HEAD" --pretty=format:"- %s" 2>/dev/null || true)
else
  commit_log=$(git log -10 --pretty=format:"- %s" 2>/dev/null || true)
fi

cat <<EOF
## What's New

EOF

if [[ -n "${section:-}" ]]; then
  echo "$section"
  echo ""
elif [[ -n "$commit_log" ]]; then
  echo "$commit_log"
  echo ""
else
  cat <<EOF
- **Title** — user-facing benefit
- **Title** — user-facing benefit

EOF
fi

cat <<EOF
## Downloads

- \`VoicePaste-${version}-arm64.zip\` — macOS (Apple Silicon)
- \`VoicePaste-${version}-win-x64.exe\` — Windows (x64 NSIS installer)

**Full Changelog**: ${compare_url}
EOF

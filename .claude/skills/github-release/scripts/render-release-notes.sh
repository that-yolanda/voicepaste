#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <version> [previous-version]" >&2
  exit 1
fi

version="$1"
shift

previous="${1:-}"

# Auto-detect previous version from git tags if not provided
if [[ -z "$previous" ]]; then
  previous=$(git tag --sort=-v:refname | head -1 || true)
  if [[ "$previous" == "v${version}" ]]; then
    previous=$(git tag --sort=-v:refname | sed -n '2p' || true)
    previous="${previous#v}"
  else
    previous="${previous#v}"
  fi
fi

compare_url="https://github.com/that-yolanda/voicepaste/compare/v${previous}...v${version}"

# Extract changelog section from CHANGELOG.md
if [[ ! -f CHANGELOG.md ]]; then
  echo "Error: CHANGELOG.md not found" >&2
  exit 1
fi

section=$(awk -v ver="$version" '
  tolower($0) ~ "##.*" ver { found=1; next }
  found && tolower($0) ~ /^## / { exit }
  found { print }
' CHANGELOG.md | sed '/^$/d')

if [[ -z "$section" ]]; then
  echo "Error: CHANGELOG.md has no entry for version ${version}" >&2
  exit 1
fi

echo "## What's New"
echo
echo "$section"
echo
echo "## Downloads"
echo
echo "- \`VoicePaste-${version}-arm64.zip\` — macOS (Apple Silicon)"
echo "- \`VoicePaste-${version}-x64.zip\` — macOS (Intel)"
echo "- \`VoicePaste-${version}-win-x64.exe\` — Windows (x64 NSIS installer)"
echo
echo "**Full Changelog**: ${compare_url}"

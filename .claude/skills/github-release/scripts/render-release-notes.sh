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
echo "- \`VoicePaste_${version}_aarch64.dmg\` — macOS (Apple Silicon)"
echo "- \`VoicePaste_${version}_x64.dmg\` — macOS (Intel)"
echo "- \`VoicePaste_${version}_x64-setup.exe\` — Windows (x64 NSIS installer)"
echo "- \`VoicePaste_${version}_x64_en-US.msi\` — Windows (x64 MSI)"
echo
echo "**Full Changelog**: ${compare_url}"

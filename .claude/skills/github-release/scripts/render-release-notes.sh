#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <version> [previous-version]" >&2
  exit 1
fi

version="$1"
shift

previous="${1:-}"

# Auto-detect previous version from git tags if not provided.
# Skip beta/RC/prerelease tags and the version currently being released.
if [[ -z "$previous" ]]; then
  previous=$(git tag --sort=-v:refname \
    | grep -vE -- '-beta|-rc|prerelease' \
    | grep -vxF "v${version}" \
    | head -1 || true)
  previous="${previous#v}"
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
echo "| 平台 | 下载 |"
echo "|------|------|"
echo "| macOS (Apple Silicon) | [\`VoicePaste_${version}_aarch64.dmg\`](https://github.com/that-yolanda/voicepaste/releases/download/v${version}/VoicePaste_${version}_aarch64.dmg) |"
echo "| macOS (Intel) | [\`VoicePaste_${version}_x64.dmg\`](https://github.com/that-yolanda/voicepaste/releases/download/v${version}/VoicePaste_${version}_x64.dmg) |"
echo "| Windows (x64 NSIS) | [\`VoicePaste_${version}_x64-setup.exe\`](https://github.com/that-yolanda/voicepaste/releases/download/v${version}/VoicePaste_${version}_x64-setup.exe) |"
echo "| Windows (x64 MSI) | [\`VoicePaste_${version}_x64_en-US.msi\`](https://github.com/that-yolanda/voicepaste/releases/download/v${version}/VoicePaste_${version}_x64_en-US.msi) |"
echo
echo "**Full Changelog**: ${compare_url}"

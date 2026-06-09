#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <version> [--platforms apple_aarch64,apple_x64,win_x64]" >&2
  exit 1
fi

version="$1"
shift

platforms=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platforms)
      platforms="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

root_dir="$(git rev-parse --show-toplevel)"
dist_dir="$root_dir/dist"

# Check for --beta flag
beta=false
for arg in "$@"; do
  case "$arg" in
    --beta) beta=true ;;
  esac
done

# Build artifact lists based on requested platforms
required=()
optional=()

if [[ -z "$platforms" ]]; then
  # All platforms — use glob matching for flexibility
  platforms="apple_aarch64,apple_x64,win_x64"
fi

IFS=',' read -ra plat_array <<< "$platforms"
has_mac_arm=false
has_mac_x64=false
has_win=false

for p in "${plat_array[@]}"; do
  case "$p" in
    apple_aarch64)
      required+=("$dist_dir/VoicePaste_${version}_aarch64.dmg")
      optional+=("$dist_dir/VoicePaste_${version}_aarch64.app.tar.gz")
      optional+=("$dist_dir/VoicePaste_${version}_aarch64.app.tar.gz.sig")
      has_mac_arm=true
      ;;
    apple_x64)
      required+=("$dist_dir/VoicePaste_${version}_x64.dmg")
      optional+=("$dist_dir/VoicePaste_${version}_x64.app.tar.gz")
      optional+=("$dist_dir/VoicePaste_${version}_x64.app.tar.gz.sig")
      has_mac_x64=true
      ;;
    win_x64)
      required+=("$dist_dir/VoicePaste_${version}_x64-setup.exe")
      required+=("$dist_dir/VoicePaste_${version}_x64_en-US.msi")
      optional+=("$dist_dir/VoicePaste_${version}_x64-setup.nsis.zip")
      optional+=("$dist_dir/VoicePaste_${version}_x64-setup.nsis.zip.sig")
      has_win=true
      ;;
    *)
      echo "Unknown platform: $p" >&2
      echo "Available: apple_aarch64, apple_x64, win_x64" >&2
      exit 1
      ;;
  esac
done

# Updater JSON metadata (only when signing key is available)
if [[ "$has_mac_arm" == true ]]; then
  if [[ "$beta" == true ]]; then
    optional+=("$dist_dir/latest-beta-darwin-aarch64.json")
  else
    optional+=("$dist_dir/latest-darwin-aarch64.json")
  fi
fi
if [[ "$has_mac_x64" == true ]]; then
  if [[ "$beta" == true ]]; then
    optional+=("$dist_dir/latest-beta-darwin-x86_64.json")
  else
    optional+=("$dist_dir/latest-darwin-x86_64.json")
  fi
fi
if [[ "$has_win" == true ]]; then
  if [[ "$beta" == true ]]; then
    optional+=("$dist_dir/latest-beta-windows-x86_64.json")
  else
    optional+=("$dist_dir/latest-windows-x86_64.json")
  fi
fi

# Validation
missing_req=0
missing_opt=0

echo "=== Required Artifacts ==="
for file in "${required[@]}"; do
  if [[ -f "$file" ]]; then
    size=$(du -h "$file" | cut -f1)
    echo "  ✅ $(basename "$file")  ($size)"
  else
    echo "  ❌ $(basename "$file")  MISSING"
    missing_req=1
  fi
done

echo
echo "=== Optional Artifacts (updater) ==="
for file in "${optional[@]}"; do
  if [[ -f "$file" ]]; then
    size=$(du -h "$file" | cut -f1)
    echo "  ✅ $(basename "$file")  ($size)"
  else
    echo "  ⬚ $(basename "$file")  (not generated — requires signing key)"
    missing_opt=1
  fi
done

echo
if [[ $missing_req -ne 0 ]]; then
  echo "❌ Validation FAILED: missing required artifacts."
  exit 1
else
  echo "✅ All required artifacts present."
  if [[ $missing_opt -ne 0 ]]; then
    echo "⚠️  Some optional updater artifacts were not generated."
  fi
fi

# Print upload-ready file list for gh release upload
echo
echo "=== Uploadable Artifacts ==="
for file in "${required[@]}" "${optional[@]}"; do
  if [[ -f "$file" ]]; then
    echo "$file"
  fi
done

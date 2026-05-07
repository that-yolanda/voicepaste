#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <version> [--platforms mac-arm64,mac-x64,win-x64]" >&2
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

# Build artifact lists based on requested platforms
required=()
optional=()

if [[ -z "$platforms" ]]; then
  # All platforms
  required+=(
    "$dist_dir/VoicePaste-${version}-arm64.zip"
    "$dist_dir/VoicePaste-${version}-x64.zip"
    "$dist_dir/VoicePaste-${version}-win-x64.exe"
    "$dist_dir/latest-mac.yml"
    "$dist_dir/latest.yml"
  )
  optional+=(
    "$dist_dir/VoicePaste-${version}-arm64.zip.blockmap"
    "$dist_dir/VoicePaste-${version}-x64.zip.blockmap"
    "$dist_dir/VoicePaste-${version}-win-x64.exe.blockmap"
  )
else
  IFS=',' read -ra plat_array <<< "$platforms"
  has_mac=false
  has_win=false

  for p in "${plat_array[@]}"; do
    case "$p" in
      mac-arm64)
        required+=("$dist_dir/VoicePaste-${version}-arm64.zip")
        optional+=("$dist_dir/VoicePaste-${version}-arm64.zip.blockmap")
        has_mac=true
        ;;
      mac-x64)
        required+=("$dist_dir/VoicePaste-${version}-x64.zip")
        optional+=("$dist_dir/VoicePaste-${version}-x64.zip.blockmap")
        has_mac=true
        ;;
      win-x64)
        required+=("$dist_dir/VoicePaste-${version}-win-x64.exe")
        optional+=("$dist_dir/VoicePaste-${version}-win-x64.exe.blockmap")
        has_win=true
        ;;
      *)
        echo "Unknown platform: $p" >&2
        exit 1
        ;;
    esac
  done

  if [[ "$has_mac" == true ]]; then
    required+=("$dist_dir/latest-mac.yml")
  fi
  if [[ "$has_win" == true ]]; then
    required+=("$dist_dir/latest.yml")
  fi
fi

missing=0

for file in "${required[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "Missing required artifact: $file" >&2
    missing=1
  fi
done

if [[ $missing -ne 0 ]]; then
  exit 1
fi

echo "Required artifacts:"
for file in "${required[@]}"; do
  echo "$file"
done

echo
echo "Optional artifacts:"
for file in "${optional[@]}"; do
  if [[ -f "$file" ]]; then
    echo "$file"
  fi
done

#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <version>" >&2
  exit 1
fi

version="$1"
root_dir="$(git rev-parse --show-toplevel)"
dist_dir="$root_dir/dist"

required=(
  "$dist_dir/VoicePaste-${version}-arm64.zip"
  "$dist_dir/VoicePaste-${version}-win-x64.exe"
  "$dist_dir/latest-mac.yml"
  "$dist_dir/latest.yml"
)

optional=(
  "$dist_dir/VoicePaste-${version}-arm64.zip.blockmap"
  "$dist_dir/VoicePaste-${version}-win-x64.exe.blockmap"
)

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

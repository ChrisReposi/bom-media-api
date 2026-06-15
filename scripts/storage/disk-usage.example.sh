#!/usr/bin/env bash
set -euo pipefail

ROOT="${LOCAL_FILE_STORAGE_ROOT:-}"
WARNING_PERCENT="${LOCAL_FILE_DISK_WARNING_PERCENT:-70}"
CRITICAL_PERCENT="${LOCAL_FILE_DISK_CRITICAL_PERCENT:-85}"

if [[ -z "$ROOT" ]]; then
  echo "Set LOCAL_FILE_STORAGE_ROOT to a private storage root placeholder/path." >&2
  exit 1
fi

if [[ "$ROOT" == "/" || "$ROOT" == *"/public_html"* || "$ROOT" == *"/htdocs"* || "$ROOT" == *"/www"* || "$ROOT" == *"/public"* || "$ROOT" == *"/dist"* ]]; then
  echo "Refusing unsafe LOCAL_FILE_STORAGE_ROOT: $ROOT" >&2
  exit 1
fi

echo "Storage root:"
du -sh "$ROOT" 2>/dev/null || true

echo "Videos:"
du -sh "$ROOT/videos" 2>/dev/null || true

echo "Temporary uploads:"
du -sh "$ROOT/tmp/uploads" 2>/dev/null || true

echo "Available disk:"
df -h "$ROOT"

USED_PERCENT="$(df -P "$ROOT" | awk 'NR==2 { gsub("%", "", $5); print $5 }')"
if [[ -n "$USED_PERCENT" ]]; then
  if (( USED_PERCENT >= CRITICAL_PERCENT )); then
    echo "CRITICAL: disk usage is ${USED_PERCENT}% (critical threshold ${CRITICAL_PERCENT}%). Block large uploads until storage is reclaimed."
  elif (( USED_PERCENT >= WARNING_PERCENT )); then
    echo "WARNING: disk usage is ${USED_PERCENT}% (warning threshold ${WARNING_PERCENT}%). Review purge/temp cleanup and backup growth."
  else
    echo "OK: disk usage is ${USED_PERCENT}%."
  fi
fi

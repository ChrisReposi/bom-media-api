#!/usr/bin/env bash
set -euo pipefail

ROOT="${LOCAL_FILE_STORAGE_ROOT:-}"
ARCHIVE="${LOCAL_FILE_RESTORE_ARCHIVE:-}"
CONFIRM="${CONFIRM_RESTORE_LOCAL_FILES:-false}"

if [[ -z "$ROOT" || -z "$ARCHIVE" ]]; then
  echo "Set LOCAL_FILE_STORAGE_ROOT and LOCAL_FILE_RESTORE_ARCHIVE." >&2
  exit 1
fi

if [[ "$ROOT" == "/" || "$ROOT" == *"/public_html"* || "$ROOT" == *"/htdocs"* || "$ROOT" == *"/www"* || "$ROOT" == *"/public"* || "$ROOT" == *"/dist"* ]]; then
  echo "Refusing unsafe LOCAL_FILE_STORAGE_ROOT: $ROOT" >&2
  exit 1
fi

echo "Would restore archive:"
echo "  $ARCHIVE"
echo "into:"
echo "  $ROOT"

if [[ "$CONFIRM" != "true" ]]; then
  echo "Dry run only. Set CONFIRM_RESTORE_LOCAL_FILES=true to extract."
  exit 0
fi

mkdir -p "$ROOT"
tar -xzf "$ARCHIVE" -C "$ROOT"
echo "Restore extraction completed. Run the restore smoke test before using this environment."

#!/usr/bin/env bash
set -euo pipefail

ROOT="${LOCAL_FILE_STORAGE_ROOT:-}"
DB_KEYS_FILE="${LOCAL_FILE_DB_KEYS_FILE:-}"

if [[ -z "$ROOT" || -z "$DB_KEYS_FILE" ]]; then
  echo "Set LOCAL_FILE_STORAGE_ROOT and LOCAL_FILE_DB_KEYS_FILE." >&2
  echo "LOCAL_FILE_DB_KEYS_FILE should contain one relative storageKey per line exported from the database." >&2
  exit 1
fi

if [[ "$ROOT" == "/" || "$ROOT" == *"/public_html"* || "$ROOT" == *"/htdocs"* || "$ROOT" == *"/www"* || "$ROOT" == *"/public"* || "$ROOT" == *"/dist"* ]]; then
  echo "Refusing unsafe LOCAL_FILE_STORAGE_ROOT: $ROOT" >&2
  exit 1
fi

ROOT_REAL="$(cd "$ROOT" && pwd -P)"
VIDEOS_DIR="$ROOT_REAL/videos"

TMP_FILES="$(mktemp)"
TMP_KEYS="$(mktemp)"
trap 'rm -f "$TMP_FILES" "$TMP_KEYS"' EXIT

if [[ -d "$VIDEOS_DIR" ]]; then
  while IFS= read -r file_path; do
    case "$file_path" in
      "$ROOT_REAL"/*) printf '%s\n' "${file_path#"$ROOT_REAL"/}" ;;
    esac
  done < <(find "$VIDEOS_DIR" -type f -print 2>/dev/null) | sort > "$TMP_FILES"
else
  : > "$TMP_FILES"
fi

sort "$DB_KEYS_FILE" > "$TMP_KEYS"

echo "Files under videos/ that are not present in LOCAL_FILE_DB_KEYS_FILE:"
comm -23 "$TMP_FILES" "$TMP_KEYS" || true

echo "Database keys that do not have a matching file:"
comm -13 "$TMP_FILES" "$TMP_KEYS" || true

echo "Review only. This script does not delete files."

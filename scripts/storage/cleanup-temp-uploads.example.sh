#!/usr/bin/env bash
set -euo pipefail

ROOT="${LOCAL_FILE_STORAGE_ROOT:-}"
MAX_AGE_HOURS="${LOCAL_VIDEO_STALE_UPLOAD_MAX_AGE_HOURS:-24}"
CONFIRM="${CONFIRM_DELETE_TEMP_UPLOADS:-false}"
MODE="${1:---dry-run}"

if [[ "$MODE" != "--dry-run" && "$MODE" != "--delete" ]]; then
  echo "Usage: $0 [--dry-run|--delete]" >&2
  exit 1
fi

if [[ -z "$ROOT" ]]; then
  echo "Set LOCAL_FILE_STORAGE_ROOT." >&2
  exit 1
fi

if [[ "$ROOT" == "/" || "$ROOT" == *"/public_html"* || "$ROOT" == *"/htdocs"* || "$ROOT" == *"/www"* || "$ROOT" == *"/public"* || "$ROOT" == *"/dist"* ]]; then
  echo "Refusing unsafe LOCAL_FILE_STORAGE_ROOT: $ROOT" >&2
  exit 1
fi

TARGET="$ROOT/tmp/uploads"

if [[ ! -d "$TARGET" ]]; then
  echo "No temp upload directory found: $TARGET"
  exit 0
fi

ROOT_REAL="$(cd "$ROOT" && pwd -P)"
TARGET_REAL="$(cd "$TARGET" && pwd -P)"

case "$TARGET_REAL" in
  "$ROOT_REAL"/tmp/uploads) ;;
  *)
    echo "Refusing target outside LOCAL_FILE_STORAGE_ROOT/tmp/uploads: $TARGET_REAL" >&2
    exit 1
    ;;
esac

echo "Temp upload directories older than ${MAX_AGE_HOURS}h under:"
echo "  $TARGET"

CANDIDATES="$(mktemp)"
trap 'rm -f "$CANDIDATES"' EXIT

find "$TARGET" -mindepth 1 -maxdepth 1 -type d -mmin "+$((MAX_AGE_HOURS * 60))" -print > "$CANDIDATES"

if [[ ! -s "$CANDIDATES" ]]; then
  echo "No stale temp upload directories found."
  exit 0
fi

cat "$CANDIDATES"

echo "Estimated reclaim size:"
while IFS= read -r candidate; do
  du -sh "$candidate" 2>/dev/null || true
done < "$CANDIDATES"

if [[ "$MODE" != "--delete" ]]; then
  echo "Dry run only. Re-run with --delete and CONFIRM_DELETE_TEMP_UPLOADS=true to delete listed directories."
  exit 0
fi

if [[ "$CONFIRM" != "true" ]]; then
  echo "Delete mode requested, but CONFIRM_DELETE_TEMP_UPLOADS=true is required." >&2
  exit 1
fi

while IFS= read -r candidate; do
  candidate_real="$(cd "$candidate" && pwd -P)"

  case "$candidate" in
    "$TARGET"/*)
      case "$candidate_real" in
        "$TARGET_REAL"/*) rm -rf "$candidate_real" ;;
        *)
          echo "Skipping unsafe candidate outside temp uploads: $candidate_real" >&2
          ;;
      esac
      ;;
    *)
      echo "Skipping unsafe candidate outside temp uploads: $candidate" >&2
      ;;
  esac
done < "$CANDIDATES"

echo "Deleted stale temp upload directories listed by this run."

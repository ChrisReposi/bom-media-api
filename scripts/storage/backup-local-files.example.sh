#!/usr/bin/env bash
set -euo pipefail

ROOT="${LOCAL_FILE_STORAGE_ROOT:-}"
BACKUP_DEST="${BACKUP_DEST:-}"
RUN_BACKUP="${RUN_BACKUP:-false}"

if [[ -z "$ROOT" || -z "$BACKUP_DEST" ]]; then
  echo "Set LOCAL_FILE_STORAGE_ROOT and BACKUP_DEST. This template uses placeholders only." >&2
  exit 1
fi

if [[ "$ROOT" == "/" || "$ROOT" == *"/public_html"* || "$ROOT" == *"/htdocs"* || "$ROOT" == *"/www"* || "$ROOT" == *"/public"* || "$ROOT" == *"/dist"* ]]; then
  echo "Refusing unsafe LOCAL_FILE_STORAGE_ROOT: $ROOT" >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="$BACKUP_DEST/local-files-$STAMP.tar.gz"

echo "Would archive videos and local thumbnails from: $ROOT"
echo "Would write archive to: $ARCHIVE"
echo "Temporary uploads are excluded."

if [[ "$RUN_BACKUP" != "true" ]]; then
  echo "Dry run only. Set RUN_BACKUP=true to create the archive."
  exit 0
fi

mkdir -p "$BACKUP_DEST"
tar \
  --exclude="./tmp" \
  -czf "$ARCHIVE" \
  -C "$ROOT" \
  videos

echo "Created archive: $ARCHIVE"

#!/usr/bin/env bash
set -euo pipefail

# Example only. This script is not scheduled automatically.
# Required env vars:
#   DB_HOST
#   DB_PORT
#   DB_USER
#   DB_NAME
#   BACKUP_DIR
#
# It intentionally prompts for the database password instead of reading a
# committed value.

required_vars=(DB_HOST DB_PORT DB_USER DB_NAME BACKUP_DIR)

for var_name in "${required_vars[@]}"; do
  if [[ -z "${!var_name:-}" ]]; then
    echo "Missing required env var: ${var_name}" >&2
    exit 1
  fi
done

mkdir -p "${BACKUP_DIR}"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_path="${BACKUP_DIR}/${DB_NAME}-${timestamp}.sql"

mysqldump \
  --single-transaction \
  --routines \
  --triggers \
  --set-gtid-purged=OFF \
  --host "${DB_HOST}" \
  --port "${DB_PORT}" \
  --user "${DB_USER}" \
  --password \
  "${DB_NAME}" > "${backup_path}"

echo "Backup written to ${backup_path}"
echo "Copy this artifact to restricted off-site storage."


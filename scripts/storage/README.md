# Storage Script Templates

These scripts are examples for Hostinger/private NVMe LOCAL_FILE operations.

They are not scheduled jobs and they do not prove backups, cleanup, or monitoring are configured.

Rules:

- Use placeholders only in git.
- Export real paths and credentials only in the operator shell/session.
- Review every dry-run output before enabling a write/delete/restore action.
- Do not run against production during normal deploys unless an approved operator owns the action.

Scripts:

- `disk-usage.example.sh` prints storage usage, available disk, and warning/critical threshold messages.
- `backup-local-files.example.sh` creates a tar archive of LOCAL_FILE videos/thumbnails only when explicitly enabled.
- `restore-local-files.example.sh` is dry-run by default and requires explicit confirmation.
- `cleanup-temp-uploads.example.sh` only targets `tmp/uploads`, supports `--dry-run` and `--delete`, estimates reclaim size, and requires `CONFIRM_DELETE_TEMP_UPLOADS=true` before deletion.
- `find-orphan-local-files.example.sh` compares local files to an operator-supplied DB key export.

No script here backs up MySQL. Use the database backup runbook separately and coordinate timestamps.

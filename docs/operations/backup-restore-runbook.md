# Backup And Restore Runbook

## Purpose

Database backup and restore testing must be handled outside the API process before production deploys and before risky migrations.

This runbook is a guide. It does not mean a backup job or restore test already exists.

## Ownership And Frequency

- Owner: assign a named production operator before launch.
- Logical database backup: at least daily in production.
- Pre-migration backup: before every Prisma migration deploy.
- Off-site copy: required; do not keep the only backup inside the same hosting account.
- Restore test: at least monthly and before high-risk migrations.

## Manual Database Backup Steps

1. Confirm the API has no destructive maintenance job running.
2. Take a MySQL/MariaDB logical dump with credentials supplied by the operator environment, not hard-coded in scripts.
3. Store the dump in a restricted location.
4. Copy the dump to off-site storage.
5. Record backup timestamp, source database, operator, and artifact location outside git.

Example command shape:

```bash
mysqldump \
  --single-transaction \
  --routines \
  --triggers \
  --set-gtid-purged=OFF \
  --host "$DB_HOST" \
  --port "$DB_PORT" \
  --user "$DB_USER" \
  --password \
  "$DB_NAME" > "$BACKUP_PATH"
```

Do not include `.env` secrets in backup artifacts. Do not paste backup credentials into docs or logs.

## LOCAL_FILE Filesystem Backup Steps

Database backup alone is not sufficient when `LOCAL_FILE` videos exist.

Backup scope:

```txt
DATABASE_NAME
LOCAL_FILE_STORAGE_ROOT/videos
optional LOCAL_FILE_STORAGE_ROOT/quarantine if operators add one later
normally exclude LOCAL_FILE_STORAGE_ROOT/tmp
```

The live application stores final video files and local thumbnails under:

```txt
LOCAL_FILE_STORAGE_ROOT/videos/<videoId>/source/<uuid>.<ext>
LOCAL_FILE_STORAGE_ROOT/videos/<videoId>/thumbnails/<uuid>.<ext>
```

Coordinate the filesystem backup with the database backup so `VideoLocalFileAsset.storageKey` and `VideoLocalThumbnailAsset.storageKey` rows point to files from the same time window.

Manual steps:

1. Confirm no bulk purge or storage cleanup is running.
2. Record the database backup start time.
3. Run the logical database backup.
4. Archive `LOCAL_FILE_STORAGE_ROOT/videos`.
5. Exclude `LOCAL_FILE_STORAGE_ROOT/tmp` unless investigating a failed upload.
6. Copy both DB and file backups off-site.
7. Record DB backup timestamp, file backup timestamp, storage root, operator, and artifact locations outside git.

Template scripts under `scripts/storage/` can help create dry-run file backup commands, but they are not active jobs.

## Migration-Before-Backup Rule

Before migration:

- Take a backup of the current production database.
- Confirm backup file exists and is readable.
- Apply Prisma migration.
- Run smoke tests.

After successful migration:

- Take a fresh post-migration backup so rollback and restore procedures have both points available.

## Restore Test

1. Restore the latest database backup into staging or a disposable local database.
2. Restore the matching `LOCAL_FILE_STORAGE_ROOT/videos` backup into a test storage root.
3. Set `LOCAL_FILE_STORAGE_ROOT` to the restored test path.
4. Run Prisma migration status against the restored database.
5. Start the API against the restored database with non-production secrets.
6. Verify DB metadata and physical files together.
7. Verify:
   - admin login
   - refresh
   - logout
   - password change
   - video metadata list
   - LOCAL_FILE video metadata
   - physical files exist for sampled `storageKey` values
   - admin LOCAL_FILE preview
   - website/domain lookup
   - public watch
   - public LOCAL_FILE playback and thumbnails
   - purge safety rejects assigned/shared videos
8. Record evidence using the template below.

## Restore Evidence Template

```txt
Date:
Environment:
Backup source:
Restore target:
Backup timestamp:
Restore started:
Restore completed:
Restore duration:
API health result:
Admin login result:
Video metadata smoke test:
Website/domain smoke test:
Public watch smoke test:
LOCAL_FILE metadata smoke test:
LOCAL_FILE admin preview result:
LOCAL_FILE public playback result:
Thumbnail render result:
Issues:
Owner:
```

## Auth Migration Note

The admin-session migration is additive, but existing access tokens without `sid` are rejected after deploy. Plan a maintenance note telling admins to log in again.

## Local Video File Backup

The database should not contain large production video files. `LOCAL_FILE` videos store bytes on Hostinger/private NVMe storage while MySQL stores relative storage keys and metadata. File backups and DB backups must be coordinated. A restored database that points to missing video files is not a complete restore.

File backup evidence should include:

- file storage root
- file backup timestamp
- DB backup timestamp
- consistency window
- sample restored video playback result

See [Local File Video Storage](../architecture/local-file-video-storage.md) for storage-key and purge behavior.

Use the operations runbooks for production LOCAL_FILE storage:

- [Hostinger LOCAL_FILE Storage Runbook](./local-video-storage-runbook.md)
- [LOCAL_FILE Storage Smoke Test](./local-video-storage-smoke-test.md)

## Backup-Before-Cleanup Rule

Take both a DB backup and a filesystem backup before:

- Prisma migrations that touch video metadata.
- Bulk purge.
- Manual orphan cleanup.
- Temp upload cleanup beyond normal expired-session cleanup.
- Storage-root migration.

Purge/delete history changes restore expectations. If an operator intentionally purges a video after backup, restoring the old DB without restoring the old files may leave missing media.

After a purge batch, record the purge response storage summaries privately:

- `localVideoDeleteAttempted`
- `localVideoDeleted`
- `localThumbnailDeleteAttempted`
- `localThumbnailDeleted`
- `bytesReclaimed`
- `orphanCleanupRequired`

If any purge reports `orphanCleanupRequired=true`, do not run broad cleanup immediately. Compare the database state, filesystem backup, and dry-run orphan report first.

## Rollback Reminder

If rollback is needed, restore the previous API build first. Only restore the database backup after confirming the migration cannot safely coexist with the rolled-back code.

Do not run destructive restore commands against production unless the owner has approved the restore target and maintenance window.

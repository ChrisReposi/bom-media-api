# Hostinger LOCAL_FILE Storage Runbook

This runbook covers production operation of `VideoSourceType.LOCAL_FILE`, where video and thumbnail bytes live on private Hostinger NVMe/local disk and MySQL stores metadata plus relative storage keys only.

This document is operational guidance. It does not mean Hostinger folders, Cloudflare rules, backup jobs, restore tests, cron jobs, or monitoring have already been configured.

## Production Env Policy

Use the live env names implemented by `src/config/env.config.ts` and `src/config/env.validation.ts`.

```env
LOCAL_FILE_STORAGE_ENABLED=true
LOCAL_FILE_STORAGE_ROOT=/home/<hostinger-user>/bom-media-storage
LOCAL_VIDEO_UPLOAD_MAX_MB=500
LOCAL_VIDEO_UPLOAD_HARD_MAX_MB=1024
LOCAL_VIDEO_CHUNK_SIZE_MB=50
LOCAL_VIDEO_UPLOAD_SESSION_TTL_MINUTES=120
LOCAL_VIDEO_MIN_FREE_SPACE_MB=15360
LOCAL_VIDEO_STALE_UPLOAD_MAX_AGE_HOURS=24
LOCAL_THUMBNAIL_UPLOAD_MAX_MB=10

VIDEO_DB_STORAGE_ENABLED=false
VIDEO_DB_STORAGE_ALLOW_PRODUCTION_OVERRIDE=false
```

Rules:

- `LOCAL_FILE_STORAGE_ROOT` is required when `LOCAL_FILE_STORAGE_ENABLED=true`.
- Production storage root should be an absolute private path outside `public_html`, `htdocs`, `www`, `public`, `dist`, static assets, and git repos.
- The API validates obvious unsafe public web-root names, but operators still own the final Hostinger path review.
- Do not expose `LOCAL_FILE_STORAGE_ROOT` or absolute file paths through public URLs, logs, tickets, or docs.
- Keep at least 10GB-20GB free as an operating reserve. The example `LOCAL_VIDEO_MIN_FREE_SPACE_MB=15360` reserves roughly 15GB.
- 500MB per file is the default MVP production limit.
- 1GB per file is the hard ceiling and should be enabled only after staging upload, playback, backup, and restore tests.
- Keep chunk size below upstream body-size limits. `LOCAL_VIDEO_CHUNK_SIZE_MB=50` is the current default.
- `VIDEO_DB_STORAGE_ENABLED=false` and `VIDEO_DB_STORAGE_ALLOW_PRODUCTION_OVERRIDE=false` are required for normal production behavior. `DB_BLOB` is fallback only.

## Actual Storage Layout

The live storage service builds relative storage keys like this:

```txt
<LOCAL_FILE_STORAGE_ROOT>/
  videos/
    <videoId>/
      source/
        <uuid>.<ext>
      thumbnails/
        <uuid>.<ext>
  tmp/
    uploads/
      <uploadId>/
        chunk-0
        chunk-1
        chunk-2
```

Do not depend on absolute paths in client code. API responses expose safe URLs and metadata, not filesystem locations.

The implementation does not currently create separate `quarantine/` or `logs/` folders. Operators may add separate operations folders under the same parent if useful, but app-owned storage keys currently use `videos/...` and `tmp/uploads/...`.

## Storage Operating Model

Hostinger/private NVMe storage:

- Stores physical LOCAL_FILE video bytes and LOCAL_FILE thumbnails.
- Is private disk storage, not object storage and not a CDN.
- Requires disk monitoring, backup, restore testing, and cleanup procedures.

MySQL/MariaDB:

- Stores `VideoAsset`, `VideoLocalFileAsset`, `VideoLocalThumbnailAsset`, upload session rows, chunk metadata, permissions, share links, access logs, and audit logs.
- Stores relative `storageKey` values only.
- Must not store large production video bytes.

DB_BLOB:

- Remains a small fallback for local/testing.
- Must stay disabled in production unless a named emergency override is approved and documented.

Cloudinary/external storage:

- Legacy upload and thumbnail behavior may still exist for older videos.
- LOCAL_FILE thumbnail updates should use local storage, not Cloudinary.

## Upload Lifecycle

Admin Web should use the chunked local upload flow:

```txt
POST /api/v1/admin/videos/upload-local/init
POST /api/v1/admin/videos/upload-local/:uploadId/chunks
GET  /api/v1/admin/videos/upload-local/:uploadId
POST /api/v1/admin/videos/upload-local/:uploadId/complete
POST /api/v1/admin/videos/upload-local/:uploadId/cancel
```

Lifecycle:

1. Admin Web selects a video.
2. `init` validates filename, MIME type, total size, chunk count, chunk size, free-space reserve, and storage enablement.
3. Backend creates `VideoUploadSession` and a private temp key under `tmp/uploads/<uploadId>`.
4. Admin Web uploads one multipart `chunk` at a time.
5. Backend stores chunk files on disk and records `VideoUploadSessionChunk` rows.
6. `complete` verifies all chunks, streams chunks into the final local video file, deletes chunks after append, validates MP4/MOV/WebM magic bytes best-effort, probes duration best-effort, writes `VideoAsset + VideoLocalFileAsset`, and optionally writes `VideoLocalThumbnailAsset`.
7. Backend deletes the temp upload directory best-effort after success.

Failure handling expectations:

- `init` failure should leave no temp files.
- Chunk upload can be retried. Duplicate matching chunks are intended to be idempotent.
- `complete` rejects missing chunks.
- If final merge fails, the partial final file should be deleted best-effort.
- If DB write fails after file creation, file cleanup should be attempted and any remaining orphan must be reviewed manually.
- Thumbnail validation failure fails the request; SVG thumbnails are rejected.
- Expired sessions are marked `EXPIRED` and temp directories are cleaned opportunistically during local upload calls.
- Cancelled sessions are marked `ABORTED` and temp chunks are deleted best-effort.

## Thumbnail Policy

LOCAL_FILE thumbnails are stored on Hostinger/private storage:

- Upload during `complete` as multipart `thumbnailFile`, or replace later with `PATCH /api/v1/admin/videos/:id/thumbnail-local`.
- MySQL stores local thumbnail metadata and relative storage key.
- Admin/public clients use API-returned thumbnail URLs, not storage keys.
- Replacing a local thumbnail deletes the previous owned local thumbnail best-effort.
- SVG thumbnails are blocked.
- Allowed production image types should stay limited to safe raster formats, typically:
  - `image/jpeg`
  - `image/png`
  - `image/webp`
- `LOCAL_THUMBNAIL_UPLOAD_MAX_MB=10` is the maximum supported env value.

## Public Playback

LOCAL_FILE public playback is token-protected.

Public static sites should resolve share tokens with:

```txt
POST /api/v1/public/watch/exchange
```

Body:

```json
{
  "host": "example.com",
  "token": "<share-token>"
}
```

The older `GET /api/v1/public/watch?host=<host>&token=<share-token>` endpoint remains available as a compatibility fallback. Both endpoints use the same public validation path and return the same response shape.

Public watch returns safe media URLs for videos in valid share links. For LOCAL_FILE videos, current public URLs are API routes such as:

```txt
/api/v1/public/watch/:token/videos/:videoId/local-file?host=<host>
/api/v1/public/watch/:token/videos/:videoId/thumbnail?host=<host>
```

The public playback endpoint validates:

- public token
- host/domain
- active share link
- expiry/view rules
- video membership in the share link
- `READY` status
- `LOCAL_FILE` source type
- local file metadata and storage presence

Video streaming supports HTTP Range for browser seeking. Private media responses should use no-store headers unless a future signed-URL design explicitly changes caching.

Public static sites must not infer storage paths. They should use `publicPlaybackUrl` and `thumbnailUrl` returned by the API.

Normal video seeking can create many Range requests, especially when users drag backward/forward quickly. Do not apply the strict `PUBLIC_WATCH_THROTTLE_*` token metadata limits to media streaming. The backend uses a separate `PUBLIC_MEDIA_THROTTLE_*` profile for public media endpoints.

Public video view growth is separate from media streaming:

- Public sites call `POST /api/v1/public/watch/:token/videos/:videoId/view` once after playback starts.
- The endpoint validates host, token, share link, and video membership before updating `VideoAsset.viewCount`.
- It dedupes by hashed viewer/window and caps growth per video/hour.
- Range requests, thumbnail requests, and list/detail metadata loads must not increment `viewCount`.
- `publishedAt` is never advanced by view growth. Public clients compute relative labels from the stored original timestamp.

Cloudflare note:

- If public sites proxy `/api/v1/...` through `/_api/*`, ensure API media routes preserve `Range`, `Content-Range`, `Content-Length`, and `Content-Type`.
- If a future response uses `/_media/*`, the Worker or origin proxy must route `/_media/*` and preserve Range headers.
- Do not assume Worker changes are complete unless they are deployed and tested.
- Cloudflare should not cache private token media unless a future signed-URL design explicitly allows it.
- Local cross-origin testing may need route-specific CORP/CORS-friendly media headers. Production should prefer same-origin `/_api` or `/_media`.

## Purge And Reclaim

Soft disable:

- `DELETE /api/v1/admin/videos/:id`
- Hides/disables the video but keeps DB metadata and physical files.

Guarded purge:

- `POST /api/v1/admin/videos/:id/purge`
- Requires `confirmVideoId`.
- Rejects videos still assigned to websites or share links.
- Deletes the `VideoAsset` row.
- Deletes owned local video and thumbnail files best-effort.
- Returns a safe storage reclaim summary with `localVideoDeleted`, `localThumbnailDeleted`, `bytesReclaimed`, and `orphanCleanupRequired`.
- Writes an audit log with safe metadata, including delete attempts/results and reclaimed bytes.

Current purge response shape:

```json
{
  "message": "Video permanently deleted successfully.",
  "videoId": "cm_video_123",
  "sourceType": "LOCAL_FILE",
  "status": "PURGED",
  "safety": {
    "hadWebsiteAssignments": false,
    "hadShareLinks": false
  },
  "storage": {
    "localVideoDeleteAttempted": true,
    "localVideoDeleted": true,
    "localThumbnailDeleteAttempted": true,
    "localThumbnailDeleted": true,
    "bytesReclaimed": "524298240",
    "orphanCleanupRequired": false
  },
  "remote": {
    "remoteAssetDeleteAttempted": false,
    "remoteAssetDeleted": false
  }
}
```

The response does not expose absolute paths, storage root, or raw storage keys. If `orphanCleanupRequired=true`, use private operator notes, backups, and the dry-run orphan review flow before any manual cleanup.

Purge must never:

- Delete files outside `LOCAL_FILE_STORAGE_ROOT`.
- Follow unsafe paths.
- Be used as a normal disable action.
- Be run without a backup if the operator may need recovery.

Reclaim verification examples:

```bash
du -sh /home/<hostinger-user>/bom-media-storage
du -sh /home/<hostinger-user>/bom-media-storage/videos
du -sh /home/<hostinger-user>/bom-media-storage/tmp
```

Use placeholders only in docs and tickets. Record real paths in private operational systems, not git.

## Cleanup And Orphan Review

Expected cleanup categories:

- stale temp upload sessions
- temp chunks older than session TTL
- final files without DB metadata
- DB metadata pointing to missing files
- orphan thumbnails after replacement

The backend opportunistically cleans expired upload sessions during local upload operations. That is not a full storage audit. Operators should run periodic dry-run reviews and only delete after DB metadata has been checked.

Safe script templates are under `scripts/storage/`. They are not scheduled jobs.

Recommended dry-run sequence:

```bash
LOCAL_FILE_STORAGE_ROOT=/home/<hostinger-user>/bom-media-storage \
  scripts/storage/disk-usage.example.sh

LOCAL_FILE_STORAGE_ROOT=/home/<hostinger-user>/bom-media-storage \
LOCAL_VIDEO_STALE_UPLOAD_MAX_AGE_HOURS=24 \
  scripts/storage/cleanup-temp-uploads.example.sh --dry-run

LOCAL_FILE_STORAGE_ROOT=/home/<hostinger-user>/bom-media-storage \
LOCAL_FILE_DB_KEYS_FILE=/path/to/exported-local-storage-keys.txt \
  scripts/storage/find-orphan-local-files.example.sh
```

Deletion mode for temp uploads requires both `--delete` and `CONFIRM_DELETE_TEMP_UPLOADS=true`. Do not schedule cleanup until dry-run output has been reviewed and backups exist.

## Health And Monitoring

Recommended checks:

- total storage root disk usage
- `videos/` size growth
- `tmp/uploads/` growth
- free-space reserve
- inode usage if Hostinger exposes it
- failed `COMPLETING` or old `ACTIVE` upload sessions
- orphan file review
- backup archive size growth
- access/audit log growth

Suggested thresholds:

- warn at 70% disk usage
- block or alert at 80%-85% disk usage
- always keep at least `LOCAL_VIDEO_MIN_FREE_SPACE_MB` free
- investigate temp uploads older than `LOCAL_VIDEO_STALE_UPLOAD_MAX_AGE_HOURS`

No monitoring is configured by this runbook. Operators must wire alerts in Hostinger, Cloudflare, uptime tooling, or external monitoring separately.

## Operator Actions Before Production

- Create private `LOCAL_FILE_STORAGE_ROOT` outside public web root.
- Ensure API process user can read/write the storage root.
- Configure production env with local storage enabled and DB_BLOB disabled.
- Confirm Cloudflare/origin route preserves Range headers.
- Configure DB backups and filesystem backups together.
- Run a restore test that includes both DB metadata and local files.
- Run the local video storage smoke test in staging.
- Decide whether to keep 500MB or enable the 1GB hard ceiling after evidence.

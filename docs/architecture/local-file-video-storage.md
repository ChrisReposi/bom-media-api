# Local File Video Storage

Production large-video storage uses private Hostinger NVMe/local disk, not MySQL. MySQL stores metadata, relative storage keys, upload-session state, permissions, and audit logs only.

## Storage Policy

- `VideoSourceType.LOCAL_FILE` represents videos stored on private local disk.
- Physical video bytes live under `LOCAL_FILE_STORAGE_ROOT`.
- Database rows store relative `storageKey` values only. Absolute filesystem paths must never be returned by API responses.
- The storage root must be outside any public web root such as `public_html`, `htdocs`, `www`, `public`, or `dist`.
- `DB_BLOB` remains a small fallback only and should stay disabled in production.

## Environment

```env
LOCAL_FILE_STORAGE_ENABLED=true
LOCAL_FILE_STORAGE_ROOT=/home/<user>/bom-media-storage
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

`LOCAL_VIDEO_UPLOAD_MAX_MB` defaults to 500MB. The hard ceiling is 1GB and should only be used after staging tests confirm Cloudflare/origin behavior and disk capacity.

## Prisma Models

- `VideoLocalFileAsset` stores the final local video `storageKey`, original filename, MIME type, size, and checksum.
- `VideoLocalThumbnailAsset` stores local thumbnail metadata.
- `VideoUploadSession` stores chunked upload lifecycle state.
- `VideoUploadSessionChunk` stores received chunk metadata.
- `VideoBinaryAsset` remains for legacy `DB_BLOB` fallback compatibility.

## Admin Upload Contract

Chunked local upload endpoints:

```txt
POST /api/v1/admin/videos/upload-local/init
POST /api/v1/admin/videos/upload-local/:uploadId/chunks
GET  /api/v1/admin/videos/upload-local/:uploadId
POST /api/v1/admin/videos/upload-local/:uploadId/complete
POST /api/v1/admin/videos/upload-local/:uploadId/cancel
```

`init` validates filename, MIME type, total bytes, chunk count, configured limits, and free-space policy. It creates a temporary upload session and returns progress metadata.

`chunks` accepts one multipart `chunk` at a time using disk-backed Multer temp files. The service validates chunk index and expected size, stores the chunk under the private temp upload directory, and records the chunk in MySQL. Duplicate chunks with the same metadata are idempotent.

`complete` verifies all chunks, streams them into the final video file, deletes chunks after append, probes duration best-effort, creates `VideoAsset + VideoLocalFileAsset`, stores an optional local `thumbnailFile`, and removes the temp upload directory.

`cancel` is idempotent and marks the upload aborted while deleting temp chunks best-effort.

## Admin Preview And Thumbnail

```txt
GET   /api/v1/admin/videos/:id/local-file
GET   /api/v1/admin/videos/:id/thumbnail
PATCH /api/v1/admin/videos/:id/thumbnail-local
```

Admin local-file preview is Bearer-token protected and supports HTTP Range. Thumbnail replacement stores image bytes on local NVMe, rejects SVG, and deletes the old owned local thumbnail best-effort.

## Public Playback Contract

Public watch responses for `LOCAL_FILE` videos include a token-protected `publicPlaybackUrl`:

```json
{
  "sourceType": "LOCAL_FILE",
  "playbackUrl": null,
  "publicPlaybackUrl": "/api/v1/public/watch/<token>/videos/<videoId>/local-file?host=<host>",
  "localFileAsset": {
    "mimeType": "video/mp4",
    "sizeBytes": "524288000"
  }
}
```

Public playback routes:

```txt
GET /api/v1/public/watch/:token/videos/:videoId/local-file?host=<host>
GET /api/v1/public/watch/:token/videos/:videoId/thumbnail?host=<host>
```

The public routes validate token, host/domain, active share link, expiry/view rules, video membership, `READY` status, source type, and local file presence. Video streaming supports HTTP Range and returns no-store cache headers.

Public display views are not counted from these media routes. Browser playback and seeking can create many Range requests, so view growth uses a separate endpoint:

```txt
POST /api/v1/public/watch/:token/videos/:videoId/view
```

The static public site should call this endpoint once after real playback starts. The endpoint validates the same public watch context, dedupes by hashed viewer/window, caps per-event and per-hour growth, and updates `VideoAsset.viewCount`. `publishedAt` remains immutable and clients render relative labels from the original timestamp.

## Purge And Cleanup

`DELETE /api/v1/admin/videos/:id` remains a soft disable.

`POST /api/v1/admin/videos/:id/purge` remains the guarded permanent purge route. It still requires `confirmVideoId`, rejects videos assigned to websites/share links, deletes the database row, and now deletes owned local video/thumbnail files best-effort.

Expired upload sessions are cleaned opportunistically during local upload init/chunk/complete/cancel calls. If physical cleanup fails, logs contain safe metadata only; operators should inspect the private storage tree manually and remove orphaned files after verifying no matching database metadata remains.

## Backup Implications

Database backup alone is not sufficient for `LOCAL_FILE` videos. Operators must coordinate:

- MySQL logical backup.
- Private local storage backup for `LOCAL_FILE` videos and thumbnails.
- Restore tests that verify metadata and physical files match the same point in time.

Do not store production large video bytes in MySQL.

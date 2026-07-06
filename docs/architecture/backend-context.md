# Backend Context — BOM Media API

## Product Shape

BOM Media API is a centralized backend for many branded static public websites and one production Admin Web.

## Production Admin Surface

Only Admin Web should manage uploads, videos, websites, domains, domain groups, share links, settings, and admin profile/password.

Public websites must not include production mini-admin logic.

## Public Website Shape

Public static sites should only render public pages, read share tokens, call public watch API, render allowed private videos for valid tokens, show generic invalid states, never store admin credentials, and never call admin write APIs.

## Public Display Views

- `VideoAsset.viewCount` is the mutable public display counter. Admins can set the initial/base value, and the public record-view endpoint can grow it over time.
- `VideoAsset.publishedAt` is the original publish date/time. It must not be mutated for relative labels; clients compute labels such as `1 day ago` or `3 months ago` at display time.
- `VideoAsset.filterKey` is an optional admin-only grouping key for list filtering, such as `sml`, `msa`, or `judge_judy`. Existing videos can keep `filterKey=null`; public watch responses do not expose this key.
- Public video view growth is recorded through `POST /api/v1/public/watch/:token/videos/:videoId/view` after playback starts.
- Media Range requests, thumbnails, and public watch metadata loads must not increment video views.
- View growth is deduped by hashed viewer/window and capped per video/hour. No raw IPs, raw tokens, or storage paths are returned.

## Video Storage Direction

- MySQL is not the large video storage layer.
- Hostinger/private NVMe local file storage is the production large-video path.
- MySQL stores relative storage keys, metadata, permissions, upload sessions, and audit logs.
- Backend streams videos through protected endpoints.
- Range requests are required for large video playback.
- See [Local File Video Storage](./local-file-video-storage.md) for the `LOCAL_FILE` upload, preview, public playback, purge, and backup contract.

## Video Disable and Purge Safety

- Disabling a video also disables related active share links. Share links are not automatically reactivated if the video later returns to `READY`.
- Permanent purge requires `VideoAsset.status=DISABLED` first and still requires explicit purge confirmation.
- Purge blocks active website assignments, disables related active share links, detaches `ShareLinkVideo` rows for the purged video, and then deletes the video metadata/files best-effort.
- Public watch errors remain generic after share links are disabled by video disable or purge; public responses must not reveal whether a token existed.

## Process-Local In-Memory Cache

- The API can use an optional dependency-free in-memory TTL/LRU cache for read-heavy metadata.
- The cache is process-local, cleared on restart, and not shared across Hostinger Node processes.
- MySQL remains the source of truth; cache misses or disabled cache mode fall back to normal database reads.
- Cached admin metadata currently includes admin video list/search responses and admin website list responses.
- Cached media data is metadata only, such as local storage key, MIME type, size, checksum/version, and update timestamp.
- The cache must never store video buffers, thumbnail buffers, readable streams, HTTP Range responses, raw JWTs, refresh tokens, authorization headers, raw share tokens, passwords, or secrets.
- Cache keys use readable prefixes and hash token-like or long user-controlled values. Public share token/code values must never appear raw in cache keys.
- Public watch metadata has stricter rules because resolve operations validate domain/share-link/video membership, enforce expiry and max-view limits, increment `ShareLink.currentViews`, and write access logs.
- Public watch cache entries are short-lived, successful metadata projections only. Invalid, revoked, expired, or max-view-limited share links are not cached.
- Public watch cache hits must still rebuild token-bearing media URLs for the current request and preserve the required current-view/access-log side effects.
- Identical admin list/media metadata reads may use short in-flight dedupe. Public watch requests avoid broad in-flight dedupe unless side effects are preserved.

## Security Direction

Immediate focus:

- harden login/session/refresh/logout
- rate limit auth/public watch
- protect admin-web behind Cloudflare Access
- disable public docs
- tune DB pool
- backup/restore validation
- reduce token leakage
- audit important auth events

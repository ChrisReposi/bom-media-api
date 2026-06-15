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

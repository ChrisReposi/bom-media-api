# Environment Security Checklist

This policy is for production env review. Values below are placeholders only.

## Production Required Baseline

```env
NODE_ENV=production
APP_ENV=production

API_INTERNAL_DOCS_ENABLED=false
API_DOCS_ALLOW_IN_PRODUCTION=false

VIDEO_DB_STORAGE_ENABLED=false
VIDEO_DB_STORAGE_ALLOW_PRODUCTION_OVERRIDE=false

ADMIN_REGISTER_ENABLED=false
```

Production `/docs` must not be exposed. Even if `API_INTERNAL_DOCS_ENABLED=true`, the API must not mount Swagger in production unless `API_DOCS_ALLOW_IN_PRODUCTION=true`.

## Secrets To Rotate Before Production

- `CLOUDINARY_API_SECRET`
- `JWT_ACCESS_SECRET`
- `REFRESH_TOKEN_PEPPER`
- `SHARE_TOKEN_PEPPER`
- `ACCESS_LOG_IP_PEPPER`
- `ADMIN_REGISTER_SECRET`
- `ADMIN_CHANGE_PASSWORD_SECRET`

Use placeholders in examples:

```env
JWT_ACCESS_SECRET=<rotate-before-production>
REFRESH_TOKEN_PEPPER=<rotate-before-production>
SHARE_TOKEN_PEPPER=<rotate-before-production>
ACCESS_LOG_IP_PEPPER=<rotate-before-production>
ADMIN_REGISTER_SECRET=<rotate-before-production>
ADMIN_CHANGE_PASSWORD_SECRET=<rotate-before-production>
CLOUDINARY_API_SECRET=<rotate-in-cloudinary-dashboard-first>
```

## Deprecated/Confusing Variables

Refresh tokens are opaque and hash-only in MySQL. Do not use `JWT_REFRESH_SECRET` or `JWT_REFRESH_EXPIRES_IN`; remove them from runtime env when safe.

## Docs

Production docs should be disabled. To enable docs in production for an emergency internal deployment, require a second explicit override:

```env
API_DOCS_ALLOW_IN_PRODUCTION=true
```

Prefer Cloudflare Access/IP allowlisting for production docs if ever enabled.

## Database

Recommended conservative production defaults:

```env
DB_CONNECTION_LIMIT=3
DB_CONNECT_TIMEOUT_MS=10000
DB_ACQUIRE_TIMEOUT_MS=10000
DB_IDLE_TIMEOUT_SECONDS=60
```

Tune based on real Hostinger/MySQL limits.

## CORS And Origins

Admin Web and API self-origin must be explicit trusted origins. Public website origins may be loaded from active assigned website domains when DB-backed CORS is enabled.

```env
ADMIN_WEB_ORIGIN=https://admin.example.com
API_SELF_ORIGIN=https://api.example.com
CORS_ALLOWED_ORIGINS=https://admin.example.com,https://api.example.com
CORS_ALLOW_DB_DOMAINS=true
CORS_DB_ORIGIN_CACHE_TTL_MS=60000
CORS_ALLOW_LOCALHOST_DB_DOMAINS=false
```

Dynamic CORS is not authorization. Public watch must still validate host, token, share-link status, expiry, view limits, and video membership.

## Trust Proxy

If behind Cloudflare/Hostinger reverse proxy:

```env
TRUST_PROXY_ENABLED=true
TRUST_PROXY_HOPS=1
TRUST_PROXY_CLOUDFLARE_ONLY=false
```

Only trust forwarded IP headers when the deployment ensures requests reach API through trusted proxy.

Do not enable `TRUST_PROXY_CLOUDFLARE_ONLY=true` until raw origin access is blocked or controlled.

## Video DB Storage

Production:

```env
VIDEO_DB_STORAGE_ENABLED=false
VIDEO_DB_STORAGE_ALLOW_PRODUCTION_OVERRIDE=false
```

Local/testing only:

```env
VIDEO_DB_STORAGE_ENABLED=true
VIDEO_DB_UPLOAD_MAX_MB=100
```

DB_BLOB is a small fallback only. It is not the production large-video storage path.

Public watch errors must remain generic and token endpoints should use no-store cache headers.

## Hostinger NVMe File Storage

Production large-video upload mode:

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
```

Keep storage outside public web root.

Hostinger/private NVMe local-file storage stores bytes on disk and relative storage keys in MySQL. DB backups and file backups must be coordinated so metadata and files restore to the same point in time.

Production policy:

- `LOCAL_FILE_STORAGE_ROOT` must be a private absolute path, for example `/home/<hostinger-user>/bom-media-storage`.
- Do not place it under `public_html`, `htdocs`, `www`, `public`, `dist`, static asset folders, or a git repo.
- Do not expose the root or absolute paths through API responses, logs, support tickets, or public docs.
- 500MB is the default upload limit.
- 1GB is a hard ceiling and requires staging evidence before production use.
- `LOCAL_VIDEO_CHUNK_SIZE_MB` must stay under Cloudflare/upstream request body limits.
- `LOCAL_VIDEO_MIN_FREE_SPACE_MB` should preserve at least 10GB-20GB.
- `VIDEO_DB_STORAGE_ENABLED=false` must remain the production default.
- `PUBLIC_MEDIA_THROTTLE_LIMIT` should be materially higher than `PUBLIC_WATCH_THROTTLE_LIMIT` so normal Range seeking does not exhaust token metadata limits.
- Run `scripts/storage/disk-usage.example.sh` during staging checks and after large purge batches. Treat 70% disk usage as warning and 80%-85% as critical/block-new-uploads territory.
- Run temp/orphan cleanup scripts in dry-run mode first. Do not delete files until DB + filesystem backups exist and candidate paths are reviewed.

## Public Display View Growth

```env
VIDEO_VIEW_GROWTH_ENABLED=false
VIDEO_VIEW_MAX_INCREMENT_PER_EVENT=99
VIDEO_VIEW_MAX_INCREMENT_PER_VIDEO_HOUR=5000
VIDEO_VIEW_DEDUPE_WINDOW_MINUTES=15
VIDEO_VIEW_MIN_WATCH_SECONDS=5
VIDEO_VIEW_RANDOM_MIN_INCREMENT=1
```

- Enable `VIDEO_VIEW_GROWTH_ENABLED=true` only when operators want backend-managed public display counters to grow from real public playback starts.
- `VIDEO_VIEW_MAX_INCREMENT_PER_EVENT` must stay `<=99`.
- `VIDEO_VIEW_MAX_INCREMENT_PER_VIDEO_HOUR` caps per-video growth and protects the database from runaway public traffic.
- `VIDEO_VIEW_DEDUPE_WINDOW_MINUTES` prevents the same hashed viewer/video from incrementing repeatedly during short replay/seek loops.
- Do not count media Range requests, thumbnail requests, or public watch metadata loads as video views.
- `VideoAsset.publishedAt` is immutable original publish time; clients compute relative labels at display time.

See:

- [Local File Video Storage](../architecture/local-file-video-storage.md)
- [Hostinger LOCAL_FILE Storage Runbook](../operations/local-video-storage-runbook.md)
- [LOCAL_FILE Storage Smoke Test](../operations/local-video-storage-smoke-test.md)

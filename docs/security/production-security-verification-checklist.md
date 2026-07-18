# Production Security Verification Checklist

Use this after deploying auth/security changes, rotating secrets, changing Cloudflare rules, or modifying production env. Record evidence outside git.

## Auth Flow

- [ ] Login succeeds for an active admin through Admin Web.
- [ ] Invalid credentials return a generic auth failure.
- [ ] Repeated invalid login attempts eventually return `429 Too Many Requests`.
- [ ] Refresh returns a new access token and rotates the refresh token.
- [ ] Reusing an old refresh token is rejected.
- [ ] Two concurrent refresh requests produce at most one rotation and revoke the replayed session/token family.
- [ ] Refresh-token replay creates a safe audit event without raw token values.
- [ ] Logout is idempotent and generic.
- [ ] Logout revokes the active server-side admin session.
- [ ] An access token issued before logout fails on protected admin endpoints.
- [ ] Password change succeeds for an active admin.
- [ ] Password change revokes active sessions and refresh tokens.
- [ ] STAFF mutations and ADMIN permanent purge return `403`; OWNER purge still requires explicit confirmation.
- [ ] An access token issued before password change fails on protected admin endpoints.

## Docs And Admin Surface

- [ ] `/docs` is not mounted in production when `API_DOCS_ALLOW_IN_PRODUCTION` is false or absent.
- [ ] `API_INTERNAL_DOCS_ENABLED=false` in production.
- [ ] Admin Web is the only production admin UI.
- [ ] Public websites do not contain production mini-admin logic or admin write API calls.
- [ ] Cloudflare Access protects the admin-web hostname before users reach React Admin Web.

## Public Watch

- [ ] Valid public watch link returns assigned videos.
- [ ] Invalid token response is generic and does not reveal whether token, host, expiry, or revocation caused failure.
- [ ] Public watch responses include no-store cache headers.
- [ ] Public DB_BLOB binary playback, if enabled in non-production, uses token-protected public URLs, not admin binary URLs.
- [ ] `VIDEO_DB_STORAGE_ENABLED=false` in production.
- [ ] Public video view growth endpoint increments `VideoAsset.viewCount` only after playback starts.
- [ ] Public view growth dedupes the same hashed viewer/video/window.
- [ ] Media Range requests, thumbnails, and public watch metadata requests do not increment `viewCount`.
- [ ] `publishedAt` remains the original admin-entered value and relative labels are computed at display time.

## Throttling

- [ ] `/api/v1/admin/auth/login` throttles under repeated abuse.
- [ ] `/api/v1/admin/auth/refresh` throttles under repeated abuse.
- [ ] `/api/v1/admin/auth/logout` throttles under repeated abuse without breaking normal logout.
- [ ] `/api/v1/public/watch*` throttles suspicious request rates without blocking expected customer traffic.
- [ ] App-side throttling remains enabled even when Cloudflare WAF/rate limits exist.

## Logging And Audit Safety

- [ ] Pino logs redact authorization headers.
- [ ] Logs do not contain passwords, raw refresh tokens, raw JWTs, raw share tokens, cookie values, Cloudinary secrets, or pepper values.
- [ ] `AdminAuditLog` records login success/failure, refresh success/failure, refresh replay, logout, and password-change events.
- [ ] Audit metadata contains safe hashes/truncated user-agent only.
- [ ] Access logs store hashed IP metadata, not raw secret material.

## Proxy And CORS

- [ ] `TRUST_PROXY_ENABLED`, hop behavior, and `TRUSTED_PROXY_CIDRS` match the actual Cloudflare/Hostinger path.
- [ ] A direct-origin request cannot spoof `CF-Connecting-IP` into logs or throttle keys.
- [ ] If `TRUST_PROXY_CLOUDFLARE_ONLY=true`, direct-to-origin spoofing is blocked or otherwise controlled.
- [ ] Auth audit IP hashes reflect the real client path expected behind Cloudflare.
- [ ] Admin Web origin is allowed by CORS.
- [ ] Active assigned public website domains are allowed when DB-backed dynamic CORS is enabled.
- [ ] Unknown, disabled, or unassigned domains are denied by CORS.

## Database And Storage

- [ ] Prisma migrations are deployed.
- [ ] `DB_CONNECTION_LIMIT` is conservative for the production MySQL host.
- [ ] Production database does not store large video binaries.
- [ ] `LOCAL_FILE` storage root is private and outside public web roots.
- [ ] `LOCAL_FILE` video playback uses token-protected public URLs and Range requests.
- [ ] Limited links use returned signed-grant URLs; missing/tampered/wrong-host grants fail generically.
- [ ] Removing an ACTIVE website assignment denies watch, video, and thumbnail access.
- [ ] Hostinger/private NVMe file backups are coordinated with DB backups.
- [ ] `LOCAL_VIDEO_UPLOAD_MAX_MB=500` unless a staging 1GB test has passed.
- [ ] `LOCAL_VIDEO_CHUNK_SIZE_MB` is below Cloudflare/upstream body-size limits.
- [ ] `LOCAL_VIDEO_MIN_FREE_SPACE_MB` is configured and free-space reserve is monitored.
- [ ] `LOCAL_FILE` thumbnails are stored on private local storage and served through safe API URLs.
- [ ] `LOCAL_FILE` purge deletes owned video and thumbnail files best-effort.
- [ ] `LOCAL_FILE` purge response reports local video/thumbnail delete attempts, delete results, reclaimed bytes, and orphan cleanup status without exposing paths.
- [ ] `LOCAL_FILE` purge rejects active website assignments and safely detaches historical share-link rows.
- [ ] `/api/v1/health/ready` returns success only when DB and enabled private storage are accessible.
- [ ] Soft disable does not delete local video files or thumbnails.
- [ ] Temp upload directories do not accumulate beyond the expected stale upload window.
- [ ] Restore testing verifies DB metadata and physical video/thumbnail files together.

Use [LOCAL_FILE Storage Smoke Test](../operations/local-video-storage-smoke-test.md) for the detailed staging checklist.

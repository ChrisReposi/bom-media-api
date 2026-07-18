# Production Auth Hardening

This document summarizes the live backend auth hardening state. For operational procedures, also use:

- [Secret Rotation Runbook](./secret-rotation-runbook.md)
- [Environment Security Checklist](./env-security-checklist.md)
- [Production Security Verification Checklist](./production-security-verification-checklist.md)
- [Cloudflare Hardening Runbook](../operations/cloudflare-hardening-runbook.md)
- [Backup And Restore Runbook](../operations/backup-restore-runbook.md)

## What Changed

- Admin access tokens are now session-bound.
- Login creates an `AdminSession`.
- Access-token JWT payloads include `sid` and `jti`.
- The access-token guard verifies JWT signature, payload type, active admin, active session, session expiry, and session revocation.
- Logout requires a valid session-bound access token and revokes that `sid` plus every refresh token in the session. The request remains idempotent even when the submitted refresh token is already unknown or revoked; database failures return 5xx instead of false success.
- Password change revokes all active refresh tokens and all active sessions for the admin.
- Refresh token rotation remains opaque-token based and hash-only in MySQL.
- Refresh rotation uses a compare-and-set claim. Concurrent reuse revokes the linked session and token family and writes a safe audit event.
- Admin authorization uses the current database role: `STAFF` is read-only, `ADMIN` may mutate but cannot permanently purge, and `OWNER` may purge.
- Auth success/failure/replay/logout/password-change events are written to `AdminAuditLog`.
- Login, refresh, logout, admin APIs, and public watch endpoints are throttled with env-tunable limits.
- `/docs` is disabled by default in production and requires two explicit flags to mount.

## Migration Notes

The migration adds:

```txt
AdminSession
AdminRefreshToken.sessionId
```

`AdminRefreshToken.sessionId` is nullable for migration safety. New login and refresh flows always create/use sessions. Existing access tokens do not contain `sid` and will be rejected after deployment. Existing refresh tokens without a session are rejected, forcing admins to log in again.

## Required Env Vars

```env
JWT_ACCESS_SECRET=replace-with-long-random-secret
JWT_ACCESS_EXPIRES_IN=15m
REFRESH_TOKEN_PEPPER=replace-with-long-random-refresh-token-pepper
REFRESH_TOKEN_BYTES=32
REFRESH_TOKEN_EXPIRES_DAYS=30
SHARE_TOKEN_PEPPER=replace-with-long-random-share-token-pepper
PUBLIC_MEDIA_GRANT_SECRET=replace-with-an-independent-32-character-or-longer-secret
PUBLIC_MEDIA_GRANT_TTL_SECONDS=21600
ACCESS_LOG_IP_PEPPER=replace-with-long-random-ip-hash-pepper
```

Refresh tokens are opaque. Do not use `JWT_REFRESH_SECRET` or `JWT_REFRESH_EXPIRES_IN`; those names are legacy/confusing and are not used by the live backend.

## Docs Exposure

Production Swagger requires both flags:

```env
API_INTERNAL_DOCS_ENABLED=true
API_DOCS_ALLOW_IN_PRODUCTION=true
```

If `NODE_ENV=production` or `APP_ENV=production` and `API_DOCS_ALLOW_IN_PRODUCTION` is not true, `/docs` is not mounted even when `API_INTERNAL_DOCS_ENABLED=true`.

## Throttling Defaults

```env
GLOBAL_THROTTLE_TTL_SECONDS=60
GLOBAL_THROTTLE_LIMIT=120
AUTH_LOGIN_THROTTLE_TTL_SECONDS=60
AUTH_LOGIN_THROTTLE_LIMIT=5
AUTH_REFRESH_THROTTLE_TTL_SECONDS=60
AUTH_REFRESH_THROTTLE_LIMIT=20
AUTH_LOGOUT_THROTTLE_TTL_SECONDS=60
AUTH_LOGOUT_THROTTLE_LIMIT=30
ADMIN_API_THROTTLE_TTL_SECONDS=60
ADMIN_API_THROTTLE_LIMIT=120
PUBLIC_WATCH_THROTTLE_TTL_SECONDS=60
PUBLIC_WATCH_THROTTLE_LIMIT=60
PUBLIC_MEDIA_THROTTLE_TTL_SECONDS=60
PUBLIC_MEDIA_THROTTLE_LIMIT=1200
```

Tune these based on real traffic and Cloudflare/WAF settings. Keep public watch metadata/token exchange stricter than token-protected media streaming. Browser video seeking can create many Range requests and must not share the same low limit as token validation.

## Proxy/IP Logging

Use these only when the API is actually behind a trusted reverse proxy path:

```env
TRUST_PROXY_ENABLED=true
TRUST_PROXY_HOPS=1
TRUST_PROXY_CLOUDFLARE_ONLY=false
TRUSTED_PROXY_CIDRS=<actual-proxy-cidr-list>
```

Production requires `TRUSTED_PROXY_CIDRS` whenever trusted proxy mode is enabled. `CF-Connecting-IP` is accepted only when the immediate socket peer matches this allowlist. Do not enable proxy trust unless direct-to-origin traffic is blocked or otherwise controlled.

## Prisma Pool Defaults

```env
DB_CONNECTION_LIMIT=5
DB_CONNECT_TIMEOUT_MS=10000
DB_ACQUIRE_TIMEOUT_MS=10000
DB_IDLE_TIMEOUT_SECONDS=60
```

Keep limits conservative for shared/managed MySQL.

## DB_BLOB Production Guard

Production must keep:

```env
VIDEO_DB_STORAGE_ENABLED=false
VIDEO_DB_STORAGE_ALLOW_PRODUCTION_OVERRIDE=false
```

DB_BLOB is a small local/testing fallback only. Large production videos must use a non-MySQL storage path.

## Operator Checklist

- [ ] Rotate `JWT_ACCESS_SECRET`.
- [ ] Rotate `REFRESH_TOKEN_PEPPER`.
- [ ] Rotate `ACCESS_LOG_IP_PEPPER`.
- [ ] Rotate `SHARE_TOKEN_PEPPER` only with a share-link invalidation plan.
- [ ] Set a separate `PUBLIC_MEDIA_GRANT_SECRET`; do not reuse or rotate `SHARE_TOKEN_PEPPER` for grants.
- [ ] Rotate `CLOUDINARY_API_SECRET` in Cloudinary dashboard, then production env, then restart API.
- [ ] Set `ADMIN_REGISTER_ENABLED=false` unless onboarding is intentionally open.
- [ ] Apply Prisma migrations before restarting the API.
- [ ] Expect old access tokens and refresh tokens without session linkage to require re-login.
- [ ] Verify `/docs` is not mounted publicly.
- [ ] Verify repeated bad logins return `429`.
- [ ] Verify logout makes the old access token fail.
- [ ] Verify STAFF write and ADMIN purge requests return `403`.
- [ ] Verify password change makes old access tokens fail.
- [ ] Verify public watch invalid-token responses remain generic.
- [ ] Verify production `VIDEO_DB_STORAGE_ENABLED=false`.

## Rollback Notes

The schema migration is additive. Rolling back code without rolling back schema is safe for the added columns/table, but refresh tokens created by hardened code may not behave as expected under old code. Prefer restoring the previous build artifact only after confirming auth behavior in staging.

## Known Limitations

- Refresh tokens are still sent in JSON responses; Admin Web should move refresh tokens to `HttpOnly; Secure; SameSite` cookies when topology allows.
- In-memory throttling is process-local. Multi-instance production should use a shared throttling store.
- Cloudflare WAF/rate-limit settings must be configured manually.

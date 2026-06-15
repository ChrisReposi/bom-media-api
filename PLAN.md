# BOM Media API — Production Hardening Plan

## Current Locked Decisions

- Backend API is now a standalone project/repo.
- React Admin Web is the only production admin surface.
- Public static websites must not include mini-admin production logic.
- Large production videos must not be stored directly in MySQL.
- Hostinger 100GB NVMe storage can be used for production video files when third-party media storage is not desired.
- MySQL stores metadata, permissions, paths, tokens, access logs, and audit logs.
- DB_BLOB remains a small fallback only.
- Use Yarn only.

## Immediate Production-Hardening Goals

### P0 — Before Production

- Rotate Cloudinary secret.
- Rotate JWT access secret.
- Rotate refresh-token pepper/session secret material.
- Rotate share-token pepper only with a clear invalidation plan.
- Disable public `/docs` in production.
- Complete backend logout so it revokes refresh tokens and active sessions.
- Set `VIDEO_DB_STORAGE_ENABLED=false` in production.
- Add NestJS throttling.
- Add Cloudflare WAF/rate-limit rules.
- Tune Prisma pool for Hostinger MySQL.
- Create off-site DB backup and restore-test runbooks.
- Remove/disable public-site mini-admin production logic.
- Ensure Admin Web logout calls backend logout.

### P1 — Admin Auth Hardening

- Add server-side admin sessions or token-version invalidation.
- Include session id or token version in JWT payload.
- Guard must reject revoked sessions or outdated token versions.
- Password change must revoke all active sessions.
- Refresh-token reuse should revoke the related session.
- Add auth audit logs.
- Add focused auth tests.

### P2 — Proxy, Rate Limit, and Logging

- Configure safe trust proxy behavior behind Cloudflare/Hostinger.
- Centralize client IP extraction.
- Do not blindly trust spoofed `x-forwarded-for`.
- Apply auth and public-watch throttles.
- Keep health checks lightly throttled or skipped.
- Keep Pino redaction for authorization/cookie/token fields.
- Avoid logging request bodies for auth endpoints.

### P3 — Admin Web Token Transport

- Move refresh token out of Redux Persist/browser-readable storage.
- Prefer `HttpOnly; Secure; SameSite` cookie if topology supports.
- Add CSRF protection if cookie-based refresh is used.
- Keep access token short-lived and memory-resident.
- If cookie auth is not feasible yet, document blockers and keep backend session hardening.

### P4 — Hostinger NVMe Local File Storage

- `LOCAL_FILE` video source mode is implemented in the live backend.
- Chunked upload endpoints exist for 500MB default files and an env-gated 1GB hard ceiling.
- Files are stored outside the public web root through `LOCAL_FILE_STORAGE_ROOT`.
- Admin preview and public token-protected playback stream through backend routes with Range support.
- `DB_BLOB` remains a small fallback and must stay disabled in production.
- Current operational priority: run staging smoke tests, configure Hostinger private storage, coordinate DB + filesystem backups, and verify purge/reclaim behavior before production.

## Current Priority

Focus now on production operations for auth/security and LOCAL_FILE storage:

- Verify Hostinger storage root, backups, restore tests, purge safety, and Cloudflare Range behavior.
- Verify public display view growth uses the dedicated record-view endpoint and never media Range requests.
- Keep Admin Web as the only production admin surface.
- Keep public sites display-only and share-token-only.

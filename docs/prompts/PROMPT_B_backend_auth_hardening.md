# PROMPT B — Backend Auth Hardening

Now implement the backend auth hardening plan in BOM Media API.

## High-Level Goal

Upgrade the login/session/logout/refresh path to a production-ready level for the current stack without over-engineering and without changing unrelated upload/video logic.

## Constraints

- Use Yarn only.
- Preserve existing endpoint paths unless there is a very strong reason to change them.
- Do not break the Admin Web contract unless the change is necessary and clearly documented.
- Keep responses generic for auth failures.
- Never log passwords, raw refresh tokens, raw JWTs, raw share tokens, cookie values, authorization headers, or secret values.
- Use current source code as the source of truth, not older markdown notes.
- Keep public website mini-admin out of scope.
- Keep `VIDEO_DB_STORAGE_ENABLED=false` in production behavior.
- Keep large production video storage out of MySQL.
- Do not commit real secrets; use placeholders/docs only.
- Avoid unnecessary architectural rewrites.
- Do not work on DRM or video upload redesign in this pass.

## Required Implementation

### A. Secret and Env Hardening

Validate and document `JWT_ACCESS_SECRET`, `JWT_ACCESS_EXPIRES_IN`, refresh-token pepper/session secret material, `REFRESH_TOKEN_BYTES`, `REFRESH_TOKEN_EXPIRES_DAYS`, `SHARE_TOKEN_PEPPER`, `ACCESS_LOG_IP_PEPPER`, docs enable flags, throttling env vars, Prisma pool env vars, and production DB_BLOB disable behavior.

Update env validation and env examples with placeholders only. Do not print or commit real secret values.

### B. Swagger/Docs Production Hardening

Ensure `/docs` is disabled by default in production.

Require a second explicit production override, for example:

```env
API_INTERNAL_DOCS_ENABLED=true
API_DOCS_ALLOW_IN_PRODUCTION=true
```

Without both flags, do not mount Swagger in production.

### C. Server-Side Admin Session Revocation

Implement session-bound access-token invalidation.

Preferred design:

1. Add an `AdminSession` model.
2. Bind access tokens and refresh tokens to a session id.
3. Add `sid` and `jti` or equivalent to JWT payload.
4. Link refresh token rows to a session.
5. `AdminAccessTokenGuard` must check active admin and active session.
6. Logout must revoke submitted refresh token and associated admin session.
7. Password change must revoke all active sessions and all active refresh tokens for that admin.
8. Refresh-token reuse should revoke the related session and audit the event.

If a full `AdminSession` table is too large for this pass, implement a documented token-version fallback. Prefer `AdminSession`.

### D. Refresh Rotation Hardening

Preserve opaque refresh tokens and hash-only storage. On refresh, validate token and session, revoke old token, create new token, and update session last-used metadata. On reuse of a revoked refresh token, reject generically, revoke the related session if identifiable, and audit suspicious reuse.

### E. Auth Audit Logs

Add safe audit logging for login success/failure, refresh success/failure, refresh replay/reuse, logout, password change success/failure, and disabled/inactive rejection where safe.

Never audit passwords, raw tokens, authorization headers, cookie values, or secret values.

### F. NestJS Throttling

Add `@nestjs/throttler` if absent. Add global throttling in `AppModule`. Use route-level throttles for login, register, refresh, logout, change-password, public watch, and tokenized endpoints. Keep health checks low-impact or skipped.

Add env-backed defaults such as:

```env
AUTH_LOGIN_THROTTLE_TTL_SECONDS=60
AUTH_LOGIN_THROTTLE_LIMIT=5
AUTH_REFRESH_THROTTLE_TTL_SECONDS=60
AUTH_REFRESH_THROTTLE_LIMIT=20
PUBLIC_WATCH_THROTTLE_TTL_SECONDS=60
PUBLIC_WATCH_THROTTLE_LIMIT=60
GLOBAL_THROTTLE_TTL_SECONDS=60
GLOBAL_THROTTLE_LIMIT=120
```

### G. Proxy-Aware Client IP Handling

Inspect `main.ts` and HTTP adapter. Add safe `trust proxy` configuration for Cloudflare/Hostinger. Add env such as `TRUST_PROXY_ENABLED`, `TRUST_PROXY_HOPS`, and optionally `TRUST_PROXY_CLOUDFLARE_ONLY`. Centralize client IP extraction and do not blindly trust spoofable headers.

### H. Prisma Pool Tuning

Make pool values env-backed if hard-coded. Keep defaults conservative for Hostinger/managed MySQL. Add env validation for `DB_CONNECTION_LIMIT`, `DB_CONNECT_TIMEOUT_MS`, `DB_ACQUIRE_TIMEOUT_MS`, and adapter-supported timeouts.

### I. Production DB_BLOB Guard

Ensure `VIDEO_DB_STORAGE_ENABLED=false` is production default. If production and DB_BLOB is enabled, fail fast unless an explicit emergency override exists.

### J. Focused Tests

Add targeted tests for login success, invalid credentials, refresh rotation, old refresh reuse, logout session revocation, password-change session revocation, disabled admin rejection, login 429 throttling, docs off in production, and production DB_BLOB disabled by default.

### K. Documentation

Update or create:

- `docs/security/production-auth-hardening.md`
- `docs/security/env-security-checklist.md`
- `docs/operations/cloudflare-hardening-runbook.md`
- `docs/operations/backup-restore-runbook.md`
- update `session-log.md`

## Acceptance Criteria

- Typecheck passes.
- Build passes.
- Prisma generate passes.
- Migration is created and documented.
- Focused tests pass or are documented if blocked by test infrastructure.
- `/docs` is off in production unless explicit production override is set.
- Logout invalidates access-token usability through session or version checks.
- Password change invalidates active sessions.
- Refresh-token replay is rejected and audited.
- Login throttling returns `429`.
- No raw credentials/tokens are logged.

## Final Output Required

At the end, provide summary of exact changes, files changed, migration notes, commands run, verification result, Admin Web follow-up required, and manual Cloudflare/secret-rotation steps still required.

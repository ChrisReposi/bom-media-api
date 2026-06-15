# BOM Media API — Session Log

This file is the persistent implementation log for Codex and future assistants.

## Usage Rules

- Append new entries at the top.
- Keep entries concise but specific.
- Include date, goal, files changed, commands run, verification result, known limitations, next recommended prompt.
- Do not paste real secrets.
- Do not treat old entries as more authoritative than live source code.

---

## 2026-06-15 — LOCAL_FILE purge reclaim and storage cleanup hardening

### Summary

- Hardened guarded `POST /api/v1/admin/videos/:id/purge` reporting for LOCAL_FILE storage reclaim.
- Purge now returns safe storage/remote deletion results, including local video/thumbnail delete attempts, delete success, reclaimed bytes, and orphan-cleanup status.
- Purge audit metadata now records storage reclaim results without absolute paths or storage roots.
- Confirmed soft disable remains metadata-only and does not delete local files.
- Added focused purge/reclaim tests and tightened dry-run storage script templates.
- Updated operations/security docs for purge evidence, dry-run cleanup, orphan review, disk thresholds, and backup-before-cleanup policy.

### Changed

```txt
src/videos/videos.controller.ts
src/videos/videos.service.ts
src/videos/types/video-response.type.ts
test/video-purge.test.ts
scripts/storage/backup-local-files.example.sh
scripts/storage/cleanup-temp-uploads.example.sh
scripts/storage/find-orphan-local-files.example.sh
scripts/storage/restore-local-files.example.sh
docs/operations/backup-restore-runbook.md
docs/operations/local-video-storage-runbook.md
docs/operations/local-video-storage-smoke-test.md
docs/operations/production-deployment-checklist.md
docs/security/env-security-checklist.md
docs/security/production-security-verification-checklist.md
session-log.md
```

### Verified

```bash
yarn db:local:generate
yarn db:local:validate
yarn typecheck
yarn lint
yarn format:check
yarn test
yarn build
bash -n scripts/storage/*.example.sh
find . -maxdepth 3 \( -name package-lock.json -o -name pnpm-lock.yaml \) -print
```

- Prisma generate/validate passed.
- Typecheck passed.
- Lint passed with existing consistent-type-import warnings and no errors.
- Format check passed.
- Test suite passed: 24 tests.
- Build passed.
- Storage script syntax checks passed.
- npm/pnpm lockfile search returned no files.

### Pending

- Manual staging purge/reclaim test with a real LOCAL_FILE video and private storage root.
- Admin Web still needs to surface the expanded purge response and storage reclaim feedback.
- Operators still need to configure real Hostinger storage, backups, dry-run cleanup review, disk monitoring, and restore testing outside the repo.

### Next Recommended Prompt

`Prompt 2 — Admin Web Purge Permanently UI and storage reclaim feedback`

## 2026-06-15 — Dynamic video views and relative published dates

### Summary

- Added additive Prisma models for public display-view growth dedupe events and hourly per-video growth buckets.
- Added env-backed view growth policy with per-event cap, per-hour cap, dedupe window, minimum watch timing, and random minimum increment.
- Added `POST /api/v1/public/watch/:token/videos/:videoId/view` for public sites to record a view after playback starts.
- Added `VideoViewGrowthService` so `VideoAsset.viewCount` grows through capped, deduped backend writes while media Range/thumbnail/public-watch metadata requests do not increment views.
- Updated the SML public static site to call the record-view endpoint once after playback starts, update visible view counts in place, and render calendar-aware relative publish dates.
- Documented that `publishedAt` is immutable and relative labels are computed at display time.

### Changed

```txt
.env.example
.env.local.example
PLAN.md
prisma/schema.prisma
prisma/migrations/20260615120000_video_view_growth/migration.sql
src/config/env.config.ts
src/config/env.validation.ts
src/public/dto/record-public-video-view.dto.ts
src/public/public.controller.ts
src/public/public.module.ts
src/public/public.service.ts
src/public/types/public-watch-response.type.ts
src/videos/video-view-growth.service.ts
test/video-view-growth.test.ts
docs/architecture/backend-context.md
docs/architecture/local-file-video-storage.md
docs/operations/local-video-storage-runbook.md
docs/operations/local-video-storage-smoke-test.md
docs/operations/production-deployment-checklist.md
docs/security/env-security-checklist.md
docs/security/production-security-verification-checklist.md
session-log.md
```

### Verification

```bash
yarn db:local:generate
yarn db:local:validate
yarn typecheck
yarn lint
yarn format:check
yarn test
yarn build
node --check assets/app.js
find /Users/monarch/Desktop/bom-media/bom-media-api /Users/monarch/Desktop/bom-media/bom-media-sites/sml/smlvideo-space -maxdepth 3 \( -name package-lock.json -o -name pnpm-lock.yaml \) -print
```

- Prisma generate/validate passed.
- Typecheck passed.
- Lint passed with existing import-type warnings and no errors.
- Format check passed after formatting the new growth service/test.
- Test suite passed: 17 tests.
- Build passed.
- Public static `node --check assets/app.js` passed.
- npm/pnpm lockfile search returned no files.

### Known Limitations

- Manual browser/API verification with a real share token is still required.
- The public static site records after a five-second playback timer or video end; the backend currently trusts the public call after validating token/host/video membership.
- The view-growth endpoint is not a full analytics system. It updates a public display counter only and does not produce admin audit analytics.
- The hourly cap uses a transaction and conditional bucket update; extreme concurrency should still be reviewed under production load if traffic spikes.

### Next Recommended Prompt

`PROMPT — End-to-End Verify Public View Growth With Real Share Link And Admin Counter Refresh`

## 2026-06-15 — LOCAL_FILE public playback seeking and thumbnail fixes

### Summary

- Split token-protected public media endpoints away from the stricter public-watch metadata throttle.
- Added `PUBLIC_MEDIA_THROTTLE_TTL_SECONDS` and `PUBLIC_MEDIA_THROTTLE_LIMIT`.
- Applied the media throttle profile to public DB_BLOB, LOCAL_FILE video, and LOCAL_FILE thumbnail routes.
- Added early public media response headers so local cross-origin media responses, including pre-controller 429 responses, are not blocked by Helmet's default same-origin resource policy.
- Updated public static site video cards, thumbnail resolution, and native video loading/seeking/buffering overlay.
- Documented media Range throttle and Cloudflare/CORP expectations.

### Root Cause

- Public LOCAL_FILE media Range requests were using the same `publicWatch` throttle profile as public watch metadata/token validation.
- Fast seeking can generate many legitimate Range requests and exhaust a 60/minute metadata-style limit.
- Route-level media headers were set inside controller methods, so throttler-generated 429 responses could still carry Helmet's default same-origin resource policy in local cross-origin testing.

### Changed

```txt
.env.example
.env.local.example
src/config/env.config.ts
src/config/env.validation.ts
src/main.ts
src/public/public.controller.ts
src/security/throttle-profile.decorator.ts
src/security/throttle.config.ts
test/auth-hardening.test.ts
docs/operations/cloudflare-hardening-runbook.md
docs/operations/local-video-storage-runbook.md
docs/operations/local-video-storage-smoke-test.md
docs/security/env-security-checklist.md
docs/security/production-auth-hardening.md
session-log.md
```

### Verified

- `yarn format:check` passed after formatting `src/main.ts`.
- `yarn typecheck` passed.
- `yarn lint` passed with existing import-type warnings and no errors.
- `yarn test` passed: 13 tests.
- `yarn build` passed.
- npm/pnpm lockfile search returned no files.
- Public static `node --check assets/app.js` passed.
- Public forbidden-management and raw-storage-path greps returned no matches.

### Pending

- Manual browser test with a valid LOCAL_FILE share token.
- Confirm rapid seeking returns valid 206 Range responses and does not hit 429 under normal playback.
- Confirm local `127.0.0.1:5500` public site can load media from `localhost:3000` without `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`.

### Next Recommended Prompt

`PROMPT — End-to-End LOCAL_FILE Playback Smoke Test With Real Share Link And Cloudflare Range Proxy`

## 2026-06-15 — Hostinger LOCAL_FILE storage operations runbooks

### Summary

Added production operations documentation for Hostinger/private NVMe `LOCAL_FILE` video storage after backend support was implemented.

- Documented production env policy, storage-root safety, actual local storage key layout, upload/chunk lifecycle, thumbnail policy, public playback, purge/reclaim, stale temp cleanup, monitoring thresholds, and operator actions.
- Added a dedicated LOCAL_FILE smoke-test checklist covering local dev, staging uploads, public playback, Range seeking, purge behavior, 500MB tests, optional 1GB staging tests, and restore verification.
- Expanded backup/restore guidance so DB metadata and physical video/thumbnail files are backed up and restored together.
- Updated production/security checklists and PLAN to reflect that LOCAL_FILE is implemented and now needs operational verification.
- Added safe storage script templates. They are examples only, not scheduled jobs.

### Files Created/Updated

```txt
PLAN.md
docs/operations/local-video-storage-runbook.md
docs/operations/local-video-storage-smoke-test.md
docs/operations/backup-restore-runbook.md
docs/operations/cloudflare-hardening-runbook.md
docs/operations/production-deployment-checklist.md
docs/security/env-security-checklist.md
docs/security/production-security-verification-checklist.md
scripts/storage/README.md
scripts/storage/disk-usage.example.sh
scripts/storage/backup-local-files.example.sh
scripts/storage/restore-local-files.example.sh
scripts/storage/find-orphan-local-files.example.sh
scripts/storage/cleanup-temp-uploads.example.sh
session-log.md
```

### Operator Actions Still Required

- Create the real private Hostinger storage root outside `public_html`.
- Configure production LOCAL_FILE env values on the host.
- Verify the API process can read/write the storage root.
- Configure real DB and filesystem backups outside this repo.
- Run and record a restore test covering DB metadata and local files together.
- Smoke-test Cloudflare/proxy Range behavior for LOCAL_FILE playback.
- Run staging 500MB upload tests before production use.
- Run optional 1GB staging tests only if the production limit will be raised.
- Decide whether and how to schedule temp/orphan cleanup after dry-run review.

### Assumptions

- Live source code is authoritative and already implements `VideoSourceType.LOCAL_FILE`.
- Actual storage keys use `videos/<videoId>/source/...`, `videos/<videoId>/thumbnails/...`, and `tmp/uploads/<uploadId>/chunk-<index>`.
- `DB_BLOB` remains a fallback only and stays disabled in production.
- Public sites consume backend-provided protected playback/thumbnail URLs and do not infer storage paths.

### Verification Performed

- Reviewed live env validation, Prisma schema, LOCAL_FILE controller/service routes, public playback response shaping, and existing docs.
- Added docs and safe script templates with placeholders only.
- Ran `bash -n scripts/storage/*.example.sh`.
- Ran `yarn format:check`.
- Ran npm/pnpm lockfile search.
- Ran a placeholder/secret/path scan over updated docs/scripts.
- No external Hostinger, Cloudflare, backup, cron, restore, DNS, or secret-rotation action was performed.

### Known Limitations

- The scripts are templates only and are not active monitoring, backup, restore, or cleanup jobs.
- No real backup, restore, purge, upload, or Cloudflare Range test was run in this pass.
- Admin Web LOCAL_FILE upload integration still requires separate verification against the live backend.

### Next Recommended Prompt

`PROMPT — Staging Verify Hostinger LOCAL_FILE Upload, Public Playback, Backup Restore, And Purge Reclaim`

## 2026-06-14 — Hostinger Local File Video Storage

### Summary

Implemented the production large-video path using private Hostinger/NVMe-style local file storage.

- Added `VideoSourceType.LOCAL_FILE` with local video/thumbnail asset metadata and upload-session tracking.
- Added chunked admin upload endpoints for init/chunk/status/complete/cancel.
- Added admin LOCAL_FILE preview and local thumbnail endpoints.
- Added public token-protected LOCAL_FILE video and thumbnail streaming endpoints with Range support.
- Extended share-link eligibility so READY LOCAL_FILE videos with local video data are playable.
- Extended guarded purge to reclaim owned local video and thumbnail files best-effort.
- Added focused local storage tests and operator docs.

### Files Changed

```txt
.env.example
.env.local.example
prisma/schema.prisma
prisma/migrations/20260614203000_local_file_video_storage/migration.sql
src/config/env.config.ts
src/config/env.validation.ts
src/admin-websites/admin-websites.service.ts
src/public/public.controller.ts
src/public/public.module.ts
src/public/public.service.ts
src/public/types/public-watch-response.type.ts
src/videos/dto/complete-local-video-upload.dto.ts
src/videos/dto/init-local-video-upload.dto.ts
src/videos/dto/update-local-video-thumbnail.dto.ts
src/videos/dto/upload-local-video-chunk.dto.ts
src/videos/storage/local-video-storage.module.ts
src/videos/storage/local-video-storage.service.ts
src/videos/types/video-response.type.ts
src/videos/videos.controller.ts
src/videos/videos.module.ts
src/videos/videos.service.ts
test/local-video-storage.test.ts
docs/architecture/backend-context.md
docs/architecture/local-file-video-storage.md
docs/security/env-security-checklist.md
docs/security/production-security-verification-checklist.md
docs/operations/backup-restore-runbook.md
docs/operations/cloudflare-hardening-runbook.md
docs/operations/production-deployment-checklist.md
session-log.md
```

### Migration Notes

- New additive migration: `20260614203000_local_file_video_storage`.
- Adds enum value `LOCAL_FILE`.
- Adds `VideoLocalFileAsset`, `VideoLocalThumbnailAsset`, `VideoUploadSession`, and `VideoUploadSessionChunk`.
- Keeps legacy manual URL, embed, Cloudinary upload, and `DB_BLOB` models/routes intact.
- Requires `LOCAL_FILE_STORAGE_ROOT` when `LOCAL_FILE_STORAGE_ENABLED=true`.
- Production should keep `VIDEO_DB_STORAGE_ENABLED=false`.

### Commands Run

```bash
yarn db:local:generate
yarn typecheck
yarn test
yarn prettier --write src/config/env.validation.ts src/public/public.service.ts src/videos/dto/complete-local-video-upload.dto.ts src/videos/dto/init-local-video-upload.dto.ts src/videos/dto/upload-local-video-chunk.dto.ts src/videos/storage/local-video-storage.service.ts src/videos/types/video-response.type.ts src/videos/videos.controller.ts src/videos/videos.service.ts
yarn format:check
yarn lint
yarn build
yarn db:local:validate
find . -maxdepth 3 \( -name package-lock.json -o -name pnpm-lock.yaml \) -print
```

### Verification Result

- Prisma generate passed.
- Prisma validate passed.
- Typecheck passed.
- Build passed.
- Format check passed.
- Test suite passed: 12 tests.
- Lint passed with existing type-import warnings; no lint errors.
- No npm or pnpm lockfile was created.

### Known Limitations

- Full multipart upload/controller integration tests were not added in this pass; storage boundary tests cover traversal, chunk merge, Range reads, and invalid range behavior.
- Admin Web still needs a chunked LOCAL_FILE upload UI and LOCAL_FILE playback/rendering support.
- Operators must configure a private storage root and coordinated file + DB backups before production use.
- Cloudflare/body-size behavior still requires staging verification with the actual admin/API host path.
- `PLAN.md` still had older “local-file later” guidance; live source and this session supersede that historical note.

### Next Recommended Prompt

`PROMPT — Implement Admin Web Chunked LOCAL_FILE Upload UI And Public LOCAL_FILE Playback Handling`

---

## 2026-06-14 — Production Operations Runbooks

### Summary

Added concrete production operations runbooks for secret rotation, Cloudflare hardening, production env policy, backup/restore, and security verification.

This was a documentation and template pass only. No external Cloudflare dashboard settings, backup jobs, secret rotations, DNS changes, restore tests, or off-site backups were performed.

### Files Created/Updated

```txt
docs/security/secret-rotation-runbook.md
docs/security/production-security-verification-checklist.md
docs/security/production-auth-hardening.md
docs/security/env-security-checklist.md
docs/operations/cloudflare-hardening-runbook.md
docs/operations/backup-restore-runbook.md
docs/operations/production-deployment-checklist.md
scripts/backup/README.md
scripts/backup/mysql-dump.example.sh
scripts/backup/restore-checklist.md
session-log.md
```

### Operator Actions Still Required

- Rotate production secrets outside git.
- Configure Cloudflare Access/WAF/rate limits/Tunnel or origin firewall.
- Create and monitor real backup jobs.
- Copy backups off-site.
- Run and record restore tests.
- Verify production env values on the actual host.

### Assumptions

- Admin Web remains the only production admin surface.
- Public websites must not ship production mini-admin logic.
- DB_BLOB stays disabled in production and remains a small fallback only.
- Large production video storage will use a non-MySQL path.

### Verification Performed

- Reviewed existing context docs and current source references for auth, env, throttling, proxy, CORS, Cloudinary, and DB_BLOB behavior.
- Updated docs with placeholders only.
- Did not print or copy real `.env` secret values.

### Known Limitations

- The backup shell file is an example template only and is not scheduled.
- Cloudflare rules and Access policies are documented but not applied.
- Secret rotation guidance is documented but not executed.
- Restore evidence templates were added, but no restore test was performed.

### Next Recommended Prompt

`PROMPT — Add Admin Web HttpOnly Refresh Cookie Transport And CSRF-Safe Session UX`

---

## 2026-06-14 — Backend Auth Hardening

### Summary

Implemented session-bound admin auth hardening for the standalone `bom-media-api` backend.

- Added server-side `AdminSession`.
- New access tokens carry `sid` and `jti`.
- The admin access-token guard now rejects old JWTs without `sid`, revoked sessions, expired sessions, and inactive admins.
- Logout remains generic/idempotent but revokes the submitted refresh token and linked session.
- Password change revokes all active sessions and refresh tokens.
- Refresh rotation revokes old refresh tokens, creates new refresh tokens linked to the session, and revokes the session on identifiable replay.
- Added safe auth audit events for login, refresh, replay, logout, and password change.
- Added Nest throttling for login, refresh, logout, admin APIs, and public watch profiles.
- Added proxy-aware request IP utility and removed direct trust of raw `x-forwarded-for`.
- Hardened production Swagger so `/docs` needs both `API_INTERNAL_DOCS_ENABLED=true` and `API_DOCS_ALLOW_IN_PRODUCTION=true`.
- Added env-backed Prisma pool tuning.
- Added production fail-fast for `VIDEO_DB_STORAGE_ENABLED=true` unless an explicit emergency override is set.

### Files Changed

```txt
.env.example
.env.local.example
package.json
yarn.lock
prisma/schema.prisma
prisma/migrations/20260614190000_admin_sessions/migration.sql
prisma/seed.ts
src/app.module.ts
src/main.ts
src/admin-auth/admin-auth.controller.ts
src/admin-auth/admin-auth.service.ts
src/admin-auth/guards/admin-access-token.guard.ts
src/admin-auth/types/admin-token-payload.type.ts
src/common/utils/request-security.util.ts
src/config/env.config.ts
src/config/env.validation.ts
src/database/prisma.service.ts
src/health/health.controller.ts
src/public/public.controller.ts
src/security/throttle.config.ts
src/security/throttle-profile.decorator.ts
src/videos/videos.controller.ts
src/admin-websites/admin-websites.controller.ts
test/auth-hardening.test.ts
docs/security/production-auth-hardening.md
docs/security/env-security-checklist.md
docs/operations/cloudflare-hardening-runbook.md
docs/operations/backup-restore-runbook.md
docs/operations/production-deployment-checklist.md
```

### Migration Notes

Additive migration:

```txt
AdminSession table
AdminRefreshToken.sessionId nullable column
```

Existing access tokens do not contain `sid` and will be rejected after deploy. Existing refresh tokens without session linkage will also require admins to log in again.

### Commands Run

```bash
yarn add @nestjs/throttler
yarn db:local:generate
yarn db:local:validate
yarn prisma format
yarn prettier --write ...
yarn typecheck
yarn test
yarn build
yarn format:check
yarn lint
```

### Verification Result

- `yarn db:local:generate` passed.
- `yarn db:local:validate` passed.
- `yarn typecheck` passed.
- `yarn test` passed with 8 focused tests.
- `yarn build` passed.
- `yarn format:check` passed.
- `yarn lint` passed with existing style warnings only.

### Admin Web Follow-Up

Admin Web should keep handling generic 401 by forcing re-login. Later, move refresh tokens out of browser-readable storage into `HttpOnly; Secure; SameSite` cookies if topology allows.

### Known Limitations

- Throttling uses in-memory storage and is process-local.
- Cloudflare WAF/rate-limit rules still require manual configuration.
- Secret rotation was documented but not performed.
- Database backup/restore jobs were documented but not performed.

### Next Recommended Prompt

`PROMPT — Admin Web Refresh Token Cookie Transport And CSRF-Safe Session UX`

---

## 2026-06-14 — Prompt A Auth/Security Inventory

### Summary

Ran a read-only analysis prompt against the standalone `bom-media-api` backend.

The current live-code behavior reported by Codex:

- `main.ts` boots `AppModule`, Pino logger, Helmet, dynamic CORS, global `/api/v1` prefix, strict `ValidationPipe`, and env-controlled Swagger at `/docs`.
- Swagger is production-default disabled but can still be enabled by env if `API_INTERNAL_DOCS_ENABLED=true`.
- `app.module.ts` calls `loadApiEnv()`, validates env, configures Pino, and redacts authorization/cookie/token fields.
- No `app.set("trust proxy", ...)`.
- No `@nestjs/throttler` or equivalent rate limit currently exists.
- Login returns safe admin data, JWT access token, opaque refresh token, token type, and expiry.
- Refresh hashes submitted opaque refresh token as `sha256(REFRESH_TOKEN_PEPPER + rawToken)`, validates it, revokes the old row, creates a new row, and returns new tokens.
- Logout is idempotent and revokes submitted refresh token hash, but does not invalidate already-issued access token.
- Change password revokes all active refresh tokens but existing access tokens remain valid until expiry unless admin is disabled.
- `AdminAccessTokenGuard` validates JWT and active admin but has no `jti`, session id, token version, password-change timestamp, or denylist check.
- Prisma uses MySQL provider, generated client output under `src/generated/prisma`, `@prisma/adapter-mariadb`, and hard-coded `connectionLimit: 5`.

### Key Risks Identified

- No rate limiting.
- Access tokens cannot be immediately invalidated on logout/password change.
- Refresh-token reuse detection does not revoke a token family/session.
- Registration defaults to enabled when unset.
- Password length policy mismatch between register/login and change-password.
- Proxy/IP handling is unsafe behind Cloudflare.
- Swagger can be enabled in production via env.
- Prisma pool is hard-coded.
- Auth events are not fully audited.

### Recommended Next Implementation

Run `docs/prompts/PROMPT_B_backend_auth_hardening.md`.

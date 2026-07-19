# BOM Media API — Session Log

This file is the persistent implementation log for Codex and future assistants.

## Usage Rules

- Append new entries at the top.
- Keep entries concise but specific.
- Include date, goal, files changed, commands run, verification result, known limitations, next recommended prompt.
- Do not paste real secrets.
- Do not treat old entries as more authoritative than live source code.

---

## 2026-07-19 — Gate 1: canonical delete policy hardened to all-Restrict

### Changed

- Pre-push audit found the app has no website/shareLink/domain hard-delete (both `@Delete` routes are status-only disables; revoke is status-only; the only physical delete is video purge, already guarded), but the Website/ShareLink FKs on `CanonicalVideoShareLink` were Cascade — a direct-SQL or future code path could silently erase provenance. Final policy: **onDelete: Restrict on all four relations**; corrective migration `restrict_canonical_record_deletes` (drops and re-adds the two FKs with RESTRICT; no data/table/column changes). Schema-contract test pins all four relations to Restrict.

### Verified

- Live MySQL: with a fully verified throwaway fixture set (website/video/domain/link/mapping), DELETE on each of the four parents fails with MySQL 1451 and the row survives; share-link revoke succeeds with the canonical mapping retained; deliberate dependency-order cleanup works. Suites: generate/validate/status (18 migrations, up to date), typecheck, lint 0 errors, **tests 153/153**, build, format, diff-check.

### Incident (dev database, caused and disclosed by this session)

- An earlier Gate-1 proof attempt ran the four DELETE statements against real dev entities after a fixture INSERT batch had silently failed (stderr suppressed) — the FKs were not yet protecting those rows and one dev website plus one dev video were cascade-deleted. Impact was limited to the local docker dev DB. Recovery: 5 ACTIVE assignments re-created via the assignment API on the remaining website; the deleted website/video rows are not recoverable (no dump existed). Process correction applied: proofs now use throwaway rows only, every fixture insert is count-verified before any destructive statement, and stderr is never suppressed.

### Pending

- Gates 2 (rawToken), 3 (DB_BLOB checksum), 4 (public parser) — not part of this task. Production migrate-deploy remains operator work.

## 2026-07-18 — Canonical website-video share links (feature branch)

### Goal

- One stable canonical public URL per website+video pair for DMCA/provenance records: repeated create-or-get returns byte-for-byte the same URL; a different website or video always yields a different alias/URL; nothing is silently replaced.

### Changed

- Schema: additive `CanonicalVideoShareLink` (`@@unique(websiteId, videoId)`, unique `shareLinkId`, snapshotted host/protocol, evidence fingerprint/snapshot; video+domain FKs Restrict, website+shareLink Cascade). Migration `20260718113156_canonical_video_share_links` (applied local only).
- `CanonicalShareLinkService`: idempotent create-or-get (Serializable tx, DB unique as arbiter, alias/token collision + P2034 retry, raced-loser reload → REUSED), read path with `evidenceDrift`, owner adoption operation (audit in-transaction), domain guard helper. Stable codes: CANONICAL_LINK_{REVOKED,INACTIVE}, CANONICAL_DOMAIN_UNAVAILABLE, CANONICAL_EVIDENCE_DRIFT, CANONICAL_VIDEO_NOT_SHAREABLE.
- Endpoints: GET/POST `/admin/websites/:websiteId/videos/:videoId/canonical-share-link` (POST accepts no body — no expiry/maxViews/caller alias/token; rawToken only on CREATED).
- Guards: purge blocked while canonical exists (`VIDEO_HAS_CANONICAL_SHARE_LINK`); domain host-rename and unassign blocked (`DOMAIN_HAS_ACTIVE_CANONICAL_LINKS`); disable/transfer transitively blocked; delete DB-Restricted.
- **Latent bug fixed for all share-link retries:** with `@prisma/adapter-mariadb`, P2002 has no `meta.target` — the constraint arrives only in `meta.driverAdapterError.cause.constraint.index` (proven by probing MySQL 1062 through the live adapter). New `share-link-errors.util.ts` consults both shapes; the pre-existing alias-collision retry in `createShareLink` silently never matched adapter-shaped errors before this.
- Tooling: read-only masked audit CLI (`audit:canonical-share-links`, `--counts-only`, never selects tokenHash) + local-only confirmation-gated adoption CLI (`remediate:local:adopt-canonical`). Docs: canonical runbook + owner adoption worksheet.

### Verified (local MySQL 8, real HTTP)

- 20 concurrent create-or-get on one pair → **1 CREATED + 19 REUSED, 0 errors**, one alias/URL/link id across all responses; DB exactly 1 canonical + 1 ShareLink + 1 ShareLinkVideo.
- Conflict matrix live: title edit → POST 409 CANONICAL_EVIDENCE_DRIFT while GET returns drift=true with unchanged URL; title revert → REUSED same alias; purge → 409; domain unassign → 409; revoke → POST 409 with mapping preserved.
- Adoption CLI adopted a legacy single-video link (GET then returns the same link id/alias); audit CLI classified 5 pairs.
- Suites: typecheck, lint 0 errors, **tests 152/152** (18 canonical unit tests incl. both P2002 meta shapes; purge-guard regression), build, format. Fixtures fully cleaned (canonical rows + fixture ShareLinks cascade-deleted; dev titles restored via API).

### Pending

- Production migration/deploy and legacy adoption remain operator work (see canonical runbook). Rotation endpoint intentionally not implemented.

## 2026-07-18 — Release packaging, CI, and release identity

### Changed

- Created branch `release/2026-07-18-production-hardening` and committed the audited working tree exactly per the persisted manifests (`~/Desktop/bom-media/release-manifests/2026-07-18/`): A1 (24 files, scoped video access + search hardening), A2 (51, auth/accounts/runtime security incl. the test-env fixture), A3 (11, operations docs). Every commit was staged with `git add --pathspec-from-file` and verified name-for-name against its manifest before committing.
- Added `.github/workflows/ci.yml`: install → prisma generate/validate (placeholder DATABASE_URL, no DB connection) → typecheck → lint → test → format:check → build → `git diff --check`; concurrency cancel, pinned action majors, Node 22, Yarn only.
- Added safe release identity: optional `APP_RELEASE_VERSION` / `APP_BUILD_SHA` / `APP_BUILD_TIME` (validated strictly when present, never required, never read from `.git` at runtime) surfaced as an additive `release` object on `/health` (and therefore `/health/ready`). New `test/release-identity.test.ts` (+6 tests). Env examples updated.
- Added `docs/operations/production-release-runbook.md` — full operator pack with placeholders (backup, migrate deploy, restart, API/Admin smoke incl. the filterKey PATCH regression, atomic Admin upload, Cloudflare purge, rollback decision tree).

### Verified

- Post-commit and post-identity suites: typecheck, lint (0 errors), **tests 133/133**, build, format:check, `git diff --check` — clean tree after every commit.
- Live probe: boot with injected metadata → `/health` returns `release {version, commit, builtAt}`; without metadata the legacy payload shape is unchanged.

### Pending

- Push/merge/deploy are intentionally left to the operator; production evidence remains NOT_VERIFIED until the runbook is executed.

## 2026-07-18 — CreateVideo filterKey persistence incident

### Incident

- Admin enters `Key lọc video` in CreateVideoModal; create/upload succeeds but the new video has no `filterKey`; EditVideoModal can set it afterwards.

### Proven Root Cause

- The pre-fix working tree contained a partial-update bug; it is fixed in this entry's changes and the description below is of the pre-fix behavior.
- **PROVEN (local E2E over real HTTP + MySQL 8):** `PATCH /admin/videos/:id` cleared `filterKey` to NULL whenever the request body omitted the field. Mechanism: validated DTOs are class instances whose declared fields are always own properties (`useDefineForClassFields`), so the service guard `Object.prototype.hasOwnProperty.call(dto, "filterKey")` was always true, and `normalizeNullableVideoFilterKey(undefined)` → null. Probe: `plainToInstance(UpdateVideoDto, { durationSeconds: 42 })` → `hasOwnProperty("filterKey") === true`.
- The Admin client (`uploadLocalVideo`) fires exactly such a metadata-only PATCH (durationSeconds/thumbnailUrl from auto-analysis) right after every LOCAL_FILE completion — so the key stored by completion was erased one request later. Manual/embed creates have no post-create PATCH → unaffected. Edit works because it sends `filterKey` explicitly.
- Why prior unit tests missed it: they invoked `updateVideo` with plain object literals (no `filterKey` own property); the real pipeline shape (`plainToInstance`) was never exercised.
- Full wire proof before fix: LOCAL_FILE init(`SML`) → session metadata `"sml"` → chunk → complete → `VideoAsset.filterKey="sml"` (DB+response+detail+list+`?filterKey=sml`) → `PATCH {durationSeconds:42}` → **DB filterKey=NULL**.

### Changed

- `src/videos/videos.service.ts` (updateVideo): guard replaced with `dto.filterKey !== undefined`.
- `src/videos/dto/update-video.dto.ts`: `@Transform` now maps the explicit clear signals (`null` / empty string) to `null` instead of collapsing them into `undefined`, so "omitted" and "clear" stay distinguishable end-to-end.
- `test/admin-video-search.test.ts` (+2): metadata-only PATCH through `plainToInstance` keeps the key; clear-by-null / set-`SML`→`sml` / clear-by-blank through the validated pipeline.

### Verified

- After rebuild, same wire sequence: metadata-only PATCH keeps `"sml"` (DB + response); `filterKey:null` and `""` still clear; `all`/`unsafe$key` still 400.
- Concurrent double-complete on one session: one 409 + one success, exactly one VideoAsset, `judge-judy` → `judge_judy`; idempotent re-complete returns the same video with the key; post-completion PATCH keeps it.
- Suites: typecheck, lint (0 errors), **tests 127/127**, build, format:check, `db:local:*`, `git diff --check` — all pass. Fixtures purged via disable→purge; upload sessions cleaned.

### Deployment Required

- Deploy API build (includes this fix) → `yarn db:migrate:deploy` → restart; then Admin dist. The fix is server-side; stale Admin builds remain safe because the clearing happened in the API.

### Pending

- Production verification (Network tab: init request contains `filterKey`; post-completion PATCH no longer nulls it) — NOT_VERIFIED this session; local evidence only.

## 2026-07-17 — Production admin-video search and filterKey incident

### Incident

- Production `GET /api/v1/admin/videos?...search=sml...` (VideosPage) and `...search=abc...` (Dashboard) return 500. Create Video reportedly accepts `filterKey` in the UI but the created video has none; PATCH later works.

### Root Cause Matrix

- Current source producing the 500 — **RULED_OUT.** Full local E2E through the real Nest stack (guard → ValidationPipe → DTO → service → memory cache → Prisma MariaDB adapter → MySQL 8.0.46 → response mapping → exception filter): 13/13 global search cases and 6/6 website-scoped cases returned HTTP 200, including `search=sml`, `search=abc`, quotes, backslash, Vietnamese, page 2, `filterKey` combinations. BigInt `viewCount` is serialized via `.toString()`; `mode: "insensitive"` never existed in committed code (only in doc prose).
- Missing production migration (schema drift) — **POSSIBLE; mechanism PROVEN locally.** Simulated a production DB without `20260704034452_add_video_filter_key_and_safe_purge_flow`: with the current Prisma client, `videoAsset.count` still succeeds but every `findMany` fails with **P2022 “The column VideoAsset.filterKey does not exist”** → 500. Signature for operators: plain (no-search) list also 500s. `filterKey` entered the API only at HEAD commit `688a77f`, so any deployment of that build without `prisma migrate deploy` hits this.
- Old API build + new Admin — **RULED_OUT for the observed symptoms.** ValidationPipe uses `forbidNonWhitelisted: true` at HEAD and in the working tree, so unknown DTO fields produce **400**, not 500, and a create carrying `filterKey` against an old API would fail loudly instead of silently dropping the key.
- Stale/mixed Admin JS chunks — **POSSIBLE (fits Incident B exactly).** New API + a cached pre-`filterKey` `videoApi` chunk: the field renders, the payload never includes it, the whitelisted API accepts the create → video saved without `filterKey`. Matches “create succeeds, filterKey lost”.
- Expensive unescaped LIKE scans under production load (timeout → 5xx) — **POSSIBLE, NOT_VERIFIED.** Wildcard leak (below) made `%%`-style searches full-table scans.
- PRODUCTION_LOG_EVIDENCE / PRODUCTION_DB_SCHEMA / PRODUCTION_API_RELEASE — **NOT_VERIFIED** (no production access this session). Operator runbook below.

### Proven Defect Fixed: LIKE wildcard leak

- Prisma `contains` through `@prisma/adapter-mariadb` does **not** escape LIKE metacharacters. Verified over HTTP: `s%l` and `s_l` matched "sml"; `%%` and `__` matched the entire table. Correctness bug plus a full-scan cost amplifier.
- Fix: `escapeAdminVideoSearchLike()` in `src/videos/utils/video-search.util.ts`, applied in `videos.service.ts` `buildVideoWhere` and `admin-websites.service.ts` `buildWebsiteVideoListWhere`. Cache keys and the short-search guard keep using the unescaped normalized value. Re-verified over HTTP after rebuild: wildcards now match literally (0 rows), `sml` still matches.

### filterKey End-To-End (current source)

- HTTP matrix against the local API: manual JSON (`"SML"` normalized → `sml`), embed JSON, manual-with-thumbnail multipart, LOCAL_FILE init (session `metadataJson.filterKey = "sml"` confirmed in DB), PATCH update, DB persisted values, `?filterKey=` list filtering, reserved `all` → 400. All create DTOs carry `filterKey` (thumbnail variants inherit from the base DTOs). Every fixture cleaned up afterward.

### Changed

- `src/videos/utils/video-search.util.ts` (+`escapeAdminVideoSearchLike`), `src/videos/videos.service.ts`, `src/admin-websites/admin-websites.service.ts`, `test/admin-video-search.test.ts` (+4 tests: escape unit cases and where-clause assertions).

### Verified

- `db:local:generate/validate/status` (16/16 migrations applied), typecheck, lint (0 errors; 86 pre-existing warnings), **tests 125/125**, build, format:check, `git diff --check` — all pass.

### Deployment Required (operator, in order)

1. Back up the production DB and record current release identifiers.
2. Deploy the API build; run `yarn db:migrate:deploy`; **restart the Node process**; confirm `prisma migrate status` is clean.
3. Smoke: plain list, `search=sml`, `search=s%l` (expect literal, not wildcard), create with `filterKey`.
4. Then deploy Admin `dist` atomically and purge Cloudflare cache; verify `index.html` references the new hashed chunks (mixed old/new chunks reproduce Incident B).
5. If 500s persist, grep API logs for `P2022` (schema drift) vs timeout/pool errors (load) — the matrix above maps each signature to its fix.

### Rollback

- Admin: restore the previous `dist` (static). API: previous build remains compatible — migrations are additive; do **not** drop columns during the incident window. No DB reset.

## 2026-07-16 — OWNER account management, password lifecycle and session isolation

### Goal And Verified Behavior

- Add OWNER-only ADMIN/STAFF lifecycle management without physical account deletion, cross-account session revocation or reuse of the bootstrap/shared-password boundary.
- Existing access tokens remain DB-session-bound. Login and refresh now recheck ACTIVE/non-deleted account state inside Serializable transactions; temporary-password expiry is revealed only after correct credentials. Forced accounts may access only `/me`, `change-own-password` and logout until the password is changed.

### Implementation

- Added one additive migration for `mustChangePassword`, password/temp/deletion timestamps and bounded account/session/token indexes. Existing accounts default to no forced change and no lifecycle timestamps; no existing role/password/session was backfilled or revoked.
- Added `AdminAccountsModule` with explicit OWNER metadata on every route, a Production-default-off feature gate, current-OWNER password step-up, ADMIN/STAFF-only create/role policy, optimistic timestamp CAS, target-scoped revoke, temporary password reset, and logical delete that preserves account/audit/upload/session history. Create/reset responses are `no-store` and return the generated password once.
- Added own-password and own-session endpoints. Password change hashes outside the transaction, rechecks the password snapshot, clears forced state, and revokes only that account. The deprecated shared-secret endpoint remains available but Admin Web no longer uses it.
- Bootstrap/seed is initial-owner-only and never upserts, promotes or resets an existing account. Credential normalization/hash/password policy/temp generation is centralized.
- Added read-only masked account audit and dry-run-by-default bounded session cleanup. Cleanup apply requires an exact environment confirmation and never deletes account/audit/active-session rows.
- Added an operational rollout/rollback runbook and a local-only smoke that creates ADMIN/STAFF fixtures, performs 20 controlled logins without printing credentials, verifies target session isolation, then disables and logically deletes the fixtures.

### Database And Local Evidence

- `20260716130000_admin_account_management` was applied to the local MySQL database; all 16 migrations are up to date. Production was not accessed.
- Local read-only audit after smoke: one active OWNER, no normalized username conflicts, no deleted ACTIVE account, and no active session/token/upload relation on deleted fixtures. Four smoke accounts are retained as logically deleted audit fixtures by design (two ADMIN, two STAFF across two smoke executions).
- Final 20-login sample: p50 298.44 ms, p95 301.90 ms. Account list has a regression assertion for exactly two DB queries per page independent of page size; no percentage improvement is claimed.

### Commands And Verification

- `yarn install --frozen-lockfile`, Prisma generate/validate/status, typecheck, build, format check and `git diff --check`: passed.
- `yarn test --runInBand`: 121/121 passed in 33 suites. New coverage includes OWNER-only route inventory, service role defense, duplicate-create race, temp expiry/forced guard, login/refresh disable races, fixed two-query list shape, target isolation and logical-delete upload blocking/history retention.
- `yarn lint`: 0 errors and 86 `consistent-type-imports` warnings. Decorated DTO/Swagger/provider imports were deliberately retained at runtime; no blind import-type autofix was used.
- Built API started successfully, mapped all account/auth routes, connected Prisma, returned health/readiness 200 and unauthenticated account/session 401, then the owned process was stopped. Nest continues to emit the existing wildcard-route auto-conversion warning.
- `yarn audit --groups dependencies --level moderate` was UNVERIFIED because the Yarn registry audit endpoint returned HTTP 410. No npm/pnpm lockfile exists.

### Known Limitations And Manual Actions

- Production remains conditional: run the account audit with a read-only Production principal, review index lock risk, deploy migration with the feature flag off, and complete real OWNER/ADMIN/STAFF plus multi-device/browser staging acceptance before enabling it.
- Hostinger/Cloudflare, backup/restore, existing legacy share-link decisions and deployed public artifacts remain separate gates. Rollback must keep forced-change enforcement for any forced account or disable/revoke it first.

### Next Recommended Prompt

- “Run a read-only Production account audit, review the additive migration/index lock risk, then stage OWNER create/reset/disable/delete, ADMIN/STAFF permissions and independent browser-session isolation with the feature flag still off in Production.”

## 2026-07-16 — Website-scoped share-link video assignment incident

### Goal

- Fix the demonstrated Dashboard/API mismatch without weakening the invariant that a share-link video must have an ACTIVE same-site assignment and be READY/playable.

### Root Cause And Local Data

- Dashboard selected from global `GET /admin/videos`; its cache key and request lifecycle had no website/assignment scope, and switching websites retained selected IDs. The create service correctly rejected the exact incident video because its `WebsiteVideo` row was missing.
- Read-only exact-pair audit found masked website `cmrhv25e` ACTIVE with one active domain and masked video `89c3f4a1` READY/playable LOCAL_FILE, no same-site or other-site assignment, and no pre-existing share-link reference.
- Under the explicit incident instruction, the local-only guarded remediation called `AdminWebsitesService.assignSingleVideo`. The assignment is now ACTIVE and the audit event was written in the same Serializable transaction. Production was not accessed or mutated.
- Full local audit still finds two unrelated ACTIVE legacy links with missing same-site assignments; both require owner review. The audit intentionally exits 2 while those cases remain.

### Implementation

- Extended existing `GET /admin/websites/:websiteId/videos` with validated pagination/search/filter/provider/source/status/sort/assignment/eligibility query parameters, nested safe video data and additive pagination/eligibility metadata.
- Added idempotent `POST /admin/websites/:websiteId/videos/assign` for an explicit single-video create/reactivation. It validates ACTIVE website plus READY/playable video, retries bounded Prisma write/serialization conflicts, uses the unique pair, and writes audit in-transaction.
- Share-link create now validates all IDs in one query, returns stable `VIDEO_NOT_ACTIVE_FOR_WEBSITE` details, preflights before work and rechecks website/assignment/video eligibility in a Serializable create transaction. Public watch continues to recheck the same-site assignment.
- Expanded the read-only audit with exact-pair output and bounded legacy-compatibility counts/samples. Added a Production runbook; universal backfill is explicitly forbidden.
- Added local-only, confirmation-gated remediation and smoke scripts. The smoke created a temporary link, verified valid watch, assignment removal generic-invalid, explicit restore recovery, and revoked the temporary link without printing its credential.

### Commands And Verification

- `yarn db:local:generate`, `yarn db:local:validate`, `yarn db:local:status`, `yarn typecheck`, `yarn build`, `yarn format:check`, focused Prettier and `git diff --check`: passed; 15 migrations are up to date and no migration was added for this incident.
- `yarn lint`: 0 errors and 76 existing `consistent-type-imports` warnings.
- `yarn test --runInBand`: 110/110 passed in 32 suites.
- `yarn install --frozen-lockfile`: passed. `yarn audit --groups dependencies --level moderate` could not complete because the Yarn registry audit endpoint returned HTTP 410; dependencies were not changed by the incident fix.
- Built artifact started successfully; health/readiness returned 200 and the new scoped list/assignment routes returned 401 without credentials. The owned process was stopped. Local application-service smoke passed as described above.

### Known Limitations And Manual Actions

- Production compatibility is unverified until an operator runs the audit with a read-only Production principal and owners decide each affected legacy case. Do not infer assignment intent from old share-link rows.
- Staging must still verify the Admin Web with real roles, browser request cancellation, Hostinger/Cloudflare playback, backup/restore and large-file gates.

### Next Recommended Prompt

- “Run the share-link assignment audit against Production using a read-only principal, prepare masked owner decisions for every affected link, then stage the API before the website-scoped Admin Web; do not apply universal backfill.”

## 2026-07-14 — Read-only share-link assignment remediation worksheet

### Goal

- Produce an owner-review worksheet and a reusable read-only audit for hardened same-website assignment policy without changing share links, assignments, videos, websites, domains or Production data.

### Current Behavior And Findings

- The local database contains two ACTIVE, unexpired links with one LOCAL_FILE video each. Both videos are READY and playable, their website and one domain are ACTIVE, but neither video has a same-site `WebsiteVideo` row or an assignment on another website.
- Both active links therefore have zero READY, playable, ACTIVE-assigned videos under the hardened policy. Identifiers and aliases are masked in all worksheet/audit output; token and token-hash fields are not selected.
- Production data was not queried. The worksheet recommends owner review only; no assignment was created/activated and no link was revoked.

### Files Changed

- Added `scripts/audit/share-link-assignment-audit.ts` and `scripts/audit/share-link-assignment-audit-core.ts` for bounded Prisma `findMany` reads, masked output, `--counts-only`, and exit code 2 when affected active links exist.
- Added `test/share-link-assignment-audit.test.ts` for query-independent classification and masking behavior.
- Added `docs/operations/share-link-assignment-remediation-worksheet.md` with the two masked local cases and non-executable remediation/compensation plans.
- Added the `audit:share-link-assignments` Yarn script. No schema, migration or database data changed in this workstream.

### Commands And Verification

- `yarn audit:share-link-assignments --counts-only`: expected exit 2; inspected 2 links/2 rows, found 2 missing same-site assignments and 2 affected active links, with zero inactive/other-site/partial/non-playable/disabled-context cases.
- `yarn typecheck`, `yarn build`, `yarn format:check`, `yarn db:local:validate`, focused Prettier and `git diff --check`: passed.
- `yarn lint`: zero errors and 74 existing `consistent-type-imports` warnings.
- `yarn test --runInBand`: 103/103 tests passed in 31 suites, including 2 new audit tests.
- No npm/pnpm lockfile was present. No Production database command was run.

### Known Limitations And Manual Actions

- Owner must decide whether each missing assignment is legitimate, stale fixture data or grounds to revoke the link, then use a backed-up, audited and validated application-level remediation.
- A Production operator must run the audit against an explicitly selected read-only Production connection; Hostinger/Cloudflare, 500MB upload and backup/restore acceptance remain separate gates.

### Next Recommended Prompt

- “With owner approval and a recorded backup, remediate only the approved masked share-link cases through audited application service operations, then rerun the read-only assignment audit and public-watch smoke checks.”

## 2026-07-14 — Independent Production hardening verification

### Goal

- Independently verify the uncommitted hardening diff, dependency graph, local data compatibility, public/admin consumer compatibility, tests, and runtime before a GO/NO-GO decision.

### Verification Findings

- The hardening scope contained 54 paths before this review: 44 tracked modifications and 10 new files, all within backend config/source/tests/docs/migration scope. No old migration was changed or deleted, and no npm/pnpm lockfile or tracked build artifact was found.
- Auth refresh CAS, session-family replay revocation, session-bound logout, Serializable bootstrap, assignment enforcement, generic public errors, limited media grants, proxy-peer validation, request redaction, readiness, dependency patches, and seven additive indexes were confirmed in live code.
- Read-only local data audit found two active share links whose two video rows have no matching same-website assignment. Both links would be invalid under the new policy. No data was changed.
- Local admin data contains one OWNER and no ADMIN/STAFF accounts. The Admin Web source recognizes roles but does not hide mutation controls for STAFF or purge for ADMIN.
- The active public consumer source uses backend-returned playback/thumbnail URLs and preserves the media-grant query, but the actually deployed public artifact was not verified.
- LOCAL_FILE static traversal/symlink checks pass, but OS-level TOCTOU remains a residual risk that depends on private-root ownership and permissions. Successful-media HEAD/client-abort behavior still requires staging verification.

### Corrections Made After Initial NO-GO Matrix

- Changed `AdminRolesGuard` to deny missing role metadata and added explicit read/write metadata to all 50 guarded admin resource routes; purge remains OWNER-only.
- Added a route-inventory regression test so any future guarded admin route without explicit roles fails the suite.
- Enforced strict canonical base64url alphabet, signature length, and payload re-encoding for public media grants; added a signed non-canonical payload regression test.

### Commands And Results

- Git scope/diff/check and lock/artifact scans: passed; no pre-existing migration was modified.
- Read-only Prisma/SQL data audit: completed without printing token or secret values.
- `yarn install --frozen-lockfile`: passed and reported already up to date.
- `yarn audit --groups dependencies --level moderate`: zero vulnerabilities across 461 packages; the intentional Prisma CLI Hono resolution warning remains.
- `yarn db:local:generate`, `yarn db:local:validate`, `yarn db:local:status`: passed; 15 migrations are up to date.
- `yarn typecheck`, `yarn build`, `yarn format:check`, and `git diff --check`: passed.
- `yarn lint`: zero errors and 74 `consistent-type-imports` warnings.
- `yarn test --runInBand`: 101/101 tests passed in 30 suites.
- Targeted tests passed for auth/RBAC/grants/errors, public assignment/generic responses, filesystem/upload/Range, and cache.
- Built-artifact smoke on an isolated port: health/readiness 200, unauthenticated admin read/write 401, invalid public media HEAD 404, request token redacted in logs, then the owned process was stopped.

### GO/NO-GO

- Repository implementation is conditionally acceptable after the two corrections, but immediate Production deployment remains NO-GO until the two affected active links are deliberately remediated or accepted, Admin Web role controls are updated, deployed public artifacts are confirmed, and Hostinger/Cloudflare/large-file/backup acceptance is completed.

### Next Recommended Prompt

- “Prepare a read-only data-remediation worksheet for the two affected active share links, then update the Admin Web to hide all mutations for STAFF and purge for ADMIN; do not modify share-link assignments without owner approval.”

## 2026-07-14 — Production hardening audit implementation

### Goal

- Implement the verified auth, public-watch, LOCAL_FILE, proxy, logging, readiness, dependency, search, and index hardening plan without changing route names, methods, API prefix, Swagger path, or existing response fields.

### Current Behavior And Findings Addressed

- Refresh rotation now claims the old token with transaction CAS; concurrent replay revokes the session/token family.
- Logout is bound to the access-token `sid`, revokes the entire session, and propagates database failure instead of returning false success.
- Bootstrap registration defaults off in Production and uses a bounded Serializable transaction retry; login uses a dummy bcrypt hash for missing/disabled accounts.
- Database-backed RBAC makes STAFF read-only, ADMIN write-capable but unable to purge, and OWNER purge-capable.
- Share links require ACTIVE website video assignments. Invalid public-watch reasons return the same `INVALID_LINK` response.
- Max-view-limited watch responses issue HMAC grants bound to share link, video, host, purpose, and expiry; limited media rejects missing/tampered grants while the final admitted view can keep seeking.
- Public media/watch/view paths re-check ACTIVE assignments. Request logs redact path token, query token/grant, and omit route params.
- LOCAL_FILE rejects traversal and symlink escape, uses exclusive randomized chunk candidates, CAS upload states, atomic staging rename, recoverable merge failure, free-space reserve, MIME magic checks, safe stream abort/HEAD handling, and protected COMPLETING sessions.
- Cloudinary video upload uses disk-backed temporary files instead of Multer memory storage.
- Trusted proxy mode requires Production CIDRs; `CF-Connecting-IP` is accepted only from a matching immediate peer. Production CORS rejects local/insecure admin origin.
- Remote metadata probing uses the exact Production host allowlist and re-checks DNS/public IP before each request.
- Global request IDs, a generic 500 exception filter, and `/api/v1/health/ready` DB/storage readiness were added.
- Multer/Nest/Swagger dependencies were patched; Yarn audit is now clean.

### Files Changed

- Runtime/config: `package.json`, `yarn.lock`, `.env.example`, `.env.local.example`, `src/main.ts`, `src/app.module.ts`, `src/config/**`, `src/common/**`, `src/security/**`, `src/health/**`.
- Auth/RBAC: `src/admin-auth/**`, `src/admin-websites/**`.
- Public access: `src/public/**`.
- Video/storage: `src/videos/**`, `src/cloudinary/cloudinary.service.ts`.
- Database: `prisma/schema.prisma`, `prisma/migrations/20260714050000_production_hardening_indexes/migration.sql`.
- Tests: existing auth/public/storage/purge tests plus `test/security-hardening.test.ts`, `test/share-link-scope.test.ts`, and `test/upload-concurrency.test.ts`.
- Docs: architecture, auth/env/security verification, Cloudflare, LOCAL_FILE, deployment runbooks, and this session log.

### Migration

- Added seven backward-compatible indexes for website/domain/share lists and split upload cleanup query shapes.
- No columns were dropped/renamed, no data backfill was required, and the migration was applied to the local DB with `yarn db:local:deploy` without reset.
- Local EXPLAIN selected the five list indexes. The tiny local upload-session table preferred its single-status index automatically; forced composite-index EXPLAIN confirmed range/index-only access for both cleanup indexes. Re-run unforced EXPLAIN on representative staging data.

### Commands And Verification

- Git safety checks and `git diff --check`: passed.
- `yarn db:local:generate`, `yarn db:local:validate`, `yarn db:local:deploy`, `yarn db:local:status`: passed; 15 migrations applied/up to date.
- `yarn typecheck`: passed.
- `yarn lint`: passed with 74 intentional/pre-existing `consistent-type-imports` warnings and zero errors; runtime Nest decorator/DI imports were not auto-converted.
- `yarn test --runInBand`: 98/98 tests passed in 30 suites.
- `yarn build`: passed; Prisma Client 7.8.0 generated.
- `yarn format:check`: passed.
- `yarn audit --groups dependencies --level moderate`: zero vulnerabilities across 461 packages; Yarn reports the intentional Hono resolution mismatch warning.
- Lock scan: no `package-lock.json` or `pnpm-lock.yaml`.
- Runtime smoke: Nest modules/routes/Prisma initialized; `/api/v1/health` and `/api/v1/health/ready` returned 200, hostile Origin received no allow-origin header, 404 shape remained compatible, and graceful shutdown completed.

### Known Limitations And Manual Actions

- Production remains conditionally ready until actual Hostinger storage permissions/location, proxy CIDRs/direct-origin restriction, Cloudflare Range/abort/cache behavior, 500MB upload/resume/cancel/complete, synchronized DB/filesystem backup and restore, WAF/rate limits, and Production smoke are verified.
- The cache and throttler remain process-local and are not suitable for consistent multi-instance enforcement.
- Crash after DB purge commit but before physical cleanup can leave an audited orphan for operator cleanup; database reset is not an acceptable recovery.
- DNS rebinding risk is reduced by exact allowlist plus repeated public-IP checks, but representative Production network testing is still required.
- No representative large Production dataset benchmark was available; no performance percentage is claimed.

### Next Recommended Prompt

- “Use the Production deployment checklist to perform a staging acceptance run: configure real proxy CIDRs and private Hostinger storage, test 500MB upload/resume/cancel/complete, limited-grant playback with rapid Cloudflare seeking/abort, synchronized backup/restore, and capture evidence without exposing secrets.”

## 2026-07-04 — Continue Video filterKey safe purge verification

### Continued From

- Previous run hit the rate limit after implementing `VideoAsset.filterKey` and the safe video disable/purge/share-link disable flow.
- Continued from the existing dirty working tree without resetting, discarding, or rewriting stable implementation.

### Confirmed

- `VideoAsset.filterKey` exists as nullable `String? @db.VarChar(64)`.
- Additive migration `20260704034452_add_video_filter_key_and_safe_purge_flow` only adds the nullable column and `filterKey` indexes.
- DTOs expose optional `filterKey` for admin create, embed create, upload, DB upload, local upload init, update, and list query paths.
- `filterKey` normalization lowercases, converts spaces/hyphens to underscores, trims repeated/edge underscores, and rejects unsafe/reserved values such as `all`.
- Admin list filtering combines `filterKey` with existing status/provider/search/sort/pagination and includes `filterKey` in the admin video list cache key.
- Create/update/local-upload paths persist normalized `filterKey`; update can explicitly clear it to `null`.
- `VideoResponse` includes `filterKey`; public watch responses do not expose it.
- Disabling a video disables related active share links, including already-disabled videos with old inconsistent active links.
- Purge requires the video to already be `DISABLED`, blocks active website assignments, disables related active share links, detaches only that video's `ShareLinkVideo` rows, and audits safe counts.

### Fixed

- No code gaps were found in this continuation pass, so no implementation code was changed.
- Added this verification-focused session-log entry only.

### Verified

- `yarn prisma generate` passed.
- `yarn prisma validate` passed.
- `yarn typecheck` passed.
- `yarn lint` passed with warning-only `consistent-type-imports` findings and no errors.
- `yarn test` passed: 69 tests.
- `yarn build` passed.
- `git diff --check` passed.
- `git ls-files --others --exclude-standard | findstr /i "package-lock pnpm-lock"` produced no matches.
- `yarn dev:local` compiled, mapped routes, connected to local Prisma DB target, and reached `Nest application successfully started`.
- `yarn format:check` still fails on 67 pre-existing repository formatting issues.
- Focused Prettier check passed for task-touched filterKey/purge TypeScript files.

### Manual Smoke Test

- Ran a local API smoke with `.env.local` bootstrap credentials and kept the access token in memory only.
- Created temporary READY videos with `filterKey=sml` and `filterKey=msa`.
- Confirmed `GET /admin/videos` isolates `filterKey=sml` and `filterKey=msa`.
- Confirmed combined `search + filterKey` returns the expected temporary video.
- Confirmed list with no `filterKey` includes the temporary video.
- Confirmed PATCH normalizes `filterKey: "Judge Judy"` to `judge_judy`.
- Confirmed PATCH with empty `filterKey` clears the field to `null`.
- Confirmed purge of a READY video returns `400`.
- Disabled and purged the temporary videos successfully, leaving no smoke-test video records behind.
- Share-link disable and generic public invalid behavior were re-confirmed by automated tests, not by creating live local share-link fixtures in this pass.

### Pending

- Admin Web follow-up: add filter-key fields to create/edit forms and add filter UI.
- Production deploy: run `yarn prisma migrate deploy` only; never run reset or force-push Prisma commands.
- Production smoke after deploy: verify real share-link/video combinations so disabled/purged videos make related public watch links return no playable videos.

## 2026-07-04 — Video filterKey and safe purge/share-link disable flow

### Summary

- Added nullable `VideoAsset.filterKey` for admin video grouping/filtering.
- Added admin list filtering by `filterKey`, combined with existing status/provider/search/sort/pagination filters.
- Added `filterKey` to admin create, embed create, upload, DB upload, local upload init/complete, update, list DTOs, admin `VideoResponse`, and admin video list cache keys.
- Enforced `VideoStatus.DISABLED` before permanent purge.
- Disabling a video now disables related active share links, including old inconsistent rows when the video was already disabled.
- Purging a disabled video now disables related active share links, detaches that video's `ShareLinkVideo` rows, then deletes the video.

### Migration

- Created additive migration:
  `prisma/migrations/20260704034452_add_video_filter_key_and_safe_purge_flow/migration.sql`
- Migration adds:
  - `VideoAsset.filterKey String? @db.VarChar(64)`
  - `VideoAsset_filterKey_idx`
  - `VideoAsset_filterKey_status_createdAt_idx`
- Existing videos remain valid with `filterKey=null`; no backfill was added.
- Production deploy should use `yarn prisma migrate deploy` only.

### Files Changed

- `prisma/schema.prisma`
- `prisma/migrations/20260704034452_add_video_filter_key_and_safe_purge_flow/migration.sql`
- `src/videos/utils/video-filter-key.util.ts`
- `src/videos/dto/create-video.dto.ts`
- `src/videos/dto/create-embed-video.dto.ts`
- `src/videos/dto/upload-video.dto.ts`
- `src/videos/dto/upload-database-video.dto.ts`
- `src/videos/dto/init-local-video-upload.dto.ts`
- `src/videos/dto/update-video.dto.ts`
- `src/videos/dto/list-videos-query.dto.ts`
- `src/videos/types/video-response.type.ts`
- `src/videos/videos.service.ts`
- `test/admin-video-search.test.ts`
- `test/video-purge.test.ts`
- `test/public-local-thumbnail.test.ts`
- `docs/architecture/backend-context.md`
- `docs/operations/production-deployment-checklist.md`
- `session-log.md`

### Safety Notes

- `filterKey` normalization uses Unicode NFKC, trim, lowercase, spaces/hyphens to underscores, repeated underscore collapse, and leading/trailing underscore trim.
- Valid keys are lowercase letters, numbers, and single underscores between segments; `all` is reserved and rejected.
- Public watch response shapes were not expanded with `filterKey`.
- Share links disabled by video disable/purge are not auto-reactivated if the video returns to `READY`.
- Purge still keeps explicit confirmation and blocks active website assignments.
- Public invalid watch responses remain generic and do not reveal token/share-link status details.
- Existing in-memory cache invalidation remains broad for video mutations: admin videos, media metadata, and public watch prefixes are cleared.

### Verified

- `yarn db:migrate:dev --name add_video_filter_key_and_safe_purge_flow` passed.
- `yarn prisma generate` passed.
- `yarn prisma validate` passed.
- `yarn typecheck` passed.
- `yarn lint` passed with warning-only `consistent-type-imports` findings and no errors.
- `yarn test` passed: 69 tests.
- `yarn build` passed.
- `yarn dev:local` compiled, mapped routes, connected to the local DB target, and reached `Nest application successfully started`.
- `git diff --check` passed.
- `git ls-files --others --exclude-standard | findstr /i "package-lock pnpm-lock"` produced no matches.
- `yarn format:check` still fails on 67 pre-existing repository formatting issues.
- Focused Prettier check passed for task-touched TypeScript files.

### Pending

- Manual local smoke test with a valid admin token for:
  `GET /admin/videos?filterKey=sml`, `GET /admin/videos?filterKey=msa`, combined `search+filterKey`, PATCH `filterKey`, disable, and purge.
- Production deploy should apply migrations with `yarn prisma migrate deploy`, then test that disabling/purging videos makes related public watch links return no playable videos.
- Admin Web follow-up: add filter-key fields to create/edit forms and add admin filtering UI.

## 2026-07-04 — Fix NestJS DI runtime errors after memory cache work

### Root Cause

- `CorsOriginService` injected `PrismaService` but imported it with `import type`, so NestJS emitted the second constructor dependency as `Function` and could not resolve it at runtime.
- The same type-only runtime provider pattern was present in several constructor-injected services/controllers after import-style cleanup.
- With `emitDecoratorMetadata` enabled, DTO/controller service classes used by decorated routes also need runtime imports when Nest relies on metadata.

### Changed

- Restored runtime imports for constructor-injected providers:
  `PrismaService`, `JwtService`, `MemoryCacheService`, `CloudinaryService`, `VideoMetadataService`, `LocalVideoStorageService`, `VideoViewGrowthService`, `CorsOriginService`, and controller service dependencies.
- Restored runtime DTO imports in controllers where decorated route parameters need emitted metadata for validation/transform.
- Kept pure TypeScript-only imports, response types, config types, and helper callback types as type-only.
- Confirmed `SecurityModule` already imports `ConfigModule` and `DatabaseModule`, so no fake `Function` provider or security-loosening workaround was added.

### Verified

- `yarn typecheck` passed.
- `yarn dev:local` initially compiled but hit `EADDRINUSE` because an old local `dist/main` Node process was already bound to port 3000.
- Stopped that stale local API process, re-ran `yarn dev:local`, and confirmed Nest booted successfully with module initialization, route mappings, Prisma local DB connection, and `Nest application successfully started`.
- `yarn lint` passed with warning-only `consistent-type-imports` findings and no errors.
- `yarn test` passed: 59 tests.
- `yarn build` passed.
- `git ls-files --others --exclude-standard | findstr /i "package-lock pnpm-lock"` produced no matches.

### Pending

- Avoid running automatic ESLint import-type fixes blindly on decorated Nest controllers/services; some runtime imports are intentionally required for DI/metadata even when ESLint reports them as type-only.

## 2026-07-04 — Backend in-memory cache layer recovery

### Summary

- Continued the interrupted in-memory backend cache implementation from the existing working tree without discarding partial changes.
- Added an optional process-local TTL/LRU memory cache and short in-flight request dedupe for safe read-heavy metadata paths.
- Cached successful admin video list/search responses, admin website list responses, safe public watch metadata projections, and local media metadata only.
- Preserved MySQL as the source of truth and kept binary buffers, streams, Range responses, raw tokens, and invalid public responses out of cache.

### Interruption Recovery

- Inspected `git status --short`, `git diff --stat`, and the targeted working-tree diff before editing.
- Preserved existing partial files and left the interrupted patch snapshots untouched:
  `codex-interrupted-memory-cache-full.patch` and `codex-interrupted-memory-cache.patch`.
- Continued from the partial implementation instead of restarting or rewriting stable code.

### Root Cause of Typecheck Failure

- `src/cache/memory-cache.service.ts` passed a `number | undefined` value into `Math.max()` in the runtime numeric clamp helper.
- TypeScript did not narrow the optional value sufficiently through the existing integer check.
- Fixed by assigning a finite integer `numericValue` with a safe fallback before clamping.

### Files Changed

- `.env.example`
- `docs/architecture/backend-context.md`
- `docs/operations/production-deployment-checklist.md`
- `prisma/schema.prisma`
- `prisma/migrations/20260629024948_add_video_list_search_indexes/migration.sql`
- `src/app.module.ts`
- `src/cache/memory-cache-key.util.ts`
- `src/cache/memory-cache.module.ts`
- `src/cache/memory-cache.service.ts`
- `src/cache/memory-cache.types.ts`
- `src/config/env.config.ts`
- `src/config/env.validation.ts`
- `src/videos/dto/list-videos-query.dto.ts`
- `src/videos/utils/video-search.util.ts`
- `src/videos/videos.service.ts`
- `src/admin-websites/admin-websites.service.ts`
- `src/public/public.service.ts`
- `test/admin-video-search.test.ts`
- `test/admin-websites-cache.test.ts`
- `test/memory-cache.test.ts`
- `test/public-local-thumbnail.test.ts`
- `session-log.md`

### Cache Policy

- Cache is optional via `MEMORY_CACHE_ENABLED` and remains process-local; it is cleared on restart and is not shared across Hostinger Node processes.
- Runtime/env config clamps cache sizes and TTLs defensively.
- Admin video list/search cache key includes page, limit, normalized search, status, provider, sort field, and sort direction.
- Admin website list cache key includes page, limit, normalized search, normalized domain, domain group key, and status.
- Media cache stores local metadata only, such as storage key, MIME type, size, checksum/version, and updated timestamp; streams and buffers are still created fresh per request.
- Mutations invalidate relevant prefixes only after successful database writes.

### Safety Notes

- Public watch cache stores only short-lived successful metadata projections.
- Raw share tokens/aliases are not stored in cache keys; token-like parts are SHA-256 hashed.
- Invalid, revoked, expired, and max-view-limited public watch responses are not cached.
- Public watch cache hits still rebuild token-bearing media URLs for the current request, run the guarded `currentViews` update, and write access logs.
- Broad public watch in-flight dedupe was intentionally avoided because watch resolve has side effects.
- No Redis, MySQL cache tables, queue, paid service, or external cache infrastructure was added.

### Verified

- `yarn prisma generate` passed.
- `yarn prisma validate` passed.
- `yarn typecheck` passed.
- `yarn lint` passed with 68 warning-only `consistent-type-imports` findings and no errors.
- `yarn test` passed: 59 tests.
- `yarn build` passed.
- `yarn format:check` still fails on 78 pre-existing repository formatting issues.
- Focused Prettier write/check passed for the files changed in this cache task.
- `git ls-files --others --exclude-standard | findstr /i "package-lock pnpm-lock"` produced no matches.

### Pending

- Run production-like manual checks for repeated admin video list/search, admin website list, safe public watch, max-view-limited watch links, and LOCAL_FILE thumbnail/video streaming.
- Deploy API first. If the existing admin video search index migration is not already applied in production, run only `yarn prisma migrate deploy`.
- Confirm public watch repeats still write expected access logs/current-view updates in production logs/DB without exposing raw tokens.

## 2026-06-29 — Cross-project admin video search pipeline audit

### Summary

- Re-audited the backend `/api/v1/admin/videos` search implementation together with the Admin Web Dashboard picker behavior.
- Confirmed the backend search-hardening work already present in the working tree matches the intended production-safe contract.
- No additional backend code changes were needed in this pass beyond the existing uncommitted search-hardening files.

### Confirmed Backend Behavior

- Prisma datasource provider is MySQL.
- `/admin/videos` remains protected by admin access-token auth.
- The list endpoint uses `ListVideosQueryDto` and strict global validation.
- Admin video search is normalized with Unicode NFC, trim, whitespace collapse, and an 80-character cap.
- Non-empty search below 2 characters returns an empty page with `total=0` and does not call Prisma.
- Normal searches use MySQL-compatible Prisma `contains` filters on `title` and `slug`.
- No raw SQL, unsafe query concatenation, or PostgreSQL-only `mode: "insensitive"` search option is used.
- Pagination, provider/status filters, and sort allowlists remain in place.
- The default Dashboard query shape has an index via `@@index([status, createdAt])`.

### Verified

- `yarn typecheck` passed.
- `yarn lint` passed with existing warning-only `consistent-type-imports` findings and no errors.
- `yarn test` passed: 45 tests.
- `yarn build` passed and regenerated Prisma Client.
- `yarn prisma validate` passed.
- PowerShell equivalent of `db:migrate:status` passed and reported the local MySQL schema is up to date with 13 migrations.
- Repository-wide `yarn format:check` still fails on 78 pre-existing unrelated formatting issues.
- Focused Prettier check passed for the changed search TS files:
  `src/videos/dto/list-videos-query.dto.ts`, `src/videos/utils/video-search.util.ts`, `src/videos/videos.service.ts`, `test/admin-video-search.test.ts`.
- No `package-lock.json` or `pnpm-lock.yaml` was found in the Admin Web or API repo roots.

### Deployment Checklist

1. Deploy API first.
2. Run `yarn prisma migrate deploy` in production if `20260629024948_add_video_list_search_indexes` is not applied yet.
3. Restart the Hostinger Node/API process.
4. Deploy the rebuilt Admin Web.
5. Hard refresh Admin Web.
6. Test Dashboard search with `i`, `i fell`, special characters, clear search, and Load more.
7. Confirm no 500 responses from `/api/v1/admin/videos`.
8. Confirm the frontend sends no request for one-character search.
9. Confirm selected videos persist and share links can still be created.

### Pending

- Run the production manual checklist after API and Admin Web deployment.
- If production still returns 500 for valid multi-character search after deployment, capture the sanitized production stack trace and investigate DB timeout/connection limits as a separate incident.

## 2026-06-29 — Admin video search 500 hardening

### Summary

- Hardened `GET /api/v1/admin/videos` search handling for Dashboard/Admin Web server-side search.
- Added normalization and a two-character minimum for non-empty admin video searches.
- Short real searches such as `search=i` now return a safe empty page instead of querying MySQL.
- Normal searches such as `search=i%20fell` still search `title` and `slug` with Prisma `contains`.
- Tightened admin video `sortBy` allowlist to `createdAt`, `updatedAt`, `publishedAt`, and `title`.
- Added a composite index for the default Dashboard query shape: `status=READY&sortBy=createdAt&sortOrder=desc`.

### Root Cause

- The current admin video list search branch sent every non-empty trimmed `search` value directly into Prisma `contains` filters for `title` and `slug`.
- That meant one-character and wildcard-like values such as `i` or `%` still triggered database search/count work.
- Local reproduction against `.env.local` did not produce a 500, but it confirmed the unsafe behavior: one-character searches and `%` entered the search branch and hit the DB.
- Production 500s are consistent with this unbounded search branch becoming expensive or failing under real production data/DB conditions.
- Current source did not use raw SQL or Prisma `mode: "insensitive"`; the fix keeps the query MySQL/MariaDB-compatible and avoids unsupported Prisma search options.

### Search Normalization Rules

- Only strings are considered searchable.
- Search is normalized to Unicode NFC.
- Leading/trailing whitespace is trimmed.
- Repeated whitespace is collapsed to one space.
- Search text is capped at 80 characters.
- Empty or whitespace-only search behaves like no search and returns the normal list.
- Non-empty search shorter than 2 characters returns:

  ```ts
  {
    items: [],
    meta: { page, limit, total: 0, totalPages: 0 }
  }
  ```

### Files Changed

```txt
prisma/schema.prisma
prisma/migrations/20260629024948_add_video_list_search_indexes/migration.sql
src/videos/dto/list-videos-query.dto.ts
src/videos/utils/video-search.util.ts
src/videos/videos.service.ts
test/admin-video-search.test.ts
session-log.md
```

### Migration Note

- Added migration `20260629024948_add_video_list_search_indexes`.
- Migration SQL:

  ```sql
  CREATE INDEX `VideoAsset_status_createdAt_idx` ON `VideoAsset`(`status`, `createdAt`);
  ```

- Local migration was created/applied with `yarn prisma migrate dev --name add_video_list_search_indexes` under `.env.local`.
- Production deployment should use `yarn prisma migrate deploy`; do not use reset/db-push force commands.

### Verification Commands

```bash
yarn typecheck
yarn lint
yarn test
yarn build
yarn prisma validate
yarn prisma migrate status
yarn prettier --ignore-path .prettierignore --check src/videos/dto/list-videos-query.dto.ts src/videos/utils/video-search.util.ts src/videos/videos.service.ts test/admin-video-search.test.ts
rg --files -g "package-lock.json" -g "pnpm-lock.yaml"
git diff --check
```

### Verification Result

- `yarn.cmd typecheck` passed.
- `yarn.cmd lint` passed with the repo's existing warning-only `consistent-type-imports` findings and no errors.
- `yarn.cmd test` passed: 45 tests.
- `yarn.cmd build` passed and regenerated Prisma Client.
- `yarn.cmd prisma validate` passed with PowerShell-provided local env vars.
- `yarn.cmd prisma migrate status` reported the local DB schema is up to date with 13 migrations.
- Focused Prettier check passed for changed TS files.
- Repository-wide `yarn.cmd format:check` was run but still fails on 79 pre-existing unrelated formatting issues; changed TS files pass focused Prettier.
- npm/pnpm lockfile scan returned no files.
- `git diff --check` passed with Windows LF-to-CRLF working-copy notices only.

### Manual Local Test Results

Started the API locally against `.env.local`, logged in with local bootstrap credentials without printing the token, and called:

```txt
/api/v1/admin/videos?page=1&limit=24&status=READY&sortBy=createdAt&sortOrder=desc
/api/v1/admin/videos?page=1&limit=24&search=i&status=READY&sortBy=createdAt&sortOrder=desc
/api/v1/admin/videos?page=1&limit=24&search=i%20fell&status=READY&sortBy=createdAt&sortOrder=desc
/api/v1/admin/videos?page=1&limit=24&search=%25&status=READY&sortBy=createdAt&sortOrder=desc
```

Observed:

```txt
no search => 200, normal READY page
search=i => 200, items=0, total=0, totalPages=0
search=i fell => 200, results or empty result, no 500
search=% => 200, items=0, total=0, totalPages=0
```

Logs redacted the Authorization header during the manual test.

### Pending

- Deploy the backend build and migration to production.
- Re-test the same Admin Web Dashboard search requests against production with a valid admin session.
- If production still returns 500 for normal searches after this deploy, inspect the production stack trace for DB timeout/connection errors and consider a separate indexed/FULLTEXT search design.

## 2026-06-17 — Danny clean-path short-code fallback hardening

### Summary

- Hardened the Danny public route parser with a shared path/hash share-entry parser for `/s/<code>` and legacy `/watch/<token>` forms.
- Switched `index.html` to root-absolute `/assets/*` URLs so clean-path fallback pages such as `/s/<code>` load the correct CSS/JS from the site root.
- Kept `/s/assets/*` plus `/watch/assets/*` compatibility mappings in fallback configs for older cached relative shells.
- Added `dev-server.mjs`, a Node-only local SPA fallback server for testing `/s/<code>#/videos` without VS Code Live Server clean-path 404s.
- Kept the public site display-only and share-code/share-token-only; no admin UI or writable public flows were added.

### Root Cause

- The browser never sends `#/videos` to the server, so a URL such as `/s/<code>#/videos` first requests `/s/<code>`.
- Static servers without SPA fallback return `Cannot GET /s/<code>` before `assets/app.js` can run.
- CSP messages such as `default-src 'none'` on that URL are symptoms of the 404/error response, not the configured Danny site CSP.

### Files Changed

```txt
bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/assets/app.js
bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/index.html
bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/dev-server.mjs
bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/.htaccess
bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/_redirects
bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/PUBLIC_SECURITY_README.md
bom-media-api/session-log.md
```

### Verification Commands

```bash
node --check bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/assets/app.js
node --check bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/dev-server.mjs
grep -R "localStorage" bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/index.html bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/assets/app.js || true
grep -R "accessToken\|refreshToken\|Authorization\|Bearer" bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/index.html bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/assets/app.js || true
grep -R "/admin/" bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/index.html bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/assets/app.js || true
grep -R "/home/\|/var/\|/srv/\|/root/\|/etc/\|/opt/\|file:" bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/index.html bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/assets/app.js || true
PORT=5599 node bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/dev-server.mjs
curl -i http://127.0.0.1:5599/s/exampleCode
curl -i http://127.0.0.1:5599/assets/app.js
curl -i http://127.0.0.1:5599/assets/styles.css
curl -i http://127.0.0.1:5599/s/assets/app.js
curl -i http://127.0.0.1:5599/watch/assets/app.js
yarn prisma validate
yarn typecheck
yarn lint
yarn format:check
yarn test
yarn build
find /Users/monarch/Desktop/bom-media -maxdepth 4 \( -name package-lock.json -o -name pnpm-lock.yaml \) -print
```

### Verification Result

- Danny `assets/app.js` and `dev-server.mjs` syntax checks passed.
- Static grep checks returned no `localStorage`, admin auth token names, or `/admin/` media URL strings.
- Raw filesystem grep only matched existing `file:` local-development/media guard code.
- Local fallback server returned HTTP 200 and `index.html` for `/s/exampleCode`.
- Local fallback server returned HTTP 200 and JavaScript content type for `/assets/app.js`.
- Local fallback server returned HTTP 200 and CSS content type for `/assets/styles.css`.
- Local fallback server returned HTTP 200 and JavaScript content type for `/s/assets/app.js` and `/watch/assets/app.js`.
- Backend Prisma schema validation passed.
- Backend typecheck passed.
- Backend format check passed.
- Backend test suite passed: 37 tests.
- Backend build passed.
- Backend lint passed with existing warning-only `consistent-type-imports` findings.
- npm/pnpm lockfile search returned no files.
- Manual browser verification with a real short code is still required.

### Manual Test Notes

- Preferred production/root-local URL: `http://127.0.0.1:5500/s/<short-code>#/videos`.
- For reliable local clean-path testing, serve the Danny site folder as the web root with `PORT=5500 node dev-server.mjs`.
- If testing from a parent-folder static server, `index.html#/s/<short-code>/videos` can avoid the clean-path 404, but root `/assets/*` must still resolve to this site's assets.
- The public site should scrub visible `/s/<short-code>` or `#/s/<short-code>` after reading it and continue through `sessionStorage` for same-tab navigation.
- Legacy `?token=`, `?t=`, and `/watch/<token>` links must remain working.

### Security Notes

- Short visible codes weaken brute-force resistance compared with long opaque tokens; this remains a customer requirement.
- Backend host/domain validation, share-link status, expiration, max views, video membership, READY checks, public-media authorization, and throttling must remain enabled.

### Rollback Notes

- If short-code rollout fails before production migration, revert the alias-related code and fallback static-site changes, then rebuild/redeploy the backend and public site.
- If the alias migration has already been applied, take a fresh backup first; then either keep the nullable `ShareLink.alias` column unused while reverting URL generation to legacy `?token=` links, or restore the database from the pre-migration backup if a full rollback is required.
- Existing legacy `?token=` and `/watch/<token>` readers are intentionally still present, so rollback can be gradual without invalidating old links.

### Next Recommended Prompt

`Prompt — Browser-test Danny /s/<short-code> links against a real local share link and verify host/domain assignment`

## 2026-06-17 — Danny public site short-code route support

### Summary

- Verified the backend already has `ShareLink.alias`, short-link URL generation, and alias-first public watch/media/view lookup.
- Updated the Danny public static site so `/s/<short-code>` and `#/s/<short-code>` entry points are treated like share credentials while preserving legacy `/watch/<token>`, `?token=`, and `?t=` links.
- Added production SPA fallback templates for Hostinger/Apache/LiteSpeed and Cloudflare Pages-style hosting.
- Updated Danny public security documentation with supported entry points, local dev caveats, rewrite requirements, and the short-code security tradeoff.

### Root Cause

- Admin Web can generate `.../s/<short-code>#/videos`, but the Danny app only parsed `/watch/<token>`, `#/watch/<token>`, `?token=`, and `?t=`.
- Static servers without SPA fallback return a 404 for clean paths like `/s/<short-code>` before the app can boot. CSP errors such as `default-src 'none'` on that URL are usually from the server error response, not the Danny app.

### Files Changed

```txt
bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/assets/app.js
bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/index.html
bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/.htaccess
bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/_redirects
bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/PUBLIC_SECURITY_README.md
bom-media-api/session-log.md
```

### Verification Commands

```bash
node --check bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/assets/app.js
grep -R "localStorage" bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/index.html bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/assets/app.js || true
grep -R "accessToken\|refreshToken\|Authorization\|Bearer" bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/index.html bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/assets/app.js || true
grep -R "/admin/" bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/index.html bom-media-sites/mau-lam-xong/danny/refactored_danny_public_site/assets/app.js || true
yarn prisma generate
yarn prisma validate
yarn typecheck
yarn lint
yarn format:check
yarn test
yarn build
find /Users/monarch/Desktop/bom-media -maxdepth 4 \( -name package-lock.json -o -name pnpm-lock.yaml \) -print
```

### Verification Result

- Danny `assets/app.js` syntax check passed.
- Danny public static grep checks returned no `localStorage`, admin auth token names, or `/admin/` media URL strings in `index.html`/`assets/app.js`.
- Backend Prisma generate and validate passed.
- Backend typecheck passed.
- Backend format check passed.
- Backend test suite passed: 37 tests.
- Backend build passed.
- Backend lint passed with existing warning-only `consistent-type-imports` findings.
- npm/pnpm lockfile search returned no files.
- Manual browser verification with a real short code is still required.

### Manual Test Notes

- Preferred new link: `https://<public-domain>/s/<short-code>#/videos`.
- Hash-only local fallback when the dev server cannot rewrite clean paths: `http://127.0.0.1:5500/#/s/<short-code>/videos`.
- Legacy links should still work: `?token=<legacy-token>#/videos`, `?t=<legacy-token>#/videos`, and `/watch/<legacy-token>#/videos`.
- If a local link resolves to an invalid/empty watch response, confirm the backend share link is assigned to the exact host sent by the public site, such as `127.0.0.1:5500` versus the production domain.

### Security And Rollback

- Short visible codes weaken brute-force resistance compared with long opaque tokens; this is a customer-requested URL change. Keep public-watch throttling, host/domain validation, expiry, max-view limits, revocation, video membership checks, READY status checks, and protected media routes enabled.
- Rollback path: remove `/s/` parsing from the public site, remove the fallback files if they are not needed, and generate/share legacy token URLs until public sites are updated again.

### Next Recommended Prompt

`Prompt — Run Danny public site browser smoke test for /s/<short-code>, legacy links, LOCAL_FILE playback, and host/domain mismatch handling`

## 2026-06-17 — Short share-link aliases

### Summary

- Added nullable unique `ShareLink.alias` storage for short public share codes.
- New share-link creation now generates both the legacy full raw token and a short URL-safe alias; the raw token is still hashed into `tokenHash`, while the alias is stored for short-link lookup.
- New `publicUrl` values use `/s/<alias>#/videos` and no longer include `?token=`.
- Public watch, LOCAL_FILE thumbnail/playback, DB_BLOB playback, and public view tracking now try alias lookup first and fall back to legacy hashed token lookup.
- Admin share-link responses include the alias for operator visibility without exposing token hashes.

### Files Changed

```txt
prisma/schema.prisma
prisma/migrations/20260617000000_add_share_link_alias/migration.sql
src/admin-websites/admin-websites.service.ts
src/admin-websites/types/admin-share-link-response.type.ts
src/admin-websites/utils/share-url.util.ts
src/public/public.service.ts
test/public-local-thumbnail.test.ts
test/share-url-util.test.ts
session-log.md
```

### Verification Commands

```bash
yarn db:local:generate
yarn db:local:validate
yarn typecheck
yarn lint
yarn format:check
yarn test
yarn build
find . -maxdepth 3 \( -name package-lock.json -o -name pnpm-lock.yaml \) -print
```

### Verification Result

- Prisma generate and validate passed.
- Typecheck passed.
- Format check passed after formatting `src/admin-websites/admin-websites.service.ts`.
- Test suite passed: 37 tests.
- Build passed.
- Lint passed with the existing warning-only `consistent-type-imports` findings.
- npm/pnpm lockfile search returned no files.

### Manual Test Notes

- New link example: `https://<public-domain>/s/<short-code>#/videos`.
- Legacy link example still supported: `https://<public-domain>/?token=<legacy-share-token>#/videos`.
- Browser testing should confirm the public static site parses `/s/<short-code>` and sends that code to `POST /api/v1/public/watch/exchange` or legacy `GET /api/v1/public/watch`.
- If a static site only understands `/watch/<token>` or query tokens, it needs a small public-site parser update before `/s/<short-code>` links will load.

### Security And Rollback

- Short aliases are intentionally easier for customers to read and share, but they are weaker than long opaque share tokens because the searchable code space is smaller. Keep public-watch throttling, host/domain validation, expiry, max-view limits, and revocation enabled.
- Rollback path: stop issuing new short links by reverting the URL/generation code, then roll back or ignore the nullable `ShareLink.alias` migration. If the migration has already deployed and must be removed, back up the DB first, remove any dependent code, and apply a controlled migration/drop in staging before production.

### Known Limitations

- Existing share links are not backfilled with aliases in this pass; they continue to work through the legacy token fallback.
- No live browser/curl test with a real share link was performed in this session.

### Next Recommended Prompt

`Prompt — Update public static site token parser to support /s/<short-code> share links and run browser smoke tests`

## 2026-06-15 — Public watch exchange endpoint

### Summary

- Added `POST /api/v1/public/watch/exchange` for static public sites that already prefer the JSON exchange flow.
- The exchange endpoint uses the same `PublicService.resolvePublicWatch()` validation and response shape as legacy `GET /api/v1/public/watch`.
- Added a validated exchange body DTO requiring `host` and `token`.
- Added focused controller/DTO regression tests for route metadata, same response shape as legacy GET, generic invalid-token behavior, required body fields, no admin guard, and no `/admin/` media URLs in the sample public response.
- Updated LOCAL_FILE public playback docs to document exchange as preferred and legacy GET as fallback.

### Root Cause

- The public static bundle called `POST /public/watch/exchange`, but the backend only exposed `GET /public/watch` plus public media/view routes.
- The public client fallback kept playback working, but the missing backend route caused noisy `404 Not Found` responses.

### Files Changed

```txt
src/public/public.controller.ts
src/public/dto/public-watch-exchange.dto.ts
test/public-watch-exchange.test.ts
docs/architecture/local-file-video-storage.md
docs/operations/local-video-storage-runbook.md
session-log.md
```

### Commands Run

```bash
yarn db:local:generate
yarn db:local:validate
yarn typecheck
yarn lint
yarn format:check
yarn test
yarn build
find . -maxdepth 3 \( -name package-lock.json -o -name pnpm-lock.yaml \) -print
```

### Verification Result

- Prisma generate/validate passed.
- Typecheck passed.
- Lint passed with existing warning-only `consistent-type-imports` findings.
- Format check passed.
- Test suite passed: 33 tests.
- Build passed.
- npm/pnpm lockfile search returned no files.

### Manual Test Steps

- Pending local browser verification with a real public share token.
- Expected: `POST /api/v1/public/watch/exchange` returns HTTP 200 and no longer logs a 404 in DevTools.
- Expected: legacy `GET /api/v1/public/watch?host=...&token=...` still returns the same response shape.
- Expected: LOCAL_FILE thumbnails, playback, seeking, and public view tracking still work through public routes.

### Known Limitations

- This pass did not start a local API server or run real curl/browser checks with a real share token.
- Existing repo lint warnings were not refactored because they are unrelated warning-level import-type cleanup.

### Next Recommended Prompt

`PROMPT — Run end-to-end public site smoke test for exchange, LOCAL_FILE thumbnails, playback, seeking, and view tracking`

## 2026-06-15 — Public LOCAL_FILE thumbnail URL serialization fix

### Summary

- Fixed public watch serialization for LOCAL_FILE thumbnails so image thumbnail assets produce token-gated public thumbnail URLs.
- Added `publicThumbnailUrl` alongside existing `thumbnailUrl` without breaking clients that only read `thumbnailUrl`.
- Prevented public watch media fields from echoing `/admin/` media URLs for LOCAL_FILE playback/thumbnail responses.
- Added focused public thumbnail regression tests covering image thumbnails, invalid thumbnail fallback, public thumbnail streaming, and generic invalid-token behavior.

### Root Cause

- `toPlayablePublicVideos()` used the video asset validator for `localThumbnailAsset`.
- The validator required `mimeType.startsWith("video/")`, so valid thumbnails such as `image/jpeg` failed and the serializer fell back to the stored admin thumbnail URL.

### Files Changed

```txt
src/public/public.service.ts
src/public/types/public-watch-response.type.ts
test/public-local-thumbnail.test.ts
session-log.md
```

### Commands Run

```bash
yarn db:local:generate
yarn db:local:validate
yarn typecheck
yarn lint
yarn format:check
yarn prettier --check test/public-local-thumbnail.test.ts
yarn test
yarn build
find . -maxdepth 3 \( -name package-lock.json -o -name pnpm-lock.yaml \) -print
```

### Verification Result

- Prisma generate/validate passed.
- Typecheck passed.
- Lint passed with existing warning-only `consistent-type-imports` findings.
- Format checks passed, including the new test file.
- Test suite passed: 28 tests.
- Build passed.
- npm/pnpm lockfile search returned no files.

### Manual Browser Test Notes

- Pending real local browser/API verification with a READY LOCAL_FILE video, valid share link, and local thumbnail asset.
- Expected public watch result: `thumbnailUrl` and `publicThumbnailUrl` point to `/api/v1/public/watch/:token/videos/:videoId/thumbnail?host=...`.
- Expected public watch result: no LOCAL_FILE thumbnail/playback media field points to `/api/v1/admin/...`.

### Known Limitations

- This pass did not create live fixture data or perform a real share-token curl/browser test.
- Existing repo lint warnings were not refactored because they are unrelated warning-level import-type cleanup.

### Next Recommended Prompt

`PROMPT — End-to-end verify LOCAL_FILE public thumbnail rendering with a real share link`

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

## 2026-07-03 — Admin video search regression coverage

### Changed

- Preserved the existing safe `/admin/videos` search implementation:
  - MySQL Prisma provider.
  - `ADMIN_VIDEO_SEARCH_MIN_LENGTH = 2`.
  - normalized search capped to 80 characters.
  - one-character search returns an empty page without querying Prisma.
  - MySQL-compatible Prisma `contains` search over `title` and `slug`.
  - sort allowlist and default `status + createdAt` list index.
- Added regression coverage for the production `search=msa` failure case.
- Expanded special-character search coverage to include comma and slash in addition to `%`, `_`, quotes, backslash, parentheses, plus, and minus.

Files involved in the current search hardening worktree:

```txt
prisma/schema.prisma
prisma/migrations/20260629024948_add_video_list_search_indexes/migration.sql
src/videos/dto/list-videos-query.dto.ts
src/videos/videos.service.ts
src/videos/utils/video-search.util.ts
test/admin-video-search.test.ts
session-log.md
```

### Verified

- `yarn typecheck` passed.
- `yarn lint` passed with existing `consistent-type-imports` warnings only.
- `yarn test` passed: 46 tests.
- `yarn build` passed.
- `yarn format:check` was also run and failed on 78 pre-existing formatting warnings across unrelated API files; no repo-wide formatter was run to avoid unrelated churn.
- Lockfile scan found no `package-lock.json` or `pnpm-lock.yaml`.

### Pending

- Deploy API before Admin Web for this incident.
- If the index migration has not reached production, run production deployment with `yarn prisma migrate deploy` only; do not use destructive Prisma reset/push commands.
- Production smoke test `/admin/videos` with empty search, `i`, `msa`, `i fell`, `%`, `_`, quotes, comma, slash, backslash, plus, and minus.

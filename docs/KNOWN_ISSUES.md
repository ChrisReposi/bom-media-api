# Known Issues

Status: CURRENT
Last verified: 2026-08-23
Verified against: source inspection and a local verification run on 2026-08-21

Every entry here is backed by evidence a reader can re-check. **No speculative
vulnerabilities.** Nothing in this file was fixed as part of writing it — this is
a register, not a work queue.

Severity: `HIGH` (breaks production or exposes data) · `MEDIUM` (real risk or
real friction) · `LOW` (hygiene, correctness of documentation, cleanup).

| ID | Title | Severity | Component | Safe to defer? |
|---|---|---|---|---|
| [KI-001](#ki-001) | `/_api` proxy has no repository-level implementation (external, unverified) | MEDIUM | Deployment / public site | Must be verified per deployment |
| [KI-002](#ki-002) | Admin SPA uses the deprecated change-password endpoint | MEDIUM | Backend ↔ Admin | Yes |
| [KI-003](#ki-003) | Admin SPA performs no role-based UI gating | LOW | Admin | Yes |
| [KI-004](#ki-004) | `mustChangePassword` is unhandled by the Admin SPA | MEDIUM | Backend ↔ Admin | Yes, while account management is off |
| [KI-005](#ki-005) | Environment variables declared but read by nothing | LOW | Config | Yes |
| [KI-006](#ki-006) | All three repos have CI; admin still has no test suite | LOW | CI | Yes |
| [KI-007](#ki-007) | Large patch artefacts committed at the repository root | LOW | Hygiene | Yes |
| [KI-008](#ki-008) | 15 duplicated `" - Copy.ts"` DTO files are committed | LOW | Hygiene | Yes |
| [KI-009](#ki-009) | `AGENTS.md` contained two concatenated older documents | LOW | Docs | Fixed in this pass |
| [KI-010](#ki-010) | In-memory cache and throttler are per-process | MEDIUM | Scaling | Yes, single process only |
| [KI-011](#ki-011) | `format:check` fails on a CRLF checkout | LOW | Tooling | Yes |
| [KI-012](#ki-012) | Local-storage symlink test fails on Windows | LOW | Tooling | Yes |
| [KI-013](#ki-013) | Audit and access logs grow unbounded | MEDIUM | Operations | Yes, short term |
| [KI-014](#ki-014) | Backend endpoints with no shipped client | LOW | Product surface | Yes |
| [KI-015](#ki-015) | Provider/direct media URLs are outside backend revocation | MED | Design characteristic | Yes — must be communicated |
| [KI-016](#ki-016) | **Admin logout does not revoke the server session** | HIGH | Backend ↔ Admin | No |
| [KI-017](#ki-017) | Purge external cleanup is post-commit and best-effort | LOW | Backend | Yes |
| [KI-018](#ki-018) | Cloudinary upload can orphan a provider asset on DB failure | LOW | Backend | Yes |
| [KI-019](#ki-019) | Concurrent refresh is conservatively treated as replay | LOW | Design/risk note | Yes |
| [KI-020](#ki-020) | Unlimited LOCAL_FILE media authorization is cached | MED | Backend | Yes |

---

### KI-001

**`/_api` proxy has no repository-level implementation**

- Status: CURRENT · Severity: MEDIUM
- Classification: **EXTERNAL / NOT REPRESENTED IN REPOSITORY**
- **Repository-verified facts.**
  - `public_website/assets/app.js:571-579` — `resolvePublicApiBaseUrl()` returns
    `SECURITY_CONFIG.apiProxyBasePath` (`/_api`) whenever no explicit
    `window.SITE_API_BASE_URL` is configured and the hostname is not local.
  - `window.SITE_API_BASE_URL` is not set anywhere in this workspace.
  - No Worker script, rewrite rule or proxy configuration for `/_api` exists in
    any of the three repositories.
  - `public_website/PUBLIC_SECURITY_README.md` states that `_headers` sets
    headers only and does not create a reverse proxy.
- **What this does NOT establish.** It does not establish that any deployed
  customer site is broken. Proxy/routing for a deployed site is configured
  outside this workspace (Cloudflare Worker, host rewrite, or an injected
  `SITE_API_BASE_URL`), and this repository has no visibility into it.
- **Correct statement.** *Repository-level proxy implementation not found. The
  public application expects `/_api` when no explicit API base is configured.
  Actual production proxy/routing is external and unverified from this
  workspace.*
- **Direction.** Treat the mapping (`/_api/* → <api-origin>/api/v1/*`, plus
  `/_media/*` when used) as a required per-deployment external artefact, record
  it in that customer's deployment record, and verify it with
  `curl -sI https://<domain>/_api/public/watch` at deploy time. If instead an
  external API origin is used via `SITE_API_BASE_URL`, the public site's CSP
  `connect-src` must be widened to match.
- **Safe to defer?** Not deferrable as a *verification* step — confirm it per
  deployment. There is no code change to make in this repository.

### KI-002

**Admin SPA uses the deprecated change-password endpoint**

- Status: CURRENT · Severity: MEDIUM · Component: backend ↔ admin
- **Evidence.** `admin-auth.controller.ts:183` marks `POST
  /admin/auth/change-password` `deprecated: true`. `bom-media-admin/src/features/auth/authApi.ts:106`
  calls exactly that path, and `SettingsPage.tsx` collects a `secretCode` field.
  The replacement `POST /admin/auth/change-own-password` has zero references in
  the admin repository.
- **Impact.** Every admin who changes their password must know the operator
  secret `ADMIN_CHANGE_PASSWORD_SECRET`, which forces that secret to be shared
  and makes rotation disruptive. The deprecated route also cannot be used while
  `mustChangePassword` is set (it lacks `@AllowPasswordChangeRequired()`).
- **Direction.** Migrate the admin client to `change-own-password`, then retire
  the deprecated route in a later release.
- **Safe to defer?** Yes — the current path works.

### KI-003

**Admin SPA performs no role-based UI gating**

- Status: CURRENT · Severity: LOW · Component: `bom-media-admin`
- **Evidence.** A search for role usage across `bom-media-admin/src` finds
  `role` only in `authTypes.ts` (the type), `SettingsPage.tsx:379` (display) and
  unrelated ARIA attributes. No component branches on `OWNER`/`ADMIN`/`STAFF`.
- **Impact.** UX only. A `STAFF` user sees write buttons and receives `403` from
  the backend. Security is unaffected — `AdminRolesGuard` is authoritative.
- **Direction.** Add read-only presentation for `STAFF` and hide OWNER-only
  actions (purge, account management) for non-owners.
- **Safe to defer?** Yes.

### KI-004

**`mustChangePassword` is unhandled by the Admin SPA**

- Status: CURRENT · Severity: MEDIUM · Component: backend ↔ admin
- **Evidence.** `AdminAccessTokenGuard` returns `403` with code
  `ADMIN_PASSWORD_CHANGE_REQUIRED` for every guarded route unless the handler is
  decorated `@AllowPasswordChangeRequired()`. `admin-accounts.service.ts` creates
  accounts and resets passwords with `mustChangePassword: true`. In the admin
  repository, `mustChangePassword`, `ADMIN_PASSWORD_CHANGE_REQUIRED` and
  `ADMIN_TEMP_PASSWORD_EXPIRED` have **zero** references, and `SafeAdmin` in
  `authTypes.ts` omits the field the backend returns.
- **Impact.** An admin created or password-reset through `/admin/accounts` can
  log in but every subsequent admin call returns `403` with no UI path to change
  the password — an effective lockout. Bounded today because
  `ADMIN_ACCOUNT_MANAGEMENT_ENABLED` defaults to **false** in production.
- **Direction.** Add `mustChangePassword` to the admin type and a forced
  password-change screen that calls `change-own-password` (which *is*
  `@AllowPasswordChangeRequired()`), before enabling account management in
  production.
- **Safe to defer?** Yes, while account management stays disabled. **No**, the
  moment it is enabled.

### KI-005

**Environment variables declared but read by nothing**

- Status: CURRENT · Severity: LOW · Component: configuration
- **Evidence.** Verified by searching `src/`, `prisma/` and `scripts/` on
  2026-08-21: `VIDEO_PROVIDER`, `API_PUBLIC_BASE_URL`, `API_SELF_ORIGIN`,
  `SHARE_TOKEN_BYTES`, `DEFAULT_SHARE_LINK_EXPIRES_DAYS`,
  `DEFAULT_SHARE_LINK_MAX_VIEWS`, all `MUX_*`, and (in
  `.env.local` only) `PUBLIC_RENDERER_LOCAL_ORIGIN`,
  `PUBLIC_RESOLVE_ALLOW_MISSING_TOKEN`, `PUBLIC_SHARE_DEFAULT_PROTOCOL` have no
  reader. `VITE_API_BASE_URL` and `VITE_VIDEO_DB_UPLOAD_ENABLED` appear in the
  backend `.env` files but belong to the admin build;
  `VITE_VIDEO_DB_UPLOAD_ENABLED` is read by no admin code either.
- **Impact.** Operators reasonably assume setting `VIDEO_PROVIDER=bunny` or
  `SHARE_TOKEN_BYTES=64` changes behaviour. It does not. Silent no-ops are a
  configuration-drift and incident-analysis hazard.
- **Updated 2026-08-23.** The `BUNNY_*` family is no longer inert:
  `BUNNY_STREAM_ENABLED`, `BUNNY_STREAM_LIBRARY_ID`, `BUNNY_STREAM_API_KEY`,
  `BUNNY_STREAM_TOKEN_SECURITY_KEY` and the two TTL variables are read by
  `BunnyStreamService` and `env.validation.ts`. `BUNNY_STREAM_SIGNING_KEY` was
  removed from the templates. **`BUNNY_STREAM_PULL_ZONE_HOSTNAME` is also read
  since 2026-08-23** — thumbnail delivery is built from it, and it is required
  when Bunny is enabled. **No `BUNNY_*` variable is inert any more.**
- **Direction.** Keep `MUX_*` as a clearly-labelled reservation; remove or wire
  up the rest. Full table in
  [ENVIRONMENT.md](./ENVIRONMENT.md#15-declared-but-not-read-by-any-code).
- **Safe to defer?** Yes, now that they are documented.

### KI-006

**All three repositories have CI; the admin repository still has no test suite**

- Status: PARTIALLY RESOLVED · Severity: LOW · Component: CI
- **Resolved.** All three repositories now have a validation workflow:
  `backend / validate` (`bom-media-api`), `admin / validate`
  (`bom-media-admin`) and `public / validate` (`public_website`). Each runs on
  `pull_request` → `main`, `push` → `main` and `merge_group`, on Node 22.22.2,
  with `contents: read` and **no secrets**. `public_website` is under version
  control and runs its 64-test share-link compatibility suite plus the
  5-test resource-loading suite.
- **Remaining.** `bom-media-admin` still has no test suite —
  `"test": "echo \"TODO_TEST: ...\""` — so its workflow deliberately does not
  run `yarn test`. Typecheck, lint, format, build and build-smoke are the only
  gates there. Tracked in
  [`../../bom-media-admin/docs/KNOWN_ISSUES.md`](../../bom-media-admin/docs/KNOWN_ISSUES.md)
  KI-A05.
- **Remaining.** The checks are not yet configured as **required** status
  checks in GitHub branch protection. Until they are, a red run does not block
  a merge.
- **Direction.** After each workflow has run successfully on a real pull
  request, mark all three as required on `main`.
- **Safe to defer?** The branch-protection step, briefly. The admin test suite,
  yes.

### KI-007

**Large patch artefacts committed at the repository root**

- Status: CURRENT · Severity: LOW · Component: hygiene
- **Evidence.** `codex-interrupted-memory-cache.patch` (~107 KB) and
  `codex-interrupted-memory-cache-full.patch` (~160 KB) are tracked by git
  (`git ls-files` lists both), UTF-16 encoded, and describe a memory-cache
  feature that already exists in `src/cache/`.
- **Impact.** Repository noise; a future agent may mistake them for pending work
  and re-apply an outdated change.
- **Direction.** Confirm the content is fully represented in `src/cache/`, then
  remove them in a dedicated cleanup commit.
- **Safe to defer?** Yes.

### KI-008

**15 duplicated `" - Copy.ts"` DTO files are committed**

- Status: CURRENT · Severity: LOW · Component: hygiene
- **Evidence.** `src/admin-websites/dto/` contains 15 files whose names end in
  `" - Copy.ts"` (`create-website.dto - Copy.ts`, `update-domain.dto - Copy.ts`,
  …), all tracked by git. No file in `src/` imports any of them.
- **Impact.** They are compiled and linted, and they invite editing the wrong
  file. No runtime effect.
- **Direction.** Delete in a dedicated cleanup commit after confirming each has
  a live counterpart.
- **Safe to defer?** Yes.

### KI-009

**`AGENTS.md` contained two concatenated older documents**

- Status: RESOLVED (2026-08-21) · Severity: LOW · Component: docs
- **Evidence.** The previous `AGENTS.md` began with an `apps/api/AGENTS.md`
  monorepo-era document and then restarted with a second
  `# BOM Media API — Codex Agent Rules` heading. The first half described a
  `{ success, data, error }` response envelope that the code does **not**
  implement (see `GlobalExceptionFilter` and any controller), and a
  `VideoProviderService` abstraction that does not exist.
- **Impact.** An agent following it would have written responses in a shape no
  client expects.
- **Resolution.** `AGENTS.md` was rewritten in this documentation pass. The real
  response shape is recorded in [API_CONTRACTS.md](./API_CONTRACTS.md).

### KI-010

**In-memory cache and throttler counters are per-process**

- Status: CURRENT · Severity: MEDIUM · Component: scaling
- **Evidence.** `src/cache/memory-cache.service.ts` is an in-process map;
  `@nestjs/throttler` is configured with no shared storage in
  `src/security/throttle.config.ts`.
- **Impact.** Correct for a single Node process, which is the current
  deployment. Running N processes multiplies effective rate limits by N and
  gives each process its own cache, so an invalidation in one is not seen by the
  others.
- **Direction.** A shared store (Redis or equivalent) is a prerequisite for
  horizontal scaling. `PLANNED`, not implemented.
- **Safe to defer?** Yes, while deployment stays single-process. Record it in
  each customer's deployment notes.

### KI-011

**`format:check` fails on a CRLF checkout**

- Status: CURRENT · Severity: LOW · Component: tooling
- **Evidence.** `yarn format:check` flags 152 files locally.
  `git config core.autocrlf` is `true`; `file src/main.ts` reports CRLF
  terminators; `npx prettier --end-of-line auto --check src/main.ts` reports
  "All matched files use Prettier code style!". CI on `ubuntu-latest` passes.
- **Impact.** Local-only false failure. `yarn check` cannot be used as-is on a
  CRLF Windows checkout.
- **Direction.** Either set `endOfLine: "auto"` in `.prettierrc.json`, or add a
  `.gitattributes` with `* text eol=lf`. **Do not** reformat the tree.
- **Safe to defer?** Yes.

### KI-012

**Local-storage symlink test fails on Windows**

- Status: CURRENT · Severity: LOW · Component: tooling
- **Evidence.** `yarn test` → 219/220 pass; `test/local-video-storage.test.ts`
  "rejects symlink components and file targets under the storage root" fails
  with `EPERM: operation not permitted, symlink`.
- **Impact.** Local-only. The behaviour under test (symlink rejection) is real
  and passes on the Linux CI runner; only the test's *setup* cannot create a
  symlink without elevation.
- **Direction.** Enable Windows Developer Mode, or skip that suite locally and
  rely on CI. Do not weaken the assertion.
- **Safe to defer?** Yes.

### KI-013

**Audit and access logs grow unbounded**

- Status: CURRENT · Severity: MEDIUM · Component: operations
- **Evidence.** `AdminAuditLog` and `AccessLog` are written on every admin
  mutation and every public watch resolution. No pruning job, retention policy
  or archival exists in `src/` or `scripts/`. `yarn cleanup:admin-sessions`
  covers sessions only, and nothing schedules it.
- **Impact.** On a busy customer these become the largest tables, slowing
  backups and consuming storage on shared MySQL plans.
- **Direction.** Define a retention window, add an archival/prune job, and
  schedule the session cleanup. Coordinate with any evidence-retention
  requirement before deleting `AccessLog` rows.
- **Safe to defer?** Yes short term; monitor table sizes.

### KI-014

**Backend endpoints with no shipped client**

- Status: CURRENT · Severity: LOW · Component: product surface
- **Evidence.** Zero references in `bom-media-admin/src` to:
  `/admin/accounts/*`, `/admin/auth/sessions*`, `/admin/auth/change-own-password`,
  `/admin/videos/upload` (Cloudinary), `/admin/videos/upload-db`,
  `…/video-assignment-options`, `…/video-assignments`, `…/videos/assign`, and
  the canonical-share-link routes. The public site uses none of them.
- **Impact.** Real capability that is only reachable by operators via curl or
  scripts, and is therefore under-exercised and easy to break unnoticed.
  Notably, **Cloudinary video *upload* has no UI**. Cloudinary-provider records
  still arise without it: `resolveProvider()` assigns `provider: CLOUDINARY` to
  any `DIRECT_URL` video whose `playbackUrl` host ends with `cloudinary.com`,
  an explicit `provider` in the create body is honoured, and a Cloudinary player
  embed also sets it. What is missing is the *upload* path, not the provider.
- **Direction.** Decide per endpoint: expose in the admin UI, keep as a
  documented operator API (see the operations runbooks), or retire. Do not
  delete on the assumption that unused means dead.
- **Safe to defer?** Yes.

### KI-015

**Provider/direct media URLs are outside backend revocation**

- Status: CURRENT · Severity: MEDIUM · Type: **design characteristic**, not a
  coding defect
- **Evidence.** `public.service.ts` `toPublicVideoResponses()` builds
  grant-bearing backend URLs only for `DB_BLOB` and `LOCAL_FILE`. For every other
  source it returns `toSafePublicMediaUrl(video.playbackUrl)` (or `embedUrl`),
  and `toSafePublicMediaUrl()` returns the stored string unchanged apart from
  nulling URLs whose path contains an `admin` segment. No token, host binding,
  grant or expiry is attached, and no backend request occurs during playback.
  Cloudinary `secure_url` values are unsigned delivery URLs; Cloudinary
  signed/expiring delivery is not used anywhere in this codebase.
- **Impact.** For `DIRECT_URL`, Cloudinary `UPLOAD` and `EMBED` videos,
  revoking/expiring/exhausting a share link, disabling the website, or removing
  the `WebsiteVideo` assignment prevents future **watch resolution** but cannot
  invalidate a URL a browser already received. Such a URL remains usable for as
  long as the provider serves it. Backend-served media (`DB_BLOB`, `LOCAL_FILE`,
  thumbnails) is unaffected by this entry.
- **Direction.** Do not redesign provider security in a documentation pass. Two
  options exist for later: adopt a provider that supports signed, short-lived
  delivery URLs (see [adr/0007](./adr/0007-video-storage-direction.md)), or
  restrict share links whose videos are externally hosted. Meanwhile, state the
  limitation plainly in any customer-facing description of "revocable" links.
- **Safe to defer?** Yes as an engineering task — **no** as a communication
  task. Nothing should describe revocation as universal.

### KI-016

**Admin logout does not revoke the server session**

- Status: CURRENT · Severity: **HIGH** · Component: backend ↔ admin ·
  **CONFIRMED APPLICATION BUG**
- **Evidence.**
  - `bom-media-api/src/admin-auth/admin-auth.controller.ts:147` —
    `POST /admin/auth/logout` is `@UseGuards(AdminAccessTokenGuard)`.
  - `admin-auth.service.ts` `logout()` derives `adminId`/`sessionId` from the
    **access token** and explicitly discards the body (`void dto.refreshToken`).
  - `bom-media-admin/src/features/auth/authApi.ts:94` — the SPA calls it with
    `axiosBaseClient`.
  - `bom-media-admin/src/lib/api/axiosClient.ts` — interceptors are registered on
    `axiosClient` only (lines 49 and 71). `axiosBaseClient` (line 33) has
    **none**, so it sends no `Authorization` header. There is no
    `axios.defaults` Authorization anywhere in `src/`, and `getAuthAccessToken()`
    is exported but never consumed.
  - `authSlice.ts` `logoutAdminThunk` catches the failure, returns
    `revokeConfirmed: false`, and `logoutAdminThunk.fulfilled` clears local state
    regardless.
- **Impact.** Clicking "log out" clears the browser but leaves the
  `AdminSession` row and its refresh token active until natural expiry
  (`REFRESH_TOKEN_EXPIRES_DAYS`, default 30 days). Anyone who obtains the
  persisted refresh token from `localStorage` after a "logout" can still mint
  access tokens. It also means the documented mitigation for the
  `localStorage` refresh token is weaker in practice than on paper.
- **Note.** The backend is correct; the SPA integration is not. Do not "fix"
  this by making the backend accept the refresh token in the body — that would
  remove the authentication requirement from a revocation endpoint.
- **Direction.** Send the logout request through `axiosClient` (which attaches
  the Bearer token), or attach the header explicitly for this one call. Until
  then, operators can revoke via `POST /admin/accounts/:id/revoke-sessions`
  (OWNER, when account management is enabled) or wait out the expiry.
- **Safe to defer?** No.

### KI-017

**Purge external cleanup is post-commit and best-effort**

- Status: CURRENT · Severity: LOW · Type: design characteristic with reporting
- **Evidence.** `videos.service.ts` `purgeVideo()` runs a Prisma transaction that
  disables share links, detaches `ShareLinkVideo` rows, deletes the `VideoAsset`
  and writes `VIDEO_PURGE_COMMIT`. **After that transaction returns**, it calls
  `deleteRemoteAssetBestEffort`, `deleteOwnedThumbnailBestEffort` and
  `deleteStorageKeyBestEffort` twice, then computes `orphanCleanupRequired` and
  writes a `VIDEO_PURGE_STORAGE` audit row with `AuditStatus.FAIL` when anything
  failed.
- **Impact.** If external cleanup fails, the database row is already gone and the
  file or provider asset remains as an orphan that no future purge can find. The
  response still reports `status: "PURGED"`.
- **Mitigation already implemented.** The response carries `storage.*`,
  `remote.*` and `orphanCleanupRequired`, and the audit row is downgraded to
  `FAIL`. `scripts/storage/find-orphan-local-files.example.sh` reconciles the
  local storage root — but **not** orphaned Cloudinary assets.
- **Narrowed 2026-08-23 for Bunny only.** The Bunny remote delete was moved
  *before* the transaction, so an unreachable Bunny now aborts the purge with the
  local row intact instead of committing the delete and orphaning the Bunny
  asset. Bunny orphans are additionally discoverable with `yarn reconcile:bunny`.
  This entry still stands in full for Cloudinary and for local storage, which
  keep the post-commit best-effort ordering.
- **Direction.** Keep the ordering; deleting files before the commit would risk
  destroying assets for a transaction that then rolls back. Ensure operators
  actually read `orphanCleanupRequired`, and add Cloudinary-side reconciliation
  if Cloudinary use grows.
- **Safe to defer?** Yes.

### KI-018

**Cloudinary upload can orphan a provider asset on database failure**

- Status: CURRENT · Severity: LOW · Component: backend
- **Evidence.** `videos.service.ts` `uploadVideo()` is
  `try { … cloudinaryService.uploadVideo(…) … prisma.videoAsset.create(…) } finally { deleteTempUploadFile(…) }`.
  There is **no `catch`** and no compensating `deleteVideoAsset()` call. If
  `ensureUniqueSlug`, thumbnail resolution or `videoAsset.create` throws after
  the upload succeeded, the Cloudinary asset stays.
- **Impact.** An orphaned Cloudinary asset with no database record pointing at
  it — so purge cannot later remove it. Storage cost and manual cleanup, not a
  security issue. Bounded in practice because `POST /admin/videos/upload` has
  **no admin UI** (KI-014) and is reachable only by operators and scripts.
- **Direction.** Wrap the create in a `catch` that best-effort deletes the
  just-uploaded public id before rethrowing, mirroring the purge cleanup. Not
  fixed in this documentation pass.
- **Safe to defer?** Yes.

### KI-019

**Concurrent refresh is conservatively treated as replay**

- Status: CURRENT · Severity: LOW · Type: **design/risk note**, not a confirmed
  bug
- **Evidence.** `admin-auth.service.ts` `refresh()` claims the presented token
  with a conditional `updateMany(… revokedAt: null → now)` inside a
  `Serializable` transaction. When `claimed.count !== 1` it calls
  `revokeSessionForRefreshReplay()` and audits `ADMIN_REFRESH_REPLAY`. The admin
  SPA de-duplicates concurrent refreshes with a single in-flight promise
  (`refreshAccessTokenOnce`), but that guard is per JavaScript context.
- **Impact.** Two contexts holding the same refresh token — most plausibly two
  browser tabs, each with its own module instance reading the same persisted
  token — can race the rotation. The loser is treated as a replay and the
  **whole session** is revoked, surfacing as an unexplained logout.
  Distinguishing a real stolen-token replay from a benign race is not possible
  from the token alone, so failing closed is the correct default.
- **Direction.** Recorded so an unexplained logout is diagnosable
  (`ADMIN_REFRESH_REPLAY` rows are the signature). If it proves disruptive, a
  short grace window on the immediately-preceding token is the usual remedy —
  but it weakens replay detection and should be a deliberate decision.
- **Safe to defer?** Yes. This is *not* the cause of KI-016.

### KI-020

**Unlimited `LOCAL_FILE` media authorization is cached per process**

- Status: CURRENT · Severity: MEDIUM · Component: backend
- **Evidence.** `public.service.ts` `getAuthorizedPublicLocalVideo()` — the
  shared path behind both the `local-file` and `thumbnail` routes — checks
  `memoryCache` **before** any database query and before `hasValidMediaGrant()`.
  A result is stored only when `canCachePublicWatchShareLink()` passes, which
  requires `status === ACTIVE`, **`maxViews === null`**, and `expiresAt` further
  away than the TTL. TTL is `MEDIA_METADATA_CACHE_TTL_SECONDS` (default 300 s,
  bounded 1–3600). `getAuthorizedPublicDatabaseBinaryAsset` does **not** consult
  the cache.
- **Impact.** For an unlimited `LOCAL_FILE` share link, revoking the link or
  removing the `WebsiteVideo` assignment may not take effect on the media route
  for up to the TTL in a process whose cache was not invalidated. Same-process
  admin mutations do invalidate (`deleteByPrefix("media:metadata:")` in
  `admin-websites.service.ts` and `videos.service.ts`); direct SQL changes and
  other processes do not (see KI-010).
- **Why this is bounded.** View-limited links are excluded from caching, so a
  cache hit can never skip grant verification. `DB_BLOB` is never cached. The
  entry can never outlive the share link's own `expiresAt`.
- **Direction.** Documented rather than changed. Operators who need immediate
  revocation should revoke through the admin API rather than the database, and
  may lower `MEDIA_METADATA_CACHE_TTL_SECONDS` or set
  `MEMORY_CACHE_ENABLED=false`.
- **Safe to defer?** Yes, provided the window is documented — which it now is,
  in [SECURITY_MODEL.md §4.2](./SECURITY_MODEL.md#42-local_file-media-authorization-cache).

---

## Adding an entry


Include: title, status, severity, affected component, **evidence with a file
path or command output**, impact, recommended direction, and whether it is safe
to defer. If you cannot point at evidence, it does not belong here.

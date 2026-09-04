# Testing

Status: CURRENT
Last verified: 2026-08-23
Verified against: `package.json`, `test/`, `scripts/test/`, `.github/workflows/ci.yml`, and a full local run on 2026-08-21

## 1. Test stack

Node's built-in `node:test` runner, executed through `tsx`:

```
tsx --import ./test/test-env.ts --test test/*.test.ts
```

There is no Jest, no Vitest and no coverage tool. `test/test-env.ts` injects the
environment the suites need, so **no database is required** for `yarn test`.

## 2. Commands

```bash
yarn test
```

```bash
yarn typecheck
```

```bash
yarn lint
```

```bash
yarn build
```

```bash
yarn check
```

`yarn check` = `typecheck` → `lint` → `format:check` → `build`.

`prisma generate` must have run at least once (`src/generated/prisma` is
gitignored); `yarn build` does it for you.

## 3. What is covered

43 `test/*.test.ts` files, 877 tests as of 2026-08-28 (counted with
`ls test/*.test.ts | wc -l` and the runner summary). Grouped by concern:

| Area | Suites |
|---|---|
| Auth and sessions | `auth-hardening`, `security-hardening` |
| Share links | `share-link-scope` (including a Bunny block proving a Bunny-backed video passes the *same* eligibility gate, and that creation mints no playback URL), `share-url-util`, `share-link-assignment-audit`, `canonical-share-link` |
| **Canonical historical recovery** | `canonical-single-video-create` — the deterministic resolution of pre-canonical duplicate history, weighted towards what it must NEVER do. The **newest** exact single-video link is the identity and its **status is not a selection input**: a newer `REVOKED`/`DISABLED`/`EXPIRED` link is pinned and then DENIES, and the test asserts the older `ACTIVE` link was *not* promoted and nothing was minted — the two concrete revoke-bypasses. An all-`REVOKED` history mints nothing. A newest link carrying `expiresAt`, `maxViews` or a null `alias`, or already anchoring another pair, refuses with its own stable code and writes **no mapping, no replacement and no fallback**; the alias case then proves remediation works and resolves to the newest link, not the older one. `C-MINT-ONLY` is exhaustive: every restricted shape refuses, and only an empty history mints. Plus `createdAt DESC`/`id DESC` tie-break over five runs, bundle-cardinality proof with a *newer* bundle, 20-way concurrency on a healthy pair and 12-way on a revoked one, audit metadata carrying `adoptedStatus` and no credential, and four **TOCTOU** tests using a transaction-open hook (website disable, eligibility loss, domain disable, evidence-at-commit) plus a post-pin revoke race. `canonical-share-link` exercises the shared policy directly, including order-independence over four permutations with a revoked newest, and pins that a revoked winner is PINNABLE rather than blocked |
| **Share-link compatibility** | `share-link-compat-resolution`, `share-link-compat-providers`, `share-link-compat-media-delivery`, `share-link-compat-http`, `share-link-compat-cache-grants`, `share-link-compat-routes` — **release-blocking**, see [SHARE_LINK_COMPATIBILITY_TESTS.md](./SHARE_LINK_COMPATIBILITY_TESTS.md) |
| Public watch | `public-watch-exchange`, `public-local-thumbnail`, `public-bunny-thumbnail` |
| **Cache never caches authority** | `public-watch-cache-authority` (45 tests) — the two caches that sat in FRONT of the alias-free checks. Each test warms a cache with a request that SUCCEEDS, changes exactly one authority fact — revoked, disabled, expiry moved, domain disabled, website disabled, domain re-pointed, assignment removed, membership removed, video not READY — and requires the next identical request to FAIL. Covered for the watch cache on both alias-free origins, and for the media cache on GET, HEAD-equivalent, Range and the thumbnail route, plus token expiry and the capability kill switch. The legacy `#k` caches are asserted UNCHANGED in the same file, with a positive control proving repeated requests still succeed when nothing changed |
| **The golden `#k` contract** | `public-watch-golden-contract` — representative pre-feature success and denial bodies are fixed, in-source serialized JSON fixtures with property order. They never read Git, the filesystem, current `HEAD`, or generated output at runtime, so the golden remains historical after commit and in CI. `resumeGrant` is proved ABSENT (via `in`, not `=== undefined`) from canonical success, legacy GET, every denial and resume; it is present only on eligible compatibility success. |
| **Review session resume** | `public-watch-resume` — the non-consuming refresh. A grant is minted ONLY by the email-safe exchange and only for an unbudgeted link; canonical `#k` success and all denials omit the property entirely. Compatibility and resume bypass the watch cache and re-read authority on every request; resume increments `currentViews` by **zero**, and ten refreshes still leave the count at one. Revocation, disablement, expiry, host/website/domain changes, membership/assignment loss, non-READY video, deletion, and capability removal all deny immediately. Compatibility and resume responses are alias-free across LOCAL_FILE, DB_BLOB, embed, DIRECT_URL, Cloudinary and Bunny. Their per-video rmv1 tokens use `PUBLIC_WATCH_RESUME_SECRET` under `resume-media-v1|<normalized-host>`, are clamped to the originating review session, never read or write the legacy authorized-media cache, and die with the capability switch; legacy media grants retain `PUBLIC_MEDIA_GRANT_SECRET` and unchanged wire bytes. |
| **Public Bunny poster proxy** | `public-bunny-thumbnail` (54 tests) — the reviewer-facing 403 fix. The watch response returns the backend-protected route and **never** the raw pull-zone URL; a `bunny-malformed` or `remoteMissing` record exposes no poster at all; the route enforces the full chain (READY, ACTIVE assignment, membership, host, revoked/expired link) and the `maxViews` grant; **no request increments a view**, on GET or HEAD; the upstream boundary sends the **configured** `Referer` in `referer` mode and none in `none` mode, refuses to follow a redirect, and fails closed when `referer` mode has no usable value (asserted by the absence of any upstream call); upstream 403/404/5xx/timeout, a non-image or SVG content type, and an oversized body — declared **or** streamed past the cap — all become the same generic 404; and the URL validator refuses metadata endpoints, `file:`, `data:`, look-alike hostnames, credentials, ports, queries, fragments, wrong path shapes, a wrong video id and encoded traversal. The Bunny HTTP boundary is mocked with `globalThis.fetch`; **no test makes a real request** |
| Videos | `admin-video-search`, `video-purge` (including the **remote-first Bunny purge ordering**: the remote delete is observably issued before the local delete, an unconfirmed delete aborts with the row intact, a 404 counts as already-deleted, and a local transaction failure after a confirmed remote delete leaves the row present. Plus the **availability refusal**: a DISABLED Bunny video with an ACTIVE `WebsiteVideo` assignment purges remote-first when Bunny is available, and is refused with the stable `BUNNY_STREAM_UNAVAILABLE_FOR_PURGE` code — `reason: NOT_WIRED` or `NOT_ENABLED` — when it is not, leaving the video, the assignment and the share-link membership all intact with no `VIDEO_PURGE_COMMIT`; an explicit `deleteRemoteAsset: false` still purges locally with **zero** Bunny calls even while Bunny is unavailable), `video-view-growth`, `database-video-checksum`, `upload-concurrency` |
| Bunny Stream | `bunny-remote-missing` — the deletion lifecycle: an authoritative Bunny 404 preserves the local row, demotes `READY` to `FAILED` (`DISABLED` survives), writes the `metadataJson.bunnyStream.remoteMissing` marker, audits `FAIL`, invalidates all three cache prefixes and is idempotent; a **transient** 5xx or network error changes nothing at all and never demotes `READY`; a later success clears the marker and allows `FAILED → READY`; and a **signing spy proves the public path mints zero playback URLs** for a reconciled asset, never falls back to the stored unsigned URL, and excludes only the missing video from a multi-video share. `bunny-stream` — config gate, request construction, TUS and embed signing, status mapping, provider isolation, **signing strictly after atomic view consumption**, **fail-closed classification of the Bunny EMBED shape**, **feature-disabled network isolation**, thumbnail metadata read from `thumbnailFileName` (mocks carry **no** pre-built URL field), storage-structure URL construction, hostname and path-segment validation, and **the public signing path staying byte-identical when no player parameter is passed**. `bunny-admin-preview` — the authenticated admin signing endpoint: signed-URL shape, independently recomputed token, guard and read-role metadata, **`autoplay=false` for admin preview**, **zero signing calls on every refusal path**, and no secret in any response or message. `bunny-thumbnail-sync` — poster persistence on status sync, driving the **real** `BunnyStreamService.buildThumbnailUrl()` so production URL construction is what is asserted: fills an empty value, never overwrites an operator's, degrades to `NULL` while encoding or when no pull-zone hostname is configured, refuses traversal/path-bearing file names without failing the sync, and stores no playback credential. `bunny-custom-thumbnail` — the custom-poster endpoint: the exact Set Thumbnail path/method/`Content-Type`, server-side `AccessKey`, **zero Bunny calls** for a non-Bunny, malformed or non-`READY` asset, MIME + magic-byte + size rejection, the URL built from the file name Bunny reports back (never `thumbnail.jpg`), truthful failure, and write-role metadata. The Bunny HTTP boundary is mocked; **no test makes a real Bunny request** |
| Bunny DI wiring | `bunny-di-wiring` — pins that `VideosService` **and** `PublicService` import `BunnyStreamService` as a runtime **value**, using TypeScript's own parser rather than a regex. An `import type` is erased, so Nest's `design:paramtypes` entry degrades to a bare `Function`, and because the parameter is `@Optional()` the container injects `undefined` **silently** — which is exactly how every Bunny path on `VideosService` (upload-init, sync, thumbnail, admin preview, purge) came to fail with `400 "Bunny Stream is not enabled."` on a fully configured, Bunny-enabled server while public signing kept working. The compiled `dist/` metadata is asserted too when a build is present, and skipped when it is not (CI runs tests before `yarn build`) |
| Video lifecycle | `video-lifecycle-disable-restore` — **DISABLE is reversible and PURGE is not**: disable preserves `WebsiteVideo` and `ShareLinkVideo` and fails the existing share link closed, restore to `READY` returns the video and re-activates the links disable had swept to `DISABLED`, and the reversal is proved narrow — an explicitly `REVOKED` link never revives, a `status: EXPIRED` link never revives, a clock-expired or view-exhausted link resumes `ACTIVE` but is still denied (asserted on the internal access-log reason, since the client only ever sees `INVALID_LINK`), `alias`/`tokenHash`/`websiteId`/`expiresAt`/`maxViews`/`currentViews` are unchanged, a wrong host is still denied, a multi-video link stays dark until its **last** disabled member returns, `DISABLED → FAILED` revives nothing, an unrelated link is never touched, the dedicated `/disable` route and the `PATCH` restore interoperate, `LocalFileAsset` is byte-identical across the cycle, and — with **no** Bunny collaborator supplied, so any provider call would throw — Bunny identifiers survive and a confirmed `remoteMissing` marker is **not** cleared by a generic restore |
| Share-link reconciliation | `share-link-status-reconcile` — the one-shot historical sweep (`yarn reconcile:share-links`). Weighted towards what it must NEVER do, asserted on a fake that records **every** write call rather than on the summary the code reports about itself: a dry run issues zero writes; the only column ever present in an update payload is `status` and the only transition is `DISABLED → ACTIVE`; `REVOKED`/`ACTIVE`/`EXPIRED` links are never even read; a zero-member link, a vanished member, a purge footprint (`sortOrder` not `{0..n-1}`), any non-`READY`, non-playable, remote-missing, malformed-Bunny or unassigned member, an expired link and a view-exhausted link are all left `DISABLED`; `alias`/`tokenHash`/`websiteId`/`expiresAt`/`maxViews`/`currentViews` are byte-identical afterwards; the mutation still requires `status = DISABLED` at write time (TOCTOU), so a concurrent revoke survives and a second `--apply` changes zero rows; the audit row uses its own `SHARE_LINK_STATUS_RECONCILE` action with `adminId: null`, never a fabricated user action. Its playability predicate is pinned for parity across all five `VideoSourceType` values. **Historical purge provenance (KI-021)** is covered separately: a purge of the highest-indexed member — invisible to the `sortOrder` gap check — is caught as `MEMBERSHIP_SHRANK` by comparing the surviving member count against `SHARE_LINK_CREATE.metadataJson.videoCount`; a canonical anchor is `SAFE_PROVEN` structurally; and absent, malformed, non-integer, negative, fractional, `NaN` or excess-count provenance all fail closed as `AMBIGUOUS_PURGE_HISTORY` |
| Website assignment | `website-video-assignment`, `website-video-bulk-assignment` |
| Provider coexistence | `storage-provider-coexistence` — Hostinger NVMe (`LOCAL_FILE`) and Bunny Stream running together: the two shapes are disjoint and the strict classifier cannot confuse them, one share link carries both and serves each through its own mechanism (token-bound backend route vs signed Bunny iframe) with exactly one signature for the Bunny video only, a purely local share mints **zero** Bunny credentials, either provider keeps working when the other's video is unavailable, and no storage key or admin URL leaks into a mixed response |
| View count | `view-count-validation` — `viewCount` is a canonical decimal digit STRING at the API boundary across **all seven** video DTOs: the digit string is accepted exactly (`BigInt`-safe, no float in the path, `"9007199254740993"` → `9007199254740993n`), while the corrupted `"2.630122"`, plain decimals, scientific notation, signed values, hex, grouped forms, free text and anything above the signed `BIGINT` range are all rejected — never truncated or rounded into a wrong integer. **A JSON number is rejected outright**, safe range or not, with a proof that `JSON.parse` has already corrupted `9007199254740993` before validation runs, plus a test that no DTO stringifies a number behind the validator's back. Omitted and `""` stay `undefined` |
| Storage | `local-video-storage` |
| Infrastructure | `memory-cache`, `admin-websites-cache`, `global-exception-filter`, `safe-database-error-context`, `release-identity` |
| MariaDB diagnostics | `mariadb-collation-probe`, `admin-video-query-diagnostics`, `mariadb-video-query-protocol-proof` |
| Safety rails | `destructive-db-guard`, `canonical-db-blob-evidence-proof-safety` |
| Accounts | `admin-account-management` |

## 4. What is **not** covered

Be explicit about this when planning work:

- No end-to-end HTTP tests against a running Nest application, **except**
  `share-link-compat-http` and `share-link-compat-routes`, which boot a
  controller-only Nest + Express app on an ephemeral loopback port to pin the
  DB_BLOB media wire contract and the public route surface (no database).
  Neither boots the full `AppModule`, so neither proves the application starts
  end-to-end.
- No integration tests against a real database in `yarn test` (those live in
  `scripts/test/` and are opt-in).
- No contract tests between the backend and either frontend. Contract drift is
  caught only by review against [API_CONTRACTS.md](./API_CONTRACTS.md).
- No tests for Cloudinary upload paths (the SDK is not stubbed end-to-end).
- No test performs a real Bunny Stream network call. `test/bunny-stream.test.ts`
  replaces `globalThis.fetch`, so Bunny request construction is verified but
  Bunny itself is not. Confirm a real upload manually before a Bunny rollout.
- No load tests. Range behaviour is covered (`share-link-compat-media-delivery`
  drives the real storage service and the real controller) but not under
  concurrency.
- No tests in `bom-media-admin` (`yarn test` there is a stub) and none in
  `public_website`.

## 5. Database-backed integration proofs (opt-in)

These require a **test** database and are never part of `yarn test` or CI:

| Script | Command |
|---|---|
| Canonical FK restrict proof | `yarn test:integration:canonical-fk` |
| DB-blob evidence proof | `yarn test:integration:canonical-db-evidence` |
| MariaDB video query protocol proof | `yarn test:integration:mariadb-video-queries` |
| MariaDB admin-search collation proof | `yarn test:integration:mariadb-collation-search` |

They run under `APP_ENV=test` with `DOTENV_CONFIG_PATH=.env.test`, and are
guarded by `scripts/safety/assert-destructive-test-database.ts`, which refuses to
run against anything that is not clearly a test database. **Do not bypass that
guard.** `test/destructive-db-guard.test.ts` exists to keep the guard honest.

Local containers:

```bash
yarn docker:mariadb-test:up
```

```bash
yarn docker:mariadb-test:down
```

The collation proof needs its own container, because
`docker-compose.mariadb-test.yml` pins
`--collation-server=utf8mb4_unicode_ci` - which makes the server default match
the schema contract and hides every host-dependent collation behaviour. The
second compose file deliberately does **not** pin it, so a stock managed host is
reproducible. Keep both.

```bash
yarn docker:mariadb-collation-test:up
```

```bash
yarn docker:mariadb-collation-test:down
```

## 6. Audit, smoke and diagnostic scripts

Read-only or local-only; useful when investigating rather than testing.

| Purpose | Command |
|---|---|
| Share-link assignment audit | `yarn audit:share-link-assignments` |
| Admin account audit | `yarn audit:admin-accounts` |
| Canonical share-link audit (local) | `yarn audit:canonical-share-links` |
| Admin video query isolation | `yarn diagnose:admin-video-queries` |
| Admin-search column collation audit (read-only, production-safe) | `yarn diagnose:admin-search-collation` |
| Share-link assignment smoke (local) | `yarn smoke:local:share-link-assignment` |
| Admin account smoke (local) | `yarn smoke:local:admin-accounts` |
| Expired admin session cleanup | `yarn cleanup:admin-sessions` |
| Bunny public thumbnail upstream probe (config only) | `yarn diagnose:bunny-thumbnail --config-only` |
| Bunny public thumbnail upstream probe (one read-only GET) | `yarn diagnose:bunny-thumbnail --bunny-video-id <guid> --file-name <name>` |
| Bunny remote-existence reconciliation (dry run) | `yarn reconcile:bunny` |
| Bunny reconciliation, local, writing | `yarn reconcile:bunny:local --apply --confirm-env=local` |
| Historical share-link status reconciliation (dry run) | `yarn reconcile:share-links` |
| Share-link reconciliation, local, writing | `yarn reconcile:share-links:local --apply --confirm-env=local` |
| Share-link compatibility mutation proof | `npx tsx scripts/test/share-link-compat-mutations/run.ts` |

`scripts/remediate/*` mutate data and are local-only. Never point them at
production.

## 7. What to test when you change something

| Change | Required tests |
|---|---|
| Auth, sessions, tokens | Extend `auth-hardening`; cover revocation and replay |
| Roles or guards | Cover the denied case, not just the allowed one |
| Share links | Extend `share-link-scope`; cover wrong host, wrong website, revoked, expired, over-limit. **Never weaken a `share-link-compat-*` test to pass** — see below |
| Public media | Cover Range `200` / `206` / `416` and the unauthorized `404` |
| Prisma schema | Add or update an invariant test; add a migration |
| Caching | Cover the stale-entry path (policy revalidation) |
| Error handling | Extend `global-exception-filter` and `safe-database-error-context` |

Every security-relevant change needs a test that **fails without the fix**.

### 7.1 Share-link compatibility suite

`test/share-link-compat-*.test.ts` pins the current behaviour of **existing
production share links** (credentials, host binding, authorization, provider
playback mapping, Range delivery, media grants and the authorization cache).

> A failure there is **release blocking**. It means the change invalidates share
> links that work today. The only way past it is an approved compatibility
> migration with a migration strategy, a backward-support window, staging proof
> and a rollback plan. Do not skip, weaken or delete one of these tests.

The contract is [`../../project-docs/SHARE_LINK_COMPATIBILITY.md`](../../project-docs/SHARE_LINK_COMPATIBILITY.md);
the COMPAT-ID map and the fixtures are in
[SHARE_LINK_COMPATIBILITY_TESTS.md](./SHARE_LINK_COMPATIBILITY_TESTS.md), and the
mutation evidence proving each protection can actually fail is in
[SHARE_LINK_COMPATIBILITY_MUTATION_REPORT.md](./SHARE_LINK_COMPATIBILITY_MUTATION_REPORT.md).

Run the group on its own:

```bash
npx tsx --import ./test/test-env.ts --test test/share-link-compat-*.test.ts
```

Prove the group can still fail — an audit step, **never** part of `yarn test` or
CI because it edits `src/` while it runs:

```bash
npx tsx scripts/test/share-link-compat-mutations/run.ts
```

## 8. CI

`.github/workflows/ci.yml` — workflow `backend`, job id `validate`, job
**name** `backend / validate`.

| | |
|---|---|
| **Intended required check** | `backend / validate` — this is the job's `name:`, which is what a Ruleset matches. Confirm the emitted context on the first real PR before configuring it. |
| **Runner** | `ubuntu-latest` |
| **Node** | **22.22.2**, pinned (same version in all three repositories) |
| **Install** | `yarn install --frozen-lockfile`, yarn cache keyed on `yarn.lock` |
| **Triggers** | `pull_request` → `main`, `push` → `main`, `merge_group` (no path filters) |
| **Permissions** | `contents: read` |
| **Secrets** | **none** |
| **Deploys** | **never** — this workflow is validation only |

```
install → prisma generate → prisma validate → typecheck → lint
       → Wave A compatibility suites   [EXECUTION GATE]
       → full test suite               [EXECUTION GATE]
       → manifest consistency          [CONSISTENCY GATE]
       → format:check → build → git diff --check
```

### Two kinds of gate — do not confuse them

**EXECUTION GATE.** A command whose **exit code** is the proof. No output is
parsed. Two of them cover Wave A:

```bash
npx tsx --import ./test/test-env.ts --test test/share-link-compat-*.test.ts
yarn test
```

The first runs the compatibility files directly and by name, so a change to the
full-suite glob cannot silently drop one. The second runs everything. Both are
release-blocking. The compatibility files run twice; the duplicate costs about
two seconds and buys unambiguous attribution when something goes red.

**MANIFEST CONSISTENCY GATE.**

```bash
node scripts/ci/check-compat-manifest.mjs
```

Compares the `COMPAT-nnn` ids named in `test/share-link-compat-*.test.ts` with
the ids documented in
[SHARE_LINK_COMPATIBILITY_TESTS.md](./SHARE_LINK_COMPATIBILITY_TESTS.md). It
fails on an id present in one and missing from the other, and on any drift from
the agreed total of **31**.

> **What it proves:** the documented inventory and the test inventory still
> agree.
> **What it does not prove:** that any test ran, or that any test passed. Only
> the execution gates prove that.

Ids are compared as **sets**. An id legitimately appears in more than one test
and repeatedly in the manifest prose, so duplicate occurrences are not an error
and are not checked.

### Not in CI

The **mutation runner stays manual** (§7). It rewrites `src/` while it runs, so
it must never execute on a shared runner as part of normal validation. Run it
locally when you need discrimination evidence.

`DATABASE_URL` is set to a placeholder for config validation only; **no job
starts a database**, and no production credential, Cloudinary key or customer
data is available to the workflow.

### Concurrency

```yaml
group: backend-validate-${{ github.event.pull_request.number || github.run_id }}
cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

- **pull_request** — all runs for one PR share a group, so pushing again
  cancels the superseded run for that PR.
- **push to `main`** and **merge_group** — `github.run_id` is unique per run, so
  each run is alone in its group and cannot be displaced by a later one.

That last point matters because GitHub keeps at most one pending run per
concurrency group: with `cancel-in-progress: false` a new run does not cancel a
*running* one, but a new **pending** run would still evict an older pending one
from the same group. Making the group unique avoids that entirely.

### Reproducing CI locally

```bash
yarn install --frozen-lockfile
yarn prisma generate && yarn prisma validate
yarn typecheck && yarn lint
npx tsx --import ./test/test-env.ts --test test/share-link-compat-*.test.ts
yarn test
node scripts/ci/check-compat-manifest.mjs
yarn format:check && yarn build
git diff --check
```

On Windows expect the two environmental failures documented in §9 (`symlink`
EPERM and CRLF `format:check`); neither occurs on the Linux runner.

Sibling workflows: `admin / validate` in `bom-media-admin` and
`public / validate` in `public_website`. See
[KNOWN_ISSUES.md](./KNOWN_ISSUES.md#ki-006).

## 9. Local run — 2026-08-21

Windows 11, Node 22.22.0, Yarn 1.22.22, after `yarn install --frozen-lockfile`.

| Command | Result | Detail |
|---|---|---|
| `yarn prisma generate` | **PASS** | Prisma Client 7.8.0 |
| `yarn prisma validate` | **PASS** | Schema valid |
| `yarn typecheck` | **PASS** | |
| `yarn lint` | **PASS** | 0 errors, 92 warnings (all `consistent-type-imports`); the script sets no `--max-warnings` |
| `yarn test` | **FAIL (environmental)** | 339/340 pass. `local-video-storage.test.ts` → "rejects symlink components and file targets under the storage root" fails with `EPERM: operation not permitted, symlink`. Creating symlinks on Windows needs elevation or Developer Mode; this passes on the Linux CI runner. Re-confirmed 2026-08-23 at 422/423 after the Bunny Stream suites and the targeted-review corrections were added — the same single failure |
| `yarn build` | **PASS** | |
| `yarn format:check` | **FAIL (environmental)** | 152 files flagged. Cause: `git config core.autocrlf=true` checks files out with CRLF while Prettier defaults to `endOfLine: "lf"`. Proven by `npx prettier --end-of-line auto --check src/main.ts` → "All matched files use Prettier code style!". No source formatting drift exists |

### 9.1 Local run — 2026-08-28

Same machine, after the canonical historical-recovery and Bunny poster-proxy
changes.

| Command | Result | Detail |
|---|---|---|
| `yarn typecheck` | **PASS** | |
| `yarn lint` | **PASS** | 0 errors, warnings only (`consistent-type-imports`) |
| `yarn test` | **FAIL (environmental)** | 876/877 pass. The single failure is the same `local-video-storage` symlink `EPERM` as above (KI-012), reproduced on the unmodified tree before any change in this pass |
| `yarn build` | **PASS** | |
| `yarn format:check` | **FAIL (environmental)** | The same CRLF checkout issue as above (KI-011), reproduced on the unmodified tree before any change in this pass |

Neither failure indicates a defect in the repository. **Do not "fix" them by
reformatting files or weakening the test** — the correct local remedies are to
enable Developer Mode (or run the storage suite on Linux/CI) and to check the
repository out with LF endings.

## 10. Reporting results

Always report one of `PASS`, `FAIL`, `NOT RUN`, `BLOCKED` per command, with the
exact command line. Never report a command as passing unless you ran it and saw
it succeed. When a failure is environmental, say so **and** name the cause.

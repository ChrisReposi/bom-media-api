# Testing

Status: CURRENT
Last verified: 2026-08-22
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

34 suites, 340 tests as of 2026-08-22. Grouped by concern:

| Area | Suites |
|---|---|
| Auth and sessions | `auth-hardening`, `security-hardening` |
| Share links | `share-link-scope`, `share-url-util`, `share-link-assignment-audit`, `canonical-share-link` |
| **Share-link compatibility** | `share-link-compat-resolution`, `share-link-compat-providers`, `share-link-compat-media-delivery`, `share-link-compat-http`, `share-link-compat-cache-grants`, `share-link-compat-routes` — **release-blocking**, see [SHARE_LINK_COMPATIBILITY_TESTS.md](./SHARE_LINK_COMPATIBILITY_TESTS.md) |
| Public watch | `public-watch-exchange`, `public-local-thumbnail` |
| Videos | `admin-video-search`, `video-purge`, `video-view-growth`, `database-video-checksum`, `upload-concurrency` |
| Website assignment | `website-video-assignment`, `website-video-bulk-assignment` |
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

## 6. Audit, smoke and diagnostic scripts

Read-only or local-only; useful when investigating rather than testing.

| Purpose | Command |
|---|---|
| Share-link assignment audit | `yarn audit:share-link-assignments` |
| Admin account audit | `yarn audit:admin-accounts` |
| Canonical share-link audit (local) | `yarn audit:canonical-share-links` |
| Admin video query isolation | `yarn diagnose:admin-video-queries` |
| Share-link assignment smoke (local) | `yarn smoke:local:share-link-assignment` |
| Admin account smoke (local) | `yarn smoke:local:admin-accounts` |
| Expired admin session cleanup | `yarn cleanup:admin-sessions` |
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
| `yarn test` | **FAIL (environmental)** | 339/340 pass. `local-video-storage.test.ts` → "rejects symlink components and file targets under the storage root" fails with `EPERM: operation not permitted, symlink`. Creating symlinks on Windows needs elevation or Developer Mode; this passes on the Linux CI runner |
| `yarn build` | **PASS** | |
| `yarn format:check` | **FAIL (environmental)** | 152 files flagged. Cause: `git config core.autocrlf=true` checks files out with CRLF while Prettier defaults to `endOfLine: "lf"`. Proven by `npx prettier --end-of-line auto --check src/main.ts` → "All matched files use Prettier code style!". No source formatting drift exists |

Neither failure indicates a defect in the repository. **Do not "fix" them by
reformatting files or weakening the test** — the correct local remedies are to
enable Developer Mode (or run the storage suite on Linux/CI) and to check the
repository out with LF endings.

## 10. Reporting results

Always report one of `PASS`, `FAIL`, `NOT RUN`, `BLOCKED` per command, with the
exact command line. Never report a command as passing unless you ran it and saw
it succeed. When a failure is environmental, say so **and** name the cause.

# Incident: Production admin video list & assignment-options 500

- Date opened: 2026-07-20
- Status: **Root cause NOT_PROVEN — diagnostic release deployed; corrective evidence pending**
- Active diagnostic release: `main @ 579becd`
- Investigation branch: `hotfix/production-video-query-500-root-cause`

## 1. Incident summary

Production behavior is not a single no-search failure:

```
GET /api/v1/admin/videos?page=1&limit=20&search=sml&status=READY&sortBy=createdAt&sortOrder=desc
GET /api/v1/admin/websites/:websiteId/videos?assignmentStatus=ACTIVE&eligibleForShareLink=true
GET /api/v1/admin/websites/:websiteId/video-assignment-options?page=1&limit=24
```

The global no-search list succeeds (200 or cache-valid 304), while assignment
options still fail without search. Therefore search code may explain only one
surface and cannot be treated as the sole root cause. `/health` and
`/health/ready` return 200.

## 2. Timeline

- 2026-07-19 20:44 UTC — Hostinger build succeeded (Prisma Client 7.8.0, no TS errors).
- 2026-07-19 — `prisma migrate deploy`: 19 migrations, no pending.
- 2026-07-20 — endpoints observed returning 500; browser sees generic 500 only.
- 2026-07-20 03:30 UTC — health proves the deployed diagnostic release is
  `579becd`, version `diag-2026.07.20-admin-video-list-500`, built at
  `2026-07-20T03:04:56.655Z`.
- 2026-07-20 — second read-only local operation matrix passes every individual
  query, array transaction, service mapper and serialization path.

## 3. Known production evidence

- Build OK; earlier `proxy-addr` TS errors already resolved (unrelated to runtime 500).
- Migration history complete (19), no pending → pending-migration RULED_OUT.
- Health 200; ready 200 (`database=ok`, `storage=disabled`).
- Release identity is PROVEN: health reports commit `579becd`.
- The diagnostic filter is deployed, but no sanitized request-correlated runtime
  log has been supplied to this investigation environment. Exact Prisma/driver
  code and failing Production stage remain NOT_VERIFIED.

## 4. Call graph (shared failure surface)

| Stage                          | Global search     | Assigned list                 | Assignment options     |
| ------------------------------ | ----------------- | ----------------------------- | ---------------------- |
| Search predicate               | yes               | optional                      | no on failing request  |
| `VideoAsset` scalar/media read | yes               | nested through `WebsiteVideo` | yes                    |
| `WebsiteVideo` relation        | no                | yes                           | yes                    |
| Eligibility predicate          | no                | yes                           | yes                    |
| Prisma array transaction       | 2 queries         | 4 queries                     | 4 queries              |
| Response mapper/serialization  | `toVideoResponse` | `toAssignedVideoResponse`     | `toAdminVideoResponse` |

`/health/ready` uses a single `SELECT 1` — **no** `$transaction`, **no** includes.
This explains why readiness alone cannot validate the affected paths, but does
not prove that the transaction or connection pool is defective.

## 5. Hypothesis matrix

| Hypothesis                                         | Status                           | Evidence for                                                                                                                                | Remaining gap                                       |
| -------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Search/title/LIKE defect                           | POSSIBLE for global search only  | global no-search passes                                                                                                                     | cannot explain no-search assignment-options failure |
| Pending migration                                  | RULED_OUT                        | migrate status clean                                                                                                                        | —                                                   |
| Code/query-shape/array-transaction defect          | RULED_OUT (local)                | exact prod shapes return 200 on real MySQL 8 incl. 4-way `$transaction`                                                                     | prod adapter/runtime unverified                     |
| Response mapping / legacy null row                 | POSSIBLE                         | mappers pass current data                                                                                                                   | prod may hold rows that throw; no prod row dump     |
| Physical schema drift (P2022 missing column/table) | POSSIBLE                         | migrate history ≠ physical schema is possible                                                                                               | needs `information_schema` output                   |
| Connection-pool timeout (P2024)                    | POSSIBLE (leading env candidate) | both failing endpoints use `$transaction` (holds a connection); health uses none; default `DB_CONNECTION_LIMIT=5` on shared Hostinger MySQL | needs runtime P2024 in logs                         |
| Stale runtime                                      | RULED_OUT                        | health reports expected `579becd`                                                                                                           | —                                                   |
| Wrong database                                     | POSSIBLE                         | runtime DB identity is not in health                                                                                                        | needs same-context schema/status evidence           |
| Observability gap                                  | CLOSED IN RUNTIME                | `579becd` contains allowlisted database context                                                                                             | operator still must return the correlated log       |

## 6. Local reproduction results

Read-only probe of the exact Production query shapes against local MySQL 8 via
`@prisma/adapter-mariadb` (dev DB, 19 migrations):

```
global no-search service/mapping                 -> 20 / 26
global search count/id/scalars/each relation     -> PASS
global full include + 2-way transaction          -> PASS
assigned count/id/full include/4-way transaction -> 5 / 5, PASS
assigned mapper + JSON serialization             -> PASS
assignment option operations A/B/C/D individually -> PASS
assignment option 4-way transaction + mapper     -> 26 / 24, PASS
non-production Promise.all comparison            -> PASS
local SQL mode NO_BACKSLASH_ESCAPES               -> false
title/slug/filterKey collation                    -> utf8mb4_unicode_ci
```

Local `EXPLAIN` chooses `VideoAsset_status_createdAt_idx` for the no-search
page. The leading-wildcard title/slug search performs a scan/filesort (expected
for `contains`), and the assigned join uses the unique website/video index plus
the VideoAsset primary key. The dataset is only 26 videos/5 assignments, so
this is not representative Production performance evidence. No index migration
is justified until Production error code and plan/cardinality are captured.

All 194 baseline tests and the previous real HTTP smoke pass. Local cannot
reproduce the Production 500.

## 7. Production evidence still required (one bundle)

For a single fresh failing request, operator provides:

```
endpoint + HTTP status + timestamp (UTC) + X-Request-Id
sanitized runtime log line for that requestId, now including:
  errorName, database.errorCode, database.modelName, database.fields,
  database.driverCode, database.databaseCategory, stage
```

Redact: Authorization, Cookie, DATABASE_URL, password, tokens, raw SQL values.

If `databaseCategory=MISSING_COLUMN/MISSING_TABLE` → run the schema SQL in §16.

If runtime log access is unavailable, run the opt-in read-only isolation command
from the exact deployed source and environment. Set the website/search inputs in
environment variables so the script never echoes them:

```bash
export ADMIN_VIDEO_DIAGNOSTIC_WEBSITE_ID='<target website id>'
export ADMIN_VIDEO_DIAGNOSTIC_SEARCH='sml'
export ALLOW_READ_ONLY_PRODUCTION_DIAGNOSTICS='I_UNDERSTAND_THIS_ONLY_READS_PRODUCTION_DATA'
NODE_ENV=production APP_ENV=production yarn diagnose:admin-video-queries
```

Do not use `--include-concurrency` in Production; the guard rejects it. The
command uses `SELECT`/Prisma read methods only and prints aggregate counts,
durations, stage names and allowlisted error context. It never prints inputs,
rows, SQL, raw messages or connection details.

## 8–9. Root cause

**NOT_PROVEN.** Cannot reproduce locally and no Production runtime exception is
available in this workspace. P2022 physical drift, P2024/pool pressure,
Production-only relation/cardinality, and legacy-row mapping remain possible.
Stale runtime is ruled out. Per incident discipline, no speculative query,
index, transaction, cache or mapping change was made.

## 10. Code changes (diagnostic release — behavior-preserving)

- `src/common/errors/safe-database-error-context.util.ts` (new): extracts
  allowlisted Prisma/driver context (`errorCode`, `modelName`, `fields`,
  `driverCode`, `sqlState`, `databaseCategory`) incl. the
  `@prisma/adapter-mariadb` `driverAdapterError.cause` shape. Never exposes raw
  message, SQL, query args, or secrets.
- `src/common/filters/global-exception.filter.ts`: single 5xx log now includes
  a safe `route` TEMPLATE (never a raw URL/query string), the failing `stage`,
  and the safe `database` context. Client response stays generic
  `{statusCode, message:"Internal server error", error}`.
- `src/common/http/safe-request-route.util.ts` (new): derives the route
  template from `request.route.path` (+ static `baseUrl`) only; ignores
  `originalUrl`/`url`/`path`; omits the field when no template is available.
- `src/videos/videos.service.ts` / `src/admin-websites/admin-websites.service.ts`:
  the failing stage (`ADMIN_VIDEO_LIST_QUERY|MAPPING`,
  `WEBSITE_ASSIGNMENT_OPTIONS_QUERY|MAPPING`) is tagged on the unchanged error
  via `.catch(rethrowWithDatabaseStage(...))`, so the filter emits one
  request-correlated log with no duplicate service logs. The `.catch` returns
  `never`, preserving the exact inferred Prisma result types (no `unknown`, no
  late cast).
- `listAssignedVideos` now also tags
  `WEBSITE_ASSIGNED_VIDEO_LIST_QUERY|MAPPING`; the query and response are
  unchanged.
- `scripts/diagnostics/admin-video-query-isolation.ts`: opt-in read-only
  per-operation probe with a Production confirmation guard and redacted output.
  Concurrency comparison is non-Production-only.
- No query, DTO, transaction, cache, auth, RBAC, or response-contract change.

Release identity injection is now verified in Production health.

## 11. Tests

- `test/safe-database-error-context.test.ts` (7): P2022→MISSING_COLUMN,
  P2024→CONNECTION_POOL_TIMEOUT, MariaDB driver shape (no `meta.target`),
  array target, init error URL redaction, graceful degrade, `isPrismaError`.
- Diagnostic safety coverage proves the Production confirmation/website guard,
  no concurrent probe in Production, allowlisted error serialization, absence
  of database mutation primitives, and assigned-list query/mapping tags.
- Baseline before this branch: 194/194 tests in 53 suites.
- Final branch verification: 199/199 tests in 54 suites; Prisma
  generate/validate/status, typecheck, lint (0 errors/92 existing warnings),
  build, format, focused diagnostic typecheck and diff-check all pass.

## 12. Deployment plan (two-stage)

1. **Evidence completion**: capture one correlated log for each failing surface,
   or run the guarded probe once in the deployed runtime context. Do not deploy
   another behavioral build first.
2. **Corrective release**: only after runtime evidence pins the cause —
   - P2022/P2021 → §16 schema comparison + reviewed additive repair migration
     (backup first; no unreviewed ALTER, no `db push`, no reset).
   - P2024 → raise `DB_CONNECTION_LIMIT` to match Hostinger MySQL limit and/or
     reduce per-request connection hold; re-test under concurrency.
   - mapping/legacy row → targeted backward-compatible normalization + fixture.
   - wrong DB → correct Hostinger environment binding before any migration.

## 13. Rollback plan

This branch is diagnostic-only and additive → rollback = redeploy `579becd`.
No DB reset, migration rollback, or data mutation is involved.

## 14. Remaining risks

- If the cause is P2024, admin concurrency may keep intermittently failing
  until the pool limit is corrected.
- Physical drift, if present, needs a reviewed repair migration + backup.

## 15. Final production acceptance status

**NOT MET** — no production smoke returned 200 yet. Do not declare fixed.

## 16. Operator read-only SQL bundle (run only if evidence points to schema)

```sql
-- Critical columns
SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND (
    (TABLE_NAME='VideoAsset' AND COLUMN_NAME='filterKey')
    OR (TABLE_NAME='VideoBinaryAsset' AND COLUMN_NAME='checksumSha256')
    OR (TABLE_NAME IN ('VideoLocalFileAsset','VideoLocalThumbnailAsset')
        AND COLUMN_NAME IN ('checksumSha256','originalFilename','mimeType','sizeBytes'))
  )
ORDER BY TABLE_NAME, COLUMN_NAME;

-- Critical tables
SELECT TABLE_NAME FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('VideoAsset','VideoBinaryAsset','VideoLocalFileAsset',
                     'VideoLocalThumbnailAsset','WebsiteVideo','CanonicalVideoShareLink')
ORDER BY TABLE_NAME;

-- Critical indexes
SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('VideoAsset','WebsiteVideo')
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;

-- Migration rows
SELECT migration_name, finished_at, rolled_back_at, applied_steps_count
FROM _prisma_migrations ORDER BY started_at;
```

If a migration row is present but its column/table is missing physically →
`SCHEMA_DRIFT = PROVEN`; prepare a reviewed additive repair after backup. Do
not ALTER/`db push`/reset directly.

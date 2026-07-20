# Incident: Production admin video list & assignment-options 500

- Date opened: 2026-07-20
- Status: **Root cause NOT_PROVEN — diagnostic release prepared, not deployed**
- Affected release: `main @ 0771e0f` (tag `api-v2026.07.19`, feature `f1a943e`)
- Author: hotfix/production-admin-video-list-500

## 1. Incident summary

Three admin endpoints return HTTP 500 in production while local passes:

```
GET /api/v1/admin/videos?page=1&limit=20
GET /api/v1/admin/videos?page=1&limit=20&search=sml&status=READY&sortBy=createdAt&sortOrder=desc
GET /api/v1/admin/websites/:websiteId/video-assignment-options?page=1&limit=24
```

The no-search variant also fails, so this is **not** a search/title defect.
`/health` and `/health/ready` return 200 (database + storage ok).

## 2. Timeline

- 2026-07-19 20:44 UTC — Hostinger build succeeded (Prisma Client 7.8.0, no TS errors).
- 2026-07-19 — `prisma migrate deploy`: 19 migrations, no pending.
- 2026-07-20 — endpoints observed returning 500; browser sees generic 500 only.

## 3. Known production evidence

- Build OK; earlier `proxy-addr` TS errors already resolved (unrelated to runtime 500).
- Migration history complete (19), no pending → pending-migration RULED_OUT.
- Health 200; ready 200 (`database=ok`, `storage=ok`).
- No captured runtime exception (global filter did not log Prisma code — see gap).
- Release metadata not injected (health shows no commit).

## 4. Call graph (shared failure surface)

| Stage | `/admin/videos` | `video-assignment-options` | Shared |
| --- | --- | --- | --- |
| Controller + DTO + ValidationPipe | yes | yes | yes |
| `VideoAsset` scalar read | yes | yes | **yes** |
| `binaryAsset` / `localFileAsset` / `localThumbnailAsset` include (selects `checksumSha256`) | yes | yes | **yes** |
| **Prisma array `$transaction([...])`** | `[findMany, count]` | 4-way `[count, findMany, count, findMany]` | **yes** |
| MariaDB adapter + prod connection pool | yes | yes | **yes** |
| Response mapping (`toVideoResponse`/`toAdminVideoResponse`) | yes | yes | shared helpers |
| `viewCount` BigInt → `.toString()` | yes | yes | yes |

`/health/ready` uses a single `SELECT 1` — **no** `$transaction`, **no** includes.
This is the one structural difference that explains health 200 while both list
endpoints 500.

## 5. Hypothesis matrix

| Hypothesis | Status | Evidence for | Remaining gap |
| --- | --- | --- | --- |
| Search/title/LIKE defect | RULED_OUT | no-search also 500 | — |
| Pending migration | RULED_OUT | migrate status clean | — |
| Code/query-shape/array-transaction defect | RULED_OUT (local) | exact prod shapes return 200 on real MySQL 8 incl. 4-way `$transaction` | prod adapter/runtime unverified |
| Response mapping / legacy null row | POSSIBLE | mappers pass current data | prod may hold rows that throw; no prod row dump |
| Physical schema drift (P2022 missing column/table) | POSSIBLE | migrate history ≠ physical schema is possible | needs `information_schema` output |
| Connection-pool timeout (P2024) | POSSIBLE (leading env candidate) | both failing endpoints use `$transaction` (holds a connection); health uses none; default `DB_CONNECTION_LIMIT=5` on shared Hostinger MySQL | needs runtime P2024 in logs |
| Stale/mixed runtime, wrong DB/app-root | POSSIBLE | local pass + prod fail with clean history | needs release identity + runtime SHA |
| Observability gap | **PROVEN** | filter logged only errorName for 5xx | closed by this release |

## 6. Local reproduction results

Read-only probe of the **exact** production query shapes against real MySQL 8
via `@prisma/adapter-mariadb` (dev DB, 19 migrations, all `checksumSha256`
columns present):

```
count()                                          -> 26
findMany full-include (global list shape)        -> 20 rows
$transaction([findMany,count]) (global list)     -> items=20 total=26
4-way $transaction (assignment-options)          -> count=26 wv=31 eligible=26 videos=24
null viewCount rows                              -> 0
```

Real HTTP smoke after the diagnostic changes: all three endpoints return 200.
**Local cannot reproduce the 500.**

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

## 8–9. Root cause

**NOT_PROVEN.** Cannot reproduce locally; no production runtime exception yet
captured; ≥2 equiprobable production-only causes (P2022 physical drift vs P2024
pool timeout, plus stale-runtime). Per incident discipline, no speculative
query/behavior change was made.

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
- No query, DTO, transaction, cache, auth, RBAC, or response-contract change.

Release identity (`APP_RELEASE_VERSION`/`APP_BUILD_SHA`/`APP_BUILD_TIME`) is
already supported by `health.service`; it only needs operator env injection.

## 11. Tests

- `test/safe-database-error-context.test.ts` (7): P2022→MISSING_COLUMN,
  P2024→CONNECTION_POOL_TIMEOUT, MariaDB driver shape (no `meta.target`),
  array target, init error URL redaction, graceful degrade, `isPrismaError`.
- Full suite: 186/186. No behavior tests changed.

## 12. Deployment plan (two-stage)

1. **Diagnostic release** (this branch): deploy, inject release identity env,
   reproduce one failing request, capture `X-Request-Id` + sanitized log,
   return the §7 bundle. No behavior change.
2. **Corrective release**: only after runtime evidence pins the cause —
   - P2022/P2021 → §16 schema comparison + reviewed additive repair migration
     (backup first; no unreviewed ALTER, no `db push`, no reset).
   - P2024 → raise `DB_CONNECTION_LIMIT` to match Hostinger MySQL limit and/or
     reduce per-request connection hold; re-test under concurrency.
   - mapping/legacy row → targeted backward-compatible normalization + fixture.
   - stale runtime → redeploy correct artifact / fix app root or DB target.

## 13. Rollback plan

Diagnostic release is code-only and additive → rollback = redeploy previous
known-good commit. No DB reset, no migration rollback, no data mutation.

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

# Incident: Production admin video list & assignment-options 500

- Date opened: 2026-07-20
- Status: **MariaDB 1267 PROVEN — exact collation/coercibility pair NOT_VERIFIED**
- Active diagnostic release: `main @ 0cc41e2`
- Investigation branch: `diagnostic/production-mariadb-collation-probe`

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
- 2026-07-20 — three Production failures are now request-correlated. Global
  search fails at `ADMIN_VIDEO_LIST_QUERY` in 14 ms and assignment options
  fails at `WEBSITE_ASSIGNMENT_OPTIONS_QUERY` in 33 ms; both are top-level
  `DriverAdapterError`. Response mapping is ruled out. The original extractor
  did not understand that top-level shape, so its safe `cause` is not yet known.
- 2026-07-20 — operator verified MariaDB `11.8.8-MariaDB-log`, all 19 migration
  rows finished, all critical physical columns/tables present, 236 LOCAL_FILE
  videos with matching file/thumbnail relations, zero WebsiteVideo rows, valid
  metadata, and direct SQL `LIKE '%sml%'` success.
- 2026-07-20 — isolated MariaDB 11.8.8 proof ran the production-built Nest API
  over real HTTP with 236 run-scoped LOCAL_FILE fixtures. Binary and text
  protocols both passed every failing query shape, mapper and HTTP/BigInt
  serialization. All fixtures were deleted.
- 2026-07-20 — release `0cc41e2` captured `DriverAdapterError` code `1267`,
  SQLSTATE `HY000`, at all three query stages. The shared failing SQL shape is
  `LIKE CONCAT(literal, bound parameter, literal)`. All audited physical
  columns and phpMyAdmin/server session variables are `utf8mb4_unicode_ci`,
  but the actual Prisma pool session and bound-parameter collation remain
  unverified.

## 3. Known production evidence

- Build OK; earlier `proxy-addr` TS errors already resolved (unrelated to runtime 500).
- Migration history complete (19), no pending → pending-migration RULED_OUT.
- Health 200; ready 200 (`database=ok`, `storage=disabled`).
- Release identity is PROVEN: the current diagnostic release reports commit
  `0cc41e2`.
- Production stage/error identity is proven from correlated logs:
  - `dcc104ad-87d3-44d1-97ab-fdcdd77da5a1` → global search,
    `ADMIN_VIDEO_LIST_QUERY`, `DriverAdapterError`, 14 ms.
  - `70e7898f-1cd8-43d4-9407-c1822050f788` → assignment options,
    `WEBSITE_ASSIGNMENT_OPTIONS_QUERY`, `DriverAdapterError`, 33 ms.
- Mapping/serialization is therefore ruled out for those requests. Missing
  table/column and pending migration are ruled out by migration and physical
  schema evidence. P2024/slow-query explanations are low probability because
  the direct adapter errors arrive in 14–33 ms, but the exact driver cause is
  still unavailable from the deployed extractor.
- Locked dependency versions are: `prisma=7.8.0`, `@prisma/client=7.8.0`,
  `@prisma/adapter-mariadb=7.8.0`, and transitive `mariadb=3.4.5`.
- Current request-correlated Production evidence is identical across all three
  failure surfaces: top-level `DriverAdapterError`, MariaDB code `1267`,
  SQLSTATE `HY000`. This proves illegal collation aggregation as the common
  database failure class, but not the two participating collations or their
  coercibilities.

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
| MariaDB illegal collation aggregation              | PROVEN                           | all three Production query stages return 1267/HY000                                                                                           | exact pair/coercibility still unknown                |
| Prisma `LIKE CONCAT` expression                    | PROVEN shared surface            | generated SQL uses literal + bound parameter CONCAT for title/slug/mimeType predicates                                                       | actual parameter/literal metadata not verified       |
| Physical column collation mismatch                 | RULED_OUT                        | 25 relevant physical columns and join pairs are utf8mb4/utf8mb4_unicode_ci                                                                    | —                                                   |
| Pending migration / physical schema drift          | RULED_OUT                        | 19/19 finished; critical physical tables/columns verified                                                                                    | —                                                   |
| Response mapping / HTTP serialization              | RULED_OUT for captured requests  | failure stage is QUERY; MariaDB 11.8 HTTP proof maps/serializes all shapes                                                                    | —                                                   |
| Slow query / pool acquisition timeout              | LOW PROBABILITY                  | adapter failures arrive in 14–33 ms; controlled 236-row concurrency passes                                                                  | exact `cause.kind` still needed                     |
| Binary prepared protocol defect                    | RULED_OUT in controlled MariaDB  | MariaDB 11.8.8 binary and text both pass identical built-API HTTP matrix                                                                      | Production A/B not run                              |
| Prisma connection/parameter collation mismatch     | POSSIBLE                         | Production-only 1267 and generated CONCAT shape                                                                                              | run guarded post-listen metadata probe               |
| Relation-join strategy                             | RULED_OUT                        | generator has no preview feature/override; adapter 7.8 reports `supportsRelationJoins=false` for MariaDB                                      | —                                                   |
| Stale runtime                                      | RULED_OUT                        | health reports expected `579becd`                                                                                                            | —                                                   |
| Wrong database/runtime environment                 | LOW PROBABILITY                  | same-context Production schema/data identity supplied                                                                                        | exact application env binding should remain audited |
| Observability gap                                  | FIX IMPLEMENTED, NOT DEPLOYED    | top-level DriverAdapterError extraction and safe Pino request serializer added                                                               | requires a diagnostic deployment                    |

## 6. Local reproduction results

Read-only probe of the exact Production query shapes against local MySQL 8 via
`@prisma/adapter-mariadb` (dev DB, 19 migrations) passed. A second, isolated
proof then used `mariadb:11.8.8`, 19 migrations, a production build, real Nest
HTTP, one test admin/website and 236 run-scoped LOCAL_FILE videos:

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
MariaDB binary: all 4 HTTP cases + mapping/BigInt  -> PASS
MariaDB text:   all 4 HTTP cases + mapping/BigInt  -> PASS
run-scoped cleanup                                -> 0 leftovers
```

Local `EXPLAIN` chooses `VideoAsset_status_createdAt_idx` for the no-search
page. The leading-wildcard title/slug search performs a scan/filesort (expected
for `contains`), and the assigned join uses the unique website/video index plus
the VideoAsset primary key. The dataset is only 26 videos/5 assignments, so
this is not representative Production performance evidence. No index migration
is justified until Production error code and plan/cardinality are captured.

The MariaDB fixture deliberately matches the key Production cardinality:
236 VideoAsset + 236 VideoLocalFileAsset + 236 VideoLocalThumbnailAsset,
zero WebsiteVideo, `search=sml`, and BigInt values above JavaScript's safe
integer range. Local still cannot reproduce the Production 500.

The new probe was also executed against the same disposable MariaDB 11.8.8
through the production-built `dist/main.js`, binary protocol and an empty
19-migration schema. It completed after listen with session, parameter,
literal and CONCAT all `utf8mb4_unicode_ci`; parameter/literal/CONCAT
coercibility was `6` and CONCAT passed. This validates the probe syntax and
safe event contract but does not substitute for the Hostinger pool result.

## 7. Production evidence still required

Deploy the guarded post-listen collation probe with binary protocol retained:

```env
DIAG_MARIADB_COLLATION_PROBE=I_UNDERSTAND_THIS_ONLY_READS_SESSION_METADATA
DB_MARIADB_USE_TEXT_PROTOCOL=false
```

Collect exactly one `MARIADB_COLLATION_PROBE_RESULT` event. It contains only
session charset/collation metadata, bound-parameter/literal/CONCAT metadata and,
when MariaDB returns 1267, bounded collation/coercibility/operation tokens.
It contains no SQL, values, connection identity, request data or raw message.
Disable the probe and restart immediately after evidence collection.

## 8–9. Root cause

**PARTIALLY PROVEN.** MariaDB 1267 illegal collation aggregation and the shared
`LIKE CONCAT(literal, bound parameter, literal)` expression are proven. The
exact collation pair and coercibilities are not proven because phpMyAdmin does
not establish the Prisma pool session/parameter metadata. Schema drift,
physical-column mismatch, mapping, relation joins and a generally broken
MariaDB binary protocol are ruled out. No corrective query, driver-collation,
index, transaction, cache or mapping change was made.

## 10. Code changes (follow-up diagnostic hardening — behavior-preserving)

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
- Top-level `DriverAdapterError` now emits only a bounded structural allowlist:
  `cause.kind`, `originalCode`, numeric/string `code`, normalized `sqlState`,
  and constraint index/fields plus a coarse category. Raw messages, stack,
  SQL, parameters and connection identity are never copied.
- Automatic Pino request logs now contain only request ID, method and a safe
  route template. They no longer serialize request URL, query object, headers,
  forwarded/client IP or remote port. Global exception logs keep their exact
  matched safe route template and stage.
- Prisma startup no longer logs the database host, port or database name in
  any environment.
- Added validated `DB_MARIADB_USE_TEXT_PROTOCOL` (default `false`) and passed it
  as the adapter option. This is an operator-controlled A/B switch, not a
  claimed fix. The guarded read-only diagnostic reports which protocol it used.
- Added isolated MariaDB 11.8.8 Docker/API proof. It is opt-in, exact-test-DB
  guarded, not part of normal unit tests, and cleans only run-scoped fixtures.
- Prisma generator preview features are empty and application source has no
  `relationLoadStrategy`; adapter 7.8 explicitly disables relation joins for
  MariaDB, so no relation strategy was changed.
- Added a disabled-by-default, exact-confirmation, post-listen collation probe.
  It uses the singleton `PrismaService`, three static tagged `$queryRaw`
  metadata queries, a four-second whole-probe timeout and one run per process.
  It never affects health/readiness and never queries Production row values.
- Added a bounded MariaDB 1267 parser. Raw driver messages are inspected only
  in memory; output is restricted to the two collation/coercibility pairs and
  operation token.

Release identity injection is now verified in Production health.

## 11. Tests

- `test/safe-database-error-context.test.ts`: P2022→MISSING_COLUMN,
  P2024→CONNECTION_POOL_TIMEOUT, MariaDB driver shape (no `meta.target`),
  top-level `DriverAdapterError` generic/column/constraint shapes, array target,
  init error URL redaction, graceful degrade and database-error recognition.
- Global filter tests prove top-level driver cause extraction while malicious
  message/SQL/parameters/token/query values are absent. Pino serializer tests
  prove URL/query/header/forwarded IP/client IP are absent.
- Protocol proof safety tests require the exact local isolated database and
  confirmation, verify run-scoped identities and both protocol branches.
- Diagnostic safety coverage proves the Production confirmation/website guard,
  no concurrent probe in Production, allowlisted error serialization, absence
  of database mutation primitives, and assigned-list query/mapping tags.
- Baseline before this branch: 194/194 tests in 53 suites.
- Final probe-branch verification: 220/220 tests in 59 suites; typecheck, lint
  (0 errors/92 existing warnings), build, format, focused MariaDB 11.8.8
  binary/text integration proof, built-API probe smoke and diff-check all pass.

## 12. Deployment plan for the final read-only probe

1. Deploy the probe commit with the exact confirmation value and
   `DB_MARIADB_USE_TEXT_PROTOCOL=false`.
2. Verify listen, health and readiness normally; the probe starts only after
   `app.listen()` and cannot change their status.
3. Extract the single `MARIADB_COLLATION_PROBE_RESULT` event.
4. Set `DIAG_MARIADB_COLLATION_PROBE=DISABLED` and restart/redeploy.
5. Choose a corrective fix only after the event proves the actual
   session/parameter/literal/CONCAT collation and coercibility combination.

## 13. Rollback plan

Environment rollback is set `DIAG_MARIADB_COLLATION_PROBE=DISABLED` and
restart. Code rollback is redeploy `0cc41e2`. Keep
`DB_MARIADB_USE_TEXT_PROTOCOL=false`. No schema, migration or Production data
change is involved.

## 14. Remaining risks

- The exact two collations/coercibilities remain unknown until the Production
  probe event is collected.
- MariaDB 1267 is proven, but changing driver collation or query behavior before
  that event would still be speculative.

## 15. Final production acceptance status

**NOT MET** — no corrective artifact or Production protocol A/B has been
deployed; the failing endpoints have not returned 200 in Production.

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

---

## 17. 2026-09-01 — mechanism identified, connection/protocol hypotheses eliminated

Status of this section: **failure class REPRODUCED and mutation-proven. The
specific production instance is NOT yet identified, because production has been
discarding the one field that identifies it.**

### 17.1 What was reproduced

`col LIKE CONCAT('%', ?, '%')` — the exact SQL Prisma 7 emits for `contains`,
re-confirmed by capturing the generated statements — raises MariaDB **1267 /
HY000** when **the bound term's character repertoire cannot be converted into
the searched COLUMN's character set**. Reproduced end to end through Prisma 7 +
`@prisma/adapter-mariadb` 7.8.0 + `mariadb` 3.4.5, with the safe error context
reporting exactly the production shape:

```
Illegal mix of collations (utf8mb3_general_ci,IMPLICIT)
                      and (utf8mb4_unicode_ci,COERCIBLE) for operation 'like'
```

Note the derivations: the column is **IMPLICIT**, the CONCAT expression is
**COERCIBLE**. MySQL/MariaDB normally coerce the COERCIBLE side to the column's
collation; that coercion is what fails when the value cannot be represented in
the column's charset.

### 17.2 What was ELIMINATED, experimentally

Each of these was previously listed as POSSIBLE. All are now RULED_OUT, by
executable matrices rather than reasoning:

| Hypothesis | How it was eliminated |
| --- | --- |
| Connection/session collation mismatch causes 1267 | 294-case matrix over {`utf8mb4_unicode_ci`, `utf8mb4_general_ci`, `utf8mb4_uca1400_ai_ci`} connections × 7 column collations × 7 term shapes × both protocols. **Zero** failures attributable to the connection collation |
| Some other `character_set_connection` triggers it | Swept **all 40 server character sets** as `character_set_connection` against a `utf8mb4_unicode_ci` column with an ASCII term: **0** failures (the only errors were Node-side "Encoding not recognized" for `dec8`/`swe7`/`ujis` etc., which never reach the server) |
| `character_set_client = binary`, `SET NAMES binary`, client≠connection charset | All tested explicitly. No 1267 |
| Binary (prepared) protocol is at fault | `useTextProtocol` **false and true fail identically** on the reproducing case, and both succeed on every non-reproducing case. The protocol is irrelevant to this error class |
| MariaDB version behaviour | Same matrices on **10.6.28, 10.11.19, 11.8.8** and **MySQL 8.0.46**. Identical outcomes |
| Migration-induced schema drift on a fresh database | `prisma migrate deploy` of all 19 migrations onto a **stock** MariaDB 11.8.8 (server default `utf8mb4_uca1400_ai_ci`) converges **all 22 tables and all 123 searchable string columns** to `utf8mb4` / `utf8mb4_unicode_ci`. Fresh databases are correct |

**Consequence for `DB_MARIADB_USE_TEXT_PROTOCOL`: it is neither the cause nor a
mitigation for this error class.** Classify it `MITIGATION_ONLY` for other
purposes and leave it at `false`. Flipping it would not have fixed this.

### 17.3 The one case that cannot be reproduced, and why it matters

**An ASCII search term such as `Surprised` never produces 1267** — not on any
column charset, connection collation, protocol or server version tested. ASCII
converts into every charset MariaDB supports.

So a production 1267 on `search=Surprised` requires at least one of:

1. the bound term was not pure ASCII (the console is Vietnamese, and
   `mimeType startsWith "video/"` in `getPlayableVideoWhereInput()` puts a LIKE
   into assignment-options **with no user search at all**); or
2. a searched column in the production database is not `utf8mb4`.

Both point at the same root class and the same corrective action. Neither can be
confirmed from here — which is the actual blocker, and it is a code defect:

### 17.4 The observability defect that kept this open

`parseMariaDbCollationConflict()` has existed since `d7cb5e1` and correctly
extracts the two collation/coercibility pairs and the operation token. It was
wired **only** into the opt-in post-`listen()` probe — **never into the request
error path**. `toSafeDatabaseErrorContext()`, which `GlobalExceptionFilter`
actually calls, did not use it, and `1267` had no entry in
`CATEGORY_BY_MYSQL_CODE`.

Every production 500 therefore logged `errorName`, `originalCode`, `code` and
`sqlState` — and threw away the message naming the two collations. That is why
this incident has read "exact collation/coercibility pair NOT_VERIFIED" since
2026-07-20.

**Fixed.** The parser is now called from `toSafeDatabaseErrorContext()` on both
the top-level `DriverAdapterError` shape and the
`meta.driverAdapterError.cause` shape, and `1267` maps to the
`COLLATION_CONFLICT` category. Output stays bounded and allowlisted: five short
tokens, no SQL, no query arguments, no values, no connection identity.

Mutation-proven: removing the wiring makes 3 unit tests and both
`COLLATION-04` integration checks fail with `category=DRIVER_ADAPTER`,
`pair=undefined` — **byte-identical to what production reports today**, which is
independent evidence that production is running the unfixed path.

### 17.5 Why the previous local harness could never see any of this

`docker-compose.mariadb-test.yml` pins `--collation-server=utf8mb4_unicode_ci`,
making the server default match the schema contract and hiding every
host-dependent collation behaviour. `docker-compose.mariadb-collation-test.yml`
was added alongside it (port 3312, **no** pinned collation) so the stock-host
condition is reproducible. Both harnesses are kept.

### 17.6 Operator next step — read-only, safe on production

```bash
yarn diagnose:admin-search-collation
```

`SELECT`-only against `information_schema` and session variables. Reads no row
data, writes nothing, prints no credential, host, user or `DATABASE_URL`. It
reports the charset/collation of every column reachable from an Admin search
input and names any that drifted from the contract. Exit `0` = clean, `1` =
drift found, `2` = audit failed.

Run it, then either:

- **drift reported** → the named columns are the cause. Prepare a narrowly
  scoped forward migration converting exactly those columns to
  `utf8mb4 / utf8mb4_unicode_ci`. Do not write that migration before this output
  exists, and do not `CONVERT TO CHARACTER SET` whole tables blind.
- **no drift reported** → deploy the observability fix and capture one real
  failure. The log line will now carry `databaseCategory: "COLLATION_CONFLICT"`
  and `collationConflict: { leftCollation, leftCoercibility, rightCollation,
  rightCoercibility, operation }`, request-correlated by `x-request-id`.

### 17.7 What was deliberately NOT changed

- **No connection `charset`/`collation` was pinned in the adapter.** It would
  not fix the reproduced class (proven in 17.2) and shipping it would be a
  speculative change to the shared database layer.
- **No migration was written.** There is no evidence yet of which production
  columns, if any, drifted.
- **No search behaviour was altered.** Normalization, NFC, trim, whitespace
  collapse, min/max length, literal `%`/`_`/`\` escaping, title+slug OR,
  `filterKey`, status, provider, sorting, pagination and cache keys are all
  unchanged and are pinned by the new proof.
- **`DB_MARIADB_USE_TEXT_PROTOCOL` was left at `false`.**

---

## 18. 2026-09-01 — RESOLVED. Root cause proven on production and fixed

Status: **ROOT CAUSE PROVEN — FIX DEPLOYED — PRODUCTION VERIFIED.**

### 18.1 Corrections to section 17

Section 17 was written without production access and contains three conclusions
that direct measurement has now falsified. They are corrected here rather than
edited away, because the reasoning that produced them is instructive.

| §17 claim | Corrected finding |
| --- | --- |
| "`DB_MARIADB_USE_TEXT_PROTOCOL` is neither cause nor mitigation" | **Wrong for this failure mode.** On production the binary protocol fails and the text protocol succeeds. §17 tested a *different* 1267 mode (charset-repertoire), where the protocol genuinely is irrelevant. Two distinct mechanisms produce the same error code |
| "Connection/session collation mismatch is RULED_OUT" | **Wrong.** The real cause *is* a collation disagreement — but between the **SQL-text literal** and the **bound parameter**, not between the connection and the column |
| "The parser exists but is wired only into the boot probe" | Described the local repo. The deployed build did contain the parser; it was `toSafeDatabaseErrorContext()` that never called it |

An unrelated but material trap: `/health` reported
`commit 0cc41e2, builtAt 2026-07-20`, which is **stale `APP_RELEASE_*` env**, not
the running build. The deployed source is `1475610` (`last-source/.git`).
Release identity from operator-set env must be corroborated against the build.

### 18.2 Root cause

`Hostinger MariaDB 11.8.8-log` assigns a **binary-protocol bound parameter** the
legacy default collation `utf8mb4_general_ci`, instead of the session's
`collation_connection`. SQL-text literals keep `collation_connection`
(`utf8mb4_unicode_ci`, from the driver's handshake collation byte 224).

Prisma compiles `contains` to `col LIKE CONCAT('%', ?, '%')`. Aggregating a
`utf8mb4_unicode_ci` literal with a `utf8mb4_general_ci` parameter — same
charset, different collation, equal derivation — yields **`utf8mb4_bin` with
DERIVATION_NONE (1)**. NONE outranks the column's IMPLICIT (2), so the operand
cannot be coerced and the server raises 1267.

Measured on production versus a local MariaDB 11.8.8:

| operand, binary protocol | local `11.8.8-ubu2404` | production `11.8.8-MariaDB-log` |
| --- | --- | --- |
| literal `'%'` | `utf8mb4_unicode_ci` (6) | `utf8mb4_unicode_ci` (6) |
| **bound parameter `?`** | `utf8mb4_unicode_ci` (6) | **`utf8mb4_general_ci` (6)** |
| `CONCAT('%', ?, '%')` | `utf8mb4_unicode_ci` (6) | **`utf8mb4_bin` (1 = NONE)** |

The failure is **value-independent**: ASCII, Vietnamese and `video/` all fail
identically, because the conflict is resolved at CONCAT aggregation before any
value is compared. This is why `search=Surprised` failed even though §17 proved
ASCII cannot trigger the charset-repertoire mode.

### 18.3 What was ruled out, with production evidence

- **Schema drift — RULED OUT.** All 11 searched columns, all 123 text columns,
  all 22 tables and the database default are `utf8mb4 / utf8mb4_unicode_ci`.
  Migrations 19/19 finished, 0 rolled back. **No migration was created.**
- **Adapter `collation` option — INEFFECTIVE.** `UTF8MB4_UNICODE_CI`,
  `UTF8MB4_GENERAL_CI` and `UTF8MB4_BIN` all leave `collation_connection`
  unchanged and all still fail. The driver applies it as a handshake byte, not a
  statement.
- **`SET collation_connection = ...` alone — INEFFECTIVE.** Only the combined
  `SET NAMES <charset> COLLATE <collation>` rebinds both sides.
- **Driver/adapter/Prisma versions — IDENTICAL** to local (`mariadb` 3.4.5,
  adapter/client/prisma 7.8.0). Not a version defect.
- **Recent work — NOT THE CAUSE.** The search predicate, `schema.prisma` and
  `prisma/migrations/` are unchanged since the July release. No search logic was
  deleted.

### 18.4 Fix

`src/database/prisma.service.ts` — one option on the pooled connection:

```ts
initSql: `SET NAMES ${SCHEMA_CHARSET} COLLATE ${SCHEMA_COLLATION}`
```

derived from the schema contract in `prisma/migrations/`, never from a host
default. It keeps the binary/prepared protocol, so prepared-statement injection
guarantees, BigInt/date/BLOB handling, transactions and pooling are untouched.

`DB_MARIADB_USE_TEXT_PROTOCOL` remains `false`. The text protocol also resolves
the error and was verified data-safe (BigInt preserved, dates as `Date`,
injection probe returned 0 rather than the full table), but it changes how
statements reach the server and was therefore rejected in favour of correcting
the session state.

### 18.5 Observability fix

`toSafeDatabaseErrorContext()` now calls the existing bounded parser and maps
`1267 → COLLATION_CONFLICT`, so a future occurrence names both operands,
request-correlated by `x-request-id`, with no SQL, values or secrets.

### 18.6 Production verification

Through the **deployed** `PrismaService`, `useTextProtocol=false`: video search
(ASCII, Vietnamese, literal `%`, literal `_`), status+search, no-search,
`mimeType startsWith` on both asset tables, websites, domains, domain groups and
admin accounts — **all OK**. Runtime log after restart: 114 entries, **0 × 1267,
0 error-level entries**, `stderr.log` 0 bytes.

### 18.7 Why no local harness could reproduce it

The behaviour is a property of the **server build**, not of configuration.
`docker-compose.mariadb-test.yml` and `docker-compose.mariadb-collation-test.yml`
were both confirmed to match production on `collation_server` and
`character_set_collations` and still assign parameters the session collation
correctly. No local MariaDB available here reproduces it. The invariant is
therefore encoded as COLLATION-05/06/07 in the proof: session, parameter and
`CONCAT` collation must all equal the schema contract and must never aggregate
to a NONE derivation.

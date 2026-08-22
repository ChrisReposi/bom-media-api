# Observability

Status: CURRENT
Last verified: 2026-08-21
Verified against: `src/app.module.ts`, `src/common/filters/global-exception.filter.ts`, `src/common/http/safe-request-route.util.ts`, `src/common/errors/safe-database-error-context.util.ts`, `src/health/**`, `src/common/diagnostics/**`

## 1. Logging

`nestjs-pino` with `pino-http`. Configured once, in `src/app.module.ts`.

- **Level** — `info` in production, `debug` otherwise.
- **Request id** — taken from an incoming `X-Request-Id` when it matches
  `^[a-zA-Z0-9._:-]{1,64}$`, otherwise a fresh `randomUUID()`. Always echoed
  back in the `X-Request-Id` response header, so a client-visible failure can be
  correlated with exactly one log line.
- **Request serializer** — emits only `id`, `method` and a **route template**
  (`safeRequestRoute`). Raw URLs and query strings are never logged, which is
  what keeps share tokens and grants out of the logs even when a route is hit
  directly.
- **Redaction** — `req.headers.authorization`, `req.headers.cookie`,
  `req.headers.proxy-authorization`, `req.headers.x-api-key`,
  `res.headers.set-cookie`, `req.query.token`, `req.query.grant` → `[Redacted]`.

> **INVARIANT: never weaken the redaction list or the request serializer.**
> Adding a raw-URL or full-headers serializer would leak share tokens and media
> grants into log storage.

There is no log shipping, aggregation or alerting configured in this repository.
Logs go to stdout and are whatever the host does with them.

## 2. Error logging

`GlobalExceptionFilter` writes exactly **one** structured line per `>= 500`:

```jsonc
{ "requestId", "method", "route", "status", "stage"?, "errorName",
  "database"? : { /* sanitised Prisma context */ } }
```

- `route` is a template, never a raw URL.
- `stage` is read from a tag services attach to the error (for example the
  share-link creation stages), so one line ties request → route → failing stage.
- `database` comes from `toSafeDatabaseErrorContext()` and never contains raw
  messages, SQL, query arguments or secrets.
- Clients always get the generic 500 body; nothing from these fields is returned.

Non-5xx `HttpException`s are returned as-is and are not error-logged.

## 3. Health and readiness

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/health` | Liveness. Never touches the database. Includes `release` when `APP_RELEASE_VERSION`/`APP_BUILD_SHA`/`APP_BUILD_TIME` were injected at build time |
| `GET /api/v1/health/ready` | Readiness: a lightweight database check plus, when local storage is enabled, an access check on the storage root. Result is short-cached |

Both use `@SkipThrottle()`. Readiness returns `503` when a check fails and never
discloses the storage path.

`release` is the supported way to answer "which build is actually running?" —
it is injected at deploy time and never derived from `.git` at runtime.

## 4. Audit log — who changed what

`AdminAuditLog`: `adminId` (nullable), `action`, `module`, `entityType`,
`entityId`, `status` (`SUCCESS`/`FAIL`), `ipHash`, truncated `userAgent`,
`metadataJson`, `createdAt`.

Auth actions: `ADMIN_LOGIN_SUCCESS`, `ADMIN_LOGIN_FAILURE`,
`ADMIN_REFRESH_SUCCESS`, `ADMIN_REFRESH_FAILURE`, `ADMIN_REFRESH_REPLAY`,
`ADMIN_LOGOUT_SUCCESS`, `ADMIN_LOGOUT_FAILURE`,
`ADMIN_PASSWORD_CHANGE_SUCCESS`, `ADMIN_PASSWORD_CHANGE_FAILURE`,
`ADMIN_SESSION_REVOKE_SUCCESS`. Domain modules add their own
(`VIDEO_UPLOAD`, `VIDEO_EMBED_CREATE`, `SHARE_LINK_CREATE`, …).

Audit writes are best effort: a failure is logged as a warning and never fails
the request. Indexed by `createdAt`, `adminId`, `module` and
`(entityType, entityId)`.

**Investigation starting points**

| Question | Query |
|---|---|
| Who changed this video? | `entityType = 'VideoAsset' AND entityId = ?` |
| Brute-force attempt? | `action = 'ADMIN_LOGIN_FAILURE'` grouped by `ipHash` |
| Stolen refresh token? | `action = 'ADMIN_REFRESH_REPLAY'` — each row is a session that was force-revoked |
| Who created this share link? | `action = 'SHARE_LINK_CREATE' AND entityId = ?` |

## 5. Access log — who viewed what

`AccessLog`: `websiteId`, `shareLinkId`, `domain`, `ipHash`, `userAgent`,
`referer`, `status` (`ALLOWED`/`DENIED`), `reasonCode`, `createdAt`.

Written on **public watch resolution**, both success and denial.

> **`AccessLog.reasonCode` is the only place the real denial reason exists.**
> The public response always says `INVALID_LINK` (see
> [SECURITY_MODEL.md §4](./SECURITY_MODEL.md#4-public-share-authorization)), so
> this table is not a convenience — it is the sole diagnostic channel for "why
> did this customer's link stop working?".

| Reason code | Meaning | Client sees |
|---|---|---|
| `OK` | Resolved and served | `OK` |
| `MISSING_HOST` | No/invalid `host` parameter | `INVALID_LINK` |
| `MISSING_TOKEN` | No credential supplied | `INVALID_LINK` |
| `INVALID_LINK` | Unknown credential, wrong website, inactive domain/website, or non-`ACTIVE` share link | `INVALID_LINK` |
| `EXPIRED_LINK` | Past `expiresAt` | `INVALID_LINK` |
| `VIEW_LIMIT_REACHED` | `currentViews >= maxViews` | `INVALID_LINK` |
| `NO_VIDEOS` | No eligible, assigned, `READY` video remained | `INVALID_LINK` |
| `SERVER_ERROR` | `SHARE_TOKEN_PEPPER` missing (also logged as an error) | `INVALID_LINK` |

> Media Range requests are **not** access-logged. A single viewer produces one
> `AccessLog` row for the watch resolution and then many unlogged media
> requests. Do not read `AccessLog` as a bandwidth or playback metric.

> Playback of a `DIRECT_URL`, Cloudinary `UPLOAD` or `EMBED` video produces **no
> backend request at all** — the browser fetches the provider URL directly.
> `AccessLog` records that the viewer was admitted, never that they watched.
> There is no server-side visibility into external provider playback.

A rising rate of `INVALID_LINK` from few `ipHash` values is the signature of
share-token guessing.

## 6. View growth telemetry

`VideoViewGrowthBucket` (hourly totals per video) and `VideoViewGrowthEvent`
(deduped per `videoId` + `viewerHash` + `windowStart`) back the capped display
counter. `VideoAsset.viewCount` is a **display** figure, not analytics.
Disabled by default in production (`VIDEO_VIEW_GROWTH_ENABLED`).

## 7. Diagnostics

- **MariaDB collation probe** — opt-in, read-only session metadata. Enabled only
  by the exact literal `DIAG_MARIADB_COLLATION_PROBE=I_UNDERSTAND_THIS_ONLY_READS_SESSION_METADATA`,
  runs once after `listen()`, and logs a single `MARIADB_COLLATION_PROBE` event.
- **`yarn diagnose:admin-video-queries`** — isolates admin video query failures.
- `parse-mariadb-collation-conflict.util.ts` recognises the collation-conflict
  signature behind the 2026-07-20 incident.

Background: `docs/incidents/2026-07-20-production-admin-video-list-500.md`.

## 8. What must never appear in logs

Passwords or bcrypt hashes; raw JWTs, refresh tokens, share tokens or media
grants; `Authorization`/`Cookie` headers; `DATABASE_URL`; any pepper or secret;
raw client IPs (hash with `ACCESS_LOG_IP_PEPPER`); raw SQL, query arguments or
Prisma error messages; request bodies of auth endpoints; full URLs or query
strings for public routes.

## 9. Gaps

Not implemented — treat as `PLANNED`:

- No metrics endpoint (no Prometheus, no OpenTelemetry, no tracing).
- No alerting; failures are visible only by reading logs.
- No log retention or rotation policy in-repo.
- No automatic pruning of `AccessLog` / `AdminAuditLog`; both grow unbounded.
- `yarn cleanup:admin-sessions` exists for expired sessions but nothing schedules
  it.
- No uptime monitoring of `/health` configured here.

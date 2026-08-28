# Environment Variables

Status: CURRENT
Last verified: 2026-08-23
Verified against: `src/config/env.validation.ts`, `src/config/env.config.ts`, `src/config/load-env.ts`, `.env.example`, and every `configService.get(...)` call in `src/`

**No real secret values appear in this document, and none may ever be added.**
Secrets are described by variable name and purpose only.

## 1. How environment loading works

`src/config/load-env.ts` runs before Nest starts:

1. If `./.env` exists it is loaded first with `override: false`.
2. If `DOTENV_CONFIG_PATH` is set, that file is loaded with `override: true`
   and loading stops. A missing path throws.
3. Otherwise, when `APP_ENV=local` or the npm lifecycle event is one of the
   local/database scripts, `.env.local` is loaded with `override: true` and must
   exist.
4. Never loads a local file when `NODE_ENV=production` or `APP_ENV=production`.

`ConfigModule` runs with `ignoreEnvFile: true`, so Nest itself reads nothing
from disk. `validateEnv()` then normalises and validates, throwing on startup
for any invalid value. Typed access is via `configService.getOrThrow("api")`
(`ApiEnvironmentConfig`).

Files present in this repository: `.env`, `.env.local`, `.env.production`,
`.env.test` (all gitignored, all containing real values on developer machines)
and the committed templates `.env.example`, `.env.local.example`,
`.env.test.example`.

## 2. Required variables

Startup fails without these, in **every** environment:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | MySQL/MariaDB connection string. **Secret** |
| `JWT_ACCESS_SECRET` | Signs and verifies admin access tokens. **Secret** |
| `REFRESH_TOKEN_PEPPER` | Peppers refresh-token hashes. **Secret** |
| `SHARE_TOKEN_PEPPER` | Peppers share-token hashes. **Secret** |
| `ACCESS_LOG_IP_PEPPER` | Peppers IP and user-agent hashes. **Secret** |

Additionally required when `NODE_ENV=production` or `APP_ENV=production`:

| Variable | Purpose |
|---|---|
| `PUBLIC_MEDIA_GRANT_SECRET` | HMAC key for public media grants; **≥ 32 characters** (a weak development default is substituted outside production). **Secret** |
| `ADMIN_CHANGE_PASSWORD_SECRET` | Operator secret for the deprecated change-password route. **Secret** |
| `ADMIN_WEB_ORIGIN` | Must be a **non-local HTTPS** origin in production |

## 3. Core runtime

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | |
| `APP_ENV` | falls back to `NODE_ENV` | Either being `production` makes `isProduction` true |
| `API_HOST` | `0.0.0.0` | |
| `API_PORT` | `3000` | Must be a valid TCP port |
| `API_PREFIX` | `api/v1` | Normalised; must not be empty |
| `API_INTERNAL_DOCS_ENABLED` | `!isProduction` | Swagger requested |
| `API_DOCS_ALLOW_IN_PRODUCTION` | `false` | Swagger in production requires **both** flags |
| `APP_RELEASE_VERSION`, `APP_BUILD_SHA`, `APP_BUILD_TIME` | unset | Optional; surfaced by `/health` |

## 4. Database

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | **Required. Secret.** |
| `SHADOW_DATABASE_URL` | unset | `prisma migrate dev` only. **Secret** |
| `DB_CONNECTION_LIMIT` | `5` | Keep conservative on shared MySQL |
| `DB_CONNECT_TIMEOUT_MS` | `10000` | |
| `DB_ACQUIRE_TIMEOUT_MS` | `10000` | |
| `DB_IDLE_TIMEOUT_SECONDS` | `60` | |
| `DB_MARIADB_USE_TEXT_PROTOCOL` | `false` | Incident mitigation switch — see `docs/incidents/2026-07-20-production-admin-video-list-500.md` |
| `DIAG_MARIADB_COLLATION_PROBE` | disabled | Enabled **only** by the exact literal `I_UNDERSTAND_THIS_ONLY_READS_SESSION_METADATA` |

## 5. Admin authentication

| Variable | Default | Notes |
|---|---|---|
| `JWT_ACCESS_SECRET` | — | **Required. Secret.** |
| `JWT_ACCESS_EXPIRES_IN` | `15m` | Must match `^\d+[smhd]?$` |
| `REFRESH_TOKEN_PEPPER` | — | **Required. Secret.** |
| `REFRESH_TOKEN_BYTES` | `32` | Integer ≥ 32 |
| `REFRESH_TOKEN_EXPIRES_DAYS` | `30` | Positive integer; also the session lifetime |
| `ADMIN_REGISTER_ENABLED` | `!isProduction` | Gate for the one-time owner registration |
| `ADMIN_REGISTER_SECRET` | unset | Required by `register` when enabled. **Secret** |
| `ADMIN_CHANGE_PASSWORD_SECRET` | unset (**required in prod**) | Deprecated change-password route. **Secret** |
| `ADMIN_ACCOUNT_MANAGEMENT_ENABLED` | `!isProduction` | When false, `/admin/accounts/*` returns `503` |
| `ADMIN_TEMP_PASSWORD_TTL_HOURS` | `24` | Clamped 1–168 |
| `ADMIN_BOOTSTRAP_USERNAME` | — | Seed script only; 3–32 chars `[A-Za-z0-9_]` |
| `ADMIN_BOOTSTRAP_PASSWORD` | — | Seed script only. **Secret** |

> `JWT_REFRESH_SECRET` / `JWT_REFRESH_EXPIRES_IN` are **RETIRED**. Refresh
> tokens are opaque; these names are read by nothing.

## 6. CORS and proxy

| Variable | Default | Notes |
|---|---|---|
| `ADMIN_WEB_ORIGIN` | `http://localhost:5173` | Always in the static allowlist |
| `CORS_ALLOWED_ORIGINS` | empty | Comma-separated additional origins |
| `CORS_ALLOW_DB_DOMAINS` | `true` | Allow origins matching `ACTIVE` website domains |
| `CORS_DB_ORIGIN_CACHE_TTL_MS` | `60000` | |
| `CORS_ALLOW_LOCALHOST_DB_DOMAINS` | `!isProduction` | Permits `http://` DB-backed origins |
| `TRUST_PROXY_ENABLED` | `false` | Enable only behind a genuinely trusted proxy |
| `TRUSTED_PROXY_CIDRS` | empty | Comma-separated; validated by `proxy-addr` |
| `TRUST_PROXY_HOPS` | `1` | Used when no CIDR list is given |
| `TRUST_PROXY_CLOUDFLARE_ONLY` | `false` | Prefer `CF-Connecting-IP` |

## 7. Rate limiting

| Variable | Default | Variable | Default |
|---|---|---|---|
| `GLOBAL_THROTTLE_TTL_SECONDS` | `60` | `GLOBAL_THROTTLE_LIMIT` | `120` |
| `AUTH_LOGIN_THROTTLE_TTL_SECONDS` | `60` | `AUTH_LOGIN_THROTTLE_LIMIT` | `5` |
| `AUTH_REFRESH_THROTTLE_TTL_SECONDS` | `60` | `AUTH_REFRESH_THROTTLE_LIMIT` | `20` |
| `AUTH_LOGOUT_THROTTLE_TTL_SECONDS` | `60` | `AUTH_LOGOUT_THROTTLE_LIMIT` | `30` |
| `ADMIN_API_THROTTLE_TTL_SECONDS` | `60` | `ADMIN_API_THROTTLE_LIMIT` | `120` |
| `PUBLIC_WATCH_THROTTLE_TTL_SECONDS` | `60` | `PUBLIC_WATCH_THROTTLE_LIMIT` | `60` |
| `PUBLIC_MEDIA_THROTTLE_TTL_SECONDS` | `60` | `PUBLIC_MEDIA_THROTTLE_LIMIT` | `1200` |

`PUBLIC_MEDIA_THROTTLE_LIMIT` must stay generous: a single seeking viewer
generates many Range requests.

## 8. In-memory cache

Process-local, lost on restart, **not shared** between Node processes.

| Variable | Default | Bounds |
|---|---|---|
| `MEMORY_CACHE_ENABLED` | `true` | |
| `MEMORY_CACHE_MAX_ENTRIES` | `1000` | 100–10000 |
| `MEMORY_CACHE_DEFAULT_TTL_SECONDS` | `60` | 1–600 |
| `MEMORY_CACHE_INFLIGHT_TTL_MS` | `5000` | 500–30000 |
| `ADMIN_VIDEOS_LIST_CACHE_TTL_SECONDS` | `30` | 1–600 |
| `ADMIN_WEBSITES_LIST_CACHE_TTL_SECONDS` | `60` | 1–600 |
| `PUBLIC_WATCH_METADATA_CACHE_TTL_SECONDS` | `10` | 1–60 |
| `MEDIA_METADATA_CACHE_TTL_SECONDS` | `300` | 1–3600 |

## 9. Public share links and media

| Variable | Default | Notes |
|---|---|---|
| `SHARE_TOKEN_PEPPER` | — | **Required. Secret.** Rotating invalidates every raw share token (aliases keep working) |
| `PUBLIC_MEDIA_GRANT_SECRET` | dev default (**required in prod**) | ≥ 32 chars. **Secret** |
| `PUBLIC_MEDIA_GRANT_TTL_SECONDS` | `21600` (6 h) | Clamped 300–86400 |
| `ACCESS_LOG_IP_PEPPER` | — | **Required. Secret.** |
| `PUBLIC_SITE_PROTOCOL` | `https` | Protocol used when building share URLs |
| `PUBLIC_SHARE_LOCAL_PROTOCOL` | `http` | Used for localhost-style domains |
| `ALLOW_LOCALHOST_DOMAIN_CLAIM` | env-dependent | Permits claiming localhost domains |

## 10. Public display-view growth

| Variable | Default | Notes |
|---|---|---|
| `VIDEO_VIEW_GROWTH_ENABLED` | `!isProduction` | Off in production unless set true |
| `VIDEO_VIEW_MAX_INCREMENT_PER_EVENT` | `99` | |
| `VIDEO_VIEW_MAX_INCREMENT_PER_VIDEO_HOUR` | `5000` | Hourly bucket cap |
| `VIDEO_VIEW_DEDUPE_WINDOW_MINUTES` | `15` | |
| `VIDEO_VIEW_MIN_WATCH_SECONDS` | `5` | |
| `VIDEO_VIEW_RANDOM_MIN_INCREMENT` | `1` | |

## 11. Video: embed, probe, DB blob

| Variable | Default | Notes |
|---|---|---|
| `VIDEO_EMBED_ALLOWED_HOSTS` | Cloudinary/YouTube/YouTube-nocookie/Vimeo | Must stay in sync with the public site's `ALLOWED_EMBED_HOSTS` and its CSP `frame-src` |
| `VIDEO_EMBED_DEFAULT_ALLOW` | `autoplay; fullscreen; encrypted-media; picture-in-picture` | iframe `allow` attribute |
| `VIDEO_METADATA_PROBE_ENABLED` | `true` | Duration/format probing |
| `VIDEO_METADATA_PROBE_TIMEOUT_MS` | `8000` | |
| `VIDEO_METADATA_PROBE_MAX_REMOTE_MB` | `100` | Bounded ranged fetch |
| `MANUAL_VIDEO_URL_ALLOWLIST` | empty | Optional host allowlist for remote probing |
| `VIDEO_DB_STORAGE_ENABLED` | `false` | Must be `false` in production unless `VIDEO_DB_STORAGE_ALLOW_PRODUCTION_OVERRIDE=true` — startup throws otherwise |
| `VIDEO_DB_STORAGE_ALLOW_PRODUCTION_OVERRIDE` | `false` | Explicit escape hatch |
| `VIDEO_DB_UPLOAD_MAX_MB` | `50` | Hard ceiling `100`; larger values throw |

## 12. Local file storage (`LOCAL_FILE`)

| Variable | Default | Notes |
|---|---|---|
| `LOCAL_FILE_STORAGE_ENABLED` | `false` | |
| `LOCAL_FILE_STORAGE_ROOT` | unset | **Required** when enabled. Rejected if it looks like a public web root (`public_html`, `htdocs`, `www`, `public`, `dist`). Must be absolute in production |
| `LOCAL_VIDEO_UPLOAD_MAX_MB` | `500` | Must be ≤ the hard max |
| `LOCAL_VIDEO_UPLOAD_HARD_MAX_MB` | `1024` | Ceiling `1024`; larger values throw |
| `LOCAL_VIDEO_CHUNK_SIZE_MB` | `50` | Keep below upstream/Cloudflare request-size limits |
| `LOCAL_VIDEO_UPLOAD_SESSION_TTL_MINUTES` | `120` | |
| `LOCAL_VIDEO_MIN_FREE_SPACE_MB` | `1024` (code) / `15360` in `.env.example` | Reserve; keep 10–20 GB in production |
| `LOCAL_VIDEO_STALE_UPLOAD_MAX_AGE_HOURS` | `24` | Cleanup threshold |
| `LOCAL_THUMBNAIL_UPLOAD_MAX_MB` | `10` | |

## 13. Cloudinary

| Variable | Default | Notes |
|---|---|---|
| `CLOUDINARY_CLOUD_NAME` | — | Required for Cloudinary upload/thumbnails |
| `CLOUDINARY_API_KEY` | — | **Secret** |
| `CLOUDINARY_API_SECRET` | — | **Secret** |
| `CLOUDINARY_UPLOAD_FOLDER` | `video-cms/videos` | |
| `CLOUDINARY_THUMBNAIL_UPLOAD_FOLDER` | `<upload folder>/thumbnails` | |
| `CLOUDINARY_SECURE` | `true` | |
| `VIDEO_UPLOAD_MAX_MB` | `500` | Cloudinary upload limit |
| `VIDEO_THUMBNAIL_UPLOAD_MAX_MB` | `5` | Ceiling `10` |

## 14. Bunny Stream

Off by default. **Nothing below is required while `BUNNY_STREAM_ENABLED=false`**,
so an existing production deployment boots unchanged before any Bunny value is
added. See [features/bunny-stream.md](./features/bunny-stream.md).

| Variable | Default | Notes |
|---|---|---|
| `BUNNY_STREAM_ENABLED` | `false` | Master switch. While false, every Bunny endpoint returns `400` and no Bunny value is validated |
| `BUNNY_STREAM_LIBRARY_ID` | unset | **Required when enabled.** Must be numeric. Not a secret |
| `BUNNY_STREAM_API_KEY` | unset | **Required when enabled.** Management API `AccessKey`. **Secret — backend only** |
| `BUNNY_STREAM_TOKEN_SECURITY_KEY` | unset | **Required when enabled.** Embed view token signing key. **Secret — backend only** |
| `BUNNY_STREAM_TUS_TTL_SECONDS` | `3600` | Bounded 300–86400. Out-of-range **fails at boot** rather than clamping |
| `BUNNY_STREAM_EMBED_TOKEN_TTL_SECONDS` | `300` | Bounded 60–3600. Same fail-fast behaviour |
| `BUNNY_STREAM_PULL_ZONE_HOSTNAME` | unset | **Required when enabled.** Stream CDN hostname of the library's pull zone, e.g. `vz-xxxxxxxx.b-cdn.net`. Hostname only — no scheme, port, path or trailing slash; a bare pull-zone *name* is rejected. Thumbnail delivery is built from it. **Not a secret** |

> **`BUNNY_STREAM_PULL_ZONE_HOSTNAME` became required on 2026-08-23.** Bunny's
> Get Video response provides `thumbnailFileName`, and the documented storage
> structure is `https://{pull_zone}/{videoId}/{thumbnailFileName}` — so the
> hostname is genuinely needed to address a poster at all. Boot **fails fast**
> when it is missing or malformed while Bunny is enabled, rather than silently
> serving videos with no thumbnail. Nothing is required while
> `BUNNY_STREAM_ENABLED=false`. See
> [features/bunny-stream.md](./features/bunny-stream.md) §4.4.

> `BUNNY_STREAM_SIGNING_KEY` was a never-read placeholder. It is superseded by
> `BUNNY_STREAM_TOKEN_SECURITY_KEY` and has been removed from the templates.

### 14.1 Public Bunny thumbnail proxy (added 2026-08-28)

Reviewer-facing Bunny posters are served **through this API** rather than fetched
from the pull zone by the reviewer's browser. Off by default; while disabled the
public response is byte-identical to before the feature existed.

| Variable | Default | Notes |
|---|---|---|
| `BUNNY_PUBLIC_THUMBNAIL_PROXY_ENABLED` | `false` | Master switch |
| `BUNNY_PUBLIC_THUMBNAIL_UPSTREAM_AUTH_MODE` | `none` | `none` or `referer`. **Any other value fails at boot.** An empty value means "use the default" |
| `BUNNY_PUBLIC_THUMBNAIL_UPSTREAM_REFERER` | unset | **Required when the proxy is enabled AND the mode is `referer`.** Absolute `https` URL with no embedded credentials, matching an entry in the pull zone's Allowed Referrers list. **Not a secret** — it is a public site URL |
| `BUNNY_PUBLIC_THUMBNAIL_MAX_BYTES` | `5242880` | Bounded 65536–20971520. Out of range **fails at boot** rather than clamping. Enforced on transferred bytes, not only `Content-Length` |
| `BUNNY_PUBLIC_THUMBNAIL_TIMEOUT_MS` | `5000` | Bounded 1000–15000. Same fail-fast behaviour. Deliberately far shorter than `BUNNY_STREAM_REQUEST_TIMEOUT_MS` (15 s), which governs operator-triggered management calls rather than an unauthenticated public route |

> **`BUNNY_STREAM_TOKEN_SECURITY_KEY` IS NOT A CDN CREDENTIAL.** It signs Stream
> **embed view tokens**. A pull zone's CDN Token Authentication is a separate
> mechanism with a separate key, and that mechanism is **not implemented** here.
> Never configure the proxy to derive anything from the embed key: the CDN would
> reject the resulting signatures while the code looked like working security.

> **The mode is a deployment decision, not a default that happens to work.**
> `none` sends nothing extra; `referer` sends the configured value. Enabling the
> proxy in `referer` mode with no usable Referer fails at boot, and at runtime it
> fails closed rather than downgrading to `none`. Full rationale and the measured
> evidence behind the choice: [features/bunny-stream.md §4.6](./features/bunny-stream.md#46-reviewer-facing-poster-delivery-the-backend-proxy).

Only the non-secret values reach `ApiEnvironmentConfig.bunnyStream`
(`enabled`, `libraryId`, `pullZoneHostname`, `tusTtlSeconds`,
`embedTokenTtlSeconds`, and the `publicThumbnailProxy` block). The two secrets
are read exclusively by `BunnyStreamService` through `ConfigService` and never
appear in a response, an exception message or a log line.

## 15. Declared but not read by any code

Generated inventory, 2026-08-21, revised 2026-08-23 when the Bunny Stream MVP
landed. Method: collect every `NAME=` declared in `.env.example`, `.env`,
`.env.local` and `.env.production`, then check each against the full text of
`src/`, `prisma/`, `scripts/` and `test/`. Re-run the check when adding or
removing a variable rather than trusting the table below.

> **Changed on 2026-08-23.** The whole `BUNNY_*` family is now read (§14) —
> including `BUNNY_STREAM_PULL_ZONE_HOSTNAME`, which thumbnail delivery is built
> from and which is **required when Bunny is enabled**. No `BUNNY_*` variable
> remains inert. `BUNNY_STREAM_SIGNING_KEY` was removed from the templates.

| Variable | Status | Note |
|---|---|---|
| `MUX_TOKEN_ID`, `MUX_TOKEN_SECRET`, `MUX_SIGNING_KEY_ID`, `MUX_SIGNING_PRIVATE_KEY_BASE64` | `PLANNED` | Reserved for a future Mux provider |
| `VIDEO_PROVIDER` | inert | Provider is chosen per video by the creation endpoint, not by this variable |
| `API_PUBLIC_BASE_URL` | inert | Documentation value only |
| `API_SELF_ORIGIN` | inert | Not used by `CorsOriginService` |
| `SHARE_TOKEN_BYTES` | inert | Share tokens are fixed at 32 bytes in `share-url.util.ts` |
| `DEFAULT_SHARE_LINK_EXPIRES_DAYS`, `DEFAULT_SHARE_LINK_MAX_VIEWS` | inert | No server-side default is applied; the client sends explicit values |
| `PUBLIC_RENDERER_LOCAL_ORIGIN`, `PUBLIC_RESOLVE_ALLOW_MISSING_TOKEN`, `PUBLIC_SHARE_DEFAULT_PROTOCOL` | inert | Only in `.env.local`; leftovers |
| `MUX_SIGNING_KEY_ID`, `MUX_SIGNING_PRIVATE_KEY_BASE64` | `PLANNED` | Counted in the 19; listed with the other `MUX_*` above |
| `VITE_API_BASE_URL`, `VITE_VIDEO_DB_UPLOAD_ENABLED` | wrong repo | Frontend variables; they belong in `bom-media-admin`. `VITE_VIDEO_DB_UPLOAD_ENABLED` is read by **no** admin code either |

Setting an inert variable has no effect. Removing one is safe but should be done
deliberately — see [KNOWN_ISSUES.md](./KNOWN_ISSUES.md#ki-005).

## 16. Rules

1. Adding a variable means: read it through `env.config.ts`, validate it in
   `env.validation.ts`, add it to `.env.example` with a **placeholder**, and add
   a row here — all in the same pull request.
2. Never commit a real value. Never paste a value into a doc, log, terminal
   summary or commit message.
3. Prefer safe-by-default: features that widen exposure (`VIDEO_DB_STORAGE_*`,
   `ADMIN_REGISTER_ENABLED`, `API_DOCS_*`, `TRUST_PROXY_ENABLED`) must default
   to off in production.
4. Rotation procedures: `docs/security/secret-rotation-runbook.md`.
   Pre-deploy checks: `docs/security/env-security-checklist.md`.

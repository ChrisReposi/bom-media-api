# Environment Variables

Status: CURRENT
Last verified: 2026-08-21
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

## 14. Declared but not read by any code

Generated inventory, 2026-08-21. Method: collect every `NAME=` declared in
`.env.example`, `.env`, `.env.local` and `.env.production` (119 distinct
names), then check each against the full text of `src/`, `prisma/`, `scripts/`
and `test/`. **19 names have no reference anywhere in backend code.** Re-run the
check when adding or removing a variable rather than trusting this count.

| Variable | Status | Note |
|---|---|---|
| `BUNNY_STREAM_LIBRARY_ID`, `BUNNY_STREAM_API_KEY`, `BUNNY_STREAM_PULL_ZONE_HOSTNAME`, `BUNNY_STREAM_SIGNING_KEY` | `PLANNED` | Reserved for a future Bunny Stream provider. **No implementation.** See [features/bunny-stream.md](./features/bunny-stream.md) |
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

## 15. Rules

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

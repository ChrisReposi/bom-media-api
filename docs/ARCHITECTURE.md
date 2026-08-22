# Architecture

Status: CURRENT
Last verified: 2026-08-21
Verified against: `src/main.ts`, `src/app.module.ts`, `src/admin-auth/**`, `src/public/**`, `src/videos/**`, `src/admin-websites/**`, `src/security/**`

## 1. Position in the system

```
┌──────────────────┐        Bearer access token         ┌────────────────────┐
│ bom-media-admin  │ ─────────────────────────────────▶ │                    │
│ (React SPA)      │ ◀───────────────────────────────── │                    │
└──────────────────┘        JSON                        │                    │
                                                        │   bom-media-api    │──▶ MySQL / MariaDB
┌──────────────────┐   host + share token (no auth)     │   (NestJS 11)      │──▶ Local NVMe storage
│ public_website   │ ─────────────────────────────────▶ │                    │──▶ Cloudinary
│ (static SPA)     │ ◀───────────────────────────────── │                    │
└──────────────────┘   JSON + Range-capable media       └────────────────────┘
```

The backend is the only writer to the database and the only component that makes
authorization decisions.

## 2. Bootstrap order

`src/main.ts` — read it before changing anything global.

1. `NestFactory.create(AppModule, { bufferLogs: true })`, then swap in the Pino
   logger.
2. Optional `trust proxy`: when `TRUST_PROXY_ENABLED=true`, Express is
   configured either with a compiled `TRUSTED_PROXY_CIDRS` predicate or with a
   numeric `TRUST_PROXY_HOPS`.
3. `helmet()`.
4. A small middleware that sets `Cross-Origin-Resource-Policy: cross-origin`
   and `Vary: Origin` on exactly
   `/{prefix}/public/watch/:token/videos/:videoId/(binary|local-file|thumbnail)`.
5. CORS with a **dynamic async origin resolver** (`CorsOriginService`),
   `credentials: false`, exposing `Accept-Ranges`, `Content-Range`,
   `Content-Length`, `Content-Type`.
6. Global prefix (`API_PREFIX`, default `api/v1`).
7. Global `ValidationPipe` — `whitelist`, `forbidNonWhitelisted`, `transform`.
8. Global `GlobalExceptionFilter`.
9. `enableShutdownHooks()`.
10. Swagger at `/docs` only when `docsEnabled` (see [ENVIRONMENT.md](./ENVIRONMENT.md)).
11. `listen()`, then an opt-in MariaDB collation probe.

Guards are wired globally in `AppModule`: `ThrottlerGuard` is an `APP_GUARD`.
Auth and role guards are applied **per controller** with `@UseGuards(...)`.

## 3. Modules

| Module | Owns |
|---|---|
| `ConfigModule` | Global config; `ignoreEnvFile: true`, custom loader + `validateEnv` |
| `LoggerModule` (nestjs-pino) | Structured logs, redaction, request ids |
| `ThrottlerModule` | Named throttle profiles (see [SECURITY_MODEL.md](./SECURITY_MODEL.md)) |
| `MemoryCacheModule` | Process-local TTL cache + in-flight de-duplication |
| `DatabaseModule` | `PrismaService` with the MariaDB adapter |
| `SecurityModule` | `CorsOriginService` (static + DB-backed origins) |
| `HealthModule` | `/health`, `/health/ready` |
| `AdminAuthModule` | Login, refresh rotation, logout, password change, sessions |
| `AdminAccountsModule` | OWNER-only account management |
| `VideosModule` | Video CRUD, uploads, purge, view growth, local storage |
| `PublicModule` | Public watch, protected media, media grants |
| `AdminWebsitesModule` | Websites, domains, domain groups, assignments, share links, canonical share links |

## 4. Request lifecycle (admin route)

```
HTTP request
  → trust proxy resolution (optional)
  → helmet
  → CORS origin check (static allowlist ∪ ACTIVE DB domains)
  → route match under /api/v1
  → ThrottlerGuard  (profile chosen by @ThrottleProfile metadata)
  → AdminAccessTokenGuard
        verify JWT (JWT_ACCESS_SECRET) → payload.type === "admin_access"
        load AdminSession by payload.sid
        reject if: missing / adminId mismatch / revoked / expired
                   / admin not ACTIVE / admin soft-deleted
        reject 403 ADMIN_PASSWORD_CHANGE_REQUIRED unless the handler is
              decorated @AllowPasswordChangeRequired()
        throttled touch of session.lastUsedAt (at most once per 60s)
        attach request.admin
  → AdminRolesGuard
        read @AdminRoles*() metadata; **missing metadata ⇒ deny**
  → ValidationPipe (DTO)
  → controller → service → Prisma
  → GlobalExceptionFilter on error
```

## 5. Flow: admin authentication

Traced from `src/admin-auth/admin-auth.service.ts` and
`src/admin-auth/guards/admin-access-token.guard.ts`.

### 5.1 Login — `POST /api/v1/admin/auth/login`

```
Browser → Admin SPA → POST /admin/auth/login {username, password}
  normalize username
  look up AdminUser; always run bcrypt compare (dummy hash when user missing)
  reject if: no user / status != ACTIVE / deletedAt != null / password mismatch
        → audit ADMIN_LOGIN_FAILURE, generic 401
  reject if mustChangePassword && temporaryPasswordExpiresAt <= now
        → 403 ADMIN_TEMP_PASSWORD_EXPIRED
  Serializable transaction:
        re-read the user, verify passwordHash unchanged and still ACTIVE
        update lastLoginAt
        create AdminSession { id: uuid, expiresAt: now + REFRESH_TOKEN_EXPIRES_DAYS,
                              ipHash, userAgentHash, userAgent (truncated 512) }
        create AdminRefreshToken { tokenHash: sha256(pepper + raw), expiresAt }
  sign access JWT { sub, sid, jti, username, role, type:"admin_access" }
        (if signing fails the session is revoked with TOKEN_SIGN_FAILURE)
  audit ADMIN_LOGIN_SUCCESS
  → 200 { message, admin, tokens{accessToken, refreshToken, tokenType, expiresIn} }
```

The raw refresh token is returned to the client and is **never** stored.

### 5.2 Refresh rotation — `POST /api/v1/admin/auth/refresh`

```
hash the presented token with REFRESH_TOKEN_PEPPER → find AdminRefreshToken
  not found                    → audit ADMIN_REFRESH_FAILURE, generic 401
  already revoked              → revoke the whole session, audit
                                 ADMIN_REFRESH_REPLAY, generic 401
  session missing/revoked/expired, token expired,
  admin not ACTIVE or soft-deleted
                               → audit ADMIN_REFRESH_FAILURE, generic 401
Serializable transaction:
  claim the old token with a conditional updateMany (revokedAt: null → now)
      claimed.count !== 1     → concurrent use ⇒ treat as replay, revoke session
  re-read admin + session inside the transaction
      any state change        → revoke every token + the session
                                 (revokedReason ACCOUNT_STATE_CHANGED)
  slide the session: lastUsedAt = now, expiresAt = now + REFRESH_TOKEN_EXPIRES_DAYS
  create the replacement AdminRefreshToken
mint a new access token bound to the SAME sid
audit ADMIN_REFRESH_SUCCESS
→ 200 { message, admin, tokens }
```

The session `id` is stable across rotations; only the refresh token changes.

### 5.3 Logout — `POST /api/v1/admin/auth/logout`

Requires a valid **access token** (`AdminAccessTokenGuard`). `adminId` and
`sessionId` come from that token. The request body's `refreshToken` is read and
deliberately ignored (`void dto.refreshToken`) so the response cannot be used to
probe refresh-token state. Revokes every unrevoked refresh token in the session
and the session itself (`revokedReason: "LOGOUT"`). Idempotent.

> **This does not currently happen through the admin SPA.** The SPA calls the
> endpoint with `axiosBaseClient`, which has no auth interceptor and sends no
> `Authorization` header, so the guard returns `401` and nothing is revoked; the
> SPA then clears local state anyway. Confirmed application defect —
> [KNOWN_ISSUES.md](./KNOWN_ISSUES.md#ki-016). The backend behaves correctly.

### 5.4 Password change

`change-own-password` (current password only) and the **deprecated**
`change-password` (current password **plus** `ADMIN_CHANGE_PASSWORD_SECRET`).
Both re-verify the password hash inside a Serializable transaction, then revoke
**all** of that admin's refresh tokens and sessions
(`revokedReason: "PASSWORD_CHANGE"`) and write an audit row.

> The admin SPA currently calls the deprecated endpoint. See
> [KNOWN_ISSUES.md](./KNOWN_ISSUES.md#ki-002).

### 5.5 Session self-service

`GET /admin/auth/sessions` lists the caller's unrevoked, unexpired sessions and
marks the current one. `POST /admin/auth/sessions/:sessionId/revoke` revokes one
owned session (`SELF_REVOKE`) and reports whether it was the current session.
Neither endpoint is used by the admin SPA today.

## 6. Flow: public share link, URL to playback

Traced from `src/public/public.service.ts` and `src/public/public.controller.ts`.

```
1. Viewer opens  https://<customer-domain>/#/s/<alias>/videos
2. public_website extracts the credential from the path/hash/query,
   scrubs it from the visible URL, keeps it in sessionStorage.
3. POST /api/v1/public/watch/exchange { host, token }
        (legacy fallback: GET /api/v1/public/watch?host=&token=)
4. Backend resolvePublicWatch:
     normalize host (lowercase, strip protocol/port rules, max 253 chars)
        null                             → DENIED  MISSING_HOST
     WebsiteDomain.findUnique({domain})
        missing / domain not ACTIVE
        / website missing or not ACTIVE  → DENIED  INVALID_LINK
     token missing                       → DENIED  MISSING_TOKEN
     SHARE_TOKEN_PEPPER unset            → DENIED  SERVER_ERROR (logged)
     find ShareLink by alias  == token AND websiteId
        else by tokenHash == sha256(pepper+token) AND websiteId
        not found                        → DENIED  INVALID_LINK
     policy check: status != ACTIVE / past expiresAt / views exhausted
                 → DENIED (access-log reason recorded; client always sees
                   INVALID_LINK)
     collect ShareLinkVideo rows, but ONLY where the video also has an
        ACTIVE WebsiteVideo row for this website
     keep only playable videos (status READY + a usable asset)
        none                             → DENIED  NO_VIDEOS
     conditional increment of currentViews (guards maxViews atomically)
        lost race                        → re-read and DENY with the real reason
     write AccessLog ALLOWED / OK
     cache the metadata (PUBLIC_WATCH_METADATA_CACHE_TTL_SECONDS)
5. Response { valid, reasonCode, website, videos[] }
   On success: reasonCode "OK".
   On ANY denial: exactly { valid:false, reasonCode:"INVALID_LINK",
   website:null, videos:[] } — invalidResponse() discards the real reason,
   which is written to AccessLog instead.
   For each video the backend supplies the URLs the client may use:
     DB_BLOB     → binaryPlaybackUrl / publicPlaybackUrl
     LOCAL_FILE  → publicPlaybackUrl (+ publicThumbnailUrl)
     EMBED       → embedUrl, embedProvider, embedAllow
     other       → playbackUrl
   If the share link has a maxViews limit, every media URL carries a signed
   `grant` query parameter.
6. Playback:
   DB_BLOB / LOCAL_FILE / thumbnail -> the browser requests a backend URL with
     Range headers. DB_BLOB re-runs the full authorization chain per request.
     LOCAL_FILE and thumbnail may be served from a process-local authorization
     cache (unlimited links only) - see SECURITY_MODEL.md section 4.2.
     Grants are verified when the link is view-limited. Streams 200/206/416.
   DIRECT_URL / UPLOAD / EMBED -> the browser fetches the external provider URL
     directly. The backend is NOT in the request path and cannot deny it.
7. After real playback starts, the site may POST
   /public/watch/:token/videos/:videoId/view once (best effort).
```

Every denial returns the same shape (`valid: false`) and never states whether
the token existed.

### 6.1 Media grants

`src/public/public-media-grant.service.ts`. A grant is
`base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, PUBLIC_MEDIA_GRANT_SECRET))`
with payload `{ v:1, sid, vid, host, exp, purpose:"public_media" }`.

- Issued **only** when the share link has a `maxViews` limit.
- `exp = min(now + PUBLIC_MEDIA_GRANT_TTL_SECONDS, shareLink.expiresAt)`;
  TTL is clamped to 5 minutes … 24 hours.
- Verified with `timingSafeEqual`, strict base64url canonicalisation, and exact
  matching of `sid` / `vid` / `host` / expiry.
- Verification short-circuits: `hasValidMediaGrant()` returns `true`
  immediately when `shareLink.maxViews === null`, so unlimited links neither
  carry nor require a grant.
- Purpose: let a view-limited link seek and range-request without each media
  request burning a view.

> **Scope: grants apply only to backend-served media** — the `binary`,
> `local-file` and `thumbnail` routes. `DIRECT_URL`, Cloudinary `UPLOAD` and
> `EMBED` URLs are returned verbatim, carry no grant, and are fetched by the
> browser without touching this backend. See
> [SECURITY_MODEL.md §4.1](./SECURITY_MODEL.md#41-backend-served-media-versus-providerdirect-media).

## 7. Flow: video sources and providers

`VideoSourceType` (what the bytes are) and `VideoProvider` (who hosts them) are
independent. Implementation status verified in `src/videos/videos.service.ts`:

| `sourceType` | Created by | Storage | Public playback | Range | Status |
|---|---|---|---|---|---|
| `DIRECT_URL` | `POST /admin/videos`, `manual-with-thumbnail` | none (URL only) | `playbackUrl` returned as-is | n/a (remote) | CURRENT |
| `EMBED` | `POST /admin/videos/embed`, `embed-with-thumbnail` | none | `embedUrl` in an iframe, host-allowlisted | n/a | CURRENT |
| `UPLOAD` | `POST /admin/videos/upload` | Cloudinary | Cloudinary `secure_url` | Cloudinary | CURRENT (not used by the admin SPA) |
| `DB_BLOB` | `POST /admin/videos/upload-db` | `VideoBinaryAsset.data` (`LongBlob`) | `/public/watch/.../binary` | yes | CURRENT, fallback only, default **off** |
| `LOCAL_FILE` | `POST /admin/videos/upload-local/*` | filesystem under `LOCAL_FILE_STORAGE_ROOT` | `/public/watch/.../local-file` | yes | CURRENT, default **off** |

| `provider` | Implementation |
|---|---|
| `MANUAL` | CURRENT — default; no provider integration |
| `CLOUDINARY` | CURRENT — `src/cloudinary/cloudinary.service.ts`; upload, delete, derived thumbnails |
| `BUNNY` | **PLANNED** — no Bunny-specific integration exists. The enum member is persistable and generic direct-URL playback works; see below |
| `MUX` | **PLANNED** — no Mux-specific integration exists; same generic behaviour |

`VIDEO_PROVIDER` in `.env.example` is **not read by any code**.

`provider` is chosen by `resolveProvider(dto)`: an explicit `dto.provider` wins,
otherwise a `*.cloudinary.com` `playbackUrl` yields `CLOUDINARY`, otherwise
`MANUAL`. Because `CreateVideoDto.provider` is `@IsEnum(VideoProvider)`, a
record with `provider: BUNNY` or `provider: MUX` **can be created today** and
will play back as an ordinary `DIRECT_URL`. That is a stored label plus generic
URL handling — not an integration. See
[features/bunny-stream.md](./features/bunny-stream.md).

### 7.1 Chunked local-file upload

```
POST /admin/videos/upload-local/init      → VideoUploadSession (tempStorageKey, totalChunks, chunkSizeBytes, expiresAt)
POST /admin/videos/upload-local/:id/chunks (multipart, one chunk per call)
                                          → VideoUploadSessionChunk rows, unique (uploadSessionId, chunkIndex)
GET  /admin/videos/upload-local/:id       → progress
POST /admin/videos/upload-local/:id/complete
                                          → merge chunks atomically, sha256 checksum,
                                            create VideoAsset + VideoLocalFileAsset
POST /admin/videos/upload-local/:id/cancel → ABORTED, temp files removed
```

Capacity is checked with `statfsSync` against `LOCAL_VIDEO_MIN_FREE_SPACE_MB`
before accepting bytes. Storage keys are validated segment by segment and
resolved paths are re-checked against the storage root (symlink and traversal
defence) in `src/videos/storage/local-video-storage.service.ts`.

### 7.2 HTTP Range

Implemented for both stored sources. **Single range only** — the parser matches
`^bytes=(\d*)-(\d*)$`, so multi-range requests, non-`bytes` units and `bytes=-`
all fall through to `416`. Suffix (`bytes=-500`) and open-ended (`bytes=500-`)
ranges are supported. No multipart/byteranges response is ever produced.

- `LOCAL_FILE` — `createRangeReadStream()` **streams** via
  `fs.createReadStream({start, end})`; memory use is bounded by the stream.
- `DB_BLOB` — `getPublicDatabaseVideoBinary()` reads the requested slice into a
  `Buffer` and sends it. **Bounded buffering, not streaming** — the range is
  fully materialised in memory. One reason `DB_BLOB` is capped at 100 MB and
  disabled in production.

Headers: `200` and `206` set `Accept-Ranges`, `Content-Type` and
`Content-Length` (plus `Content-Range` on `206`). **`416` sets `Accept-Ranges`,
`Content-Type` and `Content-Range: bytes */<total>` but no `Content-Length`** —
the controller ends the response before that header is written. All carry the
no-store cache family. `HEAD` returns headers without a body.

## 8. Flow: website / domain resolution

`WebsiteDomain.domain` is globally unique and normalized
(`src/common/utils/domain.util.ts`). A domain may sit in a pool
(`websiteId = null`), belong to a `DomainGroup`, or be assigned to a `Website`.
Public resolution is a single `findUnique` on the normalized request host, and
requires both the domain and its website to be `ACTIVE`.

The same table drives dynamic CORS: when `CORS_ALLOW_DB_DOMAINS=true`,
`CorsOriginService` allows origins whose host matches an `ACTIVE` domain of an
`ACTIVE` website, cached for `CORS_DB_ORIGIN_CACHE_TTL_MS`.

## 9. Caching

`src/cache/memory-cache.service.ts` — a bounded, TTL'd, **process-local** map
with in-flight request de-duplication. It is not shared between processes and is
lost on restart. Used for the admin videos list, the admin websites list, public
watch metadata and media metadata. Public watch cache entries are revalidated
against share-link policy on every hit and dropped when a policy check fails or
a view increment loses its race.

## 10. Error handling

`GlobalExceptionFilter` logs one structured line for every `>= 500` with
`requestId`, `method`, a **route template** (never a raw URL), an optional
database `stage` tag and a sanitised Prisma context. Clients receive:

- `500` → `{ statusCode, message: "Internal server error", error: "Internal Server Error" }`
- everything else → the `HttpException` body as-is.

There is no global success-envelope wrapper: successful responses are the raw
service DTOs.

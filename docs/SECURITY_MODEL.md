# Security Model

Status: CURRENT
Last verified: 2026-08-21
Verified against: `src/main.ts`, `src/app.module.ts`, `src/admin-auth/**`, `src/public/**`, `src/security/**`, `src/common/utils/request-security.util.ts`, `src/config/env.validation.ts`

This document states what the code actually enforces. Anything aspirational is
marked `PLANNED`.

## 1. Trust boundaries

```
 UNTRUSTED                          SEMI-TRUSTED                    TRUSTED
┌────────────────┐   ┌──────────────────────────────┐   ┌──────────────────────┐
│ Public viewer  │   │ Admin browser (authenticated)│   │ bom-media-api process│
│ public_website │──▶│ bom-media-admin SPA          │──▶│ + MySQL/MariaDB      │
│ any HTTP client│   │ (JS, fully inspectable)      │   │ + private NVMe       │
└────────────────┘   └──────────────────────────────┘   └──────────────────────┘
        │                          │                              ▲
        └──────────── every authorization decision ───────────────┘
```

> **SECURITY INVARIANT: Backend authorization is authoritative. Frontend role
> checks are UX only.** Both SPAs are static assets; anything they hide can be
> called directly. The admin SPA does not gate any UI on role today
> (see [KNOWN_ISSUES.md](./KNOWN_ISSUES.md#ki-003)) and that is *safe* precisely
> because the guards are server-side.

## 2. Credentials in the system

| Credential | Form | Where it lives | Lifetime |
|---|---|---|---|
| Admin access token | JWT, `HS256` via `JWT_ACCESS_SECRET` | Client memory + `localStorage` (redux-persist) | `JWT_ACCESS_EXPIRES_IN`, default `15m` |
| Admin refresh token | Opaque `randomBytes(REFRESH_TOKEN_BYTES ≥ 32).base64url` | Client `localStorage`; DB stores only `sha256(REFRESH_TOKEN_PEPPER + raw)` | `REFRESH_TOKEN_EXPIRES_DAYS`, default 30, slid on each rotation |
| Admin session | `AdminSession` row keyed by a UUID | Database only | Same as the refresh token; revocable |
| Public share token | `s_` + `randomBytes(32).base64url` | Returned once at creation; DB stores only `sha256(SHARE_TOKEN_PEPPER + raw)` | Until revoked/expired/limit reached |
| Public share alias | `randomBytes(5).base64url` (~7 chars) | **Stored in clear** in `ShareLink.alias`, unique | Same as the share link |
| Public media grant | `base64url(payload).base64url(HMAC-SHA256)` via `PUBLIC_MEDIA_GRANT_SECRET` | Query string of media URLs | `min(now + PUBLIC_MEDIA_GRANT_TTL_SECONDS, shareLink.expiresAt)`, clamped 5 min … 24 h |
| Admin password | bcrypt, 12 rounds | Database only | Until changed |

> **SECURITY INVARIANT: No raw refresh token and no raw share token is ever
> persisted.** Only peppered SHA-256 hashes are stored. The alias is the one
> deliberate exception — it is a short, revocable, per-website lookup key that is
> useless without a matching `ACTIVE` domain, website and share link.

### 2.1 Access token behaviour

Payload: `{ sub, sid, jti, username, role, type: "admin_access" }`.
`AdminAccessTokenGuard` requires `type === "admin_access"` and non-empty
`sub`/`sid`/`jti`, then loads the `AdminSession` and rejects when the session is
missing, belongs to a different admin, is revoked, is expired, or the admin is
not `ACTIVE` / is soft-deleted.

> **SECURITY INVARIANT: Access tokens are session-bound.** Revoking a session
> invalidates all of its unexpired access tokens on the next request — there is
> no stateless-JWT blind window.

`mustChangePassword` blocks every guarded route with
`403 ADMIN_PASSWORD_CHANGE_REQUIRED` unless the handler carries
`@AllowPasswordChangeRequired()` (`logout`, `change-own-password`, `me`).

`session.lastUsedAt` is touched at most once per 60 seconds per session.

### 2.2 Refresh-token behaviour

- Single use. Rotation runs in a `Serializable` transaction and claims the old
  token with a conditional `updateMany(... revokedAt: null → now)`.
- If the claim affects zero rows (concurrent use) **or** the presented token was
  already revoked, the entire session is revoked and an `ADMIN_REFRESH_REPLAY`
  audit row is written.
- Any account-state change detected inside the rotation transaction revokes all
  tokens and the session with `ACCOUNT_STATE_CHANGED`.
- `logout` revokes the session and its tokens **when it is reached**. It is
  guarded by `AdminAccessTokenGuard`, so the caller must present a valid Bearer
  access token; `adminId` and `sessionId` come from that token, and the
  submitted `refreshToken` body field is read and discarded (`void
  dto.refreshToken`) so the response leaks nothing about refresh state.
- Password change revokes **all** sessions and tokens for that admin.

> **SECURITY INVARIANT: Refresh-token reuse is treated as compromise and kills
> the session.**

> **CONFIRMED DEFECT — logout does not currently revoke through the admin SPA.**
> The SPA calls `POST /admin/auth/logout` via `axiosBaseClient`, which has **no**
> request interceptor and therefore sends **no** `Authorization` header
> (`bom-media-admin/src/lib/api/axiosClient.ts` registers interceptors on
> `axiosClient` only). The guard rejects the call, the SPA catches the error and
> clears local state anyway, and the server-side session survives until its
> natural expiry (`REFRESH_TOKEN_EXPIRES_DAYS`, default 30 days). The backend is
> behaving correctly; the integration is broken. See
> [KNOWN_ISSUES.md](./KNOWN_ISSUES.md#ki-016). Password change and refresh-replay
> revocation are unaffected and still work.

> A concurrent-refresh caveat worth knowing: two independent contexts holding the
> same refresh token (for example two browser tabs, each with its own
> single-flight guard) can race the rotation. The loser is treated as a replay
> and the **whole session** is revoked. This is deliberate fail-closed behaviour,
> not a bug, but it can surface as an unexplained logout. See
> [KNOWN_ISSUES.md](./KNOWN_ISSUES.md#ki-019).

## 3. Role authorization

Roles: `OWNER`, `ADMIN`, `STAFF` (`AdminRole` in `prisma/schema.prisma`).

| Helper | Grants |
|---|---|
| `@AdminReadRoles()` | `OWNER`, `ADMIN`, `STAFF` |
| `@AdminWriteRoles()` | `OWNER`, `ADMIN` |
| `@AdminRoles(AdminRole.OWNER)` | `OWNER` only |

Applied surfaces (verified from the controllers):

| Surface | Read | Write | OWNER-only |
|---|---|---|---|
| `/admin/videos/*` | `AdminReadRoles` | `AdminWriteRoles` | `POST /:id/purge` |
| `/admin/websites`, `/admin/domains`, `/admin/domain-groups`, `/admin/share-links` | `AdminReadRoles` | `AdminWriteRoles` | — |
| `/admin/accounts/*` | — | — | every route |
| `/admin/auth/*` | authenticated only (no role metadata; `AdminRolesGuard` is not applied to this controller) | | |

> **SECURITY INVARIANT: `AdminRolesGuard` denies any handler that has no
> `@AdminRoles*()` metadata.** A new admin route without role metadata is
> unreachable rather than accidentally public. Note this only holds where the
> guard is actually attached — `AdminAuthController` uses
> `AdminAccessTokenGuard` alone, by design, because its routes are self-service.

`/admin/accounts/*` is additionally gated by
`ADMIN_ACCOUNT_MANAGEMENT_ENABLED` (default **false** in production); when
disabled every route returns `503 ADMIN_ACCOUNT_MANAGEMENT_DISABLED`. OWNER
accounts cannot be created, demoted or deleted through this API.

## 4. Public share authorization

This chain applies to **backend-served media only** — the `binary`,
`local-file` and `thumbnail` routes — and to watch resolution. It does **not**
apply to externally hosted media; see §4.1.

1. Normalize the `host` parameter; reject anything over 253 chars or malformed.
2. `WebsiteDomain` must exist for that exact normalized host, be `ACTIVE`, and
   its `Website` must be `ACTIVE`.
3. Share link must be found **within that website** by `alias` or by
   `sha256(SHARE_TOKEN_PEPPER + token)`.
4. Share link must be `ACTIVE` and not past `expiresAt`.
5. The video must be a `ShareLinkVideo` of that share link.
6. The video must have an `ACTIVE` `WebsiteVideo` assignment **to that website**.
7. The video must be `VideoStatus.READY` with a usable asset.

Metadata resolution (`/public/watch`, `/public/watch/exchange`) adds a
`currentViews < maxViews` check and then atomically increments `currentViews`.

Media routes deliberately **do not** apply the `maxViews` check
(`getDeniedReasonForMediaPlayback` checks status and expiry only). Instead, when
the share link has a `maxViews` limit, every backend-served media URL carries a
signed `grant` bound to `{shareLinkId, videoId, host, exp}` which must verify.
This lets an admitted viewer seek without each byte range consuming a view,
while binding media access to one video on one host for a bounded time.

`hasValidMediaGrant()` returns `true` immediately when `shareLink.maxViews ===
null`, so **unlimited links neither carry nor require a grant**.

### 4.0 How often the chain actually runs

> **CORRECTION (2026-08-21):** an earlier revision of this document claimed the
> full chain re-runs "on every request, including every byte range". That is
> true for `DB_BLOB`, for thumbnails' first resolution, for view recording and
> for watch resolution — but **not** for every `LOCAL_FILE` byte range. See
> [§4.2](#42-local_file-media-authorization-cache).

| Path | Per-request DB authorization |
|---|---|
| `/public/watch`, `/public/watch/exchange` | Yes (a separate metadata cache exists, but it is policy-revalidated on every hit) |
| `.../videos/:id/binary` (`DB_BLOB`) | **Yes, every request.** `getAuthorizedPublicDatabaseBinaryAsset` does not consult the cache |
| `.../videos/:id/local-file` (`LOCAL_FILE`) | **Not always** — see §4.2 |
| `.../videos/:id/thumbnail` (local thumbnail) | **Not always** — same code path as `local-file` |
| `.../videos/:id/view` | Yes, every request |

> **SECURITY INVARIANT: Removing a `WebsiteVideo` assignment immediately denies
> public access to that video through every share link of that website**, because
> the assignment is part of the media query, not just the listing query.

> **SECURITY INVARIANT: Public failures are indistinguishable.** Every metadata
> denial returns the byte-identical body
> `{ valid: false, reasonCode: "INVALID_LINK", website: null, videos: [] }`.
> Every media denial raises the identical `404 "Video not found."` (all 15
> rejection paths in `public.service.ts` use that exact message).

`invalidResponse()` takes a reason code, a website and a domain — and
**discards all three** (its parameters are `_reasonCode`, `_website`,
`_domain`). It is hard-coded to emit `INVALID_LINK` with a `null` website.

> **CORRECTION (2026-08-21):** an earlier revision of this document listed
> `MISSING_HOST`, `MISSING_TOKEN`, `EXPIRED_LINK`, `VIEW_LIMIT_REACHED`,
> `NO_VIDEOS` and `SERVER_ERROR` as client-visible. They are not. Those values
> exist in the `PublicWatchReasonCode` union and are written to
> `AccessLog.reasonCode`, but they never reach a public client.

| Reason code | Client-visible? | Where it appears |
|---|---|---|
| `OK` | Yes | Successful watch resolution |
| `INVALID_LINK` | Yes | **Every** denial, whatever the cause |
| `MISSING_HOST` | No | `AccessLog` only |
| `MISSING_TOKEN` | No | `AccessLog` only |
| `EXPIRED_LINK` | No | `AccessLog` only |
| `VIEW_LIMIT_REACHED` | No | `AccessLog` only |
| `NO_VIDEOS` | No | `AccessLog` only |
| `SERVER_ERROR` | No | `AccessLog` only, plus a backend error log |

This is a deliberate anti-enumeration measure: the client cannot distinguish a
missing host from a revoked link from an exhausted view budget. Operators
diagnose the real cause from `AccessLog` — see
[OBSERVABILITY.md](./OBSERVABILITY.md#5-access-log--who-viewed-what).

### 4.1 Backend-served media versus provider/direct media

> **SECURITY INVARIANT: the authorization chain and media grants protect only
> media the backend serves.** They do not extend to externally hosted URLs.

| Class | `sourceType` | URL returned | Backend mediates bytes? | Grant? | Revocation reach |
|---|---|---|---|---|---|
| **Backend-served** | `DB_BLOB` | `/public/watch/.../binary` | Yes | Yes, when `maxViews` is set | Revoking the link stops the next byte range |
| **Backend-served** | `LOCAL_FILE` | `/public/watch/.../local-file`, `.../thumbnail` | Yes | Yes, when `maxViews` is set | Stops the next byte range, **subject to §4.2 caching** |
| **Provider / direct** | `DIRECT_URL` | the stored `playbackUrl`, verbatim | **No** | **No** | Revocation stops future *watch resolution* only |
| **Provider / direct** | `UPLOAD` (Cloudinary) | Cloudinary `secure_url`, verbatim | **No** | **No** | Same |
| **Provider / direct** | `EMBED` | `embedUrl`, verbatim | **No** | **No** | Same |

`toSafePublicMediaUrl()` returns the stored URL unchanged (it only nulls out
URLs whose path contains an `admin` segment). No token, no grant and no expiry
is attached, and no backend request occurs when the viewer plays the media.

Consequences to state plainly, rather than imply otherwise:

- A `DIRECT_URL`, Cloudinary `secure_url` or `EMBED` URL is **disclosed to the
  browser** and is thereafter reachable by anyone who has it, for as long as the
  provider serves it.
- Revoking a share link, expiring it, exhausting `maxViews`, disabling the
  website, or removing the `WebsiteVideo` assignment prevents **future
  authorized watch resolution**. It does **not** invalidate an
  already-disclosed external URL.
- Cloudinary `secure_url` values in this system are unsigned delivery URLs.
  Cloudinary's own signed/expiring delivery is not used by this codebase.
- Therefore "revocation is immediate" is accurate for backend-served media and
  for the listing, and inaccurate for provider/direct media.

This is a **current design characteristic**, not a defect to fix in this pass —
see [KNOWN_ISSUES.md](./KNOWN_ISSUES.md#ki-015). Any future provider integration
must address it explicitly; see
[ADR 0007](./adr/0007-video-storage-direction.md).

### 4.2 `LOCAL_FILE` media authorization cache

`getAuthorizedPublicLocalVideo()` — the shared code path behind both the
`local-file` and `thumbnail` routes — consults the process-local memory cache
**before** any database query and **before** `hasValidMediaGrant()`:

```
cache key = media:metadata:public:local-video | host | hash(token) | videoId
cache HIT  → return the video immediately (no DB query, no grant check)
cache MISS → full DB authorization → grant check → conditionally cache
```

A result is cached **only** when `canCachePublicWatchShareLink()` allows it:

| Condition | Cached? |
|---|---|
| `shareLink.status !== ACTIVE` | No |
| `shareLink.maxViews !== null` | **No — view-limited links are never cached** |
| `expiresAt` within `ttlSeconds` of now | No |
| Otherwise | Yes, for `MEDIA_METADATA_CACHE_TTL_SECONDS` (default **300 s**, bounded 1–3600) |

> **SECURITY INVARIANT: view-limited share links are never served from this
> cache**, so grant verification is never skipped for them. The cache-hit path
> is reachable only for unlimited, `ACTIVE`, not-about-to-expire links — which
> are exactly the links that neither carry nor require a grant.

What this means in practice:

- For an **unlimited** `LOCAL_FILE` link, revoking the share link or removing the
  `WebsiteVideo` assignment may not take effect on the media route for up to the
  configured TTL **in a process whose cache was not invalidated**.
- Same-process admin mutations do invalidate it:
  `admin-websites.service.ts` and `videos.service.ts` both call
  `deleteByPrefix("media:metadata:")` (and `"public:watch:"`).
- **Cross-process and out-of-band changes do not.** The cache is per Node
  process (see §5 of [OBSERVABILITY.md](./OBSERVABILITY.md) and
  [KNOWN_ISSUES.md](./KNOWN_ISSUES.md#ki-010)); a direct SQL change, a script, or
  a mutation handled by a different process leaves other processes' caches
  stale until the TTL expires.
- Setting `MEMORY_CACHE_ENABLED=false` removes this window entirely, at a
  performance cost.

To reduce the window, lower `MEDIA_METADATA_CACHE_TTL_SECONDS`. To eliminate it
for a specific link, revoke through the admin API (which invalidates in-process)
rather than by editing the database directly.

### 4.3 Website / domain binding

A share token is only valid on a domain of its own website. Presenting a valid
token on another customer's domain fails at step 3 (`websiteId` is part of the
lookup). This is what keeps multi-tenant share links isolated.

### 4.4 View accounting

`currentViews` is incremented with a conditional update that re-checks the
policy, so `maxViews` cannot be exceeded by concurrent requests. Media Range
requests do **not** increment views; the separate best-effort endpoint
`POST /public/watch/:token/videos/:videoId/view` drives display-view growth,
capped and deduped by `VideoViewGrowthService`.

## 5. Rate limiting

`@nestjs/throttler` with a global `ThrottlerGuard` and named profiles. The
tracker key is the resolved client IP (`getClientIpFromRequest`), falling back to
`"unknown-client"`. Exactly one profile applies per route: the `default`
throttler skips when a route declares a profile, and each named throttler skips
unless it is the declared profile.

| Profile | Default | Applied to |
|---|---|---|
| `default` | 120 / 60 s | any route with no profile |
| `login` | 5 / 60 s | `register`, `login`, `change-own-password`, all `/admin/accounts` writes |
| `refresh` | 20 / 60 s | `POST /admin/auth/refresh` |
| `logout` | 30 / 60 s | `logout`, session revoke |
| `admin` | 120 / 60 s | admin videos, websites, domains, `me`, `sessions` |
| `publicWatch` | 60 / 60 s | `watch`, `watch/exchange`, view recording |
| `publicMedia` | 1200 / 60 s | binary, local-file and thumbnail streaming |

`/health*` uses `@SkipThrottle()`.

Application-level throttling is **per process** and IP-keyed; it is not a
substitute for edge rate limiting. See
`docs/operations/cloudflare-hardening-runbook.md`.

## 6. Proxy trust and client IP

Disabled by default (`TRUST_PROXY_ENABLED=false`). When enabled:

- If `TRUSTED_PROXY_CIDRS` is set, Express uses a compiled `proxy-addr`
  predicate — only those CIDRs may set forwarding headers.
- Otherwise `TRUST_PROXY_HOPS` (default 1) is used.
- `TRUST_PROXY_CLOUDFLARE_ONLY=true` makes IP resolution prefer
  `CF-Connecting-IP`.

> **SECURITY INVARIANT: Never enable `TRUST_PROXY_ENABLED` unless the origin is
> genuinely unreachable except through the trusted proxy.** Otherwise a client
> can spoof `X-Forwarded-For` and defeat both rate limiting and IP hashing.

**Cloudflare assumptions — UNVERIFIED EXTERNAL INFRASTRUCTURE.** Operational
documentation expects the origin to sit behind Cloudflare with WAF and
rate-limiting rules, admin hostnames protected by Cloudflare Access, and
raw-origin ingress restricted. **Nothing in this repository configures, requires
or checks any of it**, and its presence cannot be confirmed from this workspace.
Do not count these as controls when reasoning about a threat; confirm them per
deployment. See the Cloudflare hardening runbook.

## 7. CORS

`src/security/cors-origin.service.ts`:

- Requests with **no** `Origin` header are allowed (server-to-server, curl,
  same-origin navigation).
- Static allowlist = `ADMIN_WEB_ORIGIN` ∪ `CORS_ALLOWED_ORIGINS`, plus
  `http://localhost:<port>` / `http://127.0.0.1:<port>` **only** outside
  production.
- When `CORS_ALLOW_DB_DOMAINS=true` (default) any origin whose host matches an
  `ACTIVE` `WebsiteDomain` of an `ACTIVE` `Website` is allowed, cached for
  `CORS_DB_ORIGIN_CACHE_TTL_MS`. `http://` DB origins are only accepted when
  `CORS_ALLOW_LOCALHOST_DB_DOMAINS` permits it (default: non-production only).
- A database failure during the lookup **denies** the origin.
- `credentials: false` — the browser never sends cookies cross-origin, which is
  consistent with the Bearer-token design.
- Exposed headers are limited to what media playback needs.

Production validation additionally requires `ADMIN_WEB_ORIGIN` to be a
non-local HTTPS origin.

## 8. Response headers

- `helmet()` defaults for all routes.
- Public media routes get `Cross-Origin-Resource-Policy: cross-origin` and
  `Vary: Origin` from a targeted middleware, so a customer domain can embed
  media served from the API origin.
- Every public route sets `Cache-Control: private, no-store, no-cache,
  must-revalidate, proxy-revalidate`, `Pragma: no-cache`, `Expires: 0`,
  `Surrogate-Control: no-store`, `X-Content-Type-Options: nosniff`.

> **SECURITY INVARIANT: Protected media must never be cached by a shared cache.**
> The `no-store` family above is what prevents a CDN from serving one viewer's
> authorized media to an unauthorized one.

There is **no** Content-Security-Policy for the public website in this
repository — that is delivered by the static host. See
`../../public_website/docs/CSP_AND_HEADERS.md`.

## 9. SSRF protection

`src/videos/metadata/video-metadata.service.ts` probes remote video URLs for
duration/format. It:

- accepts only `http:`/`https:`;
- resolves the hostname and rejects private, loopback, link-local and
  IPv4-mapped-IPv6 private addresses (`isBlockedHostname`, `isBlockedIp`,
  `isBlockedIpv4`, `isBlockedIpv6`);
- honours an optional `MANUAL_VIDEO_URL_ALLOWLIST`;
- bounds each fetch by `VIDEO_METADATA_PROBE_TIMEOUT_MS` and
  `VIDEO_METADATA_PROBE_MAX_REMOTE_MB` using ranged requests;
- can be disabled entirely with `VIDEO_METADATA_PROBE_ENABLED=false`.

Embed URLs are separately restricted to `VIDEO_EMBED_ALLOWED_HOSTS`.

## 10. Filesystem safety (`LOCAL_FILE`)

`src/videos/storage/local-video-storage.service.ts`:

- Storage keys are built server-side from UUIDs; each path segment must match
  `^[a-zA-Z0-9._-]+$` and extensions must match `^\.[a-z0-9]{1,12}$`.
- Every resolved path is re-checked to be inside the storage root, and symlink
  components and non-regular targets are rejected (`realpathSync`/`lstatSync`).
- Free space is checked against `LOCAL_VIDEO_MIN_FREE_SPACE_MB` before writes.
- In production `LOCAL_FILE_STORAGE_ROOT` must be an absolute path
  (`src/config/env.validation.ts`).

> **SECURITY INVARIANT: `LOCAL_FILE_STORAGE_ROOT` must live outside every public
> web root.** Files are only reachable through authorized API routes.

## 11. Audit and access logging

| Table | Written by | Contains |
|---|---|---|
| `AdminAuditLog` | Admin auth and every admin mutation | `adminId`, `action`, `module`, `entityType`, `entityId`, `status`, `ipHash`, truncated `userAgent`, `metadataJson` |
| `AccessLog` | Public watch resolution | `websiteId`, `shareLinkId`, `domain`, `ipHash`, `userAgent`, `referer`, `status`, `reasonCode` |

Auth audit actions include `ADMIN_LOGIN_SUCCESS/FAILURE`,
`ADMIN_REFRESH_SUCCESS/FAILURE/REPLAY`, `ADMIN_LOGOUT_SUCCESS/FAILURE`,
`ADMIN_PASSWORD_CHANGE_SUCCESS/FAILURE`, `ADMIN_SESSION_REVOKE_SUCCESS`.
Audit-write failures are logged as warnings and never break the request.

> **SECURITY INVARIANT: IP addresses are persisted only as
> `sha256(ACCESS_LOG_IP_PEPPER + ip)`.** Never store or log a raw client IP.

## 12. Data that must never be logged or returned

- Passwords, `passwordHash`, bcrypt output.
- Raw JWTs, raw refresh tokens, raw share tokens, media grants.
- `Authorization`, `Cookie`, `Proxy-Authorization`, `X-Api-Key` headers,
  `Set-Cookie`, and the `token` / `grant` query parameters — all redacted in
  `src/app.module.ts`.
- `DATABASE_URL` or any pepper/secret value.
- Raw client IPs.
- Raw SQL, query arguments or Prisma messages in client responses
  (`safe-database-error-context.util.ts` sanitises them for logs; clients get a
  generic 500).

The Pino request serializer emits only `id`, `method` and a **safe route
template** — never a raw URL or query string.

## 13. Secret management

Secrets come from the process environment only; `ConfigModule` runs with
`ignoreEnvFile: true` and `src/config/load-env.ts` decides which dotenv file to
load. `.env*` files are gitignored except the `*.example` templates.

Required in **all** environments (startup fails otherwise):
`DATABASE_URL`, `JWT_ACCESS_SECRET`, `REFRESH_TOKEN_PEPPER`,
`SHARE_TOKEN_PEPPER`, `ACCESS_LOG_IP_PEPPER`.

Additionally required in **production**: `PUBLIC_MEDIA_GRANT_SECRET`
(≥ 32 chars; a weak development default is used elsewhere) and
`ADMIN_CHANGE_PASSWORD_SECRET`.

Rotation impact is documented in `docs/security/secret-rotation-runbook.md`.
In short: rotating `JWT_ACCESS_SECRET` invalidates access tokens (refresh still
works); rotating `REFRESH_TOKEN_PEPPER` logs everyone out; rotating
`SHARE_TOKEN_PEPPER` invalidates every raw share token **but not aliases**;
rotating `PUBLIC_MEDIA_GRANT_SECRET` invalidates outstanding grants;
rotating `ACCESS_LOG_IP_PEPPER` breaks correlation with historical `ipHash`
values.

> **SECURITY INVARIANT: Documentation, commits, logs and terminal output must
> reference secrets by variable name only.** The values in `.env.example` are
> placeholders and must never be deployed.

## 14. Media URL exposure characteristics

Two different exposure profiles — do not conflate them.

**Backend-served media URLs** (`DB_BLOB`, `LOCAL_FILE`, local thumbnails)
contain the share token (path segment), the host (query) and, for view-limited
links, a grant:

- Anyone holding the URL can replay it until the share link is revoked or
  expires, or until the grant expires for view-limited links.
- Tokens therefore appear in browser history and any `Referer` the browser
  sends. The public site sets `Referrer-Policy: no-referrer` and scrubs the
  token from the visible URL to reduce this.
- Backend logs never contain them: `req.query.token` and `req.query.grant` are
  redacted and route templates are logged instead of URLs.
- Revocation takes effect server-side on the next request, with one caveat:
  unlimited `LOCAL_FILE` links may be served from the per-process metadata cache
  for up to `MEDIA_METADATA_CACHE_TTL_SECONDS` in a process that did not observe
  the invalidation (§4.2). Responses are `no-store`, so no shared HTTP cache
  retains them.

**Provider / direct media URLs** (`DIRECT_URL`, Cloudinary `secure_url`,
`EMBED`) are a different situation entirely:

- They contain **no** share token, **no** host binding and **no** grant.
- The backend is not in the request path, so it cannot observe, throttle,
  count or deny playback.
- Revoking the share link stops future *watch resolution* but **cannot
  invalidate a URL already disclosed to a browser**. It remains valid for as
  long as the provider serves it.
- Treat handing out a `DIRECT_URL`/Cloudinary/`EMBED` video through a share link
  as disclosing that URL permanently.

See §4.1 and [KNOWN_ISSUES.md](./KNOWN_ISSUES.md#ki-015).

## 15. Frontend versus backend responsibility

| Concern | Backend | Admin SPA | Public site |
|---|---|---|---|
| Authentication | Authoritative | Stores tokens, attaches Bearer, refreshes | None |
| Authorization | Authoritative | No role gating today | None |
| Input validation | Authoritative (DTOs) | Convenience (zod) | Convenience |
| Share-token validation | Authoritative | — | Passes through |
| Media URL construction | Authoritative | Displays | Uses server URLs only |
| Rate limiting | Application-level | — | — |
| CSP / security headers | Own responses only | Static host | Static host / Cloudflare |

## 16. Known deviations

Tracked with evidence in [KNOWN_ISSUES.md](./KNOWN_ISSUES.md). The most
security-relevant: admin refresh tokens are persisted in `localStorage` by
redux-persist, which is XSS-reachable. Migration to an `HttpOnly` cookie is
`PLANNED` (`docs/prompts/PROMPT_D_admin_web_cookie_refresh_migration.md`) and is
partly mitigated by session-bound access tokens, single-use rotation and
replay-triggered session revocation.

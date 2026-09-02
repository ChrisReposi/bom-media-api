# Security Model

Status: CURRENT
Last verified: 2026-08-23
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
| Public share **transport alias** | `randomBytes(16).base64url` (22 chars, 128 bits) | **Stored in clear** in `ShareLink.transportAlias`, unique, nullable | Same as the share link |
| Public media grant | `base64url(payload).base64url(HMAC-SHA256)` via `PUBLIC_MEDIA_GRANT_SECRET` | Query string of media URLs | `min(now + PUBLIC_MEDIA_GRANT_TTL_SECONDS, shareLink.expiresAt)`, clamped 5 min … 24 h |
| Bunny embed token | `SHA256_HEX(BUNNY_STREAM_TOKEN_SECURITY_KEY + videoId + expires)` | Query string of the Bunny iframe URL | `BUNNY_STREAM_EMBED_TOKEN_TTL_SECONDS`, default 5 min, bounded 1 min … 1 h |
| Bunny TUS signature | `SHA256_HEX(libraryId + BUNNY_STREAM_API_KEY + expiration + videoId)` | Admin browser only, as a TUS request header | `BUNNY_STREAM_TUS_TTL_SECONDS`, default 1 h, bounded 5 min … 24 h |
| Admin password | bcrypt, 12 rounds | Database only | Until changed |

> **SECURITY INVARIANT: No raw refresh token and no raw share token is ever
> persisted.** Only peppered SHA-256 hashes are stored. The two aliases are the
> deliberate exceptions — each is a short, revocable, per-website lookup key that
> is useless without a matching `ACTIVE` domain, website and share link.

### 2.0 The two share-link bearer credentials

> **A ShareLink has TWO bearer credentials, and both are secrets.** Say this
> precisely; the imprecise version is dangerous.

| | `alias` | `transportAlias` |
|---|---|---|
| Role | **the canonical bearer credential** | **an alternate, email-safe bearer credential** |
| Reviewer URL | `/watch#k=<alias>` — a URI FRAGMENT, never transmitted | `/watch?r=<transportAlias>` — a QUERY STRING, transmitted |
| Redeemed by | `POST /public/watch/exchange`, `GET /public/watch`, and every media route | `POST /public/watch/exchange-compatible` only |
| Exists on | every ShareLink | canonical single-video links only, and only where minted or backfilled |
| Entropy | 96 bits (40 for pre-2026-08-25 links) | 128 bits |

**Possession of either grants access to the same ShareLink**, on that link's
bound host, until the link is revoked, expires, exhausts `maxViews`, or its
website/domain/video eligibility lapses. Treat `transportAlias` with exactly
the care `alias` gets.

What the transport alias is **not** is a second authorization model.
`resolvePublicWatchCompatible()` maps it to a row and then re-enters the
**unmodified** `resolvePublicWatch()` by that row's own `alias`, so §4's chain
is evaluated in one place for both credentials. It confers no permission of
its own, carries no status, budget or expiry, and cannot outlive its ShareLink.

> **SECURITY INVARIANT: both credentials are redacted from logs, and neither
> may ever reach `AccessLog`.** `AccessLog` stores a `shareLinkId`, never a
> credential. The Pino request serializer emits only `id`, `method` and a route
> TEMPLATE, so **no request body and no query string is ever logged**; the
> redaction list additionally names `req.body.token`, `req.body.alias`,
> `req.query.token`, `req.query.grant` and `req.query.r` as a second layer.
>
> The one inbound header that can still carry a credential is `Referer`, since
> a reviewer arriving from `/watch?r=…` or the V1 `/?token=…` names it.
> `sanitizeAccessLogReferer()` keeps the origin and path and drops everything
> from the first `?` or `#`, so `AccessLog.referer` records which page the
> viewer came from and never a credential. `Referrer-Policy: no-referrer` on
> the reviewer site is a client policy and is not relied on here.
>
> Pinned by `test/transport-alias-redaction.test.ts` (R1–R10), which searches
> serialized output for the literal value rather than trusting field names.

> **THE ALTERNATE SURFACE HAS ITS OWN KILL SWITCH.**
> `PUBLIC_COMPATIBILITY_URL_HOSTS` gates redemption as well as emission:
> `PublicService.resolvePublicWatchCompatible()` refuses a host that is not on
> the list **before it reads the presented credential at all**, using the same
> `isCompatibilityCapableHost()` predicate the Admin emission path uses, so the
> two answers cannot drift. Clearing the variable and restarting therefore
> closes every `/watch?r=` link for that host at once while leaving every `#k`
> link working.
>
> This is a **suspension**, not a revocation, and the difference matters during
> an incident. Restoring the host makes every previously issued transport alias
> redeem again, because nothing rotates or clears the column. Destroying one
> credential still means revoking its `ShareLink`, which destroys the `#k`
> credential with it.

**Compromise semantics, stated plainly:**

- Compromise of a `transportAlias` grants access to **that one ShareLink**,
  on its bound host, until that ShareLink becomes invalid or is revoked.
  Revoking the ShareLink is the permanent remedy, and it stops both
  credentials at once. Removing the host from
  `PUBLIC_COMPATIBILITY_URL_HOSTS` is the reversible class-wide remedy: it
  stops every transport alias on that host without touching `#k`.
- Compromise of a `transportAlias` **does not reveal the `alias`**. The two
  values share no bytes and neither is derived from the other; the response to
  a compatibility exchange carries media URLs built from `alias`, so a holder
  of the transport alias who completes an exchange does learn the `alias` —
  but a holder of the *string alone*, from a log or a URL, does not.
- **The first `?r=` request is visible to the static host, any proxy and any
  CDN**, in the request line, before a byte of JavaScript runs. The reviewer
  site scrubs the query from the address bar with `history.replaceState`
  before any subsequent network activity, which removes it from the history
  entry and from later `Referer` headers — it does **not** remove it from that
  first server-side request log. That exposure is inherent to a
  fragment-independent URL, and it is the reason the query carries a separate
  credential rather than `alias`.

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

Metadata resolution (`/public/watch`, `/public/watch/exchange`,
`/public/watch/exchange-compatible`) adds a `currentViews < maxViews` check and
then atomically increments `currentViews`.

> **The email-safe exchange adds a step 0, not a step.** `exchange-compatible`
> takes a 22-character `transportAlias` (a separate 128-bit identifier that the
> `/watch?r=` reviewer URL carries in its query string), maps it to a ShareLink
> row, and enters the chain above at step 1 with that row's own `alias`. It
> enforces nothing of its own and skips nothing: the website scope in step 3 is
> re-imposed by the resolver, a transport alias is refused everywhere else, and
> a share alias or raw token is refused there by shape. The trade-off — the
> query carrier is visible to the static host once, the fragment credential
> never — is recorded in
> [features/share-links.md §3.1](./features/share-links.md#31-the-email-safe-compatibility-url).

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
| `.../videos/:id/thumbnail` (`LOCAL_FILE` thumbnail) | **Not always** — same code path as `local-file` (§4.2) |
| `.../videos/:id/thumbnail` (Bunny poster) | **Yes, every request** — uncached, plus an authoritative re-read of the `VideoAsset` row (§4.1.2) |
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
| **Provider / signed** | `EMBED` **(Bunny-backed)** | a freshly signed `iframe.mediadelivery.net` URL | **No** | Bunny embed token | Revocation stops future watch resolution; an already-issued URL dies at its own expiry (default 5 min) |
| **Backend-served** | `EMBED` **(Bunny-backed), poster** | `/public/watch/.../thumbnail` | **Yes**, when the proxy is enabled | Yes, when `maxViews` is set | Revoking the link stops the next poster request |

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

### 4.1.1 Bunny Stream signed embed URLs

> **SECURITY INVARIANT: a signed Bunny embed URL is minted only after the entire
> chain in section 4 has passed AND the authoritative atomic view consumption
> has succeeded.**

Watch resolution runs in four ordered stages, and signing is the last of them:

```
1. resolve credential / domain / share link / video candidates
2. every authorization check in section 4
3. AUTHORITATIVE ATOMIC CONSUMPTION - incrementShareLinkView()
     a conditional UPDATE that re-verifies status, expiry and maxViews and
     claims the view in one statement
4. ONLY IF 3 claimed a row: serialize and sign
```

`selectPublicPlayableVideos()` performs stage 2 filtering and **mints nothing**;
Bunny playability is decided there by `BunnyStreamService.canSignEmbedUrl()`, a
pure configuration check. `toPublicVideoResponses()` - the only caller of
`resolvePublicEmbedUrl()`, and the only place a Bunny URL or a media grant is
issued - runs in stage 4. Consequences:

- A request that ends `INVALID_LINK`, **including one that loses a concurrent
  revoke / expiry / `maxViews` race at stage 3**, never reaches
  `BUNNY_STREAM_TOKEN_SECURITY_KEY` at all.
- A cache hit accelerates lookup only. It follows the same four stages, so a
  cached resolution whose consumption then fails also signs nothing.
- The watch metadata cache stores raw video rows, not serialized responses, so a
  valid cache hit still mints a **newly signed** URL after its own consumption.
- It **fails closed**: if Bunny is disabled or misconfigured,
  `isPublicPlayableVideo()` drops the video rather than falling back to the
  stored unsigned URL.
- The stored `VideoAsset.embedUrl` for a Bunny asset is deliberately the
  **unsigned** base URL. It is never returned to a public client.

> **SECURITY INVARIANT: a Bunny asset reconciled as REMOTE-MISSING fails
> closed.** When Bunny answers an authoritative 404 for a video id, the local
> record is preserved but demoted out of `READY` and marked in
> `metadataJson.bunnyStream.remoteMissing`. Because public playability and
> share-link eligibility both already require `status === READY`, no new signed
> Bunny URL can be minted for it and no new share link can include it — with no
> Bunny-specific gate added anywhere. A **transient** Bunny failure never
> triggers this, so provider unavailability cannot un-publish a working
> catalogue. Remote existence is eventual-consistency state maintained by sync
> and by `yarn reconcile:bunny`; **no Bunny request is made during public watch
> resolution.** See [features/bunny-stream.md](./features/bunny-stream.md) §9.3.

> **SECURITY INVARIANT: Bunny playback signing does not trust the metadata
> cache.** `MemoryCacheService` is process-local, so reconciliation running in
> another process (`yarn reconcile:bunny --apply`, a second worker, a direct
> database fix) cannot invalidate this process's `public:watch:` entries.
> Immediately before minting a token — and after the atomic view consumption —
> `loadSignableBunnyVideoIds()` re-reads the current `VideoAsset` rows and
> requires existence, `status === READY`, the strict Bunny predicate, no
> `remoteMissing` marker, and an unchanged Bunny video id. Any failure, a
> mismatch, or an unreadable query fails closed: no token, and never a fallback
> to the stored unsigned URL. It is **one** batched indexed local query per
> response and adds no Bunny Management request. In-process invalidation is
> retained but public security no longer depends on it succeeding.

> **SECURITY INVARIANT: the Bunny EMBED shape fails closed.** A record that
> structurally claims to be a new-style Bunny asset - `provider = BUNNY` **and**
> `sourceType = EMBED` - but fails the complete identification predicate is
> classified `bunny-malformed` and is never publicly playable. It must never
> fall through to generic embed handling, which would serve its stored
> **unsigned** Bunny URL permanently. A legacy `provider: BUNNY` record with
> `sourceType: DIRECT_URL` is `not-bunny` and keeps its existing behaviour
> exactly; the strict rule applies only to the Bunny EMBED shape.

> **SECURITY INVARIANT: feature-disabled isolation.** No Bunny network request
> can leave this process while `BUNNY_STREAM_ENABLED=false`, even if stale
> credentials remain configured. `createVideo`, `getVideo` and `deleteVideo` each
> call `ensureEnabled()`, and so does the single outbound `request()` call site.
> A purge that asks for remote deletion while Bunny is disabled therefore issues
> no HTTP request — and, since 2026-08-23, **aborts the purge entirely** rather
> than deleting the local row. `ensureEnabled()` throws inside the pre-commit
> remote delete, so the record survives, `VIDEO_BUNNY_REMOTE_DELETE` is audited
> `FAIL`, and no Bunny orphan is created. Previously the row was purged and the
> Bunny asset was left behind.

The public browser receives the signed URL, its token and its expiry. It never
receives `BUNNY_STREAM_API_KEY` or `BUNNY_STREAM_TOKEN_SECURITY_KEY`. The
5-minute default TTL bounds post-revocation exposure the same way a media grant
does - better than `DIRECT_URL`/Cloudinary/plain `EMBED`, which never expire,
but not instant revocation.

> **`VIDEO_EMBED_ALLOWED_HOSTS` deliberately does NOT include
> `iframe.mediadelivery.net`.** That allowlist governs the generic
> embed-creation path, where a pasted URL is stored permanently; adding the
> Bunny host there would let an operator store a permanent **unsigned** Bunny
> URL. Bunny embed URLs are built server-side from a fixed constant instead. The
> public site allowlist and CSP `frame-src` were widened in the same change, so
> the only Bunny URL the public site can ever render is one this backend signed.

### 4.1.2 Bunny poster delivery through the backend proxy

> **SECURITY INVARIANT: the reviewer's browser never fetches a Bunny pull-zone
> URL directly while `BUNNY_PUBLIC_THUMBNAIL_PROXY_ENABLED=true`.** The poster
> is served by this API, behind the full §4 chain.

The public watch response used to hand out the raw
`https://vz-….b-cdn.net/{guid}/{file}` poster URL. Two correct decisions then
collided in production: a public site sending `Referrer-Policy: no-referrer`
gave the browser no `Referer`, and the pull zone's hotlink protection (Bunny's
Allowed Referrers) answered **403**. Every reviewer poster rendered broken.

```
reviewer browser
   │  GET /public/watch/<token>/videos/<id>/thumbnail?host=…[&grant=…]
   ▼
bom-media-api        full §4 authorization chain, then three provider gates
   │  GET https://<pull-zone>/<bunnyVideoId>/<fileName>   (one request)
   ▼                 under an EXPLICITLY CONFIGURED upstream auth mode
Bunny pull zone
```

**Three independent gates, all of which must pass**, before one byte is fetched:

1. **Authoritative Bunny identity.** `classifyBunnyVideoAsset()` — the same
   strict predicate playback signing uses, not a weaker copy — plus the absence
   of `metadataJson.bunnyStream.remoteMissing`. A `bunny-malformed` record fails
   closed and never falls through to its stored URL. Read from the **current**
   database row, not from the metadata cache, for exactly the reason
   `loadSignableBunnyVideoIds()` exists: this process's cache cannot be
   invalidated by reconciliation running anywhere else.
2. **URL validation and reconstruction** — see §9.1.
3. **Upstream response validation**: no redirect is followed, the status must be
   `2xx`, the `Content-Type` must be an allowed raster image type, and the body
   is capped in bytes.

> **SECURITY INVARIANT: the backend's own upstream request is authorized by a
> CONFIGURED mode, never by inference.** `BUNNY_PUBLIC_THUMBNAIL_UPSTREAM_AUTH_MODE`
> selects `none` (send nothing extra) or `referer` (send the configured
> `BUNNY_PUBLIC_THUMBNAIL_UPSTREAM_REFERER`). A proxy that merely moved the
> browser's 403 to the API server would not be a fix. In `referer` mode the
> value comes from validated configuration and **never** from the incoming
> request — echoing a client-supplied `Referer` would let a caller choose what
> the CDN sees. A `referer` mode with no usable value **fails closed** rather
> than silently downgrading to `none`.

> **CDN Token Authentication is NOT implemented**, and
> `BUNNY_STREAM_TOKEN_SECURITY_KEY` must never be used for it. That key signs
> Stream **embed view tokens**; a pull zone's CDN token security is a separate
> mechanism with a separate key. Signing a CDN URL with the embed key would
> produce signatures the CDN rejects while looking, in code, exactly like
> working security. See
> [features/bunny-stream.md](./features/bunny-stream.md) §4.6 and §11.

**Views are never incremented** by a poster request, on GET or HEAD. `maxViews`
is enforced through the same signed `grant` as the other media routes; the view
itself was claimed once, atomically, during watch resolution.

**Every failure is the identical generic `404 "Video not found."`** — an
upstream 403, an upstream 404, an oversized body, a rejected content type and a
network timeout are indistinguishable to a client. The real reason is logged
internally, without a URL, a header value or a secret.

**Reviewer privacy improves; revocation reach improves.** Bunny no longer sees
the reviewer's IP address for the poster, and revoking the share link stops the
next poster request. The Bunny **player** iframe is unchanged and still loads
directly from Bunny once the reviewer starts playback, so its own exposure
(§4.1.1) is unaffected.

While the proxy is **disabled** — the default — the stored pull-zone URL is
returned exactly as before, and that URL is in the provider/direct category of
§4.1 with all of its limitations.

### 4.2 `LOCAL_FILE` media authorization cache

`getAuthorizedPublicLocalVideo()` — the `LOCAL_FILE` narrowing behind both the
`local-file` route and the `LOCAL_FILE` branch of the `thumbnail` route —
consults the process-local memory cache **before** any database query and
**before** `hasValidMediaGrant()`:

> **The Bunny thumbnail branch does NOT use this cache** (2026-08-28). It runs
> the same shared authorization chain uncached and then re-reads the current
> `VideoAsset` row, so the window described below does not apply to it. See
> §4.1.2.

> **CLASSIFICATION: INTENTIONAL BOUNDED EXPOSURE, re-affirmed 2026-08-28. NOT a
> defect requiring change in this pass.**
>
> Stated plainly so nothing elsewhere in this document is read as claiming more
> than the code does: **public media authorization is NOT authoritative on every
> request.** The `LOCAL_FILE` fast path deliberately trusts a process-local cache
> and, on a hit, issues **zero database queries** and does **not** call
> `hasValidMediaGrant()`.
>
> It is classified as bounded rather than defective because every one of these
> holds, and each is enforced by `canCachePublicWatchShareLink()` rather than by
> convention:
>
> - a view-limited link (`maxViews !== null`) is **never** cached, so a cache hit
>   can never skip a grant check that would otherwise have mattered — the links
>   that are cached are exactly the links that neither carry nor require a grant;
> - `DB_BLOB` is never cached, and re-runs the full chain per request;
> - an entry can never outlive the share link's own `expiresAt`;
> - the TTL is bounded 1–3600 s, default 300 s;
> - same-process admin mutations *do* invalidate it (COMPAT-044 drives the real
>   `revokeShareLink()`, `updateVideoAssignments()`, `assignSingleVideo()` and
>   `disableVideo()` against a shared cache instance).
>
> What remains exposed, precisely: for an **unlimited `LOCAL_FILE`** link,
> revocation or un-assignment performed **out of band** — direct SQL, or a
> mutation handled by a different Node process (KI-010) — may not take effect on
> the `local-file` and `LOCAL_FILE`-thumbnail routes for up to the TTL. It is
> recorded as [KI-020](./KNOWN_ISSUES.md#ki-020), pinned as *current behaviour*
> by COMPAT-040, and eliminated entirely by `MEMORY_CACHE_ENABLED=false`.
>
> **Why this pass did not change it.** Making it authoritative per request is a
> deliberate performance/latency decision on a `publicMedia` route throttled at
> 1200 req/min, not a drive-by. The generalised thumbnail route was written to
> *preserve* the property exactly — `getPublicThumbnail()` checks the cache
> before the provider-independent chain, and
> `test/public-local-thumbnail.test.ts` asserts a warm request adds **zero**
> queries — specifically so that this decision stays where it belongs, with the
> owner of KI-020, instead of being silently reversed as a side effect of a Bunny
> change.

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

### 9.1 The Bunny poster proxy is not a general fetcher

`src/bunny/bunny-cdn-thumbnail.util.ts` is the second outbound-URL boundary in
this codebase, and it is deliberately much narrower than §9's probe.

The value it starts from is a **database column** (`VideoAsset.thumbnailUrl`).
"The value we wrote" and "the value in the row right now" are different claims:
an operator, a migration, a restored backup or a direct SQL edit can put
anything there. `fetch(row.thumbnailUrl)` with no check is the textbook SSRF
primitive — internal hosts, cloud metadata endpoints, `file:`, redirect chains —
reachable by anyone holding a share link.

So the stored string is never the thing that gets fetched. It is parsed, every
component is checked against the Bunny identity the caller already **proved**
from the current row, and the upstream URL is then **rebuilt** from those proven
components:

| Check | What it stops |
|---|---|
| absolute and `https:` | `http:`, `file:`, `data:`, relative values |
| no username or password | credential leakage to a third party; host confusion |
| no explicit port | reaching an unexpected service on a passing hostname |
| hostname **equals** `BUNNY_STREAM_PULL_ZONE_HOSTNAME` exactly | `…b-cdn.net.attacker.example`, `evil-vz-x.b-cdn.net`, any other CDN |
| no query, no fragment | a caller-controlled parameter reaching the CDN |
| exactly two path segments | nested paths, traversal shapes |
| segment 1 **equals the authoritative Bunny video id** | a row pointing at a *different* video's poster on the same pull zone |
| segment 2 passes `isSafeBunnyFileName()` | `..`, separators, schemes, whitespace |

Redirects are **never followed** (`redirect: "manual"`); a `3xx` is refused
outright, because it is the one way a URL that passed every hostname check still
ends up fetching another origin.

The response is bounded as well: a short timeout with an `AbortSignal`, a
`Content-Type` restricted to raster image types (**`image/svg+xml` is
excluded** — an SVG is a document that can carry script, and it would be served
from this API's own origin), and a byte cap enforced on the transferred stream
rather than only on `Content-Length`, so a missing or dishonest header cannot
become an unbounded transfer. Rejected responses have their body drained rather
than left to hold a socket.

> **No per-view Bunny Management API call was added.** Public watch stays free
> of provider latency; the file name is recovered from the stored URL under the
> validation above.

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

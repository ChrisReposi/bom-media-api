# API Contracts

Status: CURRENT
Last verified: 2026-08-25
Verified against: all `src/**/*.controller.ts`, `src/**/dto/*.ts`, `src/**/types/*.ts`, and the consuming code in `../bom-media-admin/src/features/**` and `../public_website/assets/app.js`

Base URL: `{origin}/api/v1` (`API_PREFIX`). Interactive schema at `/docs` when
Swagger is enabled — this document exists to record **who consumes what** and
**what will break if you change it**, which OpenAPI does not capture.

## 0. Conventions

- Auth: `Authorization: Bearer <accessToken>` on every `/admin/**` route except
  `register`, `login`, `refresh`.
- No global success envelope. Successful responses are the DTOs below.
- Errors: `{ statusCode, message, error }`, sometimes with a stable `code`.
  `500` is always the generic `{ statusCode: 500, message: "Internal server
  error", error: "Internal Server Error" }`.
- `BigInt` fields (`viewCount`, `sizeBytes`) are serialised as **strings**.
- **`viewCount` must be written as a JSON STRING of decimal digits.** Every DTO
  that accepts it declares `viewCount?: string` validated with
  `@IsCanonicalViewCount()` (`src/videos/utils/view-count.util.ts`), and the
  service parses it with `BigInt()`. A canonical digit string is the only
  accepted form: `"2.5"`, `"2e3"`, `"-1"`, `"+1"`, `"0x10"`, `"2.630.122"` and
  `"abc"` are all rejected with *"viewCount must be a non-negative integer"*.
  Surrounding whitespace is trimmed; an internal space is not. Values above the
  column's signed `BIGINT` range (`9223372036854775807`) are rejected with
  *"viewCount must not exceed 9223372036854775807"* rather than overflowing the
  database. Omitting the field means "not supplied" — 0 on create, unchanged on
  update. Pinned by `test/view-count-validation.test.ts`.

  > **CHANGED 2026-08-23: a JSON NUMBER is now rejected.** `{ "viewCount":
  > 2630122 }` returns `400` *"viewCount must be sent as a JSON string of
  > decimal digits, not a JSON number"*. The DTOs previously ran the parsed
  > number through `String(value)` **before** validation, which silently
  > destroyed precision: `JSON.parse` turns the literal `9007199254740993` into
  > the double `9007199254740992`, so the stringified `"9007199254740992"`
  > passed `/^\d+$/` and was persisted as a different integer than the client
  > sent. The transform now leaves a non-string untouched so the validator can
  > see its type and refuse it. No numeric form is accepted, safe range or not,
  > because the contract must not depend on JavaScript's number range.
  >
  > No shipped caller is affected: `bom-media-admin` sends the canonical string
  > on every path (JSON and multipart alike) and `public_website` only ever
  > READS the field. The one numeric occurrence in this repository was the
  > Swagger example on `POST /admin/videos/embed`, now `"1000"`.
  >
  > **Human thousands grouping is a UI concern, not an API one.** The admin
  > console canonicalises `2.630.122`, `2,630,122`, `2 630 122` and `2_630_122`
  > to `"2630122"` before sending
  > (`bom-media-admin/src/features/videos/viewCountUtils.ts`); the API accepts
  > only the canonical form.
- Validation is strict: unknown body properties are rejected with `400`.
- Consumer column: **A** = `bom-media-admin`, **P** = `public_website`,
  **—** = no shipped consumer (operators, scripts, curl).

## 1. Consumer matrix

| Endpoint | Method | Auth | Roles | Consumer |
|---|---|---|---|---|
| `/health` | GET | none | — | ops |
| `/health/ready` | GET | none | — | ops |
| `/admin/auth/register` | POST | secret | — | — (one-time) |
| `/admin/auth/login` | POST | none | — | **A** |
| `/admin/auth/refresh` | POST | refresh token | — | **A** |
| `/admin/auth/logout` | POST | access token | any | **A** |
| `/admin/auth/me` | GET | access token | any | **A** |
| `/admin/auth/change-password` | POST | access token + secret | any | **A** (deprecated) |
| `/admin/auth/change-own-password` | POST | access token | any | — |
| `/admin/auth/sessions` | GET | access token | any | — |
| `/admin/auth/sessions/:id/revoke` | POST | access token | any | — |
| `/admin/accounts` … | GET/POST/PATCH/DELETE | access token | OWNER | — |
| `/admin/videos` | GET | access token | read | **A** |
| `/admin/videos/:id` | GET/PATCH | access token | read / write | **A** |
| `/admin/videos/:id` | DELETE | access token | write | **A** — *soft-disable*, see §2.12 |
| `/admin/videos/:id/binary`, `/local-file`, `/thumbnail` | GET | access token | read | **A** |
| `/admin/videos` | POST | access token | write | **A** |
| `/admin/videos/manual-with-thumbnail` | POST | access token | write | **A** |
| `/admin/videos/embed`, `/embed-with-thumbnail` | POST | access token | write | **A** |
| `/admin/videos/upload` | POST | access token | write | — (Cloudinary) |
| `/admin/videos/upload-db` | POST | access token | write | — |
| `/admin/videos/upload-local/*` | POST/GET | access token | write / read | **A** |
| `/admin/videos/bunny/upload-init` | POST | access token | write | **A** |
| `/admin/videos/:id/bunny/sync` | POST | access token | write | **A** |
| `/admin/videos/:id/bunny/preview` | GET | access token | read | **A** |
| `/admin/videos/:id/bunny/thumbnail` | POST | access token | write | **A** |
| `/admin/videos/:id/binary`, `/:id/thumbnail-local` | PATCH | access token | write | **A** |
| `/admin/videos/:id/purge` | POST | access token | **OWNER** | **A** |
| `/admin/websites*`, `/admin/domains*`, `/admin/domain-groups*` | various | access token | read / write | **A** |
| `/admin/websites/:id/share-links` | GET/POST | access token | read / write | **A** |
| `/admin/share-links/:id/revoke` | POST | access token | write | **A** |
| `/admin/websites/:websiteId/video-assignment-options` | GET | access token | read | — |
| `/admin/websites/:websiteId/video-assignments` | PATCH | access token | write | — |
| `/admin/websites/:websiteId/videos/assign` | POST | access token | write | — |
| `/admin/websites/:websiteId/videos/:videoId/canonical-share-link` | GET/POST | access token | read / write | — (the Admin reaches the same logic through `POST …/share-links` with one video) |
| `/public/watch` | GET | none | — | **P** (legacy fallback) |
| `/public/watch/exchange` | POST | none | — | **P** (preferred) |
| `/public/watch/:token/videos/:videoId/view` | POST | none | — | **P** |
| `/public/watch/:token/videos/:videoId/binary` | GET/HEAD | none | — | **P** |
| `/public/watch/:token/videos/:videoId/local-file` | GET/HEAD | none | — | **P** |
| `/public/watch/:token/videos/:videoId/thumbnail` | GET/HEAD | none | — | **P** |

> Endpoints marked **—** are implemented and guarded but have no shipped client.
> They are reachable by operators and scripts. Do not delete them assuming they
> are dead; do check [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) first.

---

## 2. Admin ↔ Backend contracts

Breaking any of these breaks `bom-media-admin`.

### 2.1 `POST /admin/auth/login`

```jsonc
// request
{ "username": "string", "password": "string" }
// 200
{
  "message": "string",
  "admin": { "id", "username", "role", "status", "createdAt",
             "lastLoginAt", "mustChangePassword" },
  "tokens": { "accessToken", "refreshToken", "tokenType": "Bearer", "expiresIn": 900 }
}
```

Errors: `400` validation, `401` `"Invalid username or password."` (identical for
unknown user, wrong password, disabled and soft-deleted accounts), `403`
`ADMIN_TEMP_PASSWORD_EXPIRED`, `429` throttled.

**Contract notes.** The admin SPA stores `admin` and both tokens in redux
(persisted). It reads `tokens.expiresIn` but does not schedule a proactive
refresh. `admin.mustChangePassword` **is returned but the SPA's `SafeAdmin` type
omits it** — see [KNOWN_ISSUES.md](./KNOWN_ISSUES.md#ki-004).

### 2.2 `POST /admin/auth/refresh`

```jsonc
{ "refreshToken": "string" }        // request
{ "message", "admin", "tokens" }    // 200 — same shapes as login
```

`401` for unknown, revoked, expired or replayed tokens — all with the same
message. A replay additionally revokes the whole session server-side.

**Contract notes.** `axiosClient` (`src/lib/api/axiosClient.ts`) refreshes on any
`401` from a non-auth endpoint, de-duplicates concurrent refreshes into a single
in-flight promise, and retries the original request exactly once. It also runs
this endpoint at app start (`AuthSessionBootstrap`). The response **must**
continue to contain both a new `accessToken` and a new `refreshToken`.

### 2.3 `POST /admin/auth/logout`

Requires a valid access token (`AdminAccessTokenGuard`). `adminId` and
`sessionId` are taken from the **access token**, never from the body. Body
`{ "refreshToken": "string" }` is accepted and **ignored** (`void
dto.refreshToken`); do not start honouring it without updating the admin client.
Returns `200 { "message" }`, idempotently.

> **The body is not the authority used to revoke the session.** Sending only a
> refresh token, with no `Authorization` header, results in `401` and **no**
> revocation.

> **CONFIRMED DEFECT (consumer side).** The admin SPA calls this endpoint via
> `axiosBaseClient`, which carries no auth interceptor and so sends no Bearer
> token. The call fails with `401`, the SPA clears local state regardless, and
> the server-side session is never revoked. The backend contract is correct; the
> integration is not. See [KNOWN_ISSUES.md](./KNOWN_ISSUES.md#ki-016).

### 2.4 `GET /admin/auth/me`

`200 { "admin": { … } }`. Allowed while `mustChangePassword` is set.

### 2.5 `POST /admin/auth/change-password` — DEPRECATED but live

```jsonc
{ "oldPassword": "string", "newPassword": "string", "secretCode": "string" }
```

`secretCode` is compared against `ADMIN_CHANGE_PASSWORD_SECRET` with
`timingSafeEqual`. On success **all** sessions and refresh tokens for that admin
are revoked, so the client must clear local auth and route to `/login`.

The replacement is `POST /admin/auth/change-own-password`
(`{ currentPassword, newPassword }`, no operator secret, works while
`mustChangePassword` is set). The admin SPA still calls the deprecated route —
see [KNOWN_ISSUES.md](./KNOWN_ISSUES.md#ki-002). Keep the deprecated route until
the SPA migrates.

### 2.6 `GET /admin/videos`

Query: `page` (≥1, default 1), `limit` (1–100, default 20), `search`
(normalised, bounded), `status` (`VideoStatus`), `provider` (`VideoProvider`),
`filterKey` (`^[a-z0-9]+(?:_[a-z0-9]+)*$`, must not be the reserved value
`all`), `sortBy` (`createdAt|updatedAt|publishedAt|title`, default `createdAt`),
`sortOrder` (`asc|desc`, default `desc`).

```jsonc
{ "items": [ VideoResponse ], "meta": { "page", "limit", "total", "totalPages" } }
```

`VideoResponse` carries identity (`id`, `title`, `slug`, `description`,
`status`, `filterKey`), classification (`provider`, `sourceType`), playback
(`playbackUrl`, `playbackId`, `providerAssetId`, `embedUrl`, `embedProvider`,
`embedCloudName`, `embedPublicId`, `embedAllow`, `thumbnailUrl`), stored-asset
metadata (`binaryAsset`, `localFileAsset`, `localThumbnailAsset` — each with
`mimeType`, `sizeBytes` **as string**, and `checksumSha256` /
`originalFilename` where applicable), `durationSeconds`, `viewCount` **as
string**, `publishedAt`, `createdAt`, `updatedAt`, `metadataJson`.

**Contract notes.** Omitting `filterKey` lists everything. Sending
`filterKey=all` is a validation error by design. The admin list is cached
server-side for `ADMIN_VIDEOS_LIST_CACHE_TTL_SECONDS`.

### 2.7 Video creation

| Endpoint | Body | Produces |
|---|---|---|
| `POST /admin/videos` | JSON `CreateVideoDto` | `sourceType: DIRECT_URL`; provider per §2.7.1 |
| `POST /admin/videos/manual-with-thumbnail` | multipart (fields + `thumbnail`) | `DIRECT_URL` + uploaded thumbnail |
| `POST /admin/videos/embed` | JSON (embed URL or iframe snippet) | `sourceType: EMBED`, `provider` `CLOUDINARY` when the embed is a Cloudinary player, else `MANUAL` |
| `POST /admin/videos/embed-with-thumbnail` | multipart | same + thumbnail |
| `POST /admin/videos/upload` | multipart `file` | `sourceType: UPLOAD`, `provider: CLOUDINARY` |
| `POST /admin/videos/upload-db` | multipart `file` | `sourceType: DB_BLOB`; `400` when `VIDEO_DB_STORAGE_ENABLED` is false |
| `POST /admin/videos/bunny/upload-init` | JSON `InitBunnyVideoUploadDto` | `sourceType: EMBED`, `provider: BUNNY`, `status: PROCESSING`; `400` when `BUNNY_STREAM_ENABLED` is false. See section 2.13 |

Embed URLs are validated against `VIDEO_EMBED_ALLOWED_HOSTS`; the resulting
`embedAllow` defaults to `VIDEO_EMBED_DEFAULT_ALLOW`.

#### 2.7.1 How `provider` is chosen on `POST /admin/videos`

`resolveProvider(dto)`, in order:

1. **If the request supplies `provider`, that value is used.** `CreateVideoDto`
   declares `provider?: VideoProvider` with `@IsOptional() @IsEnum(VideoProvider)`,
   so **any** enum member — `MANUAL`, `CLOUDINARY`, `MUX` or `BUNNY` — can be
   persisted through this endpoint.
2. Otherwise, if `playbackUrl` parses as a URL whose hostname ends with
   `cloudinary.com`, the provider becomes `CLOUDINARY`.
3. Otherwise `MANUAL`.

> **CORRECTION (2026-08-21):** an earlier revision stated that
> Cloudinary-provider records are created only through the embed path. That is
> wrong. A plain `DIRECT_URL` video whose `playbackUrl` is any
> `*.cloudinary.com` URL is auto-classified as `provider: CLOUDINARY` with
> `sourceType: DIRECT_URL`, and an explicit `provider` in the body overrides
> detection entirely.

Storing `provider: BUNNY` or `provider: MUX` this way records a **label**. It
does not enable any provider integration — there is none. See
[features/bunny-stream.md](./features/bunny-stream.md).

### 2.8 Chunked local upload

```
POST /admin/videos/upload-local/init
  { title, slug?, description?, originalFilename, mimeType, totalBytes, chunkSizeBytes? }
  → { uploadId, totalChunks, chunkSizeBytes, expiresAt, … }

POST /admin/videos/upload-local/:uploadId/chunks       multipart: chunkIndex + chunk
  → { uploadedChunks, uploadedChunkIndexes, … }

GET  /admin/videos/upload-local/:uploadId              → progress

POST /admin/videos/upload-local/:uploadId/complete
  → VideoResponse (sourceType LOCAL_FILE, checksumSha256 set)

POST /admin/videos/upload-local/:uploadId/cancel       → status ABORTED
```

Chunk uploads are idempotent per `(uploadSessionId, chunkIndex)`. The admin
client's preferred chunk size comes from `VITE_LOCAL_VIDEO_CHUNK_SIZE_MB`, but
the **server** decides via `LOCAL_VIDEO_CHUNK_SIZE_MB`; the client must use the
`chunkSizeBytes` returned by `init`.

Returns `400` when `LOCAL_FILE_STORAGE_ENABLED` is false, when the file exceeds
`LOCAL_VIDEO_UPLOAD_MAX_MB`/`LOCAL_VIDEO_UPLOAD_HARD_MAX_MB`, or when free space
would drop below `LOCAL_VIDEO_MIN_FREE_SPACE_MB`.

### 2.9 Admin media preview

`GET /admin/videos/:id/binary | /local-file | /thumbnail` stream the stored asset
to an authenticated admin. The SPA fetches these as `Blob` with the Bearer header
and renders object URLs — that is why admin preview cannot be a plain `<video
src>`.

### 2.10 Websites, domains, share links

| Endpoint | Notes |
|---|---|
| `GET /admin/websites` | Cached `ADMIN_WEBSITES_LIST_CACHE_TTL_SECONDS`; supports search/paging |
| `POST/PATCH/DELETE /admin/websites/:id` | Write roles |
| `POST /admin/websites/:websiteId/domains` | Create + attach |
| `PATCH/DELETE /admin/websites/:websiteId/domains/:domainId` | Update / detach |
| `POST …/domains/:domainId/activate` / `/disable` | Domain lifecycle |
| `POST …/domains/claim-current` | Claim the caller's current host (guarded by `ALLOW_LOCALHOST_DOMAIN_CLAIM` for local hosts) |
| `GET /admin/domains`, `POST /admin/domains`, `PATCH/DELETE /admin/domains/:id` | Domain pool |
| `POST /admin/domains/:id/assign` / `/unassign` / `/activate` | Pool ↔ website |
| `GET/POST/PATCH/DELETE /admin/domain-groups*` | Domain groups |
| `GET /admin/websites/:websiteId/videos`, `PUT …/videos` | Read and replace assignments |
| `GET /admin/websites/:websiteId/share-links` | List (no raw tokens) |
| `POST /admin/share-links/:shareLinkId/revoke` | Sets `status: REVOKED` |

### 2.11 `POST /admin/websites/:websiteId/share-links` — the highest-risk contract

```jsonc
// request — all optional
{ "label": "string(≤255)", "videoIds": ["…"],   // ≤50, unique
  "expiresAt": "ISO-8601", "maxViews": 1 }

// 201
{ "message": "string",
  "shareLink": { "id", "websiteId", "alias", "label", "status",
                 "expiresAt", "maxViews", "currentViews", "createdAt",
                 "videos": [ … ], "publicUrl" },
  "rawToken": "s_…",     // MULTI-VIDEO ONLY. Returned EXACTLY ONCE, never
                         // retrievable again. ABSENT on the canonical path
  "publicUrl": "https://<domain>/watch#k=<alias>",
  "outcome": "CREATED" | "REUSED",   // added 2026-08-25
  "isCanonical": false }             // added 2026-08-25
```

Preconditions enforced server-side: the website is `ACTIVE`, it has at least one
`ACTIVE` assigned domain, and every selected video is eligible (assigned to the
website and playable). Alias/token collisions are retried up to a bounded number
of attempts inside a `Serializable` transaction.

> **CONTRACT INVARIANT (added 2026-08-25): a request for EXACTLY ONE video is
> idempotent.** The resolved video set — not the raw `videoIds`, which may be
> omitted and default to the website's whole active assignment set — decides the
> path. One video resolves that website+video pair's **canonical** ShareLink:
> the same `id`, the same `alias` and a byte-identical `publicUrl` on every
> call, forever, with `outcome: "REUSED"` and **no row written** after the
> first. Two or more videos keep creating a new bundle link each time.
>
> This closed a real defect: every call used to mint a new ShareLink with a new
> alias and a new token, so pressing Create twice for one video produced two
> links with two different reviewer URLs. `CanonicalVideoShareLink` existed to
> prevent that but was reachable only through §2.11a, which no client called.
>
> Enforcement is server-side because it must be: two clients can both check for
> an existing link, both miss, and both create. The `@@unique([websiteId,
> videoId])` constraint arbitrates and the loser returns the winner's link.

> **`rawToken` is now OPTIONAL in the response.** It is absent whenever
> `isCanonical` is true — on reuse nothing was minted, and on first canonical
> creation the contract deliberately withholds it. The alias inside `publicUrl`
> is the credential. A client must not assume the field is present.

> **A canonical request must carry no `label`, `expiresAt` or `maxViews`**, and
> is refused with `400 CANONICAL_LINK_OPTIONS_NOT_ALLOWED` if it does. A
> canonical link is permanent and unlimited by construction. Accepting the
> options and dropping them would misreport an access control that was never
> applied; honouring them would let the pair's one identity expire with no way
> to mint a replacement. Bundles still take all three.

> **A canonical link that exists but is unusable is refused, never replaced.**
> Revoked, disabled, expired, exhausted, domain drifted, evidence drifted, or
> the video no longer shareable — each returns the `409` code listed in §2.11a
> and writes nothing. Minting a fresh credential in any of those cases would
> restore access an owner had deliberately removed.

> **A pair that already has a link but no mapping ADOPTS it.** Almost every
> production pair is in this state, because the canonical endpoint had no
> client. The resolver looks for share links on this website whose membership is
> **exactly** the requested video — a bundle `[A, B]` never qualifies for A —
> and then:
>
> | Exact single-video links found | Result |
> |---|---|
> | 0 | A new canonical link is created. The only case that mints one |
> | 1 | It is adopted unchanged: same `id`, same `alias`, same `publicUrl`, same views and budget. `outcome: "REUSED"` |
> | 2 or more | `409 CANONICAL_LINK_AMBIGUOUS`, with `candidateCount`. **Nothing is written** |
>
> Adoption pins *identity*, not usability: a revoked or expired historical link
> is still adopted and the request then fails with that link's own code, so the
> pair keeps one permanent answer and no replacement appears.
>
> The ambiguous case is **never** resolved by picking the newest, the oldest or
> the only `ACTIVE` one — nothing in the data says which already-circulated URL
> a reviewer holds. An owner resolves it with
> `yarn audit:canonical-share-links` then `yarn remediate:local:adopt-canonical`,
> after which every request returns the adopted link.

> **CONTRACT INVARIANT: `rawToken` is write-once.** Any client that discards it
> has permanently lost the raw token; only the alias remains usable. The admin
> SPA shows it once and normalises `publicUrl` to the hash form
> `https://<domain>/#/s/<alias>/videos` (`shareLinkUrlUtils.ts`) because the
> public sites are static hash-router SPAs. Both forms are accepted by the public
> site; the path form additionally needs a server rewrite.

### 2.12 Disable versus purge

> **`DELETE` does not delete.** Several `DELETE` routes are soft-disables that
> set a status and keep every row and file:
>
> | Route | Actual effect |
> |---|---|
> | `DELETE /admin/videos/:id` | `VideoStatus.DISABLED`. Rows, local files, thumbnails, `DB_BLOB` bytes and the Cloudinary asset are all retained |
> | `DELETE /admin/websites/:id` | `WebsiteStatus.DISABLED` |
> | `DELETE /admin/domains/:id`, `DELETE /admin/domain-groups/:id` | Status change |
>
> The admin client names these functions `disable*` for exactly this reason. Do
> not "correct" the naming; the verb is HTTP, the semantics are status.

> **A video disable is REVERSIBLE, including its effect on share links (changed
> 2026-08-24).** The admin console drives both directions through
> `PATCH /admin/videos/:id` — `{ status: "DISABLED" }` to disable, `{ status:
> "READY" }` to restore — and never calls `DELETE`. Disabling sweeps every
> `ACTIVE` `ShareLink` containing the video to `DISABLED`; restoring to `READY`
> sweeps the eligible ones back to `ACTIVE`. Previously nothing ever wrote that
> status back, so one disable click permanently destroyed every existing share
> link for the video and the restore could not recover them.
>
> `WebsiteVideo` and `ShareLinkVideo` rows are **not touched by either
> direction** — only `PURGE` removes them — so a restored video keeps its
> website assignments and its share-link memberships.
>
> The `VIDEO_UPDATE` audit row gained an additive
> `metadataJson.reactivatedShareLinkCount` alongside the existing
> `disabledShareLinkCount`. No response body changed and no client is affected.
> The eligibility rules — `REVOKED` never revives, expiry and `maxViews` are
> never rewritten — are in
> [features/share-links.md §5](./features/share-links.md#5-revocation-and-expiry).

Permanent removal is a separate, OWNER-only route:

`POST /admin/videos/:id/purge` — body
`{ "confirmVideoId": "<must equal :id>", "deleteRemoteAsset"?: boolean }`.

Preconditions, each with its own failure:

| Check | Failure |
|---|---|
| `confirmVideoId === :id` | `400` |
| No `CanonicalVideoShareLink` for the video | `409 VIDEO_HAS_CANONICAL_SHARE_LINK` |
| Video exists | `404` |
| Video status is `DISABLED` | `400` "Video must be disabled before it can be permanently deleted." |

> **An ACTIVE `WebsiteVideo` assignment no longer blocks the purge (changed
> 2026-08-23).** It used to return `400 "Video cannot be permanently deleted
> while it is assigned to active websites."`, which forced an operator to visit
> every website and unassign by hand before removing a video they had **already
> disabled**. `status === DISABLED` is the real safety property and is
> unchanged: a `DISABLED` video is administratively unavailable, its `ACTIVE`
> share links were already disabled by `disableVideo()`, and public resolution
> requires `READY` — so no assignment can make it playable.
>
> The assignment is now relationship state the purge transaction cleans up,
> exactly like `ShareLinkVideo`. **Unchanged:** the `DISABLED` requirement, the
> `409 VIDEO_HAS_CANONICAL_SHARE_LINK` provenance conflict, the OWNER role gate
> and the `confirmVideoId` check.

**Purge is two phases and is not atomic end to end.** See
[features/video-pipeline.md](./features/video-pipeline.md#10-deleting) for the
full lifecycle. In summary: a database transaction disables remaining share
links, detaches `ShareLinkVideo` rows, deletes the `VideoAsset` and writes
`VIDEO_PURGE_COMMIT`; **after that transaction commits**, external asset cleanup
runs best-effort and non-transactionally.

> **BUNNY IS THE EXCEPTION, and runs REMOTE FIRST (changed 2026-08-23).** When
> `deleteRemoteAsset: true` is sent for a Bunny-backed asset, the local
> preconditions are validated, the Bunny video is deleted, and **only then** does
> the local purge transaction run. If Bunny does not confirm the delete — a
> timeout, a 5xx, a 429, an auth failure, or the feature being disabled — the
> purge **aborts with `503` and the local row survives**. A 404 counts as
> confirmed, which is what makes a retry work.
>
> Rationale: "remote gone + local row present" is visible and retriable, while
> "local row gone + remote present" is an invisible billable orphan. Cloudinary,
> `DIRECT_URL`, `EMBED`, `LOCAL_FILE` and `DB_BLOB` keep their existing
> post-transaction best-effort ordering unchanged.

> **Bunny unavailable carries a stable code (added 2026-08-23).** When the purge
> asks for remote deletion but Bunny cannot confirm it *at all* — the feature is
> switched off, or the collaborator is not wired into the container — the
> response is `400` with:
>
> ```jsonc
> { "code": "BUNNY_STREAM_UNAVAILABLE_FOR_PURGE",
>   "reason": "NOT_ENABLED" | "NOT_WIRED",
>   "message": "Bunny Stream is not enabled on this server, so remote deletion
>               cannot be confirmed. The local video was kept. Enable Bunny
>               Stream and retry, or explicitly choose local-only purge if that
>               is intentional." }
> ```
>
> This replaces the bare `400 "Bunny Stream is not enabled."`, which told an
> operator neither that the video survived nor what to do next, and was raised
> by two unrelated conditions with no way to tell them apart. `reason` separates
> them: `NOT_ENABLED` is a configuration choice, `NOT_WIRED` is a server defect.
> Neither value discloses a key, a library id or a hostname.
>
> **The purge is ABORTED**, exactly as for any other unconfirmed remote delete:
> the `VideoAsset`, its `WebsiteVideo` assignments and its `ShareLinkVideo`
> memberships all survive, no `VIDEO_PURGE_COMMIT` is written, and
> `VIDEO_BUNNY_REMOTE_DELETE` is audited `FAIL` with `localPurgeStage:
> "ABORTED"`. A client must **never** respond by silently retrying local-only —
> that recreates the orphan the remote-first ordering exists to prevent.
> Retrying with `deleteRemoteAsset: false` is a legitimate operator decision and
> is unaffected: it returns null from `prepareBunnyRemoteDelete()` before this
> check and issues **zero** Bunny calls.
>
> A *transient* Bunny failure is a different response and keeps its existing
> `503` — retrying that one can work, so it must not be conflated with this.
>
> The `deleteRemoteAsset` field itself is unchanged and still defaults to
> `false` when omitted. What changed is the **Admin default**: the console now
> shows a remote-deletion checkbox for Bunny assets, defaults it **ON**, and
> **always sends the field explicitly** (`true` or `false`) rather than relying
> on omission. Omitted and explicit `false` are equivalent and both mean
> local-only purge; that compatibility is pinned by `test/video-purge.test.ts`.

The response reports what actually happened, including orphans:

```jsonc
{ "message": "…", "videoId": "…", "sourceType": "…", "status": "PURGED",
  "safety":  { "hadWebsiteAssignments", "hadShareLinks",
               "activeWebsiteAssignmentCount", "disabledShareLinkCount",
               "detachedShareLinkVideoCount", "detachedWebsiteAssignmentCount" },
  "storage": { "localVideoDeleteAttempted", "localVideoDeleted",
               "localThumbnailDeleteAttempted", "localThumbnailDeleted",
               "bytesReclaimed" /* string */, "orphanCleanupRequired" },
  "remote":  { "remoteAssetDeleteAttempted", "remoteAssetDeleted" } }
```

> **`status: "PURGED"` with `orphanCleanupRequired: true` is a success response
> describing a partial failure.** The database row is gone; a file or provider
> asset was not. Clients and operators must read `storage` and `remote`, not
> just the status. A `VIDEO_PURGE_STORAGE` audit row is written with
> `AuditStatus.FAIL` in that case.

### 2.13 Bunny Stream

Four endpoints — three write-role, one read-role — all on `VideosController` so
they inherit the existing guards and the `admin` throttle profile. All return
`400 "Bunny Stream is not enabled."` while `BUNNY_STREAM_ENABLED=false`.

```jsonc
// POST /admin/videos/bunny/upload-init
// request - only `title` is required
{ "title": "string(<=200)", "description"?, "slug"?, "viewCount"?, "publishedAt"?, "filterKey"? }
//
// The Bunny Create Video call this makes always carries `thumbnailTime` (ms),
// so a video uploaded with NO custom image still gets an automatic poster
// extracted during encoding. It is a server-side constant, not a request field.

// 201
{ "message": "Bunny Stream upload initialized.",
  "video": VideoResponse,               // provider BUNNY, sourceType EMBED, status PROCESSING
  "upload": {                           // short-lived TUS credentials
    "videoId":        "<bunny guid>",
    "libraryId":      "<numeric library id>",
    "expirationTime": 1781000000,       // UNIX seconds
    "signature":      "<64 hex chars>", // SHA256(libraryId+apiKey+expirationTime+videoId)
    "tusEndpoint":    "https://video.bunnycdn.com/tusupload" } }
```

> **CONTRACT INVARIANT: `upload` never contains `BUNNY_STREAM_API_KEY`.** The
> signature is derived from it server-side and expires at `expirationTime`
> (`BUNNY_STREAM_TUS_TTL_SECONDS`, default 1 h). The admin client uploads the
> bytes directly to Bunny with `tus-js-client`; **no video byte passes through
> this API.**

There is deliberately **no `status` field** in the request: a Bunny asset starts
`PROCESSING` and its lifecycle is owned by the Bunny encoding state.

```jsonc
// POST /admin/videos/:id/bunny/sync
// no request body

// 200
{ "message": "Bunny Stream status synchronized.",
  "video": VideoResponse,
  "bunnyStatus": 4,        // raw Bunny code, or null
  "encodeProgress": 100,   // 0-100, or null. TRANSIENT - never persisted
  "statusChanged": true,
  "remoteMissing": false }

// 200 - Bunny returned an authoritative 404
{ "message": "Bunny Stream reports this video no longer exists. …",
  "video": VideoResponse,  // status FAILED (or DISABLED if it already was)
  "bunnyStatus": null,
  "encodeProgress": null,
  "statusChanged": true,
  "remoteMissing": true }
```

Errors: `400` when Bunny is disabled or the video is not Bunny-backed, `404`
when the video does not exist, `503` when Bunny is unreachable.

> **`remoteMissing` (added 2026-08-23) is a success response, not an error.**
> Bunny answered an authoritative 404 for this video id, so the remote asset is
> gone. The backend **keeps** the local record, marks it in
> `metadataJson.bunnyStream.remoteMissing`, and demotes it out of `READY` so it
> stops being publicly playable and stops being eligible for new share links.
> Clients must branch on this field rather than parsing a message.
>
> A **transient** Bunny failure never sets it — that surfaces as `503`/`500`
> with nothing changed locally, and in particular with `READY` not demoted. The
> field is additive and defaults to `false`, so an existing client is unaffected.
> Full lifecycle in [features/bunny-stream.md](./features/bunny-stream.md) §9.

Status mapping - 4 (Finished) to `READY`; 5 (Error) and 6 (UploadFailed) to
`FAILED`; everything else, including 3 (**Transcoding**), to `PROCESSING`.
`DISABLED` and `READY` are never overwritten **by an encoding state**. Details in
[features/bunny-stream.md](./features/bunny-stream.md) section 4.3.

> **One exception, and only one: an authoritative 404.** `READY` IS demoted to
> `FAILED` when Bunny states the video does not exist, because leaving it `READY`
> would keep a nonexistent video publicly playable. `DISABLED` still wins even
> then. No transient failure can trigger this. See
> [features/bunny-stream.md](./features/bunny-stream.md) §9.3.

> **Sync also persists the poster.** When the local `thumbnailUrl` is empty and
> Bunny reports a `thumbnailFileName`, sync **builds**
> `https://{BUNNY_STREAM_PULL_ZONE_HOSTNAME}/{videoGuid}/{thumbnailFileName}`
> and stores it on the `VideoAsset`, so
> `video.thumbnailUrl` becomes non-null in this response and in every later admin
> list/detail read. It never overwrites a thumbnail an operator set, and it now
> writes even when `statusChanged` is `false` — an already-`READY` asset is
> exactly the backfill case. See
> [features/bunny-stream.md](./features/bunny-stream.md) section 4.4.

```jsonc
// GET /admin/videos/:id/bunny/preview
// no request body

// 200
{ "embedUrl": "https://iframe.mediadelivery.net/embed/<library>/<guid>?token=<64 hex>&expires=<unix>&autoplay=false",
  "expires": 1756000000 }
```

> **`autoplay=false` is deliberate.** The Bunny library's Player settings
> default to autoplay, so the embed renders `<video ... autoplay ...>`. Admin
> preview must open paused. It is Bunny's documented per-embed override, is not
> covered by the embed token (which hashes `videoId + expires` only), and
> changes no library setting. The **public** reviewer URL carries the same
> parameter for its own reason — see §3.1.2.

Read-role (`@AdminReadRoles()`). Errors: `400` when Bunny is disabled or
misconfigured, when the video is not Bunny-backed, when the Bunny record is
`bunny-malformed`, or when the video is not `READY`; `404` when the video does
not exist.

> **CONTRACT INVARIANT: the admin console must render this signed URL, never the
> stored `embedUrl`.** The stored value is deliberately unsigned
> (`buildUnsignedEmbedUrl()`), and Bunny rejects it with **403** while the
> library has Embed View Token Authentication enabled. The signed URL is minted
> per request, **never persisted**, and the response never contains
> `BUNNY_STREAM_API_KEY` or `BUNNY_STREAM_TOKEN_SECURITY_KEY` — the token
> security key is only an input to the hash.

> **CONTRACT INVARIANT: it fails closed and signs nothing on refusal.** The
> endpoint is gated on the same strict `classifyBunnyVideoAsset()` predicate as
> public playback, so a `bunny-malformed` record is refused rather than falling
> back to generic embed handling, which would hand out a permanent unsigned
> Bunny URL to an admin surface. Proven by `test/bunny-admin-preview.test.ts`,
> which asserts a signing-spy count of zero on every refusal path.

This is an **admin preview** path and is entirely separate from public watch
resolution: it does not consume a view, does not touch share links, and does not
change §3 in any way.

```
POST /admin/videos/:id/bunny/thumbnail      multipart/form-data, field: thumbnail

// 200
{ "message": "Bunny Stream thumbnail updated.",
  "video": VideoResponse,
  "thumbnailUrl": "https://vz-xxxxxxxx.b-cdn.net/<guid>/thumbnail_ab12cd34.jpg",
  "thumbnailPersisted": true }
```

Write-role. Uploads an operator-chosen image to Bunny's Set Thumbnail endpoint
as `application/octet-stream`, then re-reads `thumbnailFileName` and stores the
built CDN URL on the `VideoAsset`. **This is what removes the manual Bunny
dashboard step.**

Errors: `400` when Bunny is disabled, the video is not Bunny-backed or is
`bunny-malformed`, the video is **not `READY`**, or the image is missing, empty,
too large, of an unsupported type, or its magic bytes contradict its declared
type; `404` when the video does not exist.

> **The video must be `READY` first.** `thumbnailTime` makes Bunny extract its
> own main thumbnail *during* encoding, so an image set earlier can be replaced
> by that extraction. The endpoint refuses a non-`READY` asset rather than
> risking a silently discarded poster.

> **`thumbnailPersisted: false` is a success, not an error.** It means Bunny
> accepted the image but has not exposed a `thumbnailFileName` yet. Nothing is
> written, the video stays `READY`, and the next status sync backfills the URL.
> A file name is never guessed.

> **Binary body only.** Bunny's `thumbnailUrl` query mode is deliberately not
> used — accepting a caller-supplied URL would make this backend an SSRF
> fetcher.

---

## 3. Public site ↔ Backend contracts

Breaking any of these breaks every deployed customer website.

### 3.1 `POST /public/watch/exchange` (preferred) and `GET /public/watch` (legacy)

```jsonc
// POST body            /  GET query
{ "host": "example.com", "token": "<alias or raw share token>" }

// 200 — success
{ "valid": true, "reasonCode": "OK",
  "website": { "id", "name", "slug", "domain" },
  "videos": [ {
     "id", "title", "description", "sourceType",
     "playbackUrl",            // null for DB_BLOB and LOCAL_FILE
     "binaryPlaybackUrl",      // DB_BLOB only
     "publicPlaybackUrl",      // DB_BLOB or LOCAL_FILE
     "binaryAsset"   : { "mimeType", "sizeBytes" } | null,
     "localFileAsset": { "mimeType", "sizeBytes" } | null,
     "embedUrl", "embedProvider", "embedAllow",
     "thumbnailUrl", "publicThumbnailUrl",
     "durationSeconds", "viewCount" /* string */, "publishedAt"
  } ] }

// 200 — denial (never a 4xx). ALWAYS exactly this body:
{ "valid": false,
  "reasonCode": "INVALID_LINK",
  "website": null,
  "videos": [] }
```

> **CONTRACT INVARIANT: denials are `200` with `valid: false`.** The public site
> branches on `valid`, not on HTTP status. Converting these to `4xx` would break
> every deployed site.

> **CONTRACT INVARIANT: the only client-visible reason codes are `OK` and
> `INVALID_LINK`.** `invalidResponse()` in `public.service.ts` accepts a reason
> code, a website and a domain and discards all three (`_reasonCode`,
> `_website`, `_domain`), returning a hard-coded `INVALID_LINK` with a `null`
> website.
>
> `MISSING_HOST`, `MISSING_TOKEN`, `EXPIRED_LINK`, `VIEW_LIMIT_REACHED`,
> `NO_VIDEOS` and `SERVER_ERROR` are **internal / access-log reason codes**.
> They exist in the `PublicWatchReasonCode` union and are written to
> `AccessLog.reasonCode`, but a public client never receives them. Do not build
> client behaviour on them, and do not "restore" them without a deliberate
> decision — the indistinguishability is an anti-enumeration control.

Note that `website` is `null` on **every** denial, including denials where the
website was successfully resolved. A client cannot infer that a domain is
configured from a failed watch.

> **CONTRACT INVARIANT: the public site never constructs media URLs.** It uses
> the `*PlaybackUrl` / `*ThumbnailUrl` fields verbatim (see
> `resolveProtectedPlaybackUrl` in `public_website/assets/app.js`). Adding a new
> stored source type therefore requires a matching URL field here, not client
> logic.

### 3.1.1 Two classes of URL in this response

| `sourceType` | Field(s) populated | URL points at | Backend-mediated |
|---|---|---|---|
| `DB_BLOB` | `binaryPlaybackUrl`, `publicPlaybackUrl` | this API | **Yes** |
| `LOCAL_FILE` | `publicPlaybackUrl`, `publicThumbnailUrl` | this API | **Yes** |
| `DIRECT_URL` | `playbackUrl` | wherever the operator pointed it | **No** |
| `UPLOAD` | `playbackUrl` (Cloudinary `secure_url`) | Cloudinary | **No** |
| `EMBED` | `embedUrl` (+ `embedProvider`, `embedAllow`) | the embed provider | **No** |
| `EMBED` **(Bunny-backed)** | `embedUrl` - a **freshly signed, short-lived** `iframe.mediadelivery.net` URL | Bunny CDN | **No**, but the URL expires |

For the backend-mediated rows, the URL carries the share token and host, and —
when the share link has a `maxViews` limit — a signed `grant`. Clients must pass
the URL through **unchanged**; re-encoding or stripping the query breaks the
grant.

For the non-mediated rows, the field contains the stored external URL verbatim
(`toSafePublicMediaUrl()` only nulls out URLs whose path contains an `admin`
segment). No token, host binding, grant or expiry is added, and no backend
request occurs during playback.

> **No public response field was added for Bunny.** The signed URL is returned
> in the existing `embedUrl` field, so an older deployed public bundle plays a
> Bunny video without modification - provided its embed host allowlist and CSP
> `frame-src` include `iframe.mediadelivery.net`. The URL is minted fresh on
> every watch resolution, including cache hits, so reloading a valid share page
> after the token expired yields a new URL.
>
> **CONTRACT INVARIANT: share-link revocation does not invalidate an
> already-disclosed external URL.** Revoking, expiring or exhausting a share
> link stops future watch resolution; a `DIRECT_URL` / Cloudinary / `EMBED` URL
> that a browser already received keeps working for as long as the provider
> serves it. Do not describe revocation as universal. See
> [SECURITY_MODEL.md §4.1](./SECURITY_MODEL.md#41-backend-served-media-versus-providerdirect-media).

### 3.1.2 The Bunny reviewer URL opens on the poster

Since 2026-08-23 the signed Bunny `embedUrl` returned to the public site carries
Bunny's documented per-embed override:

```
…/embed/<library>/<guid>?token=<64 hex>&expires=<unix>&autoplay=false
```

**Why.** The library's Player setting defaults to autoplay, so the embed renders
`<video ... autoplay ...>` and playback began the instant the iframe loaded —
the reviewer never saw a poster frame. Bunny's own embed already carries the
correct `data-poster`, so suppressing autoplay is what makes it visible. A share
link now opens on a recognisable still frame and plays on one click, which is
the intended reviewer experience.

**What did NOT change.** The parameter is appended *after* the credential pair
and is not part of the embed token (`videoId + expires` only), so it cannot
weaken or invalidate the signature. Authorization, the four-stage signing order
and the atomic view consumption are untouched, and the full release-blocking
share-link compatibility suite passes unchanged.

> Clients must pass `embedUrl` through **verbatim**. Stripping the query — or
> re-adding `autoplay=true` — is not a supported modification.

The public site accepts both endpoints and tries `exchange` first, falling back
to the legacy `GET` (`enableLegacyWatchFallback: true`). Removing the legacy
route would break older deployed bundles.

### 3.2 Media streaming

```
GET|HEAD /public/watch/:token/videos/:videoId/binary?host=<host>[&grant=<grant>]
GET|HEAD /public/watch/:token/videos/:videoId/local-file?host=<host>[&grant=<grant>]
GET|HEAD /public/watch/:token/videos/:videoId/thumbnail?host=<host>[&grant=<grant>]
```

| Status | When | Headers set |
|---|---|---|
| `200` | No `Range` header | `Accept-Ranges`, `Content-Type`, `Content-Length` |
| `206` | Satisfiable single range | the above **plus** `Content-Range: bytes <start>-<end>/<total>` |
| `416` | Unsatisfiable or unparseable range | `Accept-Ranges`, `Content-Type`, `Content-Range: bytes */<total>` — **no `Content-Length`** |

All three also carry the no-store cache family and
`Cross-Origin-Resource-Policy: cross-origin`. Every failure is
`404 "Video not found."`.

**Single range only.** `parseRangeHeader` matches `^bytes=(\d*)-(\d*)$`. A
multi-range request (`bytes=0-99,200-299`), a non-`bytes` unit, or `bytes=-`
does not match and yields `416`. Suffix ranges (`bytes=-500`) and open-ended
ranges (`bytes=500-`) are supported. Multipart/byteranges responses are never
produced.

Delivery differs by source:

- `LOCAL_FILE` — streamed with `fs.createReadStream({ start, end })` piped to the
  response. Memory use is bounded by the stream, not the file size.
- `DB_BLOB` — the requested slice is read into a `Buffer` and sent with
  `response.send()`. **Bounded buffering, not streaming**: the requested range is
  fully materialised in memory first. This is one reason `DB_BLOB` is capped at
  100 MB and disabled in production.

`HEAD` returns the headers without transferring a body.

The thumbnail route serves `LOCAL_FILE` thumbnails only, returns the whole
object, and does not honour Range.

> Authorization for `local-file` and `thumbnail` may be served from a
> process-local cache rather than re-queried per request. See
> [SECURITY_MODEL.md §4.2](./SECURITY_MODEL.md#42-local_file-media-authorization-cache).

### 3.3 `POST /public/watch/:token/videos/:videoId/view`

Body `{ "host": "example.com" }`.

```jsonc
{ "valid": true,  "videoId", "viewCount" /* string */, "publishedAt" }
{ "valid": false, "videoId": null, "viewCount": null, "publishedAt": null }
```

Best effort. The public site calls it at most once per video per page session,
after real playback begins, and never blocks playback on it. Growth is applied
only when `VIDEO_VIEW_GROWTH_ENABLED=true`, and is capped and deduped by
`VideoViewGrowthService`. Range requests must never increment views.

---

## 4. Health

```jsonc
GET /health        → { "status": "ok", "service": "api", "timestamp",
                       "release"?: { "version"?, "commit"?, "builtAt"? } }
GET /health/ready  → the above plus { "checks": { "database": "ok",
                                                  "storage": "ok" | "disabled" } }
```

`release` appears only when `APP_RELEASE_VERSION` / `APP_BUILD_SHA` /
`APP_BUILD_TIME` were injected at build time. `/health/ready` returns `503` when
the database or the configured private storage root is unreachable, and never
discloses the storage path. Both skip throttling.

---

## 5. Changing a contract safely

1. Check the consumer column above.
2. Additive change (new optional field): safe; document it here.
3. Removal or rename: land the client change first, deploy it, then remove the
   server field in a later release.
4. Status-code or shape change on a public route: treat as breaking for **all**
   customer sites; those bundles are deployed independently and may be old.
5. Update this file **in the same pull request**, and mirror the change in
   `../bom-media-admin/docs/API_CONTRACTS.md` and
   `../public_website/docs/API_CONTRACTS.md`.

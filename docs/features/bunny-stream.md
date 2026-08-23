# Feature: Bunny Stream video provider

Status: **CURRENT — MVP**
Last verified: 2026-08-23 (revised after targeted review)
Verified against: `src/bunny/**`, `src/videos/videos.service.ts` (`initBunnyVideoUpload`, `syncBunnyVideoStatus`, `purgeVideo`), `src/videos/videos.controller.ts`, `src/public/public.service.ts` (`resolvePublicEmbedUrl`, `isPublicPlayableVideo`), `src/config/env.validation.ts`, `test/bunny-stream.test.ts`, `test/video-purge.test.ts`
Owner: unassigned

> A previous revision of this document was a **planning artefact** with status
> `PLANNED — NOT IMPLEMENTED`. The MVP described below is now implemented. The
> scope limits in §11 are real limits, not aspirations — read them before
> assuming a capability exists.

## 1. What exists

A Bunny-backed video is an ordinary `VideoAsset` using fields the schema already
had. **No Prisma migration was required.**

| Field | Value for a Bunny asset |
|---|---|
| `provider` | `BUNNY` |
| `sourceType` | `EMBED` |
| `providerAssetId` | the Bunny video GUID |
| `playbackId` | the same GUID |
| `embedProvider` | `GENERIC_IFRAME` |
| `embedUrl` | the **unsigned** `https://iframe.mediadelivery.net/embed/{library}/{guid}` — never served to the public as-is |
| `metadataJson.bunnyStream` | `{ videoId, libraryId, createdAt }` — the marker that makes the record Bunny-backed |
| `status` | `PROCESSING` → `READY` / `FAILED`, driven by Bunny |

### 1.1 Provider isolation and fail-closed classification

`classifyBunnyVideoAsset()` in `src/bunny/bunny-video-asset.util.ts` is the
**only** predicate that decides how a record is treated, and every Bunny branch
is gated on it. It returns exactly one of three outcomes:

| Outcome | When | Public playback |
|---|---|---|
| `bunny` | the **complete** predicate holds | dynamically signed embed URL |
| `bunny-malformed` | `provider = BUNNY` **and** `sourceType = EMBED`, but the predicate fails | **fails closed** - not publicly playable, stored `embedUrl` never emitted |
| `not-bunny` | everything else | unchanged existing behaviour |

The complete predicate requires all five of:

1. `provider === BUNNY`
2. `sourceType === EMBED`
3. a non-empty `providerAssetId` (the Bunny video GUID)
4. `playbackId` equal to it
5. `metadataJson.bunnyStream.videoId` equal to it

That is exactly the shape `initBunnyVideoUpload()` writes, so any deviation is a
hand-edited or tampered record and is treated as malformed.

> **The `bunny-malformed` branch is a security boundary, not a nicety.** Letting
> such a record fall through to generic embed handling would hand out its stored
> **unsigned** `iframe.mediadelivery.net` URL, permanently and outside the
> share-link authorization model.

`readBunnyVideoAsset()` is a convenience wrapper returning the reference only
for `bunny`. It is sufficient for branches where "do nothing" is correct (status
sync, remote purge) but **not** for public playback, which must distinguish
`bunny-malformed` from `not-bunny`.

Consequence: a legacy record merely *labelled* `provider: BUNNY` — those are
`DIRECT_URL` videos with a stored playback URL, creatable through
`POST /admin/videos` - classifies as `not-bunny` and keeps resolving, playing
and purging exactly as it does today. The strict fail-closed rule applies only
to the Bunny EMBED shape.

## 2. Upload flow

```
Admin browser                    bom-media-api                    Bunny
     │  POST /admin/videos/bunny/upload-init { title, … }
     │ ─────────────────────────────▶
     │                                │  POST /library/{id}/videos
     │                                │ ───────────────────────────▶
     │                                │ ◀─────────────── { guid, … }
     │                                │  create VideoAsset (PROCESSING)
     │ ◀──── { video, upload: TUS credentials } ──────
     │
     │  TUS PATCH/POST, bytes only, direct
     │ ───────────────────────────────────────────────────────────▶
     │
     │  POST /admin/videos/:id/bunny/sync   (polled)
     │ ─────────────────────────────▶
     │                                │  GET /library/{id}/videos/{guid}
     │                                │ ───────────────────────────▶
     │                                │  map status → VideoStatus
     │ ◀──── { video, bunnyStatus, encodeProgress } ──
```

**Video bytes never pass through this API.** The backend mints short-lived
credentials and observes state; it does not proxy the upload.

## 3. Configuration

| Variable | Required | Secret |
|---|---|---|
| `BUNNY_STREAM_ENABLED` | no, defaults `false` | no |
| `BUNNY_STREAM_LIBRARY_ID` | only when enabled; must be numeric | no |
| `BUNNY_STREAM_API_KEY` | only when enabled | **yes** |
| `BUNNY_STREAM_TOKEN_SECURITY_KEY` | only when enabled | **yes** |
| `BUNNY_STREAM_TUS_TTL_SECONDS` | no; default 3600, bounded 300–86400 | no |
| `BUNNY_STREAM_EMBED_TOKEN_TTL_SECONDS` | no; default 300, bounded 60–3600 | no |

> **A production deployment that has never heard of Bunny still boots.** Nothing
> is required while `BUNNY_STREAM_ENABLED=false`, which is the default. Proven by
> `test/bunny-stream.test.ts` → "boots a production configuration with no Bunny
> variables at all".

An out-of-range TTL **fails at boot** rather than being silently clamped, which
matches every other bounded value in `env.validation.ts`.

`BUNNY_STREAM_PULL_ZONE_HOSTNAME` remains reserved and **unread** — CDN token
authentication is out of MVP scope (§11). `BUNNY_STREAM_SIGNING_KEY` was a
placeholder that never had a reader; it is superseded by
`BUNNY_STREAM_TOKEN_SECURITY_KEY` and has been removed from the templates.

## 4. The client — `src/bunny/bunny-stream.service.ts`

Five operations, nothing more.

| Method | Bunny call |
|---|---|
| `createVideo(title)` | `POST https://video.bunnycdn.com/library/{libraryId}/videos` |
| `getVideo(videoId)` | `GET .../library/{libraryId}/videos/{videoId}` |
| `deleteVideo(videoId)` | `DELETE .../library/{libraryId}/videos/{videoId}` |
| `createTusUploadCredentials(videoId)` | none — local signing |
| `createSignedEmbedUrl(videoId)` | none — local signing |

Authentication is the `AccessKey: BUNNY_STREAM_API_KEY` header, built at the one
outbound call site. Requests are bounded by a 15-second timeout. Response bodies
are never logged.

> **Feature-disabled isolation.** `createVideo`, `getVideo` and `deleteVideo`
> each call `ensureEnabled()` before reading any configuration, and the single
> outbound `request()` call site calls it again. No Bunny HTTP request can leave
> the process while `BUNNY_STREAM_ENABLED=false`, even if stale credentials are
> still present in the environment.

`canSignEmbedUrl()` is a separate, **non-minting** capability check: it reports
whether a signed embed URL *could* be produced, performing no hashing and
issuing no token. Public watch resolution uses it to decide playability before
the authoritative view consumption, which is what keeps signing strictly after
it (§6).

### 4.1 TUS signing

```
signature = SHA256_HEX(libraryId + apiKey + expirationUnixSeconds + videoId)
endpoint  = https://video.bunnycdn.com/tusupload
```

`createTusUploadCredentials()` returns exactly five fields — `videoId`,
`libraryId`, `expirationTime`, `signature`, `tusEndpoint`. **The API key is an
input to the hash and is never returned.**

### 4.2 Embed signing

```
token = SHA256_HEX(tokenSecurityKey + videoId + expirationUnixSeconds)
url   = https://iframe.mediadelivery.net/embed/{libraryId}/{videoId}
        ?token=<token>&expires=<expirationUnixSeconds>
```

### 4.3 Status mapping

Bunny status codes, verified against
`https://bunny.net/docs/reference/video_getvideo`:

| Bunny `status` | Meaning | Local `VideoStatus` |
|---|---|---|
| 4 | Finished | `READY` |
| 5 | Error | `FAILED` |
| 6 | UploadFailed | `FAILED` |
| 0, 1, 2, 3, 7, 8, unknown, absent | Created / Uploaded / Processing / **Transcoding** / JitSegmenting / JitPlaylistsCreated | `PROCESSING` |

> **3 is Transcoding, not Finished.** A video in state 3 is still encoding. Only
> 4 promotes an asset to `READY`.

Transition rules in `syncBunnyVideoStatus()` are deliberately conservative:

- `DISABLED` is never overwritten — that is an administrator's decision.
- `READY` is never demoted — a published asset must not lose its share links to
  a transient Bunny read.
- `DRAFT`, `PROCESSING` and `FAILED` follow Bunny, so a failed upload that is
  retried can recover to `READY`.

`encodeProgress` is returned for display and **never persisted** — polling must
not write to the database on every tick. No column was added for it.

## 5. Endpoints

| Endpoint | Roles | Purpose |
|---|---|---|
| `POST /admin/videos/bunny/upload-init` | write | Create the Bunny video and the local record; return TUS credentials |
| `POST /admin/videos/:id/bunny/sync` | write | Read Bunny state and map it onto `VideoStatus` |

Both sit on `VideosController`, so they inherit `AdminAccessTokenGuard`,
`AdminRolesGuard` and the `admin` throttle profile unchanged. Both return
`400 "Bunny Stream is not enabled."` when the feature is off.

Full request/response shapes: [../API_CONTRACTS.md](../API_CONTRACTS.md) §2.13.

## 6. Public playback — authorization strictly before signing

> **SECURITY INVARIANT: a signed Bunny embed URL is minted only after the entire
> existing share-link authorization chain has already passed.**

Watch resolution runs in four ordered stages, and signing is the last:

```
1. resolve credential / domain / share link / video candidates
2. every existing authorization check - host normalization -> ACTIVE domain ->
   ACTIVE website -> share link found WITHIN that website -> status / expiry /
   maxViews -> ShareLinkVideo membership -> ACTIVE WebsiteVideo assignment ->
   READY
3. AUTHORITATIVE ATOMIC CONSUMPTION - incrementShareLinkView(), a conditional
   UPDATE that re-verifies status, expiry and maxViews and claims the view in
   one statement
4. ONLY IF 3 claimed a row: toPublicVideoResponses() serializes and signs
```

`selectPublicPlayableVideos()` does the stage-2 filtering and **mints nothing** -
Bunny playability is decided there by `canSignEmbedUrl()`, a pure configuration
check. `resolvePublicEmbedUrl()` is called only from `toPublicVideoResponses()`,
in stage 4. There is no other caller and no other path to a signed URL.

Four properties follow, each covered by a test:

1. **Nothing is signed for a denied request.** The signing spy's call count
   stays at zero for an unknown host, an unknown or missing credential, a
   revoked link, an expired link, an exhausted view budget, a removed website
   assignment, and a non-`READY` video.
2. **Nothing is signed when the consumption itself fails.** A request that
   passes every earlier check but loses the atomic claim - a concurrent revoke,
   expiry or `maxViews` exhaustion - returns `INVALID_LINK` having minted
   nothing. The same holds for a cache hit whose consumption then fails.
3. **Reloading re-signs.** The public watch cache stores raw video rows, not
   serialized responses, so a valid cache hit runs the same four stages and
   mints a **newly signed** URL after its own consumption.
4. **It fails closed.** If Bunny is disabled or misconfigured,
   `isPublicPlayableVideo()` drops the video from the response rather than
   falling back to the stored unsigned URL - and a `bunny-malformed` record is
   dropped whatever the configuration (§1.1).

The public browser receives the signed URL, its token and its expiry. It never
receives `BUNNY_STREAM_API_KEY` or `BUNNY_STREAM_TOKEN_SECURITY_KEY`.

### 6.1 What revocation reaches

A signed embed URL is a **short-lived external URL**, so it sits in the same
category as media grants: revoking the share link stops future watch resolution
immediately, but cannot recall a URL already handed to a browser. The embed
token TTL — 5 minutes by default — bounds that exposure. This is a materially
better position than `DIRECT_URL`, Cloudinary and ordinary `EMBED` URLs, which
never expire at all ([KNOWN_ISSUES.md KI-015](../KNOWN_ISSUES.md#ki-015)), but it
is not instant revocation and must not be described as such.

## 7. Public site

The public site renders a Bunny video through the **existing** allowlisted
iframe path. Three lists had to move together:

| List | Change |
|---|---|
| `public_website/assets/app.js` → `ALLOWED_EMBED_HOSTS` | `iframe.mediadelivery.net` added |
| `public_website/_headers` and `cloudflare-security-headers.txt` → CSP `frame-src` | `https://iframe.mediadelivery.net` added |
| Backend `VIDEO_EMBED_ALLOWED_HOSTS` | **deliberately unchanged** |

> The backend allowlist governs the generic `POST /admin/videos/embed` path,
> where an operator pastes a URL that is then stored permanently. Adding the
> Bunny host there would let an admin store a **permanent unsigned** Bunny embed
> URL, which is exactly what §6 forbids. Bunny embed URLs are constructed
> server-side from a fixed constant instead, so the three-way agreement holds in
> substance: the only Bunny URL the public site can ever be asked to render is
> one this backend signed.

No public response field was added. The signed URL is returned in the existing
`embedUrl` field, so an older deployed bundle keeps working as long as it has the
host in its allowlist and its CSP.

## 8. Admin

`bom-media-admin/src/features/videos/bunnyVideoApi.ts` drives the flow with the
official `tus-js-client` package: init on the backend, upload direct to
`https://video.bunnycdn.com/tusupload` with the four Bunny headers, then poll
`bunny/sync` until Bunny reports a terminal state. Retry delays are
`[0, 3000, 5000, 10000, 20000, 60000]` ms; resumption uses tus-js-client's
standard `findPreviousUploads()` / `resumeFromPreviousUpload()`.

> **The default tus-js-client fingerprint is file-oriented and unsafe here.**
> Two different Bunny videos uploaded from the same local file would share it,
> so `findPreviousUploads()` could offer video A's upload URL while the admin is
> uploading video B - the bytes would land on A while the admin polls B, which
> would sit in `PROCESSING` against the wrong asset. `bunnyTusFingerprint.ts`
> supplies a custom fingerprint binding the Bunny **library id** and **video
> id** as well as the file identity, each component percent-encoded and joined
> with `/`:
>
> ```
> bunny-stream/v1/<libraryId>/<videoId>/<name>/<size>/<type>/<lastModified>
> ```
>
> **Invariant: uploads created for different Bunny `videoId`s can never share a
> resumable TUS fingerprint.** An interrupted upload of the same file to the
> *same* video still resumes. `removeFingerprintOnSuccess: true` stops a
> completed upload from remaining a resumable candidate. No secret is part of a
> fingerprint - fingerprints are persisted in browser storage.
>
> Verified by `yarn smoke:bunny-fingerprint` in `bom-media-admin`.

**No Bunny secret exists in the admin bundle or in any `VITE_*` variable.**

## 9. Delete and purge

Bunny remote deletion is folded into the existing purge flow and inherits every
safeguard: OWNER-only, `confirmVideoId` must match, no canonical share link, the
video must already be `DISABLED`, and it must have no `ACTIVE` website
assignment. Like Cloudinary, it is opt-in through `deleteRemoteAsset: true`.

The Cloudinary and Bunny branches are mutually exclusive and both are gated on
their own provider check, so no other provider can reach either.

> **A failed Bunny delete is reported as a failure.** `deleteVideo()` resolves
> `true` only when Bunny confirmed (a 404 counts — the asset is gone either
> way); anything else propagates. The purge response carries
> `remote.remoteAssetDeleted: false` and the `VIDEO_PURGE_STORAGE` audit row is
> written with `AuditStatus.FAIL`. Purge never claims a remote deletion Bunny
> did not give.

## 10. Failure and orphan handling

Proportional by design; no job system was introduced.

| Failure | Handling |
|---|---|
| Bunny create succeeds, local insert fails | Compensating `deleteVideo()` before rethrowing, plus a `VIDEO_BUNNY_UPLOAD_INIT_ORPHAN` audit row recording whether it worked |
| Local record exists, browser never uploads | The record stays `PROCESSING` and is not publicly playable. **Remaining orphan risk** — see below |
| TUS upload fails | Same as above; the admin can retry, and tus-js-client resumes |
| Bunny encoding fails | Sync maps status 5/6 to `FAILED`; a retry can recover to `READY` |
| Bunny delete fails during purge | Reported truthfully, audited `FAIL` (§9) |
| Purge requests remote deletion while Bunny is **disabled** | No HTTP request is made; `remote.remoteAssetDeleted` stays `false` and the audit row is `FAIL`. The local row is still purged, so the Bunny asset becomes an orphan an operator must remove |
| Bunny unreachable | `503 "Bunny Stream is currently unreachable."`; public playback fails closed |

> **Documented remaining orphan risk.** A Bunny video created by
> `upload-init` whose browser upload never starts leaves a `PROCESSING` local
> record and an empty Bunny asset. Nothing reaps either automatically. There is
> no equivalent of `LOCAL_VIDEO_STALE_UPLOAD_MAX_AGE_HOURS` for Bunny in this
> MVP. Operators can find them by listing videos with `provider=BUNNY` and
> `status=PROCESSING` older than a reasonable window, and purge them normally
> (disable first, then purge with `deleteRemoteAsset: true`).

## 11. Explicit MVP scope limits

Not implemented, and not partially implemented:

- Bunny **webhooks**. Status is polled, not pushed.
- **CDN token authentication** on the pull zone.
- MediaCage **DRM**.
- A custom **HLS player**. Playback is the Bunny iframe.
- **Automatic migration** of existing videos to Bunny.
- Bunny **collections**, analytics, captions, AI transcription.
- **Multi-library** management. One library per deployment.
- Background **queues** for retries or reconciliation.
- Bunny-sourced **thumbnails** (the pull-zone hostname is unread).

## 12. Tests

`test/bunny-stream.test.ts` (50 tests) and the Bunny section of
`test/video-purge.test.ts` (7 tests). The Bunny HTTP boundary is mocked by
replacing `globalThis.fetch`; **no automated test makes a real Bunny request.**

Covered: the disabled path, request construction and the `AccessKey` header, the
TUS signature formula and its expiry bounds, the absence of the API key from the
returned credentials, the embed token formula and its expiry bounds, status
mapping in all three directions, provider isolation across every legacy fixture,
authorization-before-signing across nine denial paths, re-signing on a cache hit,
fail-closed behaviour, Bunny-only remote deletion, honest failure reporting, and
environment validation with and without Bunny values.

These are **not** part of the release-blocking share-link compatibility suite.
Bunny has no legacy production links to keep compatible; what that suite proves
about Bunny is the opposite direction — that adding it changed nothing for the
five existing source types. See
[../SHARE_LINK_COMPATIBILITY_TESTS.md](../SHARE_LINK_COMPATIBILITY_TESTS.md) §8.

## 13. Related documents

- [video-pipeline.md](./video-pipeline.md) — every source type and provider
- [../SECURITY_MODEL.md](../SECURITY_MODEL.md) §4.1 — media exposure classes
- [../API_CONTRACTS.md](../API_CONTRACTS.md) §2.13 — the two endpoints
- [../ENVIRONMENT.md](../ENVIRONMENT.md) §16 — the variables
- [../KNOWN_ISSUES.md](../KNOWN_ISSUES.md#ki-015) — provider URL revocation limits

# Feature: Bunny Stream video provider

Status: **CURRENT — MVP**
Last verified: 2026-08-23 (revised after targeted review)
Verified against: `src/bunny/**`, `src/videos/videos.service.ts` (`initBunnyVideoUpload`, `syncBunnyVideoStatus`, `reconcileMissingBunnyVideo`, `purgeVideo`), `src/videos/videos.controller.ts`, `src/public/public.service.ts` (`resolvePublicEmbedUrl`, `isPublicPlayableVideo`), `src/config/env.validation.ts`, `scripts/operations/reconcile-bunny-videos.ts`, `test/bunny-stream.test.ts`, `test/bunny-remote-missing.test.ts`, `test/video-purge.test.ts`
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
| `thumbnailUrl` | Poster URL **built** from the pull-zone hostname + GUID + Bunny's `thumbnailFileName`, persisted by the first status sync that finds one — see §4.4 |
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
| `BUNNY_STREAM_PULL_ZONE_HOSTNAME` | **only when enabled**; bare CDN hostname `vz-xxxxxxxx.b-cdn.net` | no |

> **A production deployment that has never heard of Bunny still boots.** Nothing
> is required while `BUNNY_STREAM_ENABLED=false`, which is the default. Proven by
> `test/bunny-stream.test.ts` → "boots a production configuration with no Bunny
> variables at all".

An out-of-range TTL **fails at boot** rather than being silently clamped, which
matches every other bounded value in `env.validation.ts`.

`BUNNY_STREAM_PULL_ZONE_HOSTNAME` is **now read** (2026-08-23): it is the Stream
CDN hostname thumbnail delivery is built from (§4.4). Hostname only — no scheme,
port, path, query or trailing slash — validated at boot by
`isBunnyPullZoneHostname()`. It is **not a secret**. It remains *unrelated* to
CDN token authentication, which is still out of MVP scope (§11).
`BUNNY_STREAM_SIGNING_KEY` was a placeholder that never had a reader; it is
superseded by `BUNNY_STREAM_TOKEN_SECURITY_KEY` and has been removed from the
templates.

## 4. The client — `src/bunny/bunny-stream.service.ts`

Seven operations, nothing more.

| Method | Bunny call |
|---|---|
| `createVideo(title)` | `POST https://video.bunnycdn.com/library/{libraryId}/videos` |
| `getVideo(videoId)` | `GET .../library/{libraryId}/videos/{videoId}` |
| `deleteVideo(videoId)` | `DELETE .../library/{libraryId}/videos/{videoId}` |
| `createTusUploadCredentials(videoId)` | none — local signing |
| `createSignedEmbedUrl(videoId)` | none — local signing |
| `buildThumbnailUrl(videoId, thumbnailFileName)` | none — local construction from the configured pull-zone hostname |
| `setVideoThumbnail(videoId, bytes)` | `POST .../library/{libraryId}/videos/{videoId}/thumbnail` |

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

### 4.2.1 What the embed token is, and what is NOT verified about it

Recorded because an incorrect inference here would be a security change made on
no evidence.

**Proven from source, in this repository:**

| Fact | Where |
|---|---|
| The token is `SHA256_HEX(BUNNY_STREAM_TOKEN_SECURITY_KEY + videoId + expires)`, hex-encoded | `createSignedEmbedUrl()` |
| The key is read only through `ConfigService`, is never returned, logged or placed in an exception | `BunnyStreamService` |
| The TTL is `BUNNY_STREAM_EMBED_TOKEN_TTL_SECONDS`, default **300 s**, bounded 60–3600, out of range fails at boot | `bunny-stream.constants.ts`, `env.validation.ts` |
| Player parameters are appended **after** the credential pair and are not part of the hash | `createSignedEmbedUrl()` |
| The stored `embedUrl` is the **unsigned** base URL and is never returned to a public client | §1, §6 |
| The URL is minted per request and never persisted | §5.1, §6 |

**What the repository ASSUMES about the Bunny dashboard:** that the library has
**Embed View Token Authentication enabled**. §5.1 records the symptom that led to
that belief — the unsigned stored URL rendered a Bunny **403** in the admin
iframe, which is why the admin preview endpoint exists at all.

> **DASHBOARD VERIFICATION REQUIRED.** Nothing in this repository can confirm the
> library's current setting, and it has **not** been verified as part of this
> change.

**An observation that must NOT be turned into a conclusion.** It has been
reported that a request with no token, an expired token and a junk token all
return the same iframe **HTML** with HTTP 200. That does **not** establish that
token authentication is off:

- The iframe document is the player shell. Bunny may enforce the token on the
  **subsequent** playlist / media / license requests the player then makes, not
  on the shell itself.
- A 200 on the shell is consistent with both configurations, so it discriminates
  nothing.

To settle it, inspect the network trace **after** the iframe loads — the
`.m3u8` playlist and the segment requests — for a signed and an unsigned URL,
and read the library's Embed View Token Authentication setting in the dashboard.
Until both are done, treat the enforcement point as unknown.

**The 300-second TTL was reviewed and deliberately left unchanged.** Raising it
would only be justified once the enforcement point above is known: if Bunny
validates `expires` on the iframe request alone, a short TTL bounds nothing after
the player has loaded and a longer one would weaken §6.1 for no benefit; if it is
validated on later media requests, a short TTL is doing real work and raising it
would directly extend post-revocation exposure. Changing it on the current
evidence would be guessing in the less safe direction.

> **Nothing in this change modified signing.** No formula, key, TTL or ordering
> was touched. The poster proxy in §4.6 is a different mechanism against a
> different Bunny product (the pull zone, not the Stream library) and shares no
> key with it.

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

### 4.5 Two poster paths — no Bunny dashboard step

Every Bunny video gets a poster automatically. There are exactly two routes to
one, and **neither requires opening the Bunny dashboard**.

```
CUSTOM  (operator picked an image in the create form)
   upload-init  ──▶ TUS bytes ──▶ Bunny encodes ──▶ READY
                                                     │
                            POST /admin/videos/:id/bunny/thumbnail
                                                     │
                       Bunny Set Thumbnail (octet-stream body)
                                                     │
                            GET Video → thumbnailFileName
                                                     │
                     buildThumbnailUrl() → VideoAsset.thumbnailUrl

AUTO    (no image picked)
   upload-init sends thumbnailTime ──▶ Bunny extracts a frame during encoding
                                                     │
                            sync → GET Video → thumbnailFileName
                                                     │
                     buildThumbnailUrl() → VideoAsset.thumbnailUrl
```

Both paths converge on the same field, so **no separate thumbnail storage
exists for Bunny**: nothing is written to `LOCAL_FILE_STORAGE_ROOT`, nothing
goes to Cloudinary, and the image is never persisted by this backend. The
uploaded bytes are held in memory only long enough to forward them.

#### Ordering: why the custom image is applied only at READY

`thumbnailTime` is documented as "video time in ms to extract the main video
thumbnail" — that is, **Bunny writes the main thumbnail itself during
encoding**. An image uploaded while the video is still `PROCESSING` is therefore
at risk of being replaced by that extraction.

No Bunny documentation states that a mid-processing Set Thumbnail survives
encoding, so the conservative order is the implemented one:

> **TUS → wait for READY → Set Thumbnail → re-read metadata.**

`setBunnyVideoThumbnail()` enforces it: a non-`READY` asset is refused with
`400` before any Bunny call. If Bunny later documents mid-processing stability
this can be relaxed, but not on an assumption.

#### The file name always comes from Bunny

Bunny's Set Thumbnail response carries no file name, so the service re-reads
`getVideo()` and uses the `thumbnailFileName` it reports. A custom upload
commonly lands under a generated name — a real library returned
`thumbnail_60a6c476.jpg` for one and `thumbnail_ba67a0b0.jpg` for another — so
**`thumbnail.jpg` is never assumed**.

If Bunny has not exposed a name yet, the endpoint returns
`thumbnailPersisted: false`, writes nothing, and leaves the normal status sync
to backfill it. The video is never marked `FAILED` for a thumbnail problem.

#### Validation and the SSRF boundary

The image is accepted only as `image/jpeg`, `image/png`, `image/gif` or
`image/webp`, is bounded by the project's existing thumbnail size limit, and is
checked against its **magic bytes** as well as its declared type. SVG is
excluded deliberately.

> **Binary upload only.** Bunny's Set Thumbnail also accepts a `thumbnailUrl`
> query parameter, which this integration never uses: it would require the image
> to be publicly hosted first, and accepting a caller-supplied URL would turn
> this backend into an SSRF fetcher.

#### READY without a poster

Bunny can report `READY` a moment before a thumbnail is addressable. The admin
upload flow therefore keeps syncing for a small **bounded** number of extra
attempts while `thumbnailUrl` is still empty, then stops and shows the video as
READY regardless. It never polls forever, never demotes `READY`, and no database
column was added for this transient state.

### 4.4 Thumbnail (poster) persistence

Bunny only produces a thumbnail once encoding has run, so the record written by
`initBunnyVideoUpload()` has none and `VideoAsset.thumbnailUrl` starts `NULL`.
Status sync is the point where authoritative Bunny metadata is already in hand,
so the poster is stored there rather than re-fetched from Bunny on every page
load.

Bunny's Get Video response carries **`thumbnailFileName`** — a file name such
as `thumbnail.jpg` or `thumbnail_ba67a0b0.jpg`. Bunny's documented storage
structure defines delivery as:

```
https://{pull_zone_hostname}/{videoId}/{thumbnailFileName}
```

so the backend **builds** the URL from three inputs: the configured hostname,
the video GUID and that file name.

> **`BUNNY_STREAM_PULL_ZONE_HOSTNAME` is therefore REQUIRED when Bunny is
> enabled** (§3). It is the Stream CDN hostname of the library's pull zone —
> `vz-xxxxxxxx.b-cdn.net`, hostname only, no scheme or trailing slash — and is
> **not a secret**: it is the public host in every thumbnail URL a browser
> loads. Boot fails fast when it is missing or malformed, rather than silently
> serving videos with no poster.

> **The file name must come from Bunny, never from a default.** A real library
> returns `thumbnail_ba67a0b0.jpg` for some videos and `thumbnail.jpg` for
> others, so hard-coding `thumbnail.jpg` would produce a 404 for the first kind.
> `buildThumbnailUrl()` returns `null` rather than guessing.

Rules the implementation follows:

- Both path components are validated against a strict allowlist
  (`bunny-thumbnail.util.ts`) before use, so a traversal (`../secret`), a nested
  path (`foo/bar.jpg`, `fooar.jpg`), a scheme, a query or a fragment can never
  reach the URL. Percent-encoding is a second layer. This is the boundary where
  a provider string becomes an `<img src>`, so it is not trusted on Bunny's
  say-so.
- It is written **only when the local value is empty**, so a thumbnail an
  operator set is never overwritten by a later sync.
- A sync now writes even when the status did not change, because an
  already-`READY` asset is exactly the case that needs backfilling.
- It is a **poster URL, never a playback credential** — no `token`/`expires` is
  ever stored.
- When Bunny has no thumbnail yet (`thumbnailFileName` is null while encoding),
  or no hostname is configured, the column stays `NULL` and both clients fall
  back to their existing placeholder. A missing poster never breaks a page and
  never demotes the status.
- **One Bunny request.** The file name comes from the same Get Video call the
  status sync already makes; no extra endpoint (such as `/videos/{id}/play`) is
  consulted.

The public watch response returns a poster URL for every Bunny video. **Which**
URL it returns changed on 2026-08-28 — see §4.6, which supersedes the claim that
this works with no public-site change.

### 4.6 Reviewer-facing poster delivery: the backend proxy

> **CORRECTION (2026-08-28).** §4.4 previously ended "Because the public watch
> response already returns the stored `thumbnailUrl`, the reviewer-facing poster
> works with **no public-site change at all**." That was true of the *field*, and
> false of the *outcome*. In production every reviewer poster returned **403**.

#### The production failure

Two correct decisions met:

- The pull zone protects its assets with **hotlink protection**: it serves a
  request only when the `Referer` names an allowed site.
- The reviewer-facing site sends `Referrer-Policy: no-referrer` on every
  response — a deliberate, documented privacy property.

So the browser sent no `Referer`, Bunny saw an empty referrer, and refused.

> **MEASURED, not inferred**, against the live zone by `Worldfold_Studio`
> (`verify-poster-referrer.mjs`), same URL, nothing else changed:
>
> | Request | Result |
> |---|---|
> | no `Referer` | **403** |
> | `Referer: <the site's origin>` | **200** |
> | **UNSIGNED** URL with a valid `Referer` | **200** |
>
> The third row is the load-bearing one: it rules out CDN Token Authentication
> on that zone. A zone requiring a token could not serve an unsigned URL. Signing
> thumbnails server-side would therefore have fixed nothing.
>
> These measurements were taken in the sibling repository and are recorded here
> as evidence, not re-verified from this workspace. See §11 for what still
> requires dashboard verification.

#### The architecture

```
reviewer browser
   │  GET /public/watch/<token>/videos/<id>/thumbnail?host=…[&grant=…]
   ▼
bom-media-api
   │  full public authorization chain, then three provider gates
   │  GET https://<pull-zone>/<bunnyVideoId>/<fileName>
   ▼  under an EXPLICITLY CONFIGURED upstream auth mode
Bunny pull zone
```

The reviewer's browser no longer requests a Bunny URL at all for the poster.
That is the fix at the architecture level rather than at either endpoint:
poster delivery stops depending on browser referrer policy, Bunny stops
receiving the reviewer's IP address for the poster, the raw pull-zone URL stops
being the public contract, and revoking the share link stops the next poster
request.

> **The route did not change.** It is still
> `GET|HEAD /public/watch/:token/videos/:videoId/thumbnail?host=…[&grant=…]`,
> which already existed for `LOCAL_FILE`. A second route would have meant a
> second copy of the authorization chain, and two copies drift.
> `PublicService.loadAuthorizedPublicMediaVideo()` is now the one
> provider-independent chain; `LOCAL_FILE` and Bunny are narrowings of it, each
> with its own provider-specific gate. `LOCAL_FILE` behaviour is byte-identical.

#### The upstream authorization mode — the point of the whole thing

> **A proxy that simply moves the same 403 from the browser to the API server is
> NOT a fix.** Whatever the pull zone enforces, the backend's own request must
> satisfy it — so the mode is configuration, never a guess.

| `BUNNY_PUBLIC_THUMBNAIL_UPSTREAM_AUTH_MODE` | Behaviour |
|---|---|
| `none` (default) | Send nothing extra. Correct when the zone is open, or is restricted by something the backend already satisfies (an IP allowlist, for instance) |
| `referer` | Send `BUNNY_PUBLIC_THUMBNAIL_UPSTREAM_REFERER` on this one request. For a zone using Bunny's **Allowed Referrers** |

`referer` mode is an operational **compatibility** mechanism, and this document
does not dress it up as more. Hotlink protection is not strong authorization: a
`Referer` header is trivially forgeable by anything that is not a browser. What
it does is make the backend's request indistinguishable, to the zone, from the
browser request that worked before — which is exactly the problem being solved.

The value comes from validated configuration and **never** from the incoming
request. Echoing a client-supplied `Referer` would let a caller choose what the
CDN sees, which is not a mechanism. A `referer` mode with no usable value
**fails closed**: no request is made and the poster returns the generic 404,
rather than silently downgrading to `none` and producing a 403 that reads like a
Bunny fault. Boot fails too, so the mistake surfaces at deploy time.

> **CDN Token Authentication is still NOT implemented** (§11), and
> `BUNNY_STREAM_TOKEN_SECURITY_KEY` **must never be used for it**. That key
> signs Stream **embed view tokens**. A pull zone's CDN token security is a
> separate mechanism with a separate key, and reusing the embed key would
> produce signatures the CDN rejects while looking, in code, exactly like
> working security. Adding it later means a new mode, a new environment
> variable, and dashboard verification that the zone actually enforces it.

#### The three gates

1. **Authoritative Bunny identity.** `classifyBunnyVideoAsset()` — the same
   strict predicate playback signing uses — plus the absence of
   `metadataJson.bunnyStream.remoteMissing`. A `bunny-malformed` record fails
   closed and never falls through to its stored URL. Read from the **current**
   database row rather than the metadata cache, for the same reason
   `loadSignableBunnyVideoIds()` exists (§9.3): a process-local cache cannot be
   invalidated by reconciliation running elsewhere.
2. **URL validation and reconstruction.** The stored `thumbnailUrl` is parsed,
   every component is checked against the proven identity, and the upstream URL
   is rebuilt from it. Full table in
   [../SECURITY_MODEL.md §9.1](../SECURITY_MODEL.md#91-the-bunny-poster-proxy-is-not-a-general-fetcher).
3. **Upstream response validation.** No redirect is followed, the status must be
   `2xx`, the `Content-Type` must be an allowed raster image type (**never
   `image/svg+xml`**), and the body is capped in bytes rather than only by
   `Content-Length`.

#### What it does not do

- **Views are never incremented**, on GET or HEAD. `maxViews` is enforced by the
  existing signed `grant`.
- **No Bunny Management API request** is added anywhere. `thumbnailFileName` is
  not separately persisted, and recovering it with a per-view `getVideo()` would
  trade an SSRF question for a latency and rate-limit problem. It is recovered
  from the stored URL under validation instead.
- **No image buffer is cached.** The response is streamed, and nothing is
  written to `MemoryCacheService`.
- **The Bunny player iframe is unchanged.** It still loads directly from Bunny
  once the reviewer starts playback, so §6.1 is unaffected. Only the poster
  moved.
- **An operator-set poster on another host is passed through unchanged.** Sync
  only ever fills an *empty* `thumbnailUrl` and never overwrites one, so such a
  value was a deliberate choice and is not the proxy's business.

#### GET and HEAD, exactly

| Concern | Behaviour |
|---|---|
| Upstream verb | **Always GET**, never an upstream HEAD. Bunny CDN's HEAD behaviour is not verified from this workspace, and a HEAD some edge answers differently would make the two verbs disagree. One request shape, always |
| Client `HEAD` | The stream is **pull-based**, so a HEAD — which destroys it without reading — transfers essentially no body, and the upstream socket is released on `close` |
| `Content-Type` | Normalised to the **validated** media type: lower-cased, parameters stripped. Never relayed verbatim |
| `Content-Length` | Emitted only when upstream sent one, and identical on GET and HEAD (HEAD reports what a GET would return). Absent upstream ⇒ header omitted, never guessed |
| `Cache-Control` | `setNoStoreHeaders()` runs first: the full `no-store` family plus `X-Content-Type-Options: nosniff` and `Cross-Origin-Resource-Policy: cross-origin`. No upstream caching header is forwarded |
| Size cap | Enforced on the **transferred bytes**, not only `Content-Length`, so an omitted or dishonest header cannot become an unbounded transfer |
| Timeout / abort | `AbortSignal.timeout()`, bounded 1000–15000 ms |
| Redirects | `redirect: "manual"`; any `3xx` is refused outright and its body drained |
| Rejected responses | Body explicitly `cancel()`ed, so a refusal never leaks a socket |

> **Two stream-lifecycle defects were found and fixed in final review**, both in
> code added by this change:
>
> - An upstream failure arriving **before** the controller attached `pipeline()`
>   emitted `'error'` on a `Readable` with no listener, which terminates the
>   Node process — on an unauthenticated public route. The proxy now claims
>   `'error'` on the upstream stream immediately; the consumer still receives it,
>   because Node's async iterator rejects on `stream.errored` rather than on the
>   listener list.
> - A client `HEAD` destroys the stream without reading, so the generator never
>   started and nothing destroyed the upstream — the connection stayed open until
>   the CDN or the fetch timeout gave up. The socket is now released on `close`,
>   which covers a normal end and a destroy alike.
>
> Both are pinned by `test/public-bunny-thumbnail.test.ts` and each was confirmed
> to fail when its fix is removed.

#### Client URL-resolution compatibility — VERIFIED, not assumed

The route is returned as a **relative** `/api/v1/public/watch/.../thumbnail?host=…`
URL. Both shipped clients strip the version prefix and re-base onto the API
origin; neither treats it as a same-origin website path. Read from source on
2026-08-28:

| Client | Function | Transform |
|---|---|---|
| `Worldfold_Studio/private-watch.js` | `resolveMediaUrl()` | `raw.replace(/^\/_api(?=\/|$)/,"").replace(/^\/api\/v1(?=\/|$)/,"")` then `` `${resolveApiBase()}${path}` `` |
| `public_website/assets/app.js` | `buildApiResourceUrl()` | `/^\/api\/v1\/public(?:\/|$)/` → `buildApiUrl(stripApiVersionPrefix(raw))` |

`resolveApiBase()` / `API_CONFIG.baseUrl` are `/_api` in production (the
documented proxy path, KI-001) and `http://localhost:3000/api/v1` on a local
Worldfold host. Executed against the real transform:

```
/api/v1/public/watch/TOK/videos/VID/thumbnail?host=example.com&grant=g
  → production : /_api/public/watch/TOK/videos/VID/thumbnail?host=example.com&grant=g
  → local dev  : http://localhost:3000/api/v1/public/watch/TOK/videos/VID/thumbnail?host=example.com&grant=g
```

The **query string survives** in both, which matters: `host` is required by the
route and `grant` carries the `maxViews` authorization.

Which field each client reads:

| Client | Thumbnail fields, in order | Playback fields |
|---|---|---|
| Worldfold | `publicThumbnailUrl`, `thumbnailUrl` (`LEGACY_THUMBNAIL_FIELDS`) | `publicPlaybackUrl`, `binaryPlaybackUrl`, `playbackUrl` |
| `public_website` | `localThumbnailUrl`, `publicLocalThumbnailUrl`, `thumbnailProxyUrl`, `publicThumbnailUrl`, … `thumbnailUrl` | `publicPlaybackUrl`, … |

Populating **both** `thumbnailUrl` and `publicThumbnailUrl` is therefore what
makes an already-deployed bundle of either client pick the protected URL up with
no change of its own.

> **Two client-side filters the emitted URL must satisfy, and does.** Worldfold's
> `apiOwnedThumbnail()` DROPS an absolute off-origin URL — so the value must stay
> relative, which is why the backend does not emit an absolute one. And
> `public_website`'s `isForbiddenMediaUrl()` rejects any path containing an
> `admin` segment; this route contains none.
>
> **No client change is required, and none was made.** The backend half of this
> contract is pinned by `test/public-bunny-thumbnail.test.ts` → "emits a relative
> /api/v1/public URL both shipped clients re-base"; the client halves live in
> repositories this one must not edit.

#### Verifying the upstream leg before enabling it

Unit tests mock `globalThis.fetch`, deliberately, so **no CI test ever reaches
Bunny**. That leaves one question they cannot answer: does the pull zone serve a
poster to THIS server, with THIS deployment's configuration? A proxy that merely
moves the browser's 403 onto the API host is not a fix, so prove it first:

```bash
yarn diagnose:bunny-thumbnail --config-only
```

```bash
yarn diagnose:bunny-thumbnail --bunny-video-id <guid> --file-name <thumbnail_xxxx.jpg>
```

Read-only: one outbound GET, to a URL built by the **same validator** the
production path uses. No database, no share link, no credential minted, nothing
written. It never reads — let alone prints — `BUNNY_STREAM_API_KEY` or
`BUNNY_STREAM_TOKEN_SECURITY_KEY`, and it prints only the *origin* of the
configured Referer. It reports the status, `Content-Type` and `Content-Length`,
and a PASS/FAIL verdict; a 401/403 tells the operator to switch to `referer`
mode rather than to enable the proxy and hope.

The video id and file name come from an admin video detail page:
`providerAssetId`, and the last path segment of `thumbnailUrl`.

#### Configuration and rollout

| Variable | Default | Notes |
|---|---|---|
| `BUNNY_PUBLIC_THUMBNAIL_PROXY_ENABLED` | `false` | Master switch. While false the public response is byte-identical to before this feature existed |
| `BUNNY_PUBLIC_THUMBNAIL_UPSTREAM_AUTH_MODE` | `none` | `none` or `referer`. Any other value fails at boot |
| `BUNNY_PUBLIC_THUMBNAIL_UPSTREAM_REFERER` | unset | **Required** when the proxy is enabled in `referer` mode. Absolute `https` URL, no embedded credentials. Not a secret |
| `BUNNY_PUBLIC_THUMBNAIL_MAX_BYTES` | `5242880` | Bounded 65536 – 20971520; out of range fails at boot |
| `BUNNY_PUBLIC_THUMBNAIL_TIMEOUT_MS` | `5000` | Bounded 1000 – 15000; out of range fails at boot |

Enabling it is a deliberate two-part decision — turn the proxy on **and** pick
the mode that matches the zone. Turning it on with the wrong mode produces the
generic 404 rather than a broken image, and the reason is in the API log.

## 5. Endpoints

| Endpoint | Roles | Purpose |
|---|---|---|
| `POST /admin/videos/bunny/upload-init` | write | Create the Bunny video and the local record; return TUS credentials |
| `POST /admin/videos/:id/bunny/sync` | write | Read Bunny state and map it onto `VideoStatus` |
| `GET /admin/videos/:id/bunny/preview` | read | Mint a short-lived **signed** embed URL for admin preview |
| `POST /admin/videos/:id/bunny/thumbnail` | write | Upload a **custom** poster to Bunny and persist the resulting CDN URL |

All four sit on `VideosController`, so they inherit `AdminAccessTokenGuard`,
`AdminRolesGuard` and the `admin` throttle profile unchanged. All four return
`400 "Bunny Stream is not enabled."` when the feature is off.

### 5.1 Why admin preview needs its own signing endpoint

The stored `embedUrl` is the **unsigned** base URL (§1). With Embed View Token
Authentication enabled on the library, rendering it in the admin iframe returned
a Bunny **403** — the admin console has no way to sign, because
`BUNNY_STREAM_TOKEN_SECURITY_KEY` is backend-only and must stay that way.

`getBunnyVideoPreview()` therefore does for the admin what
`resolvePublicEmbedUrl()` does for the public site, minus the share-link chain
that does not apply to an authenticated admin:

```
admin guards (AdminAccessTokenGuard -> AdminRolesGuard, read roles)
  -> ensureEnabled()
  -> load the VideoAsset
  -> classifyBunnyVideoAsset()          bunny-malformed -> 400, not-bunny -> 400
  -> require status READY                                            else -> 400
  -> canSignEmbedUrl()   (pure config check, mints nothing)          else -> 400
  -> createSignedEmbedUrl()             the ONLY place a token is minted
  -> return { embedUrl, expires }       never persisted
```

> **The same fail-closed rule as public playback applies.** A
> `bunny-malformed` record is refused outright rather than falling through to
> its stored unsigned URL. Authentication and authorization both happen before
> any signing, and every refusal path signs nothing —
> `test/bunny-admin-preview.test.ts` asserts a signing-spy count of zero on each.

The admin client (`bunnyVideoApi.getBunnyVideoPreview`) fetches a fresh URL on
every detail-page mount and on video-id change. No refresh scheduler exists: the
TTL bounds an already-loaded iframe, not the fetch. The client must not fall back
to the stored `embedUrl` on failure.

### 5.2 Admin preview opens PAUSED

The Bunny library's Player settings default to autoplay, so the embed page
renders `<video ... autoplay ...>` and the browser begins playing as soon as the
admin iframe loads. That is correct for a reviewer and wrong for an admin
reviewing a catalogue.

The admin preview URL therefore carries Bunny's documented per-embed override:

```
…/embed/<library>/<guid>?token=<64 hex>&expires=<unix>&autoplay=false
```

- **Scoped to the URL.** The Bunny library Player setting is unchanged, so
  reviewer playback is unaffected.
- **Cannot break the signature.** The embed token hashes `videoId + expires`
  only, so appending a player parameter cannot invalidate it. Verified against
  the live library: the same signed URL returns the full player with and without
  the parameter, and never a 403.
- **Public does the same, for a different reason.** Since 2026-08-23 the public
  reviewer URL also carries `autoplay=false` — see §6.2. Both call sites now
  open on the poster. The no-parameter overload is still pinned by
  `test/bunny-stream.test.ts` for any future caller that wants library defaults.

Bunny documents `autoplay`, `loop`, `muted`, `preload` and `responsive` as
per-embed parameters that override the library defaults. Only `autoplay` is used.

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

### 6.2 The reviewer URL opens on the poster

The public signed URL also carries `autoplay=false` (added 2026-08-23). Same
mechanism as §5.2, different motivation: the library default started playback
the moment the iframe loaded, so a reviewer never saw a poster frame. Bunny's
embed already carries the right `data-poster`; suppressing autoplay is what
reveals it.

This is a **player** parameter, not an authorization one. It is appended after
the credential pair, is not part of the embed token, and changes nothing about
the four-stage order in §6 — signing still happens only after the atomic view
consumption. The release-blocking share-link compatibility suite passes
unchanged, and `public_website` required no modification.

> Note for anyone chasing a "missing thumbnail" report: a share link containing
> a **single** video renders straight into the Bunny iframe
> (`is-single-video-access`) with no separate thumbnail element. Before this
> change the poster was therefore never visible on that view, even though
> `thumbnailUrl` was populated and correct.

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

## 9. Deletion lifecycle — the three states

There are exactly three ways a Bunny video stops being available, and they mean
different things. Conflating them is what produced both failure modes this
section exists to prevent: publicly playable records pointing at videos that no
longer exist, and invisible billable Bunny orphans no record points at.

| Operation | CMS record | Bunny asset |
|---|---|---|
| **DISABLE** | `DISABLED`, row kept | **retained** |
| **PURGE + delete remote** | purged, row gone | **deleted** (or confirmed already absent) |
| **MANUAL BUNNY DELETE** | `FAILED` + `remoteMissing`, row **kept** | already gone |

### 9.1 DISABLE — local administrative state only

`DELETE /admin/videos/:id` sets `VideoStatus.DISABLED` and disables the video's
`ACTIVE` share links, exactly as it does for every other provider.

> **Disable NEVER touches Bunny.** No Bunny request is issued, and the remote
> video keeps existing and keeps costing storage. It is a reversible
> administrative decision, and reconciliation deliberately preserves it: a
> `DISABLED` asset stays `DISABLED` even when Bunny reports the video missing,
> because an administrator's decision outranks a provider observation.

> **And the reversal is real (2026-08-24).** Restoring the video to `READY`
> re-activates the share links that disable had swept to `DISABLED`, so a
> temporarily-disabled Bunny video does not lose its reviewer links. Restore
> issues **no** Bunny request either, creates **no** new Bunny video, and
> — critically — does **not** clear a confirmed
> `metadataJson.bunnyStream.remoteMissing` marker. A remote-missing asset that
> an operator pushes back to `READY` therefore still mints nothing, because the
> authoritative database signing gate in §9.3 checks the marker independently of
> status. Pinned by `test/video-lifecycle-disable-restore.test.ts`
> (`BUNNY-RESTORE-01` … `04`).

### 9.2 PURGE with remote deletion — REMOTE FIRST

Bunny remote deletion is folded into the existing purge flow and inherits every
safeguard: OWNER-only, `confirmVideoId` must match, no canonical share link, the
video must already be `DISABLED`, and it must have no `ACTIVE` website
assignment.

**The ordering changed on 2026-08-23, and the ordering is the whole point.**

```
STEP 1  VALIDATE, mutating nothing
          record exists · status DISABLED · no canonical share link
          · no ACTIVE WebsiteVideo assignment · OWNER role
          (prepareBunnyRemoteDelete)

STEP 2  DELETE /library/{libraryId}/videos/{videoId}

STEP 3  INTERPRET
          2xx / 204        -> confirmed
          404              -> confirmed (already absent)
          timeout / network / 429 / 5xx / auth failure
                           -> NOT confirmed -> ABORT, local row untouched,
                              retriable 503 returned
          (deleteBunnyRemoteAssetOrThrow)

STEP 4  Only now: the existing local purge transaction
          disable share links · detach ShareLinkVideo · delete VideoAsset
          · audit VIDEO_PURGE_COMMIT
```

> **Why remote first.** The two possible partial-failure states are not equally
> bad:
>
> | Failure state | Consequence |
> |---|---|
> | remote gone + local row still present | **Preferred.** Visible in the CMS, reconcilable, retriable |
> | local row gone + remote still present | **Avoided.** An invisible, billable Bunny orphan that no future purge can find |
>
> Deleting the local row first produces the second state whenever Bunny is
> unreachable. That is precisely what used to happen, because the old flow
> deleted the row inside a transaction and only then attempted a best-effort
> Bunny delete.

**Step 1 is not redundant with the transaction.** The transaction re-checks the
same preconditions and is what actually enforces them against a concurrent
change. Step 1 exists so a video the purge was always going to reject does not
get its Bunny asset deleted first.

**Cloudinary is deliberately unchanged.** It keeps its existing post-transaction
best-effort deletion. The two branches are mutually exclusive and each is gated
on its own provider check.

#### Local transaction failure after a confirmed remote delete

Handled explicitly, and reported honestly:

- The request **fails**. It never claims a successful purge.
- The local row **remains**, so the operator can see and retry it.
- The retry works, because Bunny answers 404 and step 3 counts that as
  confirmed.
- The row can also be reconciled to `remoteMissing` by a sync or by
  `yarn reconcile:bunny`.
- The Bunny video is **never** recreated.

#### `deleteRemoteAsset` and the Admin default

The API contract is unchanged: `deleteRemoteAsset` is still an explicit optional
boolean defaulting to `false`, so no existing caller breaks.

> **What changed is the Admin default.** The purge dialog previously showed the
> remote-deletion checkbox **only for Cloudinary**, so a Bunny purge silently
> sent `deleteRemoteAsset: false` and orphaned the Bunny video every time. Bunny
> assets now get their own checkbox, **defaulted ON**, labelled "Đồng thời xóa
> vĩnh viễn khỏi Bunny Stream".

Unticking it is still supported — the backend contract requires it — but the UI
now states the consequence plainly: the CMS record is deleted and the Bunny
video is retained. That is an advanced, orphan-producing action and is not the
normal path.

### 9.3 MANUAL BUNNY DELETE — reconciliation, not deletion

Someone deletes the video in the Bunny dashboard. Bunny then answers **404** for
that video id.

```
GET /library/{libraryId}/videos/{videoId}  ->  404
        |
        v
local row PRESERVED          <- never deleted on the strength of one response
metadataJson.bunnyStream.remoteMissing = { detectedAt, reason: "NOT_FOUND" }
status -> FAILED             <- unless already DISABLED, which is kept
caches invalidated           <- admin:videos: · media:metadata: · public:watch:
audit VIDEO_BUNNY_REMOTE_MISSING (AuditStatus.FAIL)
```

`syncBunnyVideoStatus()` returns a structured result rather than a generic 500:

```jsonc
{ "message": "Bunny Stream reports this video no longer exists. …",
  "video": VideoResponse,
  "bunnyStatus": null,
  "encodeProgress": null,
  "statusChanged": true,
  "remoteMissing": true }
```

> **The local row is NEVER deleted automatically.** A 404 is an observation that
> the remote asset is gone, not a mandate to destroy local history, provenance
> and audit trail — and deleting it would remove the operator's only handle on
> the problem. The record is preserved, flagged and made non-playable; the
> operator decides whether to purge it or recover it.

Provider identifiers (`providerAssetId`, `playbackId`,
`metadataJson.bunnyStream.videoId`, `libraryId`, `createdAt`) are all preserved,
so a flagged record still satisfies the strict predicate in §1.1 and remains
both purgeable and recoverable.

#### 404 is NOT a transient network error

> **THE DISTINCTION THIS WHOLE MECHANISM RESTS ON.**
>
> | Bunny outcome | Meaning | Local effect |
> |---|---|---|
> | **404** | authoritative: the video does not exist | reconciled — marker written, `READY` demoted to `FAILED` |
> | timeout, network error, 401/403, 429, 5xx | transient: Bunny could not answer | **nothing changes.** `READY` is not demoted, no marker is written, the error propagates truthfully |
>
> `BunnyStreamService.request()` raises `BunnyNotFoundError` *only* for HTTP
> 404; everything else becomes a `ServiceUnavailableException` or an
> `InternalServerErrorException`. `syncBunnyVideoStatus()` catches only
> `BunnyNotFoundError` and rethrows the rest.
>
> Treating one bad minute of Bunny availability as "deleted" would un-publish a
> working catalogue. Treating a 404 as transient would leave dead videos
> publicly playable.

**This is the one deliberate exception to "READY is never demoted."** That rule
protects a published asset from a *transient* provider read. An authoritative
404 is not that: leaving such a record `READY` would keep it publicly playable,
keep it eligible for new share links, and keep minting signed playback URLs for
a video that cannot play. `FAILED` is the existing non-playable terminal state,
so no new enum value and no migration were needed.

#### Fail-closed, everywhere, for free

No Bunny-specific gate was added anywhere. Public watch resolution and
share-link eligibility both already require `status === READY`, so demoting the
record is sufficient:

- **Public** — `isPublicPlayableVideo()` drops the video, so
  `resolvePublicEmbedUrl()` is never reached and **zero** signed Bunny URLs are
  minted. Proven by signing-spy call count in
  `test/bunny-remote-missing.test.ts`.
- **Share links** — creation rejects the video through the existing
  `VIDEO_NOT_ACTIVE_FOR_WEBSITE` / `notReadyVideoIds` path. There is deliberately
  no weaker Bunny-specific eligibility branch.
- **A multi-video share is not destroyed** because one of its videos went
  missing. The existing per-video filtering excludes only the unavailable one;
  the share link keeps working for the rest, and denies only when nothing
  playable remains.

#### Recovery

If a later authoritative `getVideo()` succeeds for the same asset, the marker is
cleared, normal status reconciliation resumes, and `FAILED → READY` is allowed
under the ordinary lifecycle rules. A `VIDEO_BUNNY_REMOTE_RECOVERED` audit row
records it and the caches are invalidated again.

> **An earlier 404 never permanently poisons a record.**

#### The authoritative database signing gate

> **Public Bunny signing does NOT depend on cache invalidation succeeding.**

`MemoryCacheService` is **process-local**. Reconciliation that runs anywhere
else — `yarn reconcile:bunny --apply` in its own process, a second API worker, a
direct database fix — commits `status = FAILED` + `remoteMissing` but cannot
reach a running API process's `public:watch:` entries. A cached READY row would
otherwise keep minting fresh signed Bunny URLs for a deleted video until the
entry expired.

So immediately before a token is minted — and **after** the atomic view
consumption, preserving the §6 ordering — `PublicService.loadSignableBunnyVideoIds()`
re-reads the current rows and requires all of:

1. the `VideoAsset` still exists;
2. `status === READY`;
3. it still passes the existing strict `classifyBunnyVideoAsset()` predicate;
4. `metadataJson.bunnyStream.remoteMissing` is absent;
5. the authoritative Bunny video id equals the one the cached row asked to sign.

Any failure — including a failure to read at all — **fails closed**: no token is
minted, and the stored unsigned `embedUrl` is never emitted as a fallback.

```
authorization -> atomic view consumption -> authoritative DB gate -> sign
```

If the gate refuses after consumption because the asset became unavailable
concurrently, the view is still spent. That is deliberate: spending one view is
strictly better than issuing playback for a known-unavailable asset.

**Cost: ONE batched, primary-key-indexed local query per response**, and only
when the share actually contains a Bunny-backed video — a share with none issues
no query at all. It adds **no** Bunny Management API request.

In-process invalidation on sync, recovery, admin mutations and purge is all
retained and still useful. It is simply no longer what public security depends
on.

#### Public watch performs NO Bunny request

> **Remote existence is eventual-consistency state, maintained by sync and
> reconciliation — it is never re-validated per view.**

A reviewer's watch request issues **zero** Bunny API calls. Adding a `getVideo()`
to the watch path would put Bunny's latency and availability directly in front
of every reviewer, for a condition that changes approximately never. The same
reasoning applies to the admin list: it performs no per-row Bunny call.

### 9.4 Reconciliation mechanism

**Bunny publishes no video-deleted webhook.** Verified against
<https://bunny.net/docs/stream/webhooks>: the webhook enumerates encoding states
only — 0 Queued, 1 Processing, 2 Encoding, 3 Finished, 4 Resolution finished,
5 Failed, 6 PresignedUploadStarted, 7 PresignedUploadFinished,
8 PresignedUploadFailed, 9 CaptionsGenerated, 10 TitleOrDescriptionGenerated.
There is no deletion event, so reconciliation has to be pull-based. No webhook
infrastructure was invented, and none was added.

Two bounded mechanisms, both using the same lifecycle helpers:

**A. Per-video Admin sync.** `POST /admin/videos/:id/bunny/sync`, surfaced as an
"Đồng bộ Bunny" button on the video detail page. Retriable, and it handles the
remote-missing response as a warning rather than a failure.

**B. `yarn reconcile:bunny`** — `scripts/operations/reconcile-bunny-videos.ts`.

```bash
yarn reconcile:bunny                              # dry run, reports only
yarn reconcile:bunny --apply --confirm-env=local  # writes
```

```jsonc
{"mode":"dry-run","checked":25,"available":23,"remoteMissing":1,
 "failedRequests":1,"updated":4,"recovered":0,"skippedNotBunny":0}
```

- Loads only records passing the strict Bunny predicate; a merely-labelled or
  malformed record is counted as `skippedNotBunny` and left alone.
- Bounded batches (`--batch-size`, default 50; `--max-batches`, default 20) with
  cursor paging by id.
- Low concurrency (`--concurrency`, default 4, **bounded 1–5**).
- Reuses `getVideo()` and the exported lifecycle helpers rather than
  reimplementing the rules, so it cannot drift from the endpoint.
- **Reconciles the database only.** It does not — and cannot — invalidate a
  running API process's memory cache. Process-local `public:watch:` entries may
  remain physically populated after it runs, but Bunny playback signing performs
  the authoritative database gate above, so a stale READY entry cannot mint a
  new Bunny token. Cross-process cache invalidation is deliberately **not** part
  of this script's contract.
- Dry run by default; `--apply` additionally requires `--confirm-env` to match
  `APP_ENV`/`NODE_ENV` exactly, matching `cleanup:admin-sessions`.
- **Transient failures are counted separately** as `failedRequests` and mark
  nothing.

> **It never deletes a local row, never deletes a Bunny asset, never mints a
> playback token, and prints only aggregate counts and ids — never a secret.**
> Structurally: it calls `update` but never `delete`, issues GET but never
> DELETE, and never touches `createSignedEmbedUrl`.

Designed so a Hostinger cron can invoke it later. **Nothing schedules it today**,
and no scheduler dependency (`@nestjs/schedule`), queue or Redis was added.

### 9.5 The remote-missing model — no migration

The condition lives inside the **existing** `metadataJson.bunnyStream` marker:

```jsonc
"bunnyStream": {
  "videoId":   "…",          // preserved
  "libraryId": "…",          // preserved
  "createdAt": "…",          // preserved
  "remoteMissing": { "detectedAt": "2026-08-23T12:00:00.000Z",
                     "reason": "NOT_FOUND" }
}
```

> **No Prisma migration was required.** `metadataJson` is already a JSON column
> the Bunny integration owns a key in, `VideoStatus.FAILED` already expresses
> "non-playable", and the classifier already reads this exact marker. Adding a
> column would have bought nothing and cost a deploy-ordering constraint.

Helper guarantees, in `bunny-video-asset.util.ts`:

- Unrelated top-level metadata (`thumbnail`, …) and every existing `bunnyStream`
  field are preserved; nothing is overwritten.
- `detectedAt` is ISO 8601; `reason` is the deterministic code `NOT_FOUND`.
- **Idempotent** — re-flagging keeps the original `detectedAt`, writes nothing
  and does not re-fire the audit event.
- It refuses to invent a `bunnyStream` block that does not exist, so a
  non-Bunny or malformed record can never be flagged.

### 9.6 Audit events

| Action | When | Status |
|---|---|---|
| `VIDEO_BUNNY_REMOTE_MISSING` | an authoritative 404 was reconciled | `FAIL` |
| `VIDEO_BUNNY_REMOTE_RECOVERED` | a later `getVideo()` succeeded and the marker was cleared | `SUCCESS` |
| `VIDEO_BUNNY_REMOTE_DELETE` | a purge's remote delete was confirmed, or aborted | `SUCCESS` / `FAIL` |

Metadata carries the video id, the Bunny video id, previous and next status, and
the remote result. **Never** an API key, a token security key or a signed
playback token.

`VIDEO_BUNNY_REMOTE_DELETE` is written **before** the local transaction, so it
carries `localPurgeStage`: `PENDING` on a confirmed remote delete, `ABORTED`
when the delete was not confirmed. A `VIDEO_PURGE_COMMIT` row following a
`PENDING` one is what says the local purge actually landed — a `PENDING` row
with no commit after it is the "Bunny gone, local row still present" state, and
is exactly what an operator should look for when reconciling.

### 9.7 When Bunny cannot confirm at all — and the DI trap behind it

> **`400 BUNNY_STREAM_UNAVAILABLE_FOR_PURGE` is a refusal, never a downgrade.**

A remote-deleting purge needs the Bunny collaborator. Two unrelated conditions
leave it unusable, and `assertBunnyAvailableForPurge()` refuses on both, before
step 2 of §9.2 and therefore before anything local is touched:

| `reason` | Meaning |
|---|---|
| `NOT_ENABLED` | `BUNNY_STREAM_ENABLED` is false. A configuration choice |
| `NOT_WIRED` | The service is not in the container. A **server defect** |

The response says the local video was kept and names the two ways forward —
enable Bunny and retry, or opt out with `deleteRemoteAsset: false`. It discloses
no key, library id or hostname. The purge is aborted, `VIDEO_BUNNY_REMOTE_DELETE`
is audited `FAIL` with `localPurgeStage: "ABORTED"`, and the row, its website
assignments and its share-link memberships all survive.

> **The Admin console must not silently retry local-only.** That would recreate
> exactly the billable orphan the remote-first ordering exists to prevent.
> Keeping the Bunny video is an operator decision, made by unticking the box.

#### Why `NOT_WIRED` exists: a real outage

`VideosService` imported the collaborator as a **type**:

```ts
import type { BunnyStreamService } from "../bunny/bunny-stream.service";
...
@Optional() private readonly bunnyStreamService?: BunnyStreamService,
```

`import type` is erased from the emitted JavaScript. Nest resolves constructor
parameters from the `design:paramtypes` metadata TypeScript emits, and that
metadata can only name a class that still exists at runtime — so the entry
degraded to a bare `Function`, matching no provider. **`@Optional()` then made
the failure silent:** Nest injected `undefined`, the container booted cleanly,
and every Bunny path on this service — upload-init, sync, custom thumbnail,
admin preview and purge — failed with the generic
`400 "Bunny Stream is not enabled."` on a server where Bunny was fully
configured, enabled and working.

`PublicService` used a **value** import for the same class, so public playback
signing kept working the entire time. That asymmetry is what made the fault read
as a purge-specific configuration problem instead of a DI defect.

> **Rule: a class injected by Nest must be imported as a VALUE, even when it is
> only referenced in type position.** ESLint's `consistent-type-imports` will
> offer the opposite; the import in `videos.service.ts` carries a targeted
> `eslint-disable-next-line` and a comment saying why. `test/bunny-di-wiring.test.ts`
> fails if either service loses its value import.

## 10. Failure and orphan handling

Proportional by design; no job system was introduced.

| Failure | Handling |
|---|---|
| Bunny create succeeds, local insert fails | Compensating `deleteVideo()` before rethrowing, plus a `VIDEO_BUNNY_UPLOAD_INIT_ORPHAN` audit row recording whether it worked |
| Local record exists, browser never uploads | The record stays `PROCESSING` and is not publicly playable. **Remaining orphan risk** — see below |
| TUS upload fails | Same as above; the admin can retry, and tus-js-client resumes |
| Bunny encoding fails | Sync maps status 5/6 to `FAILED`; a retry can recover to `READY` |
| Bunny delete not confirmed during purge | **The local purge is ABORTED** and the row survives. A retriable failure is returned and `VIDEO_BUNNY_REMOTE_DELETE` is audited `FAIL` (§9.2) |
| Purge requests remote deletion while Bunny is **disabled** or **not wired** | Refused **before any network read** with `400 BUNNY_STREAM_UNAVAILABLE_FOR_PURGE`, so no HTTP request is made **and the purge aborts**. The row survives rather than becoming an orphan. See §9.7 |
| Bunny video deleted outside the CMS | Reconciled to `FAILED` + `remoteMissing`; the row is preserved and stops being publicly playable (§9.3) |
| Bunny unreachable | `503 "Bunny Stream is currently unreachable."`; public playback fails closed |

> **Documented remaining orphan risk.** A Bunny video created by
> `upload-init` whose browser upload never starts leaves a `PROCESSING` local
> record and an empty Bunny asset. Nothing reaps either automatically. There is
> no equivalent of `LOCAL_VIDEO_STALE_UPLOAD_MAX_AGE_HOURS` for Bunny in this
> MVP. Operators can find them by listing videos with `provider=BUNNY` and
> `status=PROCESSING` older than a reasonable window, and purge them normally
> (disable first, then purge with `deleteRemoteAsset: true`).
>
> Note this is now the *only* remaining orphan direction. The two that used to
> exist on the delete path — a purge that removed the row while Bunny kept the
> video — are closed by the remote-first ordering in §9.2.

## 11. Explicit MVP scope limits

Not implemented, and not partially implemented:

- Bunny **webhooks**. Status is polled, not pushed. Bunny publishes no
  video-deleted event either (§9.4), so deletion reconciliation is pull-based by
  necessity, not by preference.
- **CDN token authentication** on the pull zone. Still not implemented, and
  deliberately so: the measured evidence in §4.6 shows the zone in question does
  not enforce it (an unsigned URL with a valid `Referer` returns 200), and no
  CDN token security key is part of this deployment's environment contract.
  `BUNNY_STREAM_TOKEN_SECURITY_KEY` is **not** that key and must never be reused
  as one. Enabling token authentication later requires a Bunny dashboard change,
  a new environment variable, a new `BUNNY_PUBLIC_THUMBNAIL_UPSTREAM_AUTH_MODE`
  value, and verification that the zone actually enforces it.
- MediaCage **DRM**.
- A custom **HLS player**. Playback is the Bunny iframe.
- **Automatic migration** of existing videos to Bunny.
- Bunny **collections**, analytics, captions, AI transcription.
- **Multi-library** management. One library per deployment.
- Background **queues** for retries or reconciliation. `yarn reconcile:bunny`
  is a bounded, low-concurrency operational script run on demand — not a queue,
  not a scheduler, and nothing schedules it today.
- Automatic **deletion** of a local row whose Bunny asset is gone. That is a
  deliberate refusal, not a gap — see §9.3.

## 12. Tests

`test/bunny-stream.test.ts`, `test/bunny-admin-preview.test.ts` (33 tests),
`test/bunny-thumbnail-sync.test.ts` (6 tests), `test/bunny-remote-missing.test.ts`
(20 tests), the Bunny block in `test/share-link-scope.test.ts` (9 tests) and the
Bunny section of `test/video-purge.test.ts` (11 tests). The Bunny HTTP boundary
is mocked by replacing `globalThis.fetch`; **no automated test makes a real Bunny
request.**

`bunny-remote-missing` covers §9.3 to §9.5. An authoritative 404 keeps the local
row, demotes `READY` to `FAILED`, writes the marker, preserves every other
metadata key and every provider identifier, audits `FAIL`, invalidates all three
cache prefixes, and is idempotent on a second sync. `DISABLED` survives
reconciliation. A 5xx and a network error each change **nothing** — no marker,
no demotion, no audit, no cache invalidation — and propagate truthfully. A later
success clears the marker and allows `FAILED → READY`. Finally, and most
importantly, a signing spy proves the public path mints **zero** playback URLs
for a reconciled asset, never falls back to the stored unsigned URL, excludes
only the missing video from a multi-video share, and resumes signing after
recovery — with a healthy positive control so the denial cannot pass for an
unrelated reason.

The Bunny section of `video-purge` additionally pins the remote-first ordering:
the remote delete is observably issued **before** the local delete, an
unconfirmed delete (`false`, a throw, or a disabled feature) aborts with the row
intact, a 404 counts as already-deleted and completes the purge, and a local
transaction failure after a confirmed remote delete leaves the row present with
no `VIDEO_PURGE_COMMIT` written.

`bunny-thumbnail-sync` covers §4.4: an empty poster is filled, a poster set by
an operator is never overwritten, a whitespace-only value counts as empty, a
still-encoding video leaves the column `NULL`, the write happens even when the
status did not change, and the stored value is a poster URL carrying no
`token`/`expires`.

The `share-link-scope` Bunny block proves a Bunny asset goes through the **same**
eligibility gate as every other source type: a `READY` Bunny video ACTIVE-assigned
to an ACTIVE website creates a link, while unassigned, `DISABLED`-assigned,
non-`READY` and embed-URL-less records are each refused with the specific
`VIDEO_NOT_ACTIVE_FOR_WEBSITE` category. One test asserts creation emits **no**
Bunny playback URL at all — signed or unsigned — because signing belongs to
authorized public resolution.

`bunny-admin-preview` covers the admin signing endpoint specifically: a signed
URL for a READY asset, the token formula recomputed independently, the
`token=<64 hex>` / `expires=<unix>` shape, and — with a signing spy asserted at
zero — refusal for all five malformed shapes, six non-Bunny shapes including the
legacy `provider: BUNNY` + `DIRECT_URL` record, all four non-`READY` statuses, a
missing video, a disabled feature, an absent collaborator and each missing
credential. It also pins the controller guards and the read-role metadata, and
asserts no Bunny secret appears in a response or in any refusal message.

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

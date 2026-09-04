# Feature: Video pipeline

Status: CURRENT
Last verified: 2026-08-21
Verified against: `src/videos/videos.service.ts`, `src/videos/videos.controller.ts`, `src/videos/storage/local-video-storage.service.ts`, `src/cloudinary/cloudinary.service.ts`, `src/public/public.service.ts`, `prisma/schema.prisma`

Every implemented way a video can enter the system and reach a viewer.

## 1. Two independent axes

`VideoSourceType` answers **where the bytes are**. `VideoProvider` answers **who
hosts them**. They are set together at creation and are not interchangeable.

| `sourceType` | Bytes live | Public playback route |
|---|---|---|
| `DIRECT_URL` | Somewhere else on the web | the stored `playbackUrl`, returned as-is |
| `EMBED` | A third-party player | `embedUrl` in an allowlisted iframe |
| `UPLOAD` | Cloudinary | Cloudinary `secure_url` |
| `DB_BLOB` | `VideoBinaryAsset.data` (`LongBlob`) | `/public/watch/:token/videos/:id/binary` |
| `LOCAL_FILE` | Filesystem under `LOCAL_FILE_STORAGE_ROOT` | `/public/watch/:token/videos/:id/local-file` |

| `provider` | Status | Evidence |
|---|---|---|
| `MANUAL` | **CURRENT** — the default; no provider integration | `videos.service.ts` |
| `CLOUDINARY` | **CURRENT** — upload, delete, derived thumbnails | `src/cloudinary/cloudinary.service.ts` |
| `BUNNY` | **CURRENT (MVP)** | `src/bunny/bunny-stream.service.ts` — TUS upload initiation, status sync, signed short-lived embed playback, remote purge. See [bunny-stream.md](./bunny-stream.md) |
| `MUX` | **PLANNED** | No Mux-specific integration exists. Same generic behaviour |

`VIDEO_PROVIDER` in `.env.example` is read by nothing.

### 1.1 How `provider` is actually decided

`resolveProvider(dto)` in `videos.service.ts`:

1. An explicit `dto.provider` wins. `CreateVideoDto` declares
   `provider?: VideoProvider` with `@IsOptional() @IsEnum(VideoProvider)`, so
   **any** enum member is accepted and persisted.
2. Otherwise a `playbackUrl` whose hostname ends with `cloudinary.com` yields
   `CLOUDINARY` (`isCloudinaryUrl`).
3. Otherwise `MANUAL`.

Two consequences that earlier documentation got wrong:

- **Cloudinary records are not created only via embed.** A `DIRECT_URL` video
  whose `playbackUrl` is any `*.cloudinary.com` URL is auto-classified
  `provider: CLOUDINARY, sourceType: DIRECT_URL`.
- **`provider: BUNNY` / `provider: MUX` records can be created this way**
  through `POST /admin/videos`, and will play back as ordinary direct URLs. That
  is a stored *label* plus generic URL handling.

  A **Bunny-backed** asset is not that. It is created only by
  `POST /admin/videos/bunny/upload-init` and is recognised by
  `classifyBunnyVideoAsset()` — `provider = BUNNY` **and** `sourceType = EMBED`
  **and** a `providerAssetId` holding the Bunny GUID **and** a `playbackId`
  equal to it **and** a matching `metadataJson.bunnyStream` marker. A
  merely-labelled `DIRECT_URL` record classifies as `not-bunny` and is untouched
  by every Bunny branch; a record claiming the Bunny EMBED shape that fails the
  predicate classifies as `bunny-malformed` and **fails closed**. See
  [bunny-stream.md](./bunny-stream.md).

## 2. Creation paths

| Endpoint | Result | Used by the admin UI? |
|---|---|---|
| `POST /admin/videos` | `DIRECT_URL` + `MANUAL` | yes |
| `POST /admin/videos/manual-with-thumbnail` | `DIRECT_URL` + uploaded thumbnail | yes |
| `POST /admin/videos/embed` | `EMBED`; provider `CLOUDINARY` for a Cloudinary player, else `MANUAL` | yes |
| `POST /admin/videos/embed-with-thumbnail` | as above + thumbnail | yes |
| `POST /admin/videos/upload` | `UPLOAD` + `CLOUDINARY` | **no** |
| `POST /admin/videos/upload-db` | `DB_BLOB` | **no** |
| `POST /admin/videos/upload-local/*` | `LOCAL_FILE` | yes |
| `POST /admin/videos/bunny/upload-init` | `EMBED` + `BUNNY`, status `PROCESSING` | yes |

Two implemented upload paths have no UI. See
[KNOWN_ISSUES.md](../KNOWN_ISSUES.md#ki-014).

## 3. `DIRECT_URL`

Stores a remote URL and returns it unchanged to the public site (via
`toSafePublicMediaUrl()`, which only nulls out URLs containing an `admin` path
segment).

> The backend does not proxy these bytes, attaches no token, host binding or
> grant, and is not in the playback request path at all. Revoking the share link
> stops future **watch resolution**; it cannot invalidate a URL already
> disclosed to a browser. See
> [SECURITY_MODEL.md §4.1](../SECURITY_MODEL.md#41-backend-served-media-versus-providerdirect-media)
> and [KNOWN_ISSUES.md](../KNOWN_ISSUES.md#ki-015).

Optional metadata probing (`VideoMetadataService`) fetches a bounded byte range
to read duration and format, with the SSRF defences described in
[SECURITY_MODEL.md](../SECURITY_MODEL.md#9-ssrf-protection).

## 4. `EMBED`

Accepts a URL or a full `<iframe>` snippet, extracts and validates the `src`,
and requires the host to be in `VIDEO_EMBED_ALLOWED_HOSTS`
(`player.cloudinary.com`, `www.youtube.com`, `www.youtube-nocookie.com`,
`player.vimeo.com` by default). Stores `embedProvider`, `embedUrl`,
`embedCloudName`, `embedPublicId` and `embedAllow` (defaulting to
`VIDEO_EMBED_DEFAULT_ALLOW`).

> Three lists must stay in sync: `VIDEO_EMBED_ALLOWED_HOSTS` here, the public
> site's `ALLOWED_EMBED_HOSTS`, and the public site's CSP `frame-src`. Changing
> one alone produces a video that validates server-side and is blocked in the
> browser.

## 5. `UPLOAD` (Cloudinary)

`CloudinaryService.uploadVideo()` streams the multer temp file to Cloudinary,
then stores `provider: CLOUDINARY`, `providerAssetId`/`playbackId` = the public
id, `playbackUrl` = `secure_url`, and a derived thumbnail
(`so_1,w_640,c_fill/<publicId>.jpg`) unless one was supplied. Cloudinary upload
metadata is kept in `metadataJson`. Temp files are removed in a `finally`.

Purge can delete the remote asset when `deleteRemoteAsset` is set — best-effort,
after the database transaction commits (§10.1).

`uploadVideo()` wraps the Cloudinary upload and the `videoAsset.create()` in one
`try { … } finally { delete temp files }` with **no `catch`**. If the database
write fails after the upload succeeded, the Cloudinary asset is left behind with
no record pointing at it. See [KNOWN_ISSUES.md](../KNOWN_ISSUES.md#ki-018).

Like every `DIRECT_URL`-style playback URL, a Cloudinary `secure_url` is an
unsigned delivery URL handed to the browser; Cloudinary signed/expiring delivery
is not used by this codebase.

## 6. `DB_BLOB` — fallback only

Bytes go into `VideoBinaryAsset.data`. Gated by `VIDEO_DB_STORAGE_ENABLED`
(default `false`); enabling it in production also requires
`VIDEO_DB_STORAGE_ALLOW_PRODUCTION_OVERRIDE=true` or startup throws.
`VIDEO_DB_UPLOAD_MAX_MB` defaults to 50 with a hard ceiling of 100.
`checksumSha256` was added by migration `20260719090000`.

Range reads select only the requested slice rather than loading the whole blob.
This exists for small internal or test files; it is not a production video
strategy.

## 7. `LOCAL_FILE` — self-hosted

The production self-hosted path. Gated by `LOCAL_FILE_STORAGE_ENABLED`.

```
init      → VideoUploadSession { tempStorageKey, totalChunks, chunkSizeBytes, expiresAt }
chunks    → VideoUploadSessionChunk per (uploadSessionId, chunkIndex), idempotent
complete  → merge atomically, sha256, create VideoAsset + VideoLocalFileAsset
cancel    → status ABORTED, temp files removed
```

Guards: server-side storage keys built from UUIDs; every path segment matched
against `^[a-zA-Z0-9._-]+$`; resolved paths re-checked to be inside the root;
symlink components and non-regular targets rejected; free space checked against
`LOCAL_VIDEO_MIN_FREE_SPACE_MB` before writing; size bounded by
`LOCAL_VIDEO_UPLOAD_MAX_MB` ≤ `LOCAL_VIDEO_UPLOAD_HARD_MAX_MB` (ceiling 1024).

Thumbnails are stored the same way (`VideoLocalThumbnailAsset`, bounded by
`LOCAL_THUMBNAIL_UPLOAD_MAX_MB`) and served by the `thumbnail` route.

> The storage root is **not** part of a code deploy. Database backups and
> filesystem backups must be coordinated, or a restore yields valid metadata
> pointing at missing files.

## 8. HTTP Range

Implemented for `DB_BLOB` and `LOCAL_FILE`, on both admin preview and public
routes.

**Single range only.** The parser matches `^bytes=(\d*)-(\d*)$`. Multi-range
requests (`bytes=0-99,200-299`), non-`bytes` units and `bytes=-` all fail to
match and produce `416`. Suffix (`bytes=-500`) and open-ended (`bytes=500-`)
ranges work. No multipart/byteranges response is ever produced.

| Request | Response | Headers |
|---|---|---|
| No `Range` | `200` | `Accept-Ranges`, `Content-Type`, `Content-Length` |
| Satisfiable range | `206` | the above **plus** `Content-Range: bytes <start>-<end>/<total>` |
| Unsatisfiable / unparseable | `416` | `Accept-Ranges`, `Content-Type`, `Content-Range: bytes */<total>` — **no `Content-Length`** |
| `HEAD` | as above | headers only; the stream is destroyed without transferring |

Delivery differs by source, and the difference matters for memory:

- `LOCAL_FILE` — **streamed** with `createReadStream({ start, end })` piped to
  the response. Memory is bounded by the stream regardless of file size.
- `DB_BLOB` — the requested slice is read into a `Buffer` and sent with
  `response.send()`. **Bounded buffering, not streaming.** A large range is
  fully materialised in memory, which is one reason `DB_BLOB` is capped at
  100 MB and disabled in production.

Premature client disconnects (`ERR_STREAM_PREMATURE_CLOSE`) are swallowed —
normal when a viewer seeks or closes the tab.

## 9. Publishing a video

```
create video (any path above)
   ↓  status must reach READY
assign to a website        → WebsiteVideo (ACTIVE)
include in a share link    → ShareLinkVideo
   ↓
public watch returns it, with URLs appropriate to its sourceType
```

A video that is `READY` but unassigned is invisible publicly. A video assigned
but not in any share link is likewise invisible.

Both checks are applied on media requests, not only on the listing — with one
documented exception, and that exception belongs to the **legacy `#k` origin
alone**: for **unlimited** `LOCAL_FILE` links reached with a `#k` credential the
authorization result may be served from a process-local cache for up to
`MEDIA_METADATA_CACHE_TTL_SECONDS`, so an un-assignment can take that long to
take effect in a process that did not observe the invalidation. `DB_BLOB` and
view-limited links are never cached, and neither is any request carrying an
alias-free `rmv1` media token — a `compat` or `resume` session bypasses this
cache entirely and revalidates against the database on every request. See
[SECURITY_MODEL.md §4.2](../SECURITY_MODEL.md#42-local_file-media-authorization-cache).

## 10. Deleting

`DELETE /admin/videos/:id` — write roles. **Soft-disable only**: sets
`VideoStatus.DISABLED`. No row, file, blob or remote asset is removed — for a
Bunny-backed video in particular, the Bunny asset is explicitly retained and no
Bunny request is issued.

### 10.0 DISABLE is REVERSIBLE; PURGE is the only destructive operation

> **DISABLE != PURGE.** Disable must never destroy a relationship that restore
> cannot recover, because "Vô hiệu hóa" is understood as temporary.

The admin console drives **both** directions through `PATCH /admin/videos/:id`
with `{ status }` — `DISABLED` to disable, `READY` to restore. (The dedicated
`DELETE /admin/videos/:id` route exists, does the same disable, and is not
currently used by the console; both paths share the same helpers, so they
interoperate.)

| Write | DISABLE | RESTORE (`→ READY`) | PURGE |
|---|---|---|---|
| `VideoAsset.status` | `→ DISABLED` | `→ READY` | row **deleted** |
| `WebsiteVideo` | **untouched** | **untouched** — the surviving `ACTIVE` assignment simply becomes effective again | **deleted**, every status |
| `ShareLinkVideo` | **untouched** | **untouched** | **deleted** |
| `ShareLink.status` | every `ACTIVE` link containing the video `→ DISABLED` | eligible `DISABLED` links `→ ACTIVE` (see [share-links.md §5](./share-links.md#5-revocation-and-expiry) for the narrow eligibility rules) | remaining `ACTIVE` links `→ DISABLED` |
| `VideoLocalFileAsset` / `DB_BLOB` bytes / thumbnails | untouched | untouched | deleted, best-effort after commit |
| `metadataJson`, provider identifiers | untouched | untouched — in particular a confirmed `bunnyStream.remoteMissing` marker is **not** cleared, so a generic restore cannot launder a known-deleted remote asset | gone with the row |
| Provider (Bunny / Cloudinary) | no request | no request | opt-in remote delete |

Because disable preserves both relations, a restored video is **still assigned**
to its websites. It therefore correctly appears as already-assigned rather than
as newly assignable in
`listVideoAssignmentOptions()` (`isAssigned: true`, `canAssign: false`), and its
previously-issued share links resume without a new link being created. Only a
video that was genuinely unassigned needs assigning again after a restore.

Restore is keyed on `READY` specifically. `DISABLED → FAILED`/`DRAFT`/
`PROCESSING` leaves share links dark, because none of those states is publicly
resolvable.

Pinned by `test/video-lifecycle-disable-restore.test.ts`.

`POST /admin/videos/:id/purge` — **OWNER only**. Preconditions, each with its own
failure:

| Check | Failure |
|---|---|
| `confirmVideoId === :id` | `400` |
| No `CanonicalVideoShareLink` for the video | `409 VIDEO_HAS_CANONICAL_SHARE_LINK` |
| Video exists | `404` |
| Status is already `DISABLED` | `400` "Video must be disabled before it can be permanently deleted." |

> **ACTIVE `WebsiteVideo` assignments are no longer a precondition** (changed
> 2026-08-23). They are cleaned up inside the purge transaction instead. See
> [../API_CONTRACTS.md](../API_CONTRACTS.md) §2.12 for the rationale; the
> `DISABLED` requirement and the canonical provenance conflict are unchanged.

### 10.1 Purge is two phases and is not atomic end to end

> **Do not describe purge as one atomic operation.** The database delete is
> transactional; the external cleanup that follows is not.

```
PHASE 0 — BUNNY ONLY, before anything is mutated (added 2026-08-23)
    if deleteRemoteAsset && readBunnyVideoAsset(video) !== null
        validate the local preconditions WITHOUT mutating   ← prepareBunnyRemoteDelete
        DELETE /library/{libraryId}/videos/{videoId}        ← deleteBunnyRemoteAssetOrThrow
            2xx / 404  -> confirmed, continue to PHASE 1
            anything else, including BUNNY_STREAM_ENABLED=false
                       -> ABORT. The local row is never touched. 503 returned,
                          VIDEO_BUNNY_REMOTE_DELETE audited FAIL
PHASE 1 — inside a single Prisma transaction
    re-read the video (status, provider, sourceType, providerAssetId,
                       thumbnailUrl, metadataJson, local asset storage keys)
    enforce the preconditions above
    disable remaining ACTIVE share links for the video
    detach ShareLinkVideo rows
    delete WebsiteVideo rows       ← every status; onDelete: Cascade would do it
                                     anyway, but deleting explicitly makes the
                                     count reportable
    videoAsset.delete()            ← satellites cascade
    audit VIDEO_PURGE_COMMIT
  ── COMMIT ──────────────────────────────────────────────────────────────────
PHASE 2 — after the commit, no transaction, all best-effort
    if deleteRemoteAsset && provider === CLOUDINARY && providerAssetId
        deleteRemoteAssetBestEffort(providerAssetId)
    deleteOwnedThumbnailBestEffort(metadataJson, thumbnailUrl)
    deleteStorageKeyBestEffort(localFileAsset.storageKey)
    deleteStorageKeyBestEffort(localThumbnailAsset.storageKey)
    compute bytesReclaimed and orphanCleanupRequired
    audit VIDEO_PURGE_STORAGE  (AuditStatus.FAIL when any cleanup failed)
    invalidate admin video caches
```

If phase 2 fails, **phase 1 is already committed**. The database row is gone and
the file or provider asset remains — an orphan that no longer has a record
pointing at it, so a later purge cannot find it.

> **Bunny is deliberately not in phase 2.** It runs in phase 0, before the
> commit, so an unreachable Bunny aborts the purge with the row intact instead
> of producing exactly the orphan described above. The preferred failure
> direction for Bunny is "remote gone + local row present", which the CMS can
> see, reconcile and retry. If phase 1 then fails after a confirmed remote
> delete, the request reports failure honestly, the row survives, and the retry
> succeeds because Bunny answers 404. See
> [bunny-stream.md](./bunny-stream.md) §9.2.
>
> Cloudinary and local storage keep their existing phase-2 best-effort
> behaviour; this change is scoped to the Bunny branch.

### 10.2 Orphan reporting — this part is implemented

The response and the audit trail both report reality rather than assuming
success:

```jsonc
"storage": { "localVideoDeleteAttempted", "localVideoDeleted",
             "localThumbnailDeleteAttempted", "localThumbnailDeleted",
             "bytesReclaimed" /* string */, "orphanCleanupRequired" },
"remote":  { "remoteAssetDeleteAttempted", "remoteAssetDeleted" }
```

`orphanCleanupRequired` is true when a local delete was attempted and failed.
`storageCleanupFailed` (local orphan **or** a failed remote delete) downgrades
the `VIDEO_PURGE_STORAGE` audit row to `AuditStatus.FAIL`.

> A `200` with `status: "PURGED"` and `orphanCleanupRequired: true` is a success
> response describing a partial failure. Operators must read `storage` and
> `remote`, and reconcile with
> `scripts/storage/find-orphan-local-files.example.sh`.

Cloudinary assets orphaned this way are **not** reported by that script — it
only scans the local storage root. See
[KNOWN_ISSUES.md](../KNOWN_ISSUES.md#ki-017).

## 11. View counting

`VideoAsset.viewCount` is a `BigInt` display counter serialised as a string. It
grows only through `POST /public/watch/:token/videos/:videoId/view`, and only
when `VIDEO_VIEW_GROWTH_ENABLED=true`, subject to per-event and hourly caps and
a dedupe window. Range requests never increment it. Treat it as a display
figure, never as analytics.

## 12. Adding a new source type or provider

1. Extend the enum **and** write the migration.
2. Mirror the enum in `bom-media-admin/src/features/videos/videoTypes.ts`.
3. Add a creation path with its own DTO and role metadata.
4. Teach `isPublicPlayableVideo()` what "playable" means for it.
5. Return a URL field the public site already consumes, or add one **and**
   update `../API_CONTRACTS.md` and the public site's resolver.
6. Extend purge so the asset is actually reclaimed.
7. Add tests for the unauthorized and not-ready paths.
8. Update this document, `../DATA_MODEL.md` and `../ENVIRONMENT.md`.

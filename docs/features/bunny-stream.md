# Feature: Bunny Stream video provider

Status: **PLANNED — NOT IMPLEMENTED**
Last verified: 2026-08-21
Verified against: `prisma/schema.prisma` (`VideoProvider`), `src/videos/videos.service.ts` (`resolveProvider`, `purgeVideo`), `src/videos/dto/create-video.dto.ts`, `.env.example` lines 147-151, and a repository-wide search for "bunny" on 2026-08-21
Owner: unassigned

> **No Bunny-specific integration exists.** Read the two tables below before
> writing or repeating any claim about Bunny status — an earlier revision of
> this document said "zero implementation code", which was imprecise: the enum
> member is reachable and generic playback works.
>
> **Do not implement from this document.** It is a planning artefact, written to
> capture constraints while the current video architecture is fresh.
> Implementation requires a separate, explicit instruction.

### CURRENT — verified present today

| Fact | Evidence |
|---|---|
| `VideoProvider.BUNNY` exists in the Prisma enum | `prisma/schema.prisma`, migration `20260529163942_init` |
| The enum member is **persistable** through the public admin API | `CreateVideoDto.provider?: VideoProvider` with `@IsOptional() @IsEnum(VideoProvider)`; `resolveProvider(dto)` returns `dto.provider` when supplied |
| A `provider: BUNNY` record plays back **generically** | It is an ordinary `sourceType: DIRECT_URL` video; the stored `playbackUrl` is returned verbatim and the public site renders it in a native `<video>` |
| Provider-ready database fields exist and are generic | `VideoAsset.provider`, `providerAssetId`, `playbackId`, `playbackUrl`, `metadataJson` |
| The admin UI has a display label | `BUNNY: "Bunny"` in `bom-media-admin/src/features/videos/videoFormatters.ts`; `VideoProvider` union in `videoTypes.ts` |
| Four `BUNNY_STREAM_*` environment placeholders exist | `.env.example` lines 147–151 — **verified unread**: no reference in `src/`, `prisma/`, `scripts/` or `test/` |

So a video can today be *labelled* Bunny and served as a plain direct URL. That
is a stored label plus generic URL handling, not an integration.

### NOT IMPLEMENTED — none of this exists

| Missing | Consequence |
|---|---|
| Bunny-specific service or API client | No programmatic upload, listing, deletion or status query |
| TUS resumable upload integration | Uploads cannot go to Bunny at all |
| Bunny webhooks | No encoding-complete or failure callbacks; `VideoStatus` cannot be driven by Bunny |
| Signed Bunny playback (token authentication) | A Bunny URL stored today would be an unsigned, non-expiring URL — see [KNOWN_ISSUES.md](../KNOWN_ISSUES.md#ki-015) |
| Bunny player integration | Playback would use the native element or a `GENERIC_IFRAME` embed |
| Bunny metadata synchronisation | Duration, size and thumbnails are not fetched from Bunny |
| Provider-specific purge | `purgeVideo()` deletes remote assets only for `provider === CLOUDINARY`; a `BUNNY` record's remote asset is never deleted |
| Reading of `BUNNY_STREAM_*` | Setting these variables has no effect whatsoever |
| Production Bunny infrastructure | Not represented in this workspace; classification **EXTERNAL / UNVERIFIED** |

The same applies to `MUX`: enum member and `MUX_*` placeholders only, with no
Mux-specific integration.

## Goal

Move production video storage and delivery to Bunny Stream so that video bytes
are served by a CDN instead of the application origin, while keeping every
authorization decision in this backend.

## Non-goals

- Removing `LOCAL_FILE`. It must remain a supported self-hosted option.
- Removing `DB_BLOB`. It remains a small, production-disabled fallback.
- Removing Cloudinary. It stays for images/thumbnails and existing assets.
- DRM or watermarking.
- Migrating existing assets automatically.

## Existing behaviour

See [video-pipeline.md](./video-pipeline.md). Five source types are implemented;
`MANUAL` and `CLOUDINARY` are the only implemented providers. For `LOCAL_FILE`
and `DB_BLOB` the backend serves every byte and implements Range itself.

Relevant current facts any integration must respect:

- Public authorization for **backend-served** media runs the chain host →
  `ACTIVE` domain → `ACTIVE` website → `ACTIVE` share link (status/expiry) →
  `ShareLinkVideo` membership → `ACTIVE` `WebsiteVideo` assignment → `READY` →
  playable asset. It runs per request for `DB_BLOB`; for unlimited `LOCAL_FILE`
  links a process-local cache may serve the result for up to
  `MEDIA_METADATA_CACHE_TTL_SECONDS`
  ([SECURITY_MODEL.md §4.2](../SECURITY_MODEL.md#42-local_file-media-authorization-cache)).
- **Externally hosted media is outside that chain entirely.** `DIRECT_URL`,
  Cloudinary `UPLOAD` and `EMBED` URLs are returned verbatim and fetched by the
  browser directly. A Bunny integration that returns unsigned Bunny URLs would
  land in this category and inherit its revocation limits
  ([KNOWN_ISSUES.md](../KNOWN_ISSUES.md#ki-015)). Signed, short-lived URLs are
  what keeps it out of that category.
- View-limited links additionally require an HMAC grant
  ([ADR 0004](../adr/0004-hmac-media-grants-for-view-limited-links.md)).
- The public site never constructs media URLs; it consumes the URL fields the
  watch response returns
  ([API_CONTRACTS.md](../API_CONTRACTS.md#31-post-publicwatchexchange-preferred-and-get-publicwatch-legacy)).
- The public site's CSP currently allows `media-src 'self' blob: https:`, so an
  https CDN host is permitted today, but `connect-src` is `'self'`.

## Target behaviour

Not built. If built, it would introduce a `BUNNY` provider whose videos are
uploaded to a Bunny Stream library and played back through short-lived signed
Bunny URLs handed out only after this backend has authorized the request.

## Architecture (sketch only)

```
Admin upload  → API validates → API uploads to Bunny Stream library
                              → store providerAssetId / playbackId

Public watch  → API runs the full authorization chain (unchanged)
              → API mints a short-lived signed Bunny playback URL
              → response carries that URL in an existing URL field
Viewer        → requests video bytes directly from Bunny CDN
```

Origin bandwidth drops to metadata only. Range handling moves to Bunny.

## Backend impact

A `BunnyStreamService` (upload, delete, signed-URL minting), a provider branch
in `videos.service.ts`, playback-URL resolution in `public.service.ts`, and new
creation/purge paths. The authorization chain must not be altered.

## Admin impact

A new upload path in `CreateVideoModal`, provider display (the label already
exists), and progress/error handling for a third-party upload.

## Public impact

Ideally **none**: if signed URLs are returned in an existing field, older
deployed bundles keep working. CSP `media-src` must permit the Bunny pull-zone
host. Verify against the oldest deployed bundle, not only against `main`.

## Database impact

Likely none structurally — `providerAssetId` and `playbackId` already exist. A
new satellite table would only be needed for Bunny-specific state. Any change
needs a migration and an update to [DATA_MODEL.md](../DATA_MODEL.md).

## Environment variables

Reserved and currently **unread**:

| Variable | Intended purpose | Secret |
|---|---|---|
| `BUNNY_STREAM_LIBRARY_ID` | Target library | no |
| `BUNNY_STREAM_API_KEY` | Management API auth | **yes** |
| `BUNNY_STREAM_PULL_ZONE_HOSTNAME` | Playback host | no |
| `BUNNY_STREAM_SIGNING_KEY` | Token-authentication signing | **yes** |

Per-customer values, per the customer deployment model. Names only in
documentation, always.

## Security considerations

- **A signed Bunny URL must never become an unauthenticated bypass.** Keep the
  TTL short and mint it only after full authorization.
- Bunny URLs will appear in responses and browser history exactly as media URLs
  do today; the same redaction rules apply.
- Two new secrets per customer, with their own rotation procedure.
- The share-link revocation story changes: revocation cannot recall an already
  minted signed URL, so TTL bounds the exposure — the same trade-off as media
  grants, and it must be stated explicitly.
- The upload path introduces outbound calls to a third party: timeouts, retries
  and partial-failure handling all need deliberate design.

## Performance considerations

Origin bandwidth and Node event-loop pressure drop substantially. Watch
resolution gains a signing step (cheap, local). Upload becomes slower and
failure-prone in new ways.

## Migration

Existing `LOCAL_FILE` and `DB_BLOB` videos must keep working unchanged.
Any migration is opt-in, per video, reversible, and must not delete the source
until the Bunny asset is verified playable.

## Backward compatibility

The watch response shape must not change. Adding a field is safe; changing the
meaning of `publicPlaybackUrl` for existing source types is not.

## Rollback

Provider selection must be per video, so rollback is: stop creating `BUNNY`
videos, and re-point or restore affected videos to their retained source. This
is only possible if sources are retained through the transition — a hard
requirement.

## Observability

New audit actions for Bunny upload/delete, a health signal for provider
reachability, and clear logging of provider failures **without** logging keys or
signed URLs.

## Acceptance criteria

1. A `BUNNY` video can be created, appears in the admin list, and plays through
   a share link on a customer domain.
2. Every existing authorization check still applies; removing the
   `WebsiteVideo` assignment immediately denies playback.
3. A signed URL expires and stops working at its TTL.
4. A `LOCAL_FILE` and a `DB_BLOB` video still play, unchanged.
5. An older deployed public bundle plays a `BUNNY` video without modification.
6. Purge removes the Bunny asset and the database rows.
7. No key or signed URL appears in any log.

## Required tests

Provider service unit tests (mocked HTTP); signing and expiry; the full
authorization chain for a `BUNNY` video including wrong host, revoked link,
removed assignment and non-`READY` status; purge; and failure handling when
Bunny is unreachable.

## Open questions

- One Bunny library per customer, or one library with per-customer collections?
- Are signed URLs IP-bound? If so, how does that interact with `TRUST_PROXY_*`
  and mobile networks that change IP mid-playback?
- Who owns the Bunny account per customer — us or the customer?
- What is the fallback when Bunny is down: fail closed, or fall back to a
  retained local source?
- Does any customer contract require assets to stay on infrastructure we
  control?

## Before implementing

Read [video-pipeline.md](./video-pipeline.md),
[SECURITY_MODEL.md](../SECURITY_MODEL.md),
[API_CONTRACTS.md](../API_CONTRACTS.md),
[ADR 0004](../adr/0004-hmac-media-grants-for-view-limited-links.md) and
[ADR 0007](../adr/0007-video-storage-direction.md). Then write a full spec from
[FEATURE_TEMPLATE.md](./FEATURE_TEMPLATE.md) and have it reviewed. This document
is context, not a specification.

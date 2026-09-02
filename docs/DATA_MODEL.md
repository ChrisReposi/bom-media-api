# Data Model

Status: CURRENT
Last verified: 2026-08-21
Verified against: `prisma/schema.prisma`, `prisma/migrations/`, `src/database/prisma.service.ts`

Authoritative source: [`prisma/schema.prisma`](../prisma/schema.prisma). This
document explains the *meaning* and the *invariants*; it deliberately does not
reproduce the schema.

## 1. Domain concepts

| Concept | Model(s) | Plain meaning |
|---|---|---|
| Admin identity | `AdminUser` | A person who can sign in to the admin console |
| Admin session | `AdminSession`, `AdminRefreshToken` | One browser's logged-in session and its rotating refresh credential |
| Video | `VideoAsset` (+ asset satellites) | One piece of content, whatever its storage |
| Stored bytes | `VideoBinaryAsset`, `VideoLocalFileAsset`, `VideoLocalThumbnailAsset` | Where the bytes physically live when the CMS stores them |
| Upload in progress | `VideoUploadSession`, `VideoUploadSessionChunk` | A resumable chunked upload |
| Website | `Website` | One customer-facing public site |
| Domain | `WebsiteDomain`, `DomainGroup` | Hostnames, pooled or assigned to a website |
| Publication | `WebsiteVideo` | "This video may appear on this website" |
| Share link | `ShareLink`, `ShareLinkVideo` | A revocable viewing pass over a subset of a website's videos |
| Provenance | `CanonicalVideoShareLink` | Immutable "official" URL for one website+video, for DMCA/evidence |
| Telemetry | `AccessLog`, `AdminAuditLog`, `VideoViewGrowthBucket`, `VideoViewGrowthEvent` | Who accessed what, who changed what, capped display views |
| Theming | `ThemeConfig` | Per-website presentation config (data only; no renderer in this repo) |

## 2. Relationship map

```
AdminUser ─1:N─ AdminSession ─1:N─ AdminRefreshToken
    │                 └──────────────────┘ (token.sessionId, Cascade)
    ├─1:N─ AdminRefreshToken            (Cascade)
    ├─1:N─ AdminAuditLog                (SetNull — logs survive the admin)
    └─1:N─ VideoUploadSession           (Cascade)

DomainGroup ─1:N─ Website               (SetNull)
DomainGroup ─1:N─ WebsiteDomain         (SetNull)
Website     ─1:N─ WebsiteDomain         (SetNull — domain returns to the pool)
Website     ─1:1─ ThemeConfig           (Cascade)
Website     ─1:N─ WebsiteVideo ─N:1─ VideoAsset      (both Cascade)
Website     ─1:N─ ShareLink   ─1:N─ ShareLinkVideo ─N:1─ VideoAsset  (all Cascade)
Website/ShareLink ─1:N─ AccessLog       (SetNull — logs survive)

VideoAsset ─1:1─ VideoBinaryAsset | VideoLocalFileAsset | VideoLocalThumbnailAsset (Cascade)
VideoAsset ─1:N─ VideoUploadSession     (SetNull)
VideoAsset ─1:N─ VideoViewGrowthBucket / VideoViewGrowthEvent (Cascade)

CanonicalVideoShareLink ─N:1─ Website, VideoAsset, WebsiteDomain
CanonicalVideoShareLink ─1:1─ ShareLink
        ALL FOUR RELATIONS ARE onDelete: Restrict
```

## 3. Key uniqueness constraints

| Constraint | Model | Why it matters |
|---|---|---|
| `username` unique | `AdminUser` | Login identity; normalized to lowercase before write |
| `tokenHash` unique | `AdminRefreshToken` | Refresh-token lookup and single-use rotation |
| `slug` unique (nullable) | `VideoAsset` | Human-readable identifier |
| `videoId` unique | `VideoBinaryAsset`, `VideoLocalFileAsset`, `VideoLocalThumbnailAsset` | At most one stored asset of each kind per video |
| `storageKey` unique | local file/thumbnail assets, upload sessions and chunks | No two records may point at the same file |
| `(uploadSessionId, chunkIndex)` unique | `VideoUploadSessionChunk` | Chunk idempotency |
| `slug` unique | `Website` | Website identity |
| `key` unique | `DomainGroup` | Group identity |
| `domain` unique **globally** | `WebsiteDomain` | One hostname resolves to exactly one website |
| `tokenHash` unique, `alias` unique, `transportAlias` unique (nullable) | `ShareLink` | Public credential lookup. All three are bearer credentials: `transportAlias` is the email-safe **alternate** one, resolved only by the compatibility exchange, minted only for canonical single-video links |
| `(websiteId, videoId)` unique | `WebsiteVideo` | One assignment row per pair |
| `(shareLinkId, videoId)` unique | `ShareLinkVideo` | One membership row per pair |
| `(websiteId, videoId)` unique **and** `shareLinkId` unique | `CanonicalVideoShareLink` | Exactly one canonical URL per website+video, and a share link anchors at most one |
| `(videoId, bucketStart)` unique | `VideoViewGrowthBucket` | Hourly cap accounting |
| `(videoId, viewerHash, windowStart)` unique | `VideoViewGrowthEvent` | View de-duplication |

## 4. Critical invariants

> **INVARIANT 1 — A video is public only through an assignment.**
> Public access requires an `ACTIVE` `WebsiteVideo` row for the website resolved
> from the request host, *in addition to* `ShareLinkVideo` membership. Deleting
> or disabling the assignment revokes public access immediately.

> **INVARIANT 2 — `WebsiteDomain.domain` is globally unique and normalized.**
> Two websites can never claim the same hostname. Always normalize through
> `src/common/utils/domain.util.ts` before comparing or storing.

> **INVARIANT 3 — Share credentials are never stored in reversible form.**
> `ShareLink.tokenHash = sha256(SHARE_TOKEN_PEPPER + rawToken)`. The raw token is
> returned exactly once. `alias` is stored in clear by design and is only usable
> together with a matching `ACTIVE` domain and website.

> **INVARIANT 4 — Canonical provenance must never disappear via a cascade.**
> All four `CanonicalVideoShareLink` relations use `onDelete: Restrict`
> (migration `20260719004743_restrict_canonical_record_deletes`). Any hard delete
> of the website, video, share link or canonical domain fails until the canonical
> mapping is removed deliberately. `videos.service.ts` surfaces this as
> `409 VIDEO_HAS_CANONICAL_SHARE_LINK` before attempting the delete.
> Website/share-link lifecycle is status-based (disable/revoke), so this
> constraint does not interfere with normal operations.

> **INVARIANT 5 — Canonical URLs are snapshots.**
> `canonicalHostSnapshot` and `canonicalProtocol` are frozen at creation so the
> recorded URL never follows a later change of primary domain.

> **INVARIANT 6 — Logs outlive their subjects.**
> `AdminAuditLog.adminId` and `AccessLog.websiteId/shareLinkId` are `SetNull`.
> Never convert them to `Cascade`.

> **INVARIANT 7 — `maxViews` is enforced atomically.**
> `currentViews` is incremented with a conditional update that re-checks status,
> expiry and the limit. Never replace this with read-then-write.

> **INVARIANT 8 — Admin soft delete is real.**
> `AdminUser.deletedAt` is checked by the auth guard, login, refresh and
> `getMe`. Any new query that resolves an admin must also exclude
> `deletedAt != null` and `status != ACTIVE`.

> **INVARIANT 9 — A stored asset row implies a real object.**
> `VideoLocalFileAsset.storageKey` must reference a file under
> `LOCAL_FILE_STORAGE_ROOT`. Purge deletes DB rows and files together; orphan
> detection lives in `scripts/storage/find-orphan-local-files.example.sh`.

> **INVARIANT 10 — `viewCount` is a display counter, not analytics.**
> It is `BigInt`, serialised as a string in API responses, and grown by capped,
> deduped increments. Do not treat it as a measurement.

## 5. Important enums

| Enum | Values | Notes |
|---|---|---|
| `AdminRole` | `OWNER`, `ADMIN`, `STAFF` | Enforced by `AdminRolesGuard` |
| `AccountStatus` | `ACTIVE`, `DISABLED` | Used by `AdminUser` |
| `VideoProvider` | `MANUAL`, `BUNNY`, `MUX`, `CLOUDINARY` | `MANUAL`, `CLOUDINARY` and `BUNNY` have code. `MUX` is a `PLANNED` placeholder. A Bunny-backed asset is `provider=BUNNY` + `sourceType=EMBED` + a `metadataJson.bunnyStream` marker; a record merely *labelled* `BUNNY` is an ordinary `DIRECT_URL` video and is untouched by every Bunny branch — see [features/bunny-stream.md](./features/bunny-stream.md) §1.1 |
| `VideoSourceType` | `UPLOAD`, `DIRECT_URL`, `EMBED`, `DB_BLOB`, `LOCAL_FILE` | All implemented; see [features/video-pipeline.md](./features/video-pipeline.md) |
| `VideoStatus` | `DRAFT`, `PROCESSING`, `READY`, `FAILED`, `DISABLED` | Only `READY` is publicly playable |
| `VideoUploadSessionStatus` | `ACTIVE`, `COMPLETING`, `COMPLETED`, `ABORTED`, `EXPIRED`, `FAILED` | Chunked upload lifecycle |
| `EmbedProvider` | `CLOUDINARY_PLAYER`, `YOUTUBE`, `YOUTUBE_NOCOOKIE`, `VIMEO`, `GENERIC_IFRAME` | Must match the public site's embed host allowlist |
| `WebsiteStatus`, `DomainStatus`, `DomainGroupStatus`, `ThemeStatus`, `AssignmentStatus` | `ACTIVE`, `DISABLED` | Soft lifecycle |
| `WebsiteLanguage` | `VI`, `EN` | Presentation metadata |
| `ShareLinkStatus` | `ACTIVE`, `REVOKED`, `EXPIRED`, `DISABLED` | Only `ACTIVE` resolves publicly |
| `AccessLogStatus` | `ALLOWED`, `DENIED` | Public access outcome |
| `AuditStatus` | `SUCCESS`, `FAIL` | Admin action outcome |

> Enum values are mirrored in `bom-media-admin/src/features/videos/videoTypes.ts`.
> Changing an enum here is a breaking change for that file.

## 6. Ownership and deletion behaviour

| If you delete… | …this happens |
|---|---|
| `AdminUser` | Sessions, refresh tokens and upload sessions cascade away; audit logs keep `adminId = NULL`. Prefer `deletedAt` + `status = DISABLED` |
| `Website` | Domains detach (`SetNull`, returning to the pool), theme/assignments/share links cascade, access logs keep `NULL`. **Blocked** if a canonical share link exists |
| `WebsiteDomain` | **Blocked** if it is a canonical domain |
| `VideoAsset` | Asset satellites, assignments, memberships and growth rows cascade; upload sessions detach. **Blocked** if a canonical share link exists |
| `ShareLink` | Memberships cascade, access logs keep `NULL`. **Blocked** if it anchors a canonical link. Prefer `status = REVOKED` |
| `VideoUploadSession` | Chunk rows cascade |

Permanent video deletion goes through `POST /admin/videos/:id/purge`
(OWNER only, requires `confirmVideoId` to equal the id, audited, optionally
deletes the remote Cloudinary **or** Bunny Stream asset — the two branches are
mutually exclusive and each is gated on its own provider check).

> **`WebsiteVideo` rows are removed by the purge, not a barrier to it**
> (2026-08-23). `WebsiteVideo.video` is `onDelete: Cascade`, so the rows would
> disappear with the `VideoAsset` regardless; the purge deletes them explicitly
> — every status, not only `ACTIVE` — so the count can be reported in the
> response and the audit row. The video must still be `DISABLED` first, and
> canonical provenance still blocks with `409`.

> **Bunny Stream needed no schema change.** It reuses `provider`,
> `sourceType`, `providerAssetId`, `playbackId`, `embedProvider`, `embedUrl`,
> `metadataJson` and `status`. No migration was added for it, and no column
> exists for transient encode progress.

## 7. Indexing

The schema indexes for the read paths that matter: video listing and search
(`status`, `(status, createdAt)`, `filterKey`, `(filterKey, status, createdAt)`,
`(provider, providerAssetId)`, `createdAt`, `publishedAt`, `slug`), session and
token validation (`(adminId, revokedAt, expiresAt)`), domain resolution
(`(status, domain)`), share links (`(websiteId, status)`, `expiresAt`) and log
retrieval (`createdAt` plus foreign keys). Migration
`20260714050000_production_hardening_indexes` added the composite hardening
indexes; `20260629024948_add_video_list_search_indexes` added search support.

Add an index in the same migration as any new hot query path.

## 8. Client and connection

`src/database/prisma.service.ts` builds a `PrismaMariaDb` adapter from
`DATABASE_URL`, applying `DB_CONNECTION_LIMIT`, `DB_CONNECT_TIMEOUT_MS`,
`DB_ACQUIRE_TIMEOUT_MS`, `DB_IDLE_TIMEOUT_SECONDS` and the
`DB_MARIADB_USE_TEXT_PROTOCOL` switch. The generated client is emitted to
`src/generated/prisma` (gitignored) — run `prisma generate` before typecheck,
test or build.

`DB_MARIADB_USE_TEXT_PROTOCOL` exists because of a production incident; see
`docs/incidents/2026-07-20-production-admin-video-list-500.md` and
[adr/0006-mariadb-adapter-protocol-controls.md](./adr/0006-mariadb-adapter-protocol-controls.md).

## 9. Migration conventions

- Directory name: `<UTC timestamp>_<snake_case_description>`. 20 migrations
  exist, from `20260529163942_init` to
  `20260902120000_add_share_link_transport_alias` (an additive nullable
  `ShareLink.transportAlias VARCHAR(32)` plus its unique index; no backfill).
- `prisma/migrations/migration_lock.toml` pins `provider = "mysql"`. Never edit.
- Author migrations locally with `yarn db:migrate:dev` (uses
  `SHADOW_DATABASE_URL`). Apply with `yarn db:migrate:deploy`. Never
  `prisma db push` against a shared database.
- Migrations must be **additive and backward compatible** with the running
  build: add nullable columns or new tables, backfill, then tighten in a later
  release. Do not drop or rename a column in the same release that stops using
  it.
- `yarn db:reset` and `prisma migrate reset` are local-only and destructive.
  `scripts/safety/assert-destructive-test-database.ts` guards the destructive
  script paths — do not bypass it.
- Take a database backup before every production migration
  (`docs/operations/backup-restore-runbook.md`).

## 10. Seeding

`prisma/seed.ts` creates the first `OWNER` from `ADMIN_BOOTSTRAP_USERNAME` /
`ADMIN_BOOTSTRAP_PASSWORD` (username must be 3–32 chars, `[A-Za-z0-9_]`, stored
lowercase; password bcrypt-hashed with 12 rounds). Intended for local and
first-time setup. `POST /admin/auth/register` is the alternative one-time path
and is disabled unless `ADMIN_REGISTER_ENABLED=true` **and** the caller supplies
`ADMIN_REGISTER_SECRET`; it refuses to run once any admin exists.

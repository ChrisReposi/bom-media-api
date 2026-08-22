# ADR 0005 — Canonical share links use RESTRICT deletes

Status: ACCEPTED
Last verified: 2026-08-21
Verified against: `prisma/schema.prisma` (`CanonicalVideoShareLink`), migrations `20260718113156_canonical_video_share_links` and `20260719004743_restrict_canonical_record_deletes`, `src/videos/videos.service.ts` (`purgeVideo`)

## Context

Copyright and takedown work needs a stable answer to "what was the official URL
for this video on this website?" Every other relation in the schema cascades, so
deleting a website or a video would silently erase that record — exactly when it
is most likely to be needed.

## Decision

`CanonicalVideoShareLink` records one immutable mapping per website+video, and
**all four** of its relations (`website`, `video`, `shareLink`,
`canonicalDomain`) use `onDelete: Restrict`.

- `canonicalHostSnapshot` and `canonicalProtocol` are frozen at creation, so the
  recorded URL never follows a later change of primary domain.
- `@@unique([websiteId, videoId])` and a unique `shareLinkId` keep it one-to-one.
- `purgeVideo` counts canonical mappings first and raises
  `409 VIDEO_HAS_CANONICAL_SHARE_LINK` with an actionable message, rather than
  letting the database reject the delete opaquely.
- `evidenceFingerprint` and `evidenceSnapshotJson` capture supporting state.

## Alternatives

- **Cascade like everything else.** Provenance disappears exactly when needed.
  Rejected.
- **`SetNull`.** Leaves an orphan row that no longer identifies anything.
  Rejected.
- **Application-level checks only.** A direct SQL console or a future script
  would bypass them. The foreign key holds regardless of who issues the delete.
  Rejected as insufficient.
- **A separate append-only evidence store.** Stronger, and much larger in scope.
  Not rejected on merit — out of scope for now.

## Consequences

- Deleting a website, video, share link or canonical domain **fails** while a
  canonical mapping exists. Removing it is a deliberate act.
- Normal lifecycle is unaffected, because websites and share links are disabled
  or revoked by status, never hard-deleted.
- Purge grew a pre-check and a stable error code the admin UI can surface.
- The schema comment above the model explains the intent; keep it.

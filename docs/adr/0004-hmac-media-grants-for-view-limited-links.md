# ADR 0004 — HMAC media grants for view-limited share links

Status: ACCEPTED
Last verified: 2026-08-21
Verified against: `src/public/public-media-grant.service.ts`, `src/public/public.service.ts` (`toPublicVideoResponses`, `getDeniedReasonForMediaPlayback`)

## Context

A share link may carry a `maxViews` limit. Video playback is not one request: a
browser issues many `Range` requests, and every seek issues more. If each media
request counted as a view, a single viewer would exhaust a 5-view link in
seconds. If media requests skipped the limit entirely, the URL would remain
usable long after the link was exhausted.

## Decision

Views are counted **only** at watch resolution. Media routes check share-link
status and expiry but not `maxViews`; instead, when the link is view-limited,
every media URL returned by the watch response carries a signed grant.

A grant is `base64url(payload) + "." + base64url(HMAC-SHA256(payload, PUBLIC_MEDIA_GRANT_SECRET))`
over `{ v: 1, sid: shareLinkId, vid: videoId, host, exp, purpose: "public_media" }`.

- `exp = min(now + PUBLIC_MEDIA_GRANT_TTL_SECONDS, shareLink.expiresAt)`; the
  TTL is clamped to 5 minutes … 24 hours.
- Verification uses `timingSafeEqual`, requires canonical `base64url`, and
  matches `sid`, `vid`, `host` and expiry exactly.
- Grants are issued only when `shareLink.maxViews !== null`.

## Alternatives

- **Count every media request.** Makes `maxViews` meaningless. Rejected.
- **Ignore `maxViews` on media routes with no compensating control.** The media
  URL would outlive the limit indefinitely. Rejected.
- **Server-side per-viewer sessions for public playback.** Requires state and
  probably cookies on a cross-origin static site. Rejected as disproportionate.
- **Signed URLs for all share links.** Adds a secret dependency and an expiry
  cliff to unlimited links that do not need one. Rejected.

## Scope — what this decision does and does not cover

> **Grants protect only backend-served media routes.** Precisely:
> `/public/watch/:token/videos/:videoId/binary`, `.../local-file` and
> `.../thumbnail`.

| Media class | Grant issued | Grant verified |
|---|---|---|
| `DB_BLOB` on a `maxViews` link | Yes | Yes, per request |
| `LOCAL_FILE` / thumbnail on a `maxViews` link | Yes | Yes — and such links are never served from the metadata cache |
| Any media on an unlimited link | **No** | `hasValidMediaGrant()` returns `true` immediately when `maxViews === null` |
| `DIRECT_URL`, Cloudinary `UPLOAD`, `EMBED` | **No** | **Not applicable — the backend is not in the request path** |

This ADR therefore says nothing about externally hosted media. A
`DIRECT_URL`, Cloudinary `secure_url` or `EMBED` URL is returned verbatim, is
fetched by the browser directly from the provider, and cannot be expired,
counted or denied by this system. Any future provider integration must solve
that separately — see
[ADR 0007](./0007-video-storage-direction.md) and
[SECURITY_MODEL.md §4.1](../SECURITY_MODEL.md#41-backend-served-media-versus-providerdirect-media).

## Consequences

- A viewer admitted once can seek freely for the grant's lifetime.
- The grant binds media access to one video on one host, so it cannot be
  replayed against another video or another customer's domain.
- `PUBLIC_MEDIA_GRANT_SECRET` becomes required in production and must be at
  least 32 characters; rotating it invalidates outstanding grants and forces
  re-resolution.
- Grants appear in URLs, so `req.query.grant` must stay in the Pino redaction
  list.
- Unlimited share links get no grant, and their backend-served media URLs are
  valid until the link is revoked or expires — subject to the `LOCAL_FILE`
  authorization cache window
  ([SECURITY_MODEL.md §4.2](../SECURITY_MODEL.md#42-local_file-media-authorization-cache)).
  That is the accepted trade-off.
- The `maxViews`-only issuance rule is what makes the cache safe: view-limited
  links are excluded from caching by `canCachePublicWatchShareLink()`, so a
  cache hit can never bypass grant verification.

## Status note

`ACCEPTED`, and implemented as described — but the original wording of this ADR
implied broader coverage than the code provides. The **Scope** section above was
added on 2026-08-21 after an independent audit found documentation claiming that
grants and revocation applied to all media URLs. They do not.

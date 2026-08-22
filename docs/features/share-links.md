# Feature: Share links

Status: CURRENT
Last verified: 2026-08-21
Verified against: `src/admin-websites/admin-websites.service.ts`, `src/admin-websites/utils/share-url.util.ts`, `src/admin-websites/canonical-share-link.service.ts`, `src/public/public.service.ts`, `prisma/schema.prisma`

A share link is a revocable viewing pass: it grants access to a chosen subset of
one website's videos, on that website's domains only.

## 1. Model

`ShareLink` belongs to exactly one `Website` and holds:

| Field | Meaning |
|---|---|
| `tokenHash` | `sha256(SHARE_TOKEN_PEPPER + rawToken)`; unique. The raw token is never stored |
| `alias` | ~7-char `base64url`, unique, stored in clear; the customer-facing credential |
| `label` | Operator note |
| `expiresAt` | Optional absolute expiry |
| `maxViews` / `currentViews` | Optional view budget and its counter |
| `status` | `ACTIVE` / `REVOKED` / `EXPIRED` / `DISABLED` |
| `lastViewedAt` | Last successful resolution |

`ShareLinkVideo` holds the ordered membership. Rationale for the two-credential
design is in [ADR 0003](../adr/0003-share-link-alias-and-peppered-token.md).

## 2. Creation

`POST /admin/websites/:websiteId/share-links` (write roles). Body: optional
`label`, `videoIds` (≤ 50, unique), `expiresAt` (ISO-8601), `maxViews` (≥ 1).

```
require SHARE_TOKEN_PEPPER
require the website to be ACTIVE
resolve the video ids   → at least one playable video, else 400
validate eligibility    → each video must be assigned to this website
require one ACTIVE assigned domain, else 400
retry loop (bounded):
    rawToken = "s_" + randomBytes(32).base64url
    alias    = randomBytes(5).base64url
    Serializable transaction:
        re-check creation scope
        create ShareLink + ordered ShareLinkVideo rows
    on alias/token collision → retry
audit SHARE_LINK_CREATE, invalidate public caches
→ { message, shareLink, rawToken, publicUrl }
```

> **`rawToken` is returned exactly once.** It is not recoverable afterwards.
> The alias remains usable.

`publicUrl` is built by `buildPublicShareUrl()` as
`https://<domain>/s/<alias>#/videos`, using `PUBLIC_SITE_PROTOCOL` (and
`PUBLIC_SHARE_LOCAL_PROTOCOL` for localhost-style domains).

## 3. URL forms

| Form | Works on static hosting? |
|---|---|
| `https://<domain>/#/s/<alias>/videos` | Yes — pure hash routing, no rewrite needed |
| `https://<domain>/s/<alias>#/videos` | Only with an SPA rewrite (`.htaccess` / `_redirects`) |
| `https://<domain>/?token=<rawToken>#/videos` | Legacy; accepted, not recommended |
| `/watch/<token>`, `?t=<code>` | Legacy compatibility |

The admin SPA normalises whatever the backend returns into the first form
(`shareLinkUrlUtils.ts`), because that is the form that works everywhere. The
public site accepts all of them.

## 4. Resolution (public)

Full trace in [ARCHITECTURE.md](../ARCHITECTURE.md#6-flow-public-share-link-url-to-playback).
In short: normalize host → `ACTIVE` domain → `ACTIVE` website → find the share
link **within that website** by alias then token hash → check
status/expiry/`maxViews` → intersect `ShareLinkVideo` with `ACTIVE`
`WebsiteVideo` → keep `READY` videos with a usable asset → atomically increment
`currentViews` → log → respond.

Every denial is HTTP `200` with the byte-identical body
`{ valid:false, reasonCode:"INVALID_LINK", website:null, videos:[] }`.
`invalidResponse()` discards the real reason, which is recorded in
`AccessLog.reasonCode` instead. `MISSING_HOST`, `MISSING_TOKEN`, `EXPIRED_LINK`,
`VIEW_LIMIT_REACHED`, `NO_VIDEOS` and `SERVER_ERROR` are **internal /
access-log** codes, never client-visible.

## 5. Revocation and expiry

| Mechanism | Effect on watch resolution | Access-log reason |
|---|---|---|
| `POST /admin/share-links/:id/revoke` | Fails | `INVALID_LINK` |
| `expiresAt` passes | Fails | `EXPIRED_LINK` |
| `currentViews >= maxViews` | Fails | `VIEW_LIMIT_REACHED` |
| Website or domain disabled | Fails | `INVALID_LINK` |
| `WebsiteVideo` assignment removed | That video disappears | `NO_VIDEOS` if none remain |
| `SHARE_TOKEN_PEPPER` rotated | Raw tokens stop working; **aliases keep working** | `INVALID_LINK` |

The client sees `INVALID_LINK` in every one of these cases.

### 5.1 What revocation actually reaches

> **Revocation is not universal. Be precise about this with customers.**

| Target | Reached by revocation? |
|---|---|
| Future watch resolution (the listing) | **Yes, immediately** |
| `DB_BLOB` media | **Yes** — full authorization runs per request |
| `LOCAL_FILE` / thumbnail media, **view-limited** link | **Yes** — never cached |
| `LOCAL_FILE` / thumbnail media, **unlimited** link | **Mostly** — a process-local authorization cache may serve it for up to `MEDIA_METADATA_CACHE_TTL_SECONDS` (default 300 s) in a process that did not observe the invalidation. Admin API mutations invalidate in-process; direct SQL and other processes do not. See [SECURITY_MODEL.md §4.2](../SECURITY_MODEL.md#42-local_file-media-authorization-cache) |
| Outstanding media **grants** | **No** — a grant stays valid until its own expiry, bounded by `PUBLIC_MEDIA_GRANT_TTL_SECONDS` (≤ 24 h) and the link's `expiresAt` |
| `DIRECT_URL` / Cloudinary `secure_url` / `EMBED` URLs | **No** — these are external URLs already disclosed to the browser. The backend is not in their request path and cannot invalidate them. See [KNOWN_ISSUES.md](../KNOWN_ISSUES.md#ki-015) |

Public responses are `no-store`, so no shared HTTP cache retains them, and
cached *watch metadata* is policy-revalidated on every hit.

## 6. Canonical share links

`CanonicalVideoShareLink` records one immutable, official URL per website+video
for provenance and takedown work.

- `GET|POST /admin/websites/:websiteId/videos/:videoId/canonical-share-link`
  (read / write roles). **Not used by the admin UI today.**
- `canonicalHostSnapshot` and `canonicalProtocol` are frozen at creation, so the
  URL never follows a later change of primary domain.
- `buildCanonicalPublicShareUrl()` always emits the hash form
  `https://<host>/#/s/<alias>/videos`, byte-for-byte stable no matter which
  client rebuilds it.
- All four relations are `onDelete: Restrict` —
  [ADR 0005](../adr/0005-canonical-share-link-restrict-deletes.md).

Operational procedures: `../operations/canonical-share-link-runbook.md`.

## 7. Auditing

Creation and revocation write `AdminAuditLog` rows. Every public resolution —
allowed or denied — writes an `AccessLog` row with the domain, hashed IP, user
agent, referer and reason code. Media Range requests are **not** logged, so
`AccessLog` counts admissions, not playback.

## 8. Operational scripts

| Purpose | Command |
|---|---|
| Audit assignment/eligibility drift | `yarn audit:share-link-assignments` |
| Audit canonical mappings (local) | `yarn audit:canonical-share-links` |
| Local smoke | `yarn smoke:local:share-link-assignment` |
| Adopt a canonical link (local) | `yarn remediate:local:adopt-canonical` |

## 9. Backward-compatibility tests

Everything in sections 1-5 is pinned by the release-blocking suite
`test/share-link-compat-*.test.ts`. Before changing share-link creation,
resolution, authorization, provider playback mapping, media grants or the
authorization cache, read
[../SHARE_LINK_COMPATIBILITY_TESTS.md](../SHARE_LINK_COMPATIBILITY_TESTS.md)
and treat a failure there as a blocked release, not a test to update.

## 10. Common mistakes

- **Assuming the raw token can be retrieved later.** It cannot.
- **Assuming revocation invalidates outstanding media grants.** It does not;
  they expire on their own schedule.
- **Assuming revocation invalidates an external provider URL.** For
  `DIRECT_URL`, Cloudinary and `EMBED` videos it cannot — see §5.1.
- **Assuming the client can tell why a link failed.** It always sees
  `INVALID_LINK`; the real reason is in `AccessLog`.
- **Rotating `SHARE_TOKEN_PEPPER` expecting all links to die.** Alias links
  survive; revoke them explicitly.
- **Creating a share link for a video that is not assigned to the website.**
  Rejected at creation, and would be invisible publicly anyway.
- **Treating `AccessLog` as playback analytics.** It counts resolutions.

# Feature: Share links

Status: CURRENT
Last verified: 2026-08-25
Verified against: `src/admin-websites/admin-websites.service.ts`, `src/admin-websites/utils/share-url.util.ts`, `src/admin-websites/canonical-share-link.service.ts`, `src/public/public.service.ts`, `prisma/schema.prisma`

A share link is a revocable viewing pass: it grants access to a chosen subset of
one website's videos, on that website's domains only.

## 1. Model

`ShareLink` belongs to exactly one `Website` and holds:

| Field | Meaning |
|---|---|
| `tokenHash` | `sha256(SHARE_TOKEN_PEPPER + rawToken)`; unique. The raw token is never stored |
| `alias` | `base64url`, unique, stored in clear; the customer-facing credential. **16 chars / 96 bits for links created since 2026-08-25; 7 chars / 40 bits before that.** Existing short aliases are never rotated — see §2.3 |
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

### 2.1 One video is not a small bundle — it is the canonical link

> **The resolved video set decides which path runs.** `CanonicalShareLinkService.createShareLinkForRequest()`
> resolves `videoIds` first (an omitted list still means the website's whole
> active assignment set), then branches on the COUNT.

| Resolved set | Path | Result |
|---|---|---|
| Exactly one video | `createOrGetCanonical()` | The canonical link for that `(websiteId, videoId)` pair. Same id, same alias, byte-identical `publicUrl` on every call. `outcome: "REUSED"` when nothing was written, and **no `rawToken`** |
| Two or more | `createShareLink()` below | A new bundle link each time, unchanged |
| Zero | — | `400` |

Until 2026-08-25 this branch did not exist: every call minted a new ShareLink
with a new alias and a new token, so pressing Create twice for one video
produced two links with two different reviewer URLs, and ten presses produced
ten. The `CanonicalVideoShareLink` mapping that exists to prevent exactly that
was only reachable through §6's dedicated endpoint, which no client called.

Routing lives on the **server** because no client-side "check first, then
create" can be correct — two operators can both check, both miss, and both
create. The `@@unique([websiteId, videoId])` constraint is the arbiter; a loser
of that race recovers by returning the winner's link.

#### 2.1.1 A pair with history but no mapping

Most production pairs are in this state: links were created long before any
canonical mapping existed, because §6's endpoint had no client. Minting a new
canonical link for such a pair would produce exactly the duplicate this feature
exists to prevent, so `createOrGetCanonical()` looks for what is already there
first. The scan runs **inside** the Serializable transaction, alongside the
writes, so a link committed by a concurrent request cannot slip through the gap
between deciding and inserting.

| Exact single-video links found | Result |
|---|---|
| 0 | Create a new canonical link. **The only case that mints one.** |
| 1 | **Adopt it.** Its `id`, `alias`, `tokenHash`, `createdAt`, `label`, `status`, `expiresAt`, `maxViews`, `currentViews` and membership are all preserved untouched; only the mapping row is written. Audited `CANONICAL_SHARE_LINK_ADOPT` |
| 2 or more | `409 CANONICAL_LINK_AMBIGUOUS`. **Nothing is written** |

> **"Exact" is proven, not assumed.** A bundle `[A, B]` contains A, so a
> `some: { videoId }` condition matches it — and adopting a bundle as the
> canonical link for A would publish B to everyone who follows A's canonical
> URL. `findExactSingleVideoCandidates()` therefore fetches the membership rows
> and requires `length === 1` with that one member being the requested video.

> **Adoption pins identity, not usability.** A revoked, disabled, expired or
> exhausted historical link is still adopted — the pair gets its one permanent
> answer — and the request then fails with that link's own status code. No
> replacement is minted and nothing is revived, which is the point: a pair whose
> only link was revoked must stay revoked.

> **Ambiguity is never resolved by guessing.** `createdAt`, status, and alias
> order are all available and all deliberately unused: nothing in the data says
> which already-circulated URL a reviewer was given, and silently blessing one
> would quietly demote the other. The refusal routes the operator to
> `yarn audit:canonical-share-links` and `yarn remediate:local:adopt-canonical`,
> where an owner chooses. Once one is adopted, every later request returns it.

**A canonical request carries no options.** `label`, `expiresAt` and `maxViews`
are refused with `400 CANONICAL_LINK_OPTIONS_NOT_ALLOWED`, because a canonical
link is permanent and unlimited by construction. Accepting and dropping them
would be worse — `maxViews` is an access control, and an operator told "link
created" would believe a budget applied that does not exist. Honouring them on
first creation would be worse still: the pair's single identity could then
expire, with no way to mint a replacement. Bundles still take all three.

**A canonical link that is unusable is refused, never replaced.** Revoked,
disabled, expired, view-exhausted, domain drifted, evidence drifted, video no
longer shareable — each returns a `409` with its own stable code (§6) and
writes nothing. Minting a fresh credential in any of those cases would hand
back access an owner had deliberately taken away, which is the whole reason the
refusal exists. `POST` never revives a `REVOKED` link.

### 2.2 The multi-video path

```
require SHARE_TOKEN_PEPPER
require the website to be ACTIVE
resolve the video ids   → at least one playable video, else 400
validate eligibility    → each video must be assigned to this website
require one ACTIVE assigned domain, else 400
retry loop (bounded):
    rawToken = "s_" + randomBytes(32).base64url
    alias    = randomBytes(12).base64url   # 16 chars, 96 bits - see 2.3
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
`https://<domain>/watch#k=<alias>`, using `PUBLIC_SITE_PROTOCOL` (and
`PUBLIC_SHARE_LOCAL_PROTOCOL` for localhost-style domains).

> `publicUrl` is **computed on read, never persisted.** No table stores a share
> URL string, so changing its shape converts no data and mutates no row.

### 2.3 The alias is a bearer credential

`resolvePublicWatch()` accepts the alias in place of a raw share token, so on
the bound host **the alias alone authorizes the watch**. A canonical alias is
additionally permanent, because a canonical link never expires.

`generateShareAlias()` was `randomBytes(5)` — 7 base64url characters, **40
bits**. That is thin for a bearer credential and the canonical work made it
worse by giving those aliases unlimited lifetime. It is now `randomBytes(12)`:
**16 characters, 96 bits**, which is the full width of `alias VARCHAR(16)` and
therefore needed no migration.

> **Existing aliases are never rotated.** Length is not part of any lookup — the
> resolver matches `alias` by equality with no length or charset assumption in
> the backend, the public site or the Admin — so 7- and 16-character aliases
> coexist indefinitely. Rewriting one would break every reviewer URL already
> handed out, which the compatibility contract forbids.

The alphabet is unchanged (`[A-Za-z0-9_-]`), so nothing about parsing, encoding
or URL shape changes: `encodeURIComponent()` remains a no-op on an alias, which
is what keeps a canonical URL byte-identical whichever client rebuilds it.
Collisions still retry against the `@unique` constraint with fresh CSPRNG
material — never a counter or a suffix.

Pinned by `test/share-url-util.test.ts`.

## 3. URL forms

**V2 — what is generated now:**

| Form | Emitted by |
|---|---|
| `https://<domain>/watch#k=<alias>` | `buildPublicShareUrl()` (bundles) and `buildCanonicalReviewUrl()` (single-video canonical links); both are what Admin copies |
| `https://<domain>/watch#k=<alias>&v=<videoId>` | Admin, when a single video is selected |

**V1 — permanent legacy contract. Still accepted, never re-issued:**

| Form | Note |
|---|---|
| `https://<domain>/#/s/<alias>/videos` | Still generated by `buildCanonicalPublicShareUrl()` as the pinned **provenance** string — never as a link handed to a reviewer. See §6 |
| `https://<domain>/s/<alias>#/videos` | Previous `buildPublicShareUrl()` output |
| `https://<domain>/?token=<rawToken>#/videos` | Previous token branch |
| `/watch/<token>`, `?t=<code>` | Parser compatibility |

The Admin normalises whatever the backend returns into the V2 form
(`shareLinkUrlUtils.ts`); the public site accepts all of them and resolves every
one to the same `ShareLink`.

### Why the credential is in the fragment and not the path

`/watch/<alias>` was considered and **rejected**. The credential is a bearer
secret — `resolvePublicWatch()` accepts it as either an alias or a raw token, and
once the host matches, that alone authorizes the watch. A path segment is sent
to the customer's static host and every proxy in front of it, so it would be
written into access logs that outlive the link. A URI fragment is never
transmitted. V2 buys a clean path without moving the secret.

> **Never emit a share credential in a path segment or a query string.** The
> public repository's compatibility suite asserts this across repositories and
> will fail the build if a generator regresses.

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
| A member video is **disabled** | Fails — the link is swept to `DISABLED` | `INVALID_LINK` |
| `SHARE_TOKEN_PEPPER` rotated | Raw tokens stop working; **aliases keep working** | `INVALID_LINK` |

The client sees `INVALID_LINK` in every one of these cases.

> **`DISABLED` is the one REVERSIBLE row in that table, and it is the only one.**
> Disabling a video sweeps every `ACTIVE` link containing it to `DISABLED`, and
> restoring that video to `READY` sweeps the link back to `ACTIVE`
> (`reactivateShareLinksDisabledWithVideo()` in `videos.service.ts`, the exact
> inverse of `disableActiveShareLinksForVideo()`). This exists because
> "Vô hiệu hóa" is a reversible administrative decision and must not behave like
> a purge of share-link availability — which is precisely what it did until
> 2026-08-24, when `ShareLinkStatus.DISABLED` was written in one place and read
> in none, making it a one-way trapdoor that killed every existing link for a
> video on a single click.
>
> The reversal is deliberately narrow, and the narrowness is the safety property:
>
> - Only `DISABLED` links are eligible. **`REVOKED` never revives** — revocation
>   is an operator decision, not a consequence of video availability — and
>   `EXPIRED` is a terminal clock fact.
> - Only links that still contain the video, so an emptied link cannot revive.
> - Only when **no** remaining member video is still `DISABLED`. Restoring one
>   video of two leaves the link dark, which is the fail-closed direction.
> - Only a return to `READY` counts. `DISABLED → FAILED`/`DRAFT`/`PROCESSING`
>   revives nothing, because none of those is publicly resolvable.
> - `tokenHash`, `alias`, `websiteId`, `expiresAt`, `maxViews` and `currentViews`
>   are **never** rewritten, so a revived link resumes on exactly the credential,
>   domain binding, expiry and remaining view budget it already had. An expired
>   or view-exhausted link therefore returns to `ACTIVE` and is **still denied**
>   by `getDeniedReason()`, which reads those columns and not this status alone.
>
> Pinned by `test/video-lifecycle-disable-restore.test.ts`.

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
  (read / write roles). The Admin console does not call these directly; it
  reaches the same `createOrGetCanonical()` through §2.1, by sending exactly one
  video id to the ordinary create endpoint.
- `canonicalHostSnapshot` and `canonicalProtocol` are frozen at creation, so the
  URL never follows a later change of primary domain.
- **Two URLs, one credential, different jobs.** Both are built from the same
  snapshot and the same alias, and the public site resolves either to the same
  ShareLink:

  | Field | Builder | Shape | Why |
  |---|---|---|---|
  | `publicUrl` | `buildCanonicalPublicShareUrl()` | `https://<host>/#/s/<alias>/videos` | **Provenance.** Copies of this exact string already sit in filed DMCA submissions, so its shape is pinned forever — re-shaping it would make filed evidence disagree with what the system reports |
  | `reviewUrl` | `buildCanonicalReviewUrl()` | `https://<host>/watch#k=<alias>` | **What an operator copies and a reviewer opens.** New links are V2 everywhere else, and this is the link handed out most often |

  `shareLink.publicUrl` inside the response carries `reviewUrl`, matching every
  other share-link response in the API. Only the top-level `publicUrl` is
  pinned to the legacy shape.
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
| Historical share-link status reconciliation (dry run) | `yarn reconcile:share-links` |
| The same, local, writing | `yarn reconcile:share-links:local --apply --confirm-env=local` |

### 8.1 `yarn reconcile:share-links` — one-shot historical sweep

Until 2026-08-24, disabling a video swept its `ACTIVE` links to `DISABLED` and
nothing ever wrote that status back (§5). `reactivateShareLinksDisabledWithVideo()`
closes that for every FUTURE `DISABLED → READY` transition, but cannot heal links
stranded before it shipped — no transition will fire for them again. This command
is the remedy for that residue.

**Dry run by default; `--apply` additionally requires `--confirm-env` to match
`APP_ENV`/`NODE_ENV` exactly**, matching `reconcile:bunny` and
`cleanup:admin-sessions`. It is an explicit administrative command: nothing runs
it at startup, on deploy, on a schedule, or from a request path.

The **only** mutation it can perform is `ShareLink.status: DISABLED → ACTIVE`.
`alias`, `tokenHash`, `websiteId`, `label`, `expiresAt`, `maxViews`,
`currentViews` and `lastViewedAt` never appear in an update payload, and no
`ShareLinkVideo`, `WebsiteVideo`, `VideoAsset` or provider metadata is touched.
It issues no provider request of any kind.

A `DISABLED` link is reactivated only when **all** of these hold:

| Guard | Skip reason |
|---|---|
| At least one `ShareLinkVideo` remains | `NO_MEMBERS` |
| Every membership row resolves to a video | `MEMBER_MISSING` |
| `sortOrder` is exactly `{0..n-1}` — a gap proves a member was purged | `MEMBERSHIP_GAP` |
| Surviving member count equals the count recorded at creation | `MEMBERSHIP_SHRANK` |
| Creation provenance survives at all | `PROVENANCE_MISSING` |
| Creation provenance is well-formed | `PROVENANCE_MALFORMED` |
| Every member is `READY` | `MEMBER_NOT_READY` |
| Every member has a usable asset for its `sourceType` | `MEMBER_NOT_PLAYABLE` |
| No Bunny member is `remoteMissing` or malformed | `MEMBER_BUNNY_REMOTE_MISSING` |
| Every member has an `ACTIVE` `WebsiteVideo` for **this link's** website | `MEMBER_NOT_ASSIGNED` |

Candidates that clear every guard are then classified by **current** usability,
and `--apply` writes only the first:

- `RESTORABLE_AND_CURRENTLY_USABLE` — reactivated.
- `RESTORABLE_BUT_EXPIRED` — reported, left `DISABLED`.
- `RESTORABLE_BUT_VIEW_LIMIT_REACHED` — reported, left `DISABLED`.

#### Historical purge provenance — the three-way verdict

`MEMBERSHIP_GAP` alone is incomplete: purging the **highest-indexed** member
leaves `{0..n-2}`, still contiguous and therefore invisible to it. Two further
sources of provenance close that, both using data historical production rows
already contain:

1. **`SHARE_LINK_CREATE.metadataJson.videoCount`** — the exact `ShareLinkVideo`
   count at creation, keyed by `entityId = shareLinkId`. It is present in
   **every commit of this repository**, so it is available for links created
   long before the lifecycle fix. Comparing it against the surviving member
   count detects any deleted membership row regardless of which index was
   removed, because the only production path that deletes one is
   `detachShareLinkVideosForVideo()`, called only from `purgeVideo()`.
2. **`CanonicalVideoShareLink`** — structural rather than observational. A video
   anchoring a canonical record **cannot** be purged: `purgeVideo()` refuses
   with `409 VIDEO_HAS_CANONICAL_SHARE_LINK` before its transaction, and all
   four relations are `onDelete: Restrict`, so the database would reject the
   delete even if that guard were bypassed.

Every candidate therefore carries one of three verdicts, reported in the
summary as `provenance`:

| Verdict | Meaning | `--apply` |
|---|---|---|
| `SAFE_PROVEN` | Creation provenance survives and the membership is intact, or the link is a purge-immune canonical anchor | **may write** |
| `AMBIGUOUS_PURGE_HISTORY` | No creation provenance survives, or it is malformed, so a purge can be neither proven nor excluded | never |
| `PURGE_PROVEN` | A `sortOrder` gap or a shrunken membership proves a member was destroyed | never |

> **Absence of evidence is not evidence of absence.** `writeAudit()` on the
> creation path is best effort, so a `SHARE_LINK_CREATE` row can legitimately be
> missing. That resolves to `AMBIGUOUS_PURGE_HISTORY` and is never reactivated —
> a missing row must never read as "nothing happened". `videoCount` is accepted
> only as a non-negative safe integer; anything else is malformed, not guessed.
> A member count *exceeding* the recorded one is also ambiguous, because no path
> adds a member after creation and an unexplainable state must not be assumed
> healthy.
>
> The new `SHARE_LINK_STATUS_RECONCILE` event and the new
> `reactivatedShareLinkCount` field are deliberately **not** consulted: both
> postdate the damage and are worthless as historical evidence.

There is intentionally **no operator override** for the two unsafe verdicts.
Reactivating one is a manual, per-link decision.

> **Why expired and exhausted links are reported but never written.**
> `ShareLinkStatus.EXPIRED` is written by no code path — expiry is enforced from
> the `expiresAt` column alone — so there is no status-normalization semantic to
> honour here. Flipping such a row to `ACTIVE` would change nothing any viewer
> can observe, because the independent expiry and `maxViews` gates still deny it,
> while erasing the evidence that it was darkened by the historical bug. Smallest
> write set, identical observable behaviour.

**Safety properties.** The candidate read is scoped to `status = DISABLED`, so
`REVOKED`, `ACTIVE` and `EXPIRED` rows are never read. The mutation is a
conditional `updateMany` that still requires `status = DISABLED` at write time,
which makes it TOCTOU-safe (a concurrent revoke wins) and idempotent (a second
`--apply` changes zero rows). Output is aggregate counts plus `ShareLink`
database ids; `alias` and `tokenHash` are bearer credentials and are never
selected, printed or audited. Each write records an
`AdminAuditLog` row with action `SHARE_LINK_STATUS_RECONCILE` and
`adminId: null` — its own maintenance action, never a fabricated `VIDEO_RESTORE`.

Pinned by `test/share-link-status-reconcile.test.ts`.

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

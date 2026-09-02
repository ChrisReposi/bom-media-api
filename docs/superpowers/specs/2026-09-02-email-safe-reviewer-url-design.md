# Email-safe reviewer URL for the Arcwild private-review flow — design

Status: PROPOSED (uncommitted; production untouched)
Date: 2026-09-02
Scope: `bom-media-api`, `CPR_arcwildstudios`, `bom-media-admin`

## 1. Problem

Arcwild reviewer links are `https://arcwildstudios.com/watch#k=<credential>[&v=<videoId>]`.
The credential lives in the URI fragment, which a browser never transmits, so the
static host and its logs never see it. Some mail clients and link-rewriting
proxies strip fragments, and a server-side fetch of the URL sees only `/watch`.
A reviewer who follows a stripped link lands on the empty Private Review shell.

Goal: add a fragment-independent reviewer URL that survives email transport,
without moving the existing credential into the query string, without creating
a second permission model, and without changing any existing link.

## 2. Forensic findings (Phase 1)

### 2.1 What `k` is

`k` is `ShareLink.alias` — a cleartext, globally unique, base64url bearer
credential stored on the ShareLink row (`prisma/schema.prisma`,
`alias String? @unique @db.VarChar(16)`).

- Minted by `generateShareAlias()` in `src/admin-websites/utils/share-url.util.ts`:
  `randomBytes(12).base64url` = 16 chars / 96 bits since 2026-08-25; historical
  aliases are `randomBytes(5)` = 7 chars / 40 bits and are never rotated.
- Placed in the URL by `buildCleanPublicShareUrl()` → `https://<domain>/watch#k=<alias>`,
  reached from `buildPublicShareUrl()` (bundles) and `buildCanonicalReviewUrl()`
  (canonical single-video links). The no-alias branch would emit the raw token
  instead; it is unreachable from the current create paths.
- Resolved by `PublicService.resolvePublicWatch()` (`src/public/public.service.ts`):
  `shareLink.findFirst({ alias: token, websiteId })` then, if absent,
  `findFirst({ tokenHash: sha256(pepper + token), websiteId })`. So `k` may also be
  a raw share token (`s_` + 43 chars) for legacy links; Admin never emits that.
- It is NOT the ShareLink id, NOT a CanonicalVideoShareLink id, NOT a token
  hash. On the bound host it alone authorizes the watch (ADR 0003).

### 2.2 The V2 flow, traced

```
Admin  POST /admin/websites/:id/share-links {videoIds,...}
  → CanonicalShareLinkService.createShareLinkForRequest()
      1 video  → createOrGetCanonical(): existing mapping (REUSED, assertReusable)
                 | adopt newest exact historical link | mint (alias+token) in one
                 Serializable tx; reviewUrl = https://<snapshotHost>/watch#k=<alias>
      ≥2 videos→ AdminWebsitesService.createShareLink(): mint alias+token,
                 publicUrl = https://<preferredActiveDomain>/watch#k=<alias>
Admin copies publicUrl (CreatedShareLinkCard / DashboardPage auto-copy).
Reviewer opens /watch#k=…  (CPR_arcwildstudios src/js/watch.js)
  readShareEntry(pathname, hash): whole fragment must match ^#k=<cred>(&v=<id>)?$
  ONE fetch: POST <api>/public/watch/exchange {host: location.host, token}
  → resolvePublicWatch(): host→ACTIVE domain→ACTIVE website→ShareLink within
    website by alias/tokenHash→status/expiry/maxViews→ShareLinkVideo ∩ ACTIVE
    WebsiteVideo→READY+playable→ATOMIC incrementShareLinkView()→AccessLog→
    media URLs carry the presented credential in the path (+grant when maxViews)
  Client renders; selection is in-memory; `v=` is a hint bounded by the set.
Media routes  GET /public/watch/:token/videos/:id/{binary,local-file,thumbnail}
  re-run the chain by alias/tokenHash; never increment; grant re-checked.
POST /public/watch/:token/videos/:id/view records display-view growth on the
  VIDEO (`viewCount`), never the ShareLink budget.
Revoke   POST /admin/share-links/:id/revoke → status REVOKED (status only)
Expiry   expiresAt column, enforced at resolution and in the atomic update
maxViews currentViews < maxViews in the atomic update; media via HMAC grant
Domain   host → WebsiteDomain.domain (exact, normalized) → website scope on lookup
```

Important measured facts:

- The V2 exchange CONSUMES one `currentViews` per successful call. Denials
  consume nothing. `/view` does not touch `currentViews`.
- `GET /admin/websites/:id/share-links` returns `publicUrl: null` for every
  item; the only place a reviewer URL is surfaced is the create response.
- Admin does not append `&v=`; the backend emits `#k=<alias>` only.
- Arcwild's build gate (`tools/quality.mjs`) enumerates network calls: exactly
  one `fetch(endpoint, …)` with `const endpoint = apiBase + EXCHANGE_PATH`.
- Backend request logs carry only method + matched route TEMPLATE
  (`safeRequestRoute`); bodies are never logged; `req.query.token|grant` are
  redacted.

### 2.3 Inventory of high-entropy identifiers

| Identifier | Entropy | Role | Usable as transport alias? |
|---|---|---|---|
| `ShareLink.alias` | 96 bits (40 legacy) | THE canonical watch credential (`k`) | No — putting it in a query IS the forbidden shortcut |
| `ShareLink.tokenHash` | hash of 256-bit raw token | second credential, raw value unrecoverable | No — raw token is lost after creation and is the strongest secret |
| `ShareLink.id`, `ShareLinkVideo.id`, `CanonicalVideoShareLink.id` | cuid | database identity | No — not random enough to be a bearer, and not a secret |
| `CanonicalVideoShareLink.evidenceFingerprint` | sha256 of evidence | deterministic provenance | No — reproducible from public facts; nullable |

Conclusion: no existing identifier is a distinct, high-entropy value that can
be spent in a query string without spending an existing credential. A new
column is required. Everything else in the design reuses existing
infrastructure unchanged.

> **TERMINOLOGY, CORRECTED.** An earlier revision of this document called the
> transport alias a "non-authority" identifier. That reads as "harmless" and it
> is wrong. `transportAlias` is an **ALTERNATE BEARER CREDENTIAL**: possession
> → compatibility exchange → access to the same ShareLink. It is a secret and
> is handled as one everywhere. What is true, and what the design actually
> buys, is narrower: it creates no SECOND AUTHORIZATION MODEL, because every
> decision is delegated to the existing ShareLink resolver, and it is a
> distinct value, so compromising it never reveals the `#k` alias.

## 3. Design

### 3.1 Transport alias (new column, additive migration)

`ShareLink.transportAlias String? @unique @db.VarChar(32)`

- Minted by `generateTransportAlias()` = `randomBytes(16).base64url` → 22
  characters, 128 bits, alphabet `[A-Za-z0-9_-]`. Collisions retry via the
  existing unique-violation retry loop (the `alias` needle already matches
  `transportAlias`).
- Stored in CLEAR, deliberately, and documented as such (§5). Hashing at rest
  is not practical here: canonical links are re-issued on every request
  (`outcome: "REUSED"`) and the Admin has no other channel to re-display the
  email-safe URL. The canonical watch credential (`alias`) is already stored in
  clear by design (ADR 0003), so this does not lower the at-rest posture.
- An ALTERNATE BEARER CREDENTIAL for the row, and treated as a secret
  throughout: redacted from logs alongside `alias`, never written to
  `AccessLog`, never echoed in an error, never in audit metadata.
- Tied to the ShareLink row: no own status, no own counter, no own expiry.
  Revoke/expire/disable/exhaust the ShareLink and the transport alias dies with
  it, because resolution delegates to the ShareLink's own checks. Compromise of
  a transport alias therefore grants that link's access until that link becomes
  invalid, and grants nothing else — in particular it never reveals `alias`.
- Minted (a) inside the canonical mint transaction and (b) lazily, once, for an
  existing canonical link on the REUSED path ONLY after `assertReusable()` has
  passed — so a revoked, disabled, expired, limited, domain-drifted or
  evidence-drifted link never receives one. The backfill is a conditional
  `updateMany({ id, transportAlias: null, status: ACTIVE })`, idempotent and
  race-safe.
- **NOT minted for a bundle.** The email-safe URL is emitted only for canonical
  single-video links (§3.1.2), so a bundle alias would be an unused alternate
  bearer credential at rest. Reducing credential surface area beats the
  convenience of having one ready.
- Never rotated, never re-pointed, never minted from a public request.

### 3.1.1 Reviewer-frontend capability gate (added after review)

This backend serves **three** reviewer frontends, and they are not
interchangeable. Every one redeems `#k=`; only one redeems `?r=`. Measured
2026-09-02:

| Frontend | `#k=` | `?r=` | What `/watch?r=…` does today | Backend emits `compatibilityUrl`? | Admin displays it? | Safe? |
|---|---|---|---|---|---|---|
| `CPR_arcwildstudios` — `src/js/watch.js` | yes | **yes** | parses, scrubs, exchanges | yes, once its host is declared | yes | yes |
| `public_website` — `assets/app.js` | yes | **no** | `getUrlSearchToken()` reads only `token`/`t`; no credential found; falls through to the reviewer room's "link is incomplete" state | **no** | no (row omitted) | yes |
| `Worldfold_Studio` — `private-watch-access.js` | yes | **no** | entry grammar matches `#k=` / `#/s/` only; location is **inert** | **no** | no (row omitted) | yes |

Without a gate the second and third would receive a link that loads a real
page and then does nothing — a silent broken link, a worse failure than the
fragment-stripping the feature exists to fix.

**Mechanism.** `PUBLIC_COMPATIBILITY_URL_HOSTS`, a comma-separated hostname
allowlist, matching the existing `VIDEO_EMBED_ALLOWED_HOSTS` convention. No
existing per-website capability mechanism exists (`Website` has no such
column, and `ThemeConfig` describes presentation, not client capability), so
this is the narrowest addition: no migration, no admin surface, no
feature-flag framework.

- **Config, not a database column**, because the capability belongs to the
  deployed frontend *bundle*, not to the `Website` row. The fact declared is
  "the bundle serving this hostname understands `?r=`".
- **One predicate, one place.** `AdminWebsitesService.supportsCompatibilityUrl()`;
  `CanonicalShareLinkService` delegates to it exactly as it already delegates
  the protocol. No hostname guessing is scattered through services, and the
  host tested is the same host the URL would be built from.
- **Fails closed.** Unset ⇒ no website anywhere receives one. A malformed
  entry fails at boot.
- **Minting is unconditional WITHIN the canonical scope** (§3.1.2); only
  *emission* is gated by the host. Declaring a host later is then config-only
  with nothing to backfill. An unemitted alias is unguessable, and redeeming
  one would grant nothing the `#k` alias does not.

### 3.1.2 Canonical single-video scope (added after review)

> **The compatibility exchange consumes a view, at full parity with the `#k`
> exchange. A JAVASCRIPT-EXECUTING MAIL SECURITY SCANNER CAN THEREFORE SPEND
> ONE.**

A plain `GET` of the reviewer URL consumes nothing — a fetching scanner gets
the static shell (§6) — but a scanner that executes the page runs the
bootstrap, reaches the exchange and claims a view. On a **budgeted** link that
is a real loss: a `maxViews: 1` bundle can be exhausted before the reviewer
opens it. Parity is the right design for the exchange and the wrong exposure
for a budgeted link, so the first production version narrows *who gets the URL*
rather than weakening the exchange.

Emission is restricted to **canonical single-video links**, which by their own
contract carry no `expiresAt` and no `maxViews`. A scanner spends one increment
of an unbounded counter, which changes nothing any reviewer can observe.

The predicate is evaluated at the single emission site
(`CanonicalShareLinkService.isCompatibilityUrlEligible()`), not trusted from a
caller — the canonical READ endpoint reaches that site without
`assertReusable()`, so a caller-side guard would not run there. All six clauses
must hold: capable host; a well-formed transport alias actually PERSISTED;
`status === ACTIVE`; `expiresAt === null` and `maxViews === null`; membership
exactly the one video the mapping names; `websiteId` matching the mapping.

**Bundles are excluded structurally, not by a runtime condition:** there is no
bundle-shaped compatibility-URL builder in the codebase, the bundle create
transaction writes no `transportAlias`, and the bundle response hard-codes
`compatibilityUrl: null`. An unlimited bundle is excluded too — "unbudgeted
today" is not a property a bundle carries by contract, and a link that can
acquire a budget must not have already handed out a scanner-spendable URL.

Broadening to bundles is a later, separate decision needing a non-consuming
probe or a budget the exchange does not spend. It is not a change to this
predicate.

### 3.2 URL shape

`https://<domain>/watch?r=<transportAlias>[&v=<videoId>]`

Built by `buildCanonicalCompatibilityUrl()` — the ONLY builder, taking the
canonical snapshot host and protocol, so the URL is byte-stable for the pair.
There is deliberately no bundle-shaped builder (§3.1.2). Physical route
`/watch` is unchanged; Apache serves `watch/index.html` for `/watch?…` exactly
as it does for `/watch`. No rewrite rule is added.

### 3.3 Public API

`POST /api/v1/public/watch/exchange-compatible`
body `{ "host": "<location.host>", "alias": "<transportAlias>" }`
response: byte-identical semantics to `POST /public/watch/exchange`.

Service: `resolvePublicWatchCompatible()`

1. normalize host (null → `MISSING_HOST` access log, generic denial)
2. alias must match `^[A-Za-z0-9_-]{22}$` (else `INVALID_LINK`, generic denial;
   no database read)
3. `shareLink.findUnique({ where: { transportAlias }, select: { alias } })`;
   missing row or null alias → `INVALID_LINK`, generic denial
4. `return this.resolvePublicWatch({ host, token: row.alias, requestMeta })`

Step 4 is the whole authority story: the transport alias is swapped for the
ShareLink's own alias and the UNMODIFIED V2 resolver runs — host/domain/website
scope (`findFirst({alias, websiteId})` re-scopes the row to the host's website),
status, expiry, maxViews, membership, assignment, READY/playable, atomic view
consumption, access log, cache, Bunny gate, media-URL and grant minting. There
is no second resolver and no third lookup on the media routes. Media URLs carry
the ShareLink's alias exactly as the `#k` exchange's do, so every downstream
route is untouched.

`videoId` is deliberately NOT a body field: in the V2 flow `v=` is a
client-side selection hint bounded by the authorized set, and the compatibility
flow keeps that contract (COMPAT-03/09 are proven in the Arcwild suite and by
the resolver's membership intersection).

No fallback: the alias string handed to the resolver is 16 or 7 characters and
a raw token is `s_` + 43, so the resolver's tokenHash branch can never match
another ShareLink.

### 3.4 Arcwild client (`src/js/watch.js`)

`readShareEntry(pathname, hash, search)`:

| Location | Result |
|---|---|
| `#k=…` valid, no `?r=` | fragment flow (unchanged) |
| `?r=<22>` or `?r=<22>&v=<id>` (whole query must match), no share fragment | compatibility flow |
| any `#k…` fragment AND any `?r=` | CONFLICT → fail closed, no request, query scrubbed |
| `?r=` present but query malformed | MALFORMED_QUERY → fail closed, no request, query scrubbed |
| neither | idle (a query without `r` is ignored exactly as today) |

Compatibility flow, in order: parse → capture `v` → `history.replaceState(null,
'', '/watch')` IMMEDIATELY → single `fetch` to `exchange-compatible` with the
alias held only in the module-scoped session → render. The alias is never
written to the URL, DOM, storage, console or a history entry. In-document
selection pushes `#v=<id>` / `/watch` so Back/All-titles work; a reload after
the scrub lands on `/watch` and shows the idle state (no request, nothing to
leak). The existing one-fetch build gate is widened to exactly two literal
paths chosen by the entry kind; count-equality is preserved.

### 3.5 Admin

Backend returns `compatibilityUrl` on `CreateShareLinkResponse` (both paths),
on `CanonicalShareLinkResponse`, and as `shareLink.compatibilityUrl`
(null in list/revoke responses, as `publicUrl` is). `CreatedShareLinkCard`
renders two labelled rows with their own copy buttons: the email-safe link and
the secure `#k` link. Nothing else in the Admin changes; the auto-copy on
create still copies the secure link.

## 4. Security invariant

One authority: the existing ShareLink. The compatibility endpoint adds one
lookup that maps a 128-bit random identifier to a row and then re-enters the
V2 resolver by that row's own alias. It cannot admit anything the `#k` path
would refuse, and it consumes exactly what the `#k` exchange consumes.

## 5. Trade-off, stated honestly

| | `#k=<alias>` (fragment) | `?r=<transportAlias>` (query) |
|---|---|---|
| Sent to the static host / proxies / CDN logs | never | on the first document request |
| Survives fragment-stripping mail clients | no | yes |
| Retained in browser history / HTTP cache index | fragment kept in history | scrubbed from the history entry by `replaceState`; the original URL may still be in the browser's own visit history and cache index |
| What it is | the canonical bearer credential | an ALTERNATE bearer credential for the same ShareLink |
| Authorization model | one resolver | the same one resolver — no second model |
| Redacted from logs | yes | yes, identically |
| Compromise reveals the other | n/a | no — the two values are independent |
| Consumes a view on exchange | yes | yes (parity) |

The compatibility URL is NOT as private as the fragment URL, and its carrier is
NOT a harmless identifier. Both statements have to be made together:

- It exists because reliability through email matters more than log privacy for
  a recipient who would otherwise not get in at all.
- Its identifier is a separate 128-bit **bearer credential**. Whoever reads it
  out of a static-host access log can open that share link until it is revoked.
- What the separation buys is that such a leak yields only the email-safe
  credential. The `#k` alias is not derivable from it, and revoking the
  ShareLink invalidates both at once.
- The `replaceState` scrub happens before any network activity this page
  initiates, so it bounds exposure to the first document request. It does not
  remove that request from the static host's, a proxy's or a CDN's logs.

## 6. Mail-scanner behaviour

A GET of `/watch?r=…` returns the static reviewer shell. It touches no
database row, consumes nothing, logs nothing on the API, and the shell is
identical for every URL. Only a JavaScript-executing client performs the
exchange, and that consumes exactly one `currentViews` — the same as a
JavaScript-executing client opening a `#k` link. Server-side scanners cannot
consume a view.

## 7. Backward compatibility

Unchanged: `alias`, `tokenHash`, `publicUrl`, `reviewUrl`, canonical
provenance URL, every V2/V1 inbound form, media routes, grants, caching,
maxViews/expiry/revoke semantics, Bunny/LOCAL_FILE/DB_BLOB behaviour. The
migration is an additive nullable column plus a unique index; the previous
build ignores it. Historical links without a transport alias keep working
through `#k`; a canonical one gains a compatibility URL the first time it is
re-issued while usable.

## 8. Rollout / rollback

> **The contracts are additive; FEATURE EXPOSURE IS NOT ORDER-INDEPENDENT.**
> The Admin is what puts a URL in front of a human, so it must be the last
> thing to gain the ability to show one and the first thing to lose it. An
> earlier draft proposed Backend → Admin → Arcwild, which would have let an
> operator copy an email-safe URL before the reviewer frontend could redeem
> it.

### 8.1 Rollout — least user-visible first

```
1. BACKEND      build → back up the DB → yarn db:migrate:deploy → restart
                PUBLIC_COMPATIBILITY_URL_HOSTS stays UNSET, so no
                compatibilityUrl is emitted to anyone yet.
2. VERIFY       POST /public/watch/exchange-compatible answers the generic
                denial for a random alias; a known #k link still resolves;
                a fresh single-video create returns compatibilityUrl: null.
3. ARCWILD      npm run package:production with the production API base;
                upload, INCLUDING watch/.htaccess.
4. VERIFY       curl -sD- https://arcwildstudios.com/watch confirms
                Referrer-Policy: no-referrer and the reviewer CSP; open a
                real /watch?r=<alias> against the production backend and
                confirm it plays and that the address bar reads /watch.
                (A transport alias for this step is read from the database
                by the operator; the Admin is not yet showing one.)
5. BACKEND      add arcwildstudios.com to PUBLIC_COMPATIBILITY_URL_HOSTS and
                restart. compatibilityUrl now appears in API responses for
                that host only.
6. ADMIN        build, smoke, deploy atomically. LAST — this is the step that
                exposes the URL to operators, and it is safe only because
                steps 3-5 already proved the link works.
```

Steps 1-2 change nothing a user sees. Step 3 makes the site able to redeem a
URL nobody has yet. Step 5 starts emitting it to the API. Step 6 is the only
step that puts it in front of a person.

### 8.2 Rollback — reverse USER-EXPOSURE order

```
1. ADMIN        redeploy the previous dist/ FIRST. The row disappears
                immediately; the field is simply unread. This alone stops all
                new user exposure and is usually the whole rollback.
2. BACKEND cfg  if URLs already handed out must stop resolving as a class,
                clear PUBLIC_COMPATIBILITY_URL_HOSTS and restart. Emission
                stops; already-sent links keep working, because the endpoint
                is not gated — revoke the individual ShareLink to kill one.
3. ARCWILD      only if the reviewer bundle itself is at fault. Re-upload the
                previous package; it ignores ?r= and shows the idle state.
4. BACKEND      redeploy the previous tag LAST. The column stays and is
                ignored by the old build; no schema change is needed.
```

> **Do not describe the layers as rollback-safe in arbitrary order.** They are
> contract-compatible in any order, which is not the same claim: rolling the
> backend back first while the Admin still displays the field would leave
> operators copying a URL the API has stopped emitting for new links, and
> rolling Arcwild back first would break links the Admin is still handing out.
> The order above is the one that never widens the window in which a user can
> obtain a link that does not work.

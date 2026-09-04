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
| `transportAlias` | `base64url`, unique, nullable, stored in clear; **22 chars / 128 bits**, since 2026-09-02. The identifier behind the EMAIL-SAFE reviewer URL (§3.1), and an **ALTERNATE BEARER CREDENTIAL** for this row — holding one reaches this link's videos through `POST /public/watch/exchange-compatible`, which resolves it into this row's own `alias`. It is a credential on no other route, and it carries no permissions, budget or status of its own. **Minted only for canonical single-video links** (§2.2.1); null on every bundle, and on every canonical row that predates it until the link is next issued while usable |
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
| 0 | Create a new canonical link. **The only case that mints one** |
| ≥ 1 | The **NEWEST** (`createdAt DESC`, `id DESC`) becomes the identity. Its `id`, `alias`, `tokenHash`, `createdAt`, `label`, `status`, `expiresAt`, `maxViews`, `currentViews` and membership are all preserved untouched; only the mapping row is written. Audited `CANONICAL_SHARE_LINK_AUTO_ADOPT` |

> **Adoption pins IDENTITY, not usability — and the winner's status is not a
> selection input.** A revoked, disabled or expired newest link is still adopted;
> the pair gets its one permanent answer and the request then fails with that
> link's own status code. No replacement is minted and nothing is revived, which
> is the point: **a pair whose newest link was revoked must stay revoked.**
>
> Filtering to "usable" candidates first reads as safer and is the opposite. Two
> concrete bypasses it creates:
>
> - L1 (Jan, `ACTIVE`) and L2 (Apr) which an owner REVOKED after a leak →
>   filtering picks L1 and returns a **working** URL.
> - Only L2, revoked → filtering finds nothing usable and **mints a fresh working
>   link** for a video whose only share link the owner deliberately removed.
>
> `currentViews`, `updatedAt` and `lastViewedAt` are never consulted either.

> **"Exact" is proven, not assumed.** A bundle `[A, B]` contains A, so a
> `some: { videoId }` condition matches it — and adopting a bundle as the
> canonical link for A would publish B to everyone who follows A's canonical
> URL. `findExactSingleVideoCandidates()` therefore fetches the membership rows
> and requires `length === 1` with that one member being the requested video.

> **The candidate query filters by NOTHING ELSE.** It carries no status filter
> and no `canonicalVideoShareLink: null` filter, and that absence is load-bearing:
> a `where` clause that removes a row makes it invisible, and an invisible newest
> link means an OLDER link silently wins. The anchor relation is SELECTED instead,
> so an integrity fault can be refused explicitly rather than skipped.

> **Three structural faults refuse the pin outright, writing NOTHING** — no
> mapping, no replacement link, no fallback to an older candidate:
>
> | Blocker | `409` code |
> |---|---|
> | newest link has no usable `alias` | `CANONICAL_HISTORICAL_ALIAS_MISSING` |
> | newest link carries `expiresAt` or `maxViews` | `CANONICAL_HISTORICAL_OPTIONS_PRESENT` |
> | newest link already anchors a **different** pair | `CANONICAL_HISTORICAL_INTEGRITY_CONFLICT` |
>
> `expiresAt` / `maxViews` are legacy **access controls** the canonical contract
> cannot *represent*. **Neither can be bypassed by pinning**: public resolution
> enforces both independently and never consults the canonical mapping (§4).
> What breaks is the canonical contract — `assertReusable()` reads neither, so
> the **admin** side would keep reporting a "permanent" URL while reviewers were
> denied, and once the link lapses the pair's identity is dead with no
> replacement. Minting or falling back WOULD bypass the control; refusing does
> neither.
>
> `alias` is the one genuinely **unremediable** pin: the alias IS the canonical
> URL's credential, so the mapping would commit and `buildCanonicalReviewUrl()`
> would then throw on this request and every later one, with no HTTP path to undo
> it. Refusing keeps the pair fixable — restore the alias and retry.

> **`409 CANONICAL_LINK_AMBIGUOUS` is no longer emitted.** There is exactly one
> newest link, so no irreducible ambiguity remains. The constant is retained for
> client compatibility and produced by nothing.

> **An existing mapping always wins and is never repointed.** Once one exists,
> history is not re-scanned. A newer duplicate created afterwards does not
> displace it. Moving canonical identity is an explicit, OWNER-driven operation
> (`adoptExistingShareLink()`), never a side effect of pressing "Get link".

> **Legacy rows are never rewritten.** Automatic resolution chooses which
> existing row becomes canonical. It never deletes, revokes, renames, re-aliases,
> re-scopes or re-budgets any of them — they may already be cited in DMCA
> evidence or bookmarked by a reviewer.

> **Every precondition is read inside the Serializable transaction** — website
> status, video eligibility, the active domain and the evidence snapshot — so a
> concurrent disable, unassignment or domain change cannot be committed against.
> `yarn audit:canonical-share-links` predicts the outcome per pair in advance,
> including `ADOPT_HISTORICAL_THEN_DENY`, using the **same** policy function the
> request path uses.

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

### 2.2.1 The transport alias is minted for CANONICAL links only

> **A TRANSPORT ALIAS IS AN ALTERNATE BEARER CREDENTIAL, so it is minted only
> where it is actually used.** The email-safe URL is emitted for canonical
> single-video links and nothing else (§3.1.2), so a bundle receiving one would
> be an unused credential sitting at rest for the life of the row. The bundle
> transaction above writes no `transportAlias`, and there is no bundle-shaped
> compatibility-URL builder in the codebase to call.

The canonical mint generates `transportAlias = randomBytes(16).base64url` in
the same attempt as `alias` and the token, so a unique-violation on any of the
three regenerates all three. `compatibilityUrl` is built from the same snapshot
host and protocol as `reviewUrl`.

A canonical mapping committed before the column existed has none. It is
**backfilled exactly once, lazily**, by `CanonicalShareLinkService.ensureTransportAlias()`
on the REUSED path — after `assertReusable()` has passed, so a revoked,
disabled, expired, limited, domain-drifted or evidence-drifted link never
receives one. The write is a conditional
`updateMany({ id, transportAlias: null, status: ACTIVE })`: idempotent, race-safe
(one writer wins, every other racer reloads its value), guarded by status at
write time as well as before it, and audited as `SHARE_LINK_TRANSPORT_ALIAS_BACKFILL`
with ids only. Nothing else about the row is touched. Bundles created before
2026-09-02 are never re-issued by any client and are not backfilled.

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
| `https://<domain>/watch?r=<transportAlias>` | `buildCanonicalCompatibilityUrl()` — the only builder, and canonical-only by construction. The EMAIL-SAFE form, returned as `compatibilityUrl` beside `publicUrl`. See §3.1 |

### 3.1 The email-safe compatibility URL

A URI fragment is never transmitted, which is what makes the `#k` form private
and what makes it fragile: some mail clients and link-rewriting proxies strip
fragments, and a reviewer following such a link reaches an empty page. The
compatibility form puts a carrier in the QUERY STRING instead, where transport
preserves it — and pays for that with privacy, because the static host, every
proxy in front of it and every access log on the way see the query once.

So the carrier is a **different** credential, not a harmless one.
`transportAlias` is a separate 22-character, 128-bit identifier, and it is an
**ALTERNATE BEARER CREDENTIAL**: whoever holds one reaches the same ShareLink.
`POST /public/watch/exchange-compatible`
([API_CONTRACTS.md §3.1.3](../API_CONTRACTS.md#313-post-publicwatchexchange-compatible--the-email-safe-reviewer-exchange-added-2026-09-02))
maps it to its ShareLink and hands that row's own `alias` to the unmodified
`resolvePublicWatch()`: one authority, one budget, one payload.

What the separation buys is narrower than "it is not a secret", and is worth
stating exactly:

- Compromise of a transport alias grants access to that ShareLink's videos,
  under that link's own checks, until the link is revoked or otherwise becomes
  invalid. It is a secret and is redacted everywhere `alias` is.
- Compromise of a transport alias does **not** reveal the `#k` alias. A leaked
  static-host access log yields the email-safe credential and nothing else, and
  revoking the ShareLink kills both at once.
- The two kinds are disjoint by shape in both directions, so neither is
  accepted on the other's route.
- It creates no SECOND authorization model. There is one resolver, one budget
  and one set of checks; the transport alias has no permissions, expiry, view
  budget or status of its own.

| | `#k=<alias>` (fragment) | `?r=<transportAlias>` (query) |
|---|---|---|
| Sent to the static host, proxies, CDN logs | never | on the first document request |
| Survives fragment-stripping mail clients | no | yes |
| What it is | the canonical bearer credential | an alternate, email-safe bearer credential for the same ShareLink |
| Must be redacted from logs | yes | yes — identically |
| Emitted for | every ShareLink | canonical single-video links on a capable host only |
| Checks, budget, payload | the V2 chain | the same V2 chain, entered by the row's own alias |
| Consumes a view on exchange | yes | yes — parity, one shared budget |

> **Do not describe the compatibility URL as having the fragment URL's privacy
> properties.** It does not. It exists because a link that never opens protects
> nobody; the Admin shows it as the *email* link next to the *secure* link and
> says why.

#### 3.1.1 It is emitted only where a reviewer frontend can redeem it

> **THIS BACKEND SERVES SEVERAL REVIEWER FRONTENDS AND THEY ARE NOT
> INTERCHANGEABLE.** Every one of them redeems `#k=`. Only a frontend that has
> shipped the compatibility bootstrap redeems `?r=`. Measured 2026-09-02:

| Frontend | Redeems `#k=` | Redeems `?r=` | What `/watch?r=…` does today |
|---|---|---|---|
| `CPR_arcwildstudios` (`src/js/watch.js`) | yes | **yes** | parses, scrubs, exchanges |
| `public_website` (`assets/app.js`) | yes | **no** | `getUrlSearchToken()` reads only `token`/`t`, so no credential is found; the route falls through to the reviewer room's "link is incomplete" state |
| `Worldfold_Studio` (`private-watch-access.js`) | yes | **no** | the entry grammar matches `#k=` and `#/s/` only; the location is **inert** |

Emitting a compatibility URL for the second or third would hand a reviewer a
link that loads a real page and then does nothing — a silent broken link, which
is a worse failure than the fragment-stripping this feature exists to fix. So
emission is gated on `PUBLIC_COMPATIBILITY_URL_HOSTS`, an explicit list of
hosts whose deployed reviewer bundle can redeem the query form.

- **One predicate, one place.** `AdminWebsitesService.supportsCompatibilityUrl()`
  is the only implementation; `CanonicalShareLinkService` delegates to it
  exactly as it already delegates the protocol, so no second copy can drift and
  no service guesses at a hostname. The value tested is the SAME host the URL
  would be built from — the canonical snapshot host.
- **It fails closed.** Unset means no website anywhere gets a compatibility
  URL. A malformed entry fails at boot rather than being silently dropped.
- **A host, not a database column**, because the capability belongs to the
  deployed frontend bundle rather than to the `Website` row: the fact being
  declared is "the bundle serving this hostname understands `?r=`". It also
  means enabling a customer is a one-line deploy change with no migration and
  nothing to backfill. The shape matches `VIDEO_EMBED_ALLOWED_HOSTS`.
- **It gates REDEMPTION as well as emission.**
  `PublicService.resolvePublicWatchCompatible()` calls the same
  `isCompatibilityCapableHost()` predicate before it examines the presented
  credential, so a transport alias offered on an undeclared host is refused
  with the generic `INVALID_LINK` and is never read from the database. This is
  what makes the variable a kill switch rather than a labelling preference: a
  transport alias is a bearer credential that nothing expires, so gating
  emission alone would leave every already-delivered URL working after an
  operator cleared the list. It **suspends** rather than revokes — restore the
  host and every alias redeems again.
- **`#k=` is untouched and stays universal.** The gate withholds only the new
  field and refuses only the new endpoint. Clearing the allowlist entirely
  leaves every `#k` link on every host working exactly as before.
- **A canonical link is minted or backfilled one regardless of the gate**, so
  declaring a host later needs no data work. It is never emitted for an
  undeclared host, so it is unguessable there; and redeeming one grants nothing
  the `#k` alias does not, because it resolves to the same row through the same
  checks. A bundle gets none at all (§2.2.1) — an alternate bearer credential
  that is never emitted is credential surface area for nothing.
- **`compatibilityUrl` is therefore `null` in three distinct cases** — the pair
  is not an eligible canonical single-video link, the host is not declared, or
  no transport alias is persisted yet — and the Admin renders all three
  identically by omitting the row.

#### 3.1.2 It is emitted only for CANONICAL SINGLE-VIDEO links

> **THE COMPATIBILITY EXCHANGE CONSUMES A VIEW, SO A MAIL SCANNER CAN SPEND
> ONE.** Parity with the `#k` exchange is the design (§3.1), and parity cuts
> both ways: a successful exchange claims one `currentViews`. A plain `GET` of
> the reviewer URL consumes nothing — a scanner that only fetches receives the
> static shell — but a JavaScript-executing mail security scanner runs the
> bootstrap, reaches the exchange, and spends a view. On a **budgeted** link
> that is a real loss: a `maxViews: 1` bundle can be exhausted before the
> reviewer ever opens it.
>
> The first production version therefore restricts the email-safe URL to
> **canonical single-video links**, which by their own contract carry no
> `expiresAt` and no `maxViews` (§2.1). A scanner spends one increment of an
> unbounded counter, which changes nothing any reviewer can observe.

The complete eligibility predicate lives in one place —
`CanonicalShareLinkService.isCompatibilityUrlEligible()`, evaluated at the
single emission site rather than trusted from a caller, because the canonical
**read** endpoint reaches that site without `assertReusable()`. Every clause
must hold:

| # | Clause | Withheld when |
|---|---|---|
| 1 | the snapshot host is in `PUBLIC_COMPATIBILITY_URL_HOSTS` | the reviewer frontend there cannot redeem `?r=` (§3.1.1) |
| 2 | a well-formed `transportAlias` is PERSISTED on the row | never a value this process generated but did not store |
| 3 | `status === ACTIVE` | revoked, disabled or marked expired |
| 4 | `expiresAt === null` **and** `maxViews === null` | any budget or expiry at all |
| 5 | membership is exactly the one video this mapping names | the anchored link has grown a second member |
| 6 | `websiteId` matches the mapping's | a cross-website integrity fault |

Clauses 3–6 duplicate checks `assertReusable()` also makes, deliberately:
`assertReusable()` decides whether a URL may be returned at all on the write
path, while this decides whether the NEW field may be emitted on any path.

**Bundles are excluded structurally, not by a runtime flag.** There is no
bundle-shaped compatibility-URL builder in the codebase, the bundle create
transaction writes no `transportAlias`, and the bundle response hard-codes
`compatibilityUrl: null`. So the outcome for a bundle does not depend on a
condition anyone can get wrong later — including a `maxViews: null` bundle,
which is still excluded because "unbudgeted today" is not a property a bundle
carries by contract.

| Link | Capable host | `compatibilityUrl` | `publicUrl` (`#k`) |
|---|---|---|---|
| Canonical single-video | yes | **emitted** | unchanged |
| Canonical single-video | no | `null` | unchanged |
| Bundle, any `maxViews` | yes | `null` | unchanged |
| Bundle, unlimited | yes | `null` | unchanged |
| Historical bundle | either | `null` | unchanged |

Broadening this to bundles is a **later, separate decision**. It would need a
non-consuming probe, or a budget the exchange does not spend — not a change to
this predicate.

The public site (`CPR_arcwildstudios`, `src/js/watch.js`) scrubs the carrier
from the visible URL with `history.replaceState(null, "", "/watch")` before it
makes any request, holds the alias in one module-scoped variable, redeems it on
the compatibility exchange, and refuses a location that carries **both** a
`#k` fragment and a `?r=` query rather than picking one. A plain `GET` of the
URL — a mail scanner, a link preview — receives the static shell and consumes
nothing; only a JavaScript-executing client exchanges, and that consumes one
view exactly as a JavaScript-executing client opening a `#k` link does.

Pinned by `test/public-watch-compatibility-exchange.test.ts` (backend) and the
`COMPAT-*` scenarios in `CPR_arcwildstudios/tools/watch-test.mjs` and
`tools/watch-browser-test.mjs` (client). Design and trade-off record:
`docs/superpowers/specs/2026-09-02-email-safe-reviewer-url-design.md`.

#### 3.2 Resuming a scrubbed review session

The compatibility URL's privacy comes from removing its own carrier before the
first request. That left one real defect: a refresh, a Back past the entry, or
returning from another tab landed on a bare `/watch/` with nothing to redeem,
and the reviewer had to go back to the email.

`POST /public/watch/resume` closes it without putting a credential anywhere.

```
/watch?r=<transportAlias>
   │  parse, then history.replaceState onto the canonical path
   │  POST /public/watch/exchange-compatible   → payload + resumeGrant
   │  sessionStorage["arcwild.watch.resume.v1"] = resumeGrant
   ▼
/watch/                     the reviewer refreshes, or comes back
   │  POST /public/watch/resume { host, grant }
   ▼  the SAME payload, and NO view spent
```

| | first redemption | resume |
|---|---|---|
| carrier | `?r=<transportAlias>` in the URL | a grant in `sessionStorage` |
| endpoint | `exchange-compatible` | `resume` |
| consumes a view | **yes**, exactly one | **no** |
| authorization | the §4 chain | the same §4 chain, re-read |
| `AccessLog` row | yes | yes |

**What is stored, and what is deliberately not.** The reviewer's tab holds the
grant and nothing else — not the transport alias it arrived with, not a `#k`
credential, not a media grant, not a signed Bunny URL, not the payload. The
selection is not stored either: it already lives in the `#v=` fragment, which
is where Back and forward read it from. `sessionStorage` rather than a cookie
(the reviewer site and the API are different registrable domains, so a cookie
would be cross-site) and rather than `localStorage` (which is shared between
tabs and outlives the browser closing).

**Bootstrap priority**, and it is not a preference between working links:

1. a `#k` fragment — an explicit instruction about which link to open;
2. a `?r=` carrier — likewise, and it supersedes any stored grant;
3. a bare route with a grant in this tab — the only case where the URL says
   nothing and the reviewer is still entitled to their session;
4. otherwise idle.

A fresh entry of either kind **erases the stored grant before requesting a new
one**, so a failed second exchange cannot leave the previous link's grant
behind. A carrier this site cannot account for — a `#k` and a `?r` together, or
a malformed query — erases it too and fails closed: the reviewer followed a
different URL and is owed a truthful answer about it.

**Any authoritative refusal erases it.** A revoke, an expiry, an un-assignment,
a video leaving `READY` and a cleared `PUBLIC_COMPATIBILITY_URL_HOSTS` are all
one generic denial to the client, and all five erase the grant rather than
retrying it on the next refresh. A *transport* failure does not erase — an
offline moment is not the backend refusing, and losing the session over one
would be the worse outcome, while the grant buys nothing the backend does not
re-authorize anyway.

**The canonical path.** Production serves `/watch/`; Apache's `DirectorySlash`
301s `/watch` to it before any script runs. The client writes the pathname it
was actually served at, never a hardcoded one, so no navigation triggers a
second redirect. Both forms are accepted on input.

#### 3.2.1 A resumed reply carries no share credential

> **THE DEFECT THIS CLOSES, STATED PLAINLY.** A resume re-enters the
> unmodified resolver with the row's own `alias`, and every backend media URL
> echoes the presented token into its path. So a resumed reply used to contain
> `/public/watch/<ALIAS>/videos/…` — and redeeming a stolen resume grant ONCE
> yielded the canonical `#k` credential, which then kept working after the
> grant expired, after `sessionStorage` was cleared, and after the host left
> `PUBLIC_COMPATIBILITY_URL_HOSTS`. The TTL bounded nothing.

Both alias-free origins changed; `#k` did not. A `#k` caller presented the
alias, so echoing it back discloses nothing — and every deployed client and
the release-blocking compatibility suite depend on that URL shape. A `?r=`
caller presented only a transport alias, and a resume caller only a session
grant, so for those two the alias is withheld.

> **THE `?r=` HALF CLOSED A SEPARATE, OPERATIONAL DEFEAT.** Until 2026-09-03
> a compatibility reply carried the canonical alias in its media URLs, so a
> stolen transport alias redeemed ONCE yielded a `#k` credential that kept
> working after the host was removed from `PUBLIC_COMPATIBILITY_URL_HOSTS`.
> The kill switch stopped future redemption and nothing else.

**The split is `#k` versus the two ALIAS-FREE origins, not `#k`+`?r=` versus
resume.** An earlier revision of this table grouped the first `?r=` redemption
with `#k`, which was true only before 2026-09-03 and is exactly the defect the
note above records as closed. `mediaTokenModeFor()` now returns one alias-free
mode for `compat` and `resume` alike, so they share this column:

| | `#k` (canonical) | first `?r=` **and** every resume |
|---|---|---|
| `:token` segment | the presented credential | `rmv1<payload><sig>` |
| scope | the whole ShareLink | ONE video |
| host binding | the request host | bound into the MAC domain |
| expiry | the link's | `min(media TTL, the originating review session's expiry)` |
| survives the kill switch | yes — it is `#k` | **no** |

`playbackUrl`, `embedUrl` and a stored external thumbnail never carried a
credential and are unchanged; a signed Bunny player URL is Bunny's own and
contains no share value at all.

**No client change was required, and that was a constraint rather than luck.**
The reviewer client refuses a media URL whose path segments fall outside
`[A-Za-z0-9_-]{1,256}` — an alphabet pin that exists because a looser test let
Chrome normalise `%2e%2e` into a path the validator had not approved. The
token is shaped to fit it: pure base64url, no separator, the host in the MAC
domain rather than the payload so even a 253-character hostname stays inside
the limit (worst case measured, 207 of 256).

Pinned by `test/public-watch-resume.test.ts` RESUME-25…34, which search the
serialized reply for the literal credential rather than a named field list.

Pinned by `test/public-watch-resume.test.ts` (backend) and the `RESUME-*`
scenarios in `CPR_arcwildstudios/tools/watch-test.mjs` and
`tools/watch-browser-test.mjs` (client). Security model:
[SECURITY_MODEL.md §2.0.1](../SECURITY_MODEL.md#201-the-review-resume-grant--a-pointer-not-a-permission).

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
| `LOCAL_FILE` / thumbnail media, **unlimited** link, **`#k` credential** | **Mostly** — a process-local authorization cache may serve it for up to `MEDIA_METADATA_CACHE_TTL_SECONDS` (default 300 s) in a process that did not observe the invalidation. Admin API mutations invalidate in-process; direct SQL and other processes do not. See [SECURITY_MODEL.md §4.2](../SECURITY_MODEL.md#42-local_file-media-authorization-cache) |
| `LOCAL_FILE` / thumbnail media, **`compat`/`resume` `rmv1` token, any budget** | **Yes, immediately** — `rmv1` media tokens bypass this cache entirely (both read and write) and re-read every authorization fact from the database on every request, so this row's bounded exposure never applies to a compatibility or resumed session |
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

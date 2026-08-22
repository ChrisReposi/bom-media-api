# Share-Link Compatibility Test Manifest

Status: CURRENT
Criticality: RELEASE-BLOCKING
Last verified: 2026-08-22
Verified against: `test/share-link-compat-*.test.ts`, `src/public/**`, `src/admin-websites/admin-websites.service.ts`, `src/videos/videos.service.ts`, `src/videos/storage/local-video-storage.service.ts`, `prisma/schema.prisma`

The contract these tests defend is
[`../../project-docs/SHARE_LINK_COMPATIBILITY.md`](../../project-docs/SHARE_LINK_COMPATIBILITY.md).
This file is the map from that contract to the tests — it does not restate it.
Mutation evidence lives in
[SHARE_LINK_COMPATIBILITY_MUTATION_REPORT.md](./SHARE_LINK_COMPATIBILITY_MUTATION_REPORT.md).

## 1. What this suite is

Automated regression coverage that pins the **current, source-verified**
behaviour of existing production share links, so that future work — Bunny
Stream, provider changes, public-site changes, auth/security refactors, database
migrations, playback changes — cannot silently invalidate a link that works
today.

Every assertion was written against the source, not against a desired design.
Where current behaviour is a documented trade-off (the unlimited `LOCAL_FILE`
authorization cache, provider URLs outside backend revocation), the test records
the behaviour that exists and says so in a comment. **No test claims a stronger
guarantee than the code provides.**

## 2. Failure meaning

> **A failing SHARE-LINK COMPATIBILITY test is RELEASE BLOCKING.**

Do not weaken, skip or delete one to make a build green. The only legitimate way
past a failure is an explicitly approved compatibility migration carrying all
four of:

1. a migration strategy for existing links,
2. a backward-support window,
3. staging proof against realistic legacy data,
4. a rollback strategy.

Absent those, a failure means the change breaks existing production share links
and must not ship.

## 3. Design rules the suite follows

These exist because a compatibility gate that fails on cosmetic change is worse
than no gate — it trains people to override it.

1. **Behaviour over introspection.** A property is proved by what a caller
   receives — denied or served, which bytes, which status — not by inspecting
   query objects, call counts or cache internals. Where an internal assertion
   survives it is labelled *secondary coverage* and is never the contract.
2. **Independent expectations.** The token-hash expectation is a literal
   computed outside this codebase (§5), not the output of the function under
   test.
3. **Positive controls.** Every "must be denied" test is paired with a case
   proving the same fixture *is* servable when the one thing under test is
   correct, so a denial can never pass for the wrong reason.
4. **No brittle assertions.** Property *sets*, not key order. Parsed URL
   pathname plus query parameters, not exact query strings. Case-insensitive
   header lookups. No assertions on private helper sequencing, Prisma query
   objects, Prisma call counts, SQL text or controller constructor arity.
5. **A response double proves what a controller *sets*; only a real server
   proves what a client *receives*.** Express rewrites `Content-Length` when
   `res.send()` is reached, so anything asserting the wire contract of `HEAD`,
   `Content-Length` or status codes runs over a real Nest + Express server
   (COMPAT-035). This rule exists because a double previously hid a real
   regression - see the mutation report, M8.

## 4. Layout

Files live flat in `test/` alongside every other suite, because `yarn test`
globs `test/*.test.ts` and does not descend into subdirectories. The
`share-link-compat-` prefix is the grouping.

| File | Tests | Covers |
|---|---|---|
| `test/share-link-compat-harness.ts` | — | Shared synthetic fixtures and fakes (not a suite) |
| `test/share-link-compat-http-harness.ts` | — | Transpiler compensation for the HTTP suites (not a suite) |
| `test/share-link-compat-resolution.test.ts` | 41 | COMPAT-001 … 013 |
| `test/share-link-compat-providers.test.ts` | 18 | COMPAT-020 … 024 |
| `test/share-link-compat-media-delivery.test.ts` | 18 | COMPAT-009, 030 … 034 |
| `test/share-link-compat-http.test.ts` | 7 | COMPAT-035 |
| `test/share-link-compat-cache-grants.test.ts` | 24 | COMPAT-040 … 042, 044 |
| `test/share-link-compat-routes.test.ts` | 12 | COMPAT-050, 051 |

Run the group on its own:

```bash
npx tsx --import ./test/test-env.ts --test test/share-link-compat-*.test.ts
```

They are also part of `yarn test`.

### In CI

`backend / validate` runs both, as separate **execution gates**:

```
npx tsx --import ./test/test-env.ts --test test/share-link-compat-*.test.ts
yarn test
```

The first names the compatibility files directly, so a change to the
`test/*.test.ts` glob cannot silently drop one. Both are release-blocking, and
the exit code is the proof — no output is parsed.

A third step is a **manifest consistency gate**, not an execution gate:

```
node scripts/ci/check-compat-manifest.mjs
```

It compares the `COMPAT-nnn` ids named in `test/share-link-compat-*.test.ts`
with the ids documented in this file, and fails on any disagreement or on drift
from the expected total of **31**.

> It proves the documented inventory and the test inventory still agree. It
> proves **nothing** about whether a test ran or passed.

Ids are compared as sets — an id legitimately appears in several tests and
repeatedly in this document's prose, so duplicate occurrences are not an error.

## 5. The independent legacy token fixture

COMPAT-001 would be circular if the expected hash came from `hashShareToken()`.
It does not. `share-link-compat-harness.ts` carries an immutable literal
computed **outside this codebase**, with a different SHA-256 implementation
(Python `hashlib`), over the exact byte sequence `pepper ‖ token`:

```
python -c "import hashlib; print(hashlib.sha256((PEPPER + TOKEN).encode('utf-8')).hexdigest())"
```

The production function is called only to produce *actual* behaviour. Three
things follow:

- The share-link fixture's `tokenHash` column holds **the literal**, so
  resolution end-to-end proves the production hashing path still reproduces the
  stored legacy digest.
- The digest of the **reversed** concatenation is pinned as a second literal, so
  swapping the operands cannot pass unnoticed.
- A change to the algorithm, the encoding, the concatenation order or any
  normalisation of either input changes the output and fails the test.

### Exactly what the vectors prove

| Vector | Proves | Does not prove |
|---|---|---|
| `LEGACY_*` (ASCII pepper + ASCII token) | The digest, the algorithm and the pepper-first concatenation for the credential shape production actually issues | Anything about non-ASCII input |
| `REVERSED_CONCATENATION_HASH` | Swapping the operands produces a different, pinned value | — |
| `UNICODE_TOKEN_PEPPER` (40 code points, 47 UTF-8 bytes) | `SHARE_TOKEN_PEPPER` is hashed as UTF-8 bytes. Peppers come from the environment, so a non-ASCII value is realistic | Anything about non-ASCII **tokens** |
| `NFC_TOKEN_PEPPER` / `NFD_TOKEN_PEPPER` | No Unicode normalisation is applied: the same visual pepper in two normalisation forms yields two different, independently pinned digests | — |

**Share tokens are deliberately not covered by a non-ASCII vector.**
`generateShareToken()` emits `s_` + base64url, which is ASCII by construction,
so a non-ASCII token would assert a format production never produces. The
suite claims UTF-8 and normalisation fidelity for the **pepper** only.

Token, pepper and every digest are synthetic. **No production token or pepper
appears anywhere in the suite.**

## 6. Manifest

| ID | Behaviour locked | Surface | File | Status |
|---|---|---|---|---|
| COMPAT-001 | Legacy raw `s_…` token resolves against an independently computed stored digest; pepper-first concatenation pinned in both directions; a non-ASCII pepper is hashed as UTF-8; no Unicode normalisation is applied; pepper rotation kills raw tokens | credential | `…-resolution` | COVERED |
| COMPAT-002 | Legacy alias resolves; survives pepper rotation; the presented credential is carried into media URLs | credential | `…-resolution` | COVERED |
| COMPAT-003 | **Behavioural cross-tenant isolation**: a video actively assigned to *both* websites, one share per website — each credential works only on its own host, in both directions, for watch and media, with positive controls proving the video itself is authorized on both. Plus unknown host, disabled domain/website, host normalization, sibling domains. No Prisma `where` object is inspected | resolution | `…-resolution` | COVERED |
| COMPAT-004 | `REVOKED` / `DISABLED` / `EXPIRED` deny watch **and** backend media; a denial consumes no view | authorization | `…-resolution` | COVERED |
| COMPAT-005 | Past `expiresAt` denies; `EXPIRED_LINK` reaches `AccessLog` only | authorization | `…-resolution` | COVERED |
| COMPAT-006 | Eleven denial causes all return the byte-identical denial body; the public property *set* is fixed; internal reason codes never reach the client; every media denial is the same generic 404 | public contract | `…-resolution` | COVERED |
| COMPAT-007 | `ACTIVE` unlimited link resolves repeatedly; `currentViews` is a counter, not a budget; no grant issued or required | authorization | `…-resolution` | COVERED |
| COMPAT-008 | Exactly `maxViews` resolutions succeed; concurrent requests at the final view admit exactly one; heavier concurrency never exceeds the budget | authorization | `…-resolution` | COVERED |
| COMPAT-009 | A view-limited link spends one view on watch resolution and **zero** on any number of `LOCAL_FILE` / `DB_BLOB` Range requests; media requests write no `AccessLog` row. Asserted on observable state only — `currentViews`, whether a further viewer can be admitted, and served bytes — never on Prisma call counts | playback | `…-media-delivery` | COVERED |
| COMPAT-010 | An `ACTIVE` `WebsiteVideo` assignment **for the resolving website** is required for both the listing and backend media | authorization | `…-resolution` | COVERED |
| COMPAT-011 | **Real non-member videos**: `video-y-local` and `video-y-blob` exist globally, are `READY`, playable, and hold ACTIVE assignments to the *same* website — they are simply absent from `ShareLinkVideo`. They are never listed, streamed or view-recorded, while member videos of the same types are | authorization | `…-resolution` | COVERED |
| COMPAT-012 | `READY` is the only publicly playable status; `READY` plus a usable asset is required per source type | authorization | `…-resolution` | COVERED |
| COMPAT-013 | **Adversarial ordering**: membership rows sit physically as C, A, B with `sortOrder` 30, 10, 20; output must be A, B, C. Also holds while filtering an unauthorized video out of the middle | authorization | `…-resolution` | COVERED |
| COMPAT-020 | `DIRECT_URL` returns the stored `playbackUrl` verbatim, no grant, no backend route; admin-path URLs are nulled | provider | `…-providers` | COVERED |
| COMPAT-021 | `EMBED` returns `embedUrl` / `embedProvider` / `embedAllow` verbatim with no backend playback route | provider | `…-providers` | COVERED |
| COMPAT-022 | `LOCAL_FILE` returns the token-bound `local-file` and `thumbnail` routes, never the stored admin URL | provider | `…-providers` | COVERED |
| COMPAT-023 | `DB_BLOB` returns the token-bound `binary` route with `publicPlaybackUrl === binaryPlaybackUrl` | provider | `…-providers` | COVERED |
| COMPAT-024 | All three Cloudinary shapes keep working: upload (`UPLOAD` + `secure_url`), direct (`DIRECT_URL` on a `cloudinary.com` host), player embed (`EMBED` + `CLOUDINARY_PLAYER`). None receives a backend grant | provider | `…-providers` | COVERED |
| COMPAT-030 | `LOCAL_FILE` with no `Range` → `200` with the whole file; asserted at the service **and** through the real controller | playback | `…-media-delivery` | COVERED |
| COMPAT-031 | Satisfiable single range → `206` with `Content-Range`; suffix and open-ended ranges preserved | playback | `…-media-delivery` | COVERED |
| COMPAT-032 | Beyond-end, unparseable, bound-less, multi-range, non-`bytes` and inverted ranges → `416`, `Content-Range: bytes */<total>`, **no `Content-Length`** | playback | `…-media-delivery` | COVERED |
| COMPAT-033 | `HEAD` returns the full header set with no body, for `LOCAL_FILE` and `DB_BLOB`, full and ranged | playback | `…-media-delivery` | COVERED |
| COMPAT-034 | **DB_BLOB through the real `PublicController`**: (A) full GET, (B) Range GET, (C) full HEAD — *and no blob read is issued*, (D) ranged HEAD, (E) invalid Range. Plus byte-accurate suffix/open-ended ranges at the service layer. Asserted against a response double, so it covers what the controller *sets* | playback | `…-media-delivery` | COVERED |
| COMPAT-035 | **DB_BLOB over a real Nest + Express server**: full HEAD reports the full resource length (not `0`), ranged HEAD reports the range length with `Content-Range`, unsatisfiable Range on HEAD returns `416`, HEAD and GET agree on every header, and no blob read is issued for a HEAD. This is the surface a response double cannot reach — see the mutation report, M8 | playback | `…-http` | COVERED |
| COMPAT-040 | The unlimited `LOCAL_FILE` cache exists, and its key is independently proved on **all three dimensions** — host (A), credential (B), video (C) — behaviourally, with a no-cache control run. Also: a link expiring inside the TTL is not cached | cache | `…-cache-grants` | COVERED (records the KI-020 window; asserts no stronger guarantee) |
| COMPAT-041 | **Release-blocking.** A link with `maxViews !== null` is never cached, so a cache hit can never skip `hasValidMediaGrant()`; view-limited watch metadata is not cached; `DB_BLOB` is never cached | cache | `…-cache-grants` | COVERED |
| COMPAT-042 | Grant binds `{sid, vid, host, exp}`; **cross-share replay** between two view-limited shares on the same host and video is refused in both directions, through the real `PublicMediaGrantService` in the production media path; **independent grant expiry** denies while the share stays `ACTIVE` and unexpired, with a fresh-grant positive control; cross-video and cross-host replay, tampered/truncated/oversized grants refused | grant | `…-cache-grants` | COVERED |
| COMPAT-043 | `maxViews` has no supported mutation path after `ShareLink` creation | structural | — | **DOCUMENTED INVARIANT — NOT A RUNTIME RELEASE-GATE TEST.** See §7 |
| COMPAT-044 | **Real admin mutation paths invalidate the authorization cache**: `AdminWebsitesService.revokeShareLink()`, `updateVideoAssignments()` (unassign), `assignSingleVideo()`, and `VideosService.disableVideo()` — each driven as the production service, sharing one `MemoryCacheService` with `PublicService` | cache | `…-cache-grants` | COVERED |
| COMPAT-050 | **Controller route-decorator compatibility.** Legacy `GET /public/watch`, `POST /public/watch/exchange`, the view route and all three media routes resolve on the right methods with HEAD working, and five near-miss paths still 404. Scope: the controller is registered *directly* under a prefix the test sets, so this proves the decorators — **not** that the controller is reachable in the real app | routing | `…-routes` | COVERED (scope stated) |
| COMPAT-051 | **Production wiring.** `AppModule` imports `PublicModule`; `PublicModule` registers `PublicController`; the real config factory still yields the `api/v1` prefix COMPAT-050 mounts under. These read the same module metadata `NestFactory.create(AppModule)` reads at boot | routing | `…-routes` | COVERED (see §8 for what is still not booted) |

## 7. COMPAT-043 — structural invariant, not a runtime gate

**Classification: STRUCTURAL / DOCUMENTED INVARIANT. NOT a runtime
release-gate test.**

An earlier revision asserted this by scanning source files with a regular
expression. That was withdrawn: a regex over a fixed file set cannot establish
absolute immutability, it breaks on unrelated refactors, and a release gate that
can be defeated by moving code to a new file is not a gate.

### The invariant, as of 2026-08-21

> **`maxViews` has no supported mutation path after `ShareLink` creation.**

It is set once, in `admin-websites.service.ts` at share-link creation
(`tx.shareLink.create`). `canonical-share-link.service.ts` pins it to `null` on
the links it creates and refuses to adopt a link that carries one. No endpoint,
service method or script updates it on an existing row. `revokeShareLink()`
writes only `status`.

### Why it matters

COMPAT-041 leans on it. An entry cached while a link was **unlimited** would
still be served without a grant if that same link could later become
**view-limited** — the cached entry predates the budget and the cache is
consulted before `hasValidMediaGrant()`. Today that transition cannot occur.
`…-cache-grants` carries a test named *"documents the hazard that COMPAT-043
keeps closed"* which makes the coupling explicit without pretending to gate it.

### MANDATORY RULE FOR FUTURE DEVELOPMENT

> If any future application path is introduced that can transition an existing
> share link from unlimited to view-limited, or otherwise mutate `maxViews`,
> that change **MUST** either:
>
> 1. invalidate all relevant media and watch authorization caches, **or**
> 2. redesign caching so a stale unlimited authorization cannot survive the
>    transition,
>
> and **MUST** introduce behavioural compatibility and security tests covering
> the transition — at minimum: an entry cached while unlimited must not serve an
> ungranted media request after the link becomes view-limited.

Treat that as a review checklist item on any change to `ShareLink` mutation
surfaces.

## 8. Deliberate non-goals

- **No Bunny scenarios.** Bunny is `PLANNED` with no implementation
  (`docs/features/bunny-stream.md`); it is not legacy production behaviour and
  has nothing to keep compatible.
- **No test asserts that a provider/direct URL becomes invalid on revocation.**
  It does not, and writing that test would encode a false guarantee. See
  [SECURITY_MODEL.md §4.1](./SECURITY_MODEL.md#41-backend-served-media-versus-providerdirect-media)
  and [KNOWN_ISSUES.md KI-015](./KNOWN_ISSUES.md#ki-015). Backend-served and
  provider-served media are kept in separate assertions throughout.
- **No test asserts immediate revocation for unlimited `LOCAL_FILE` media on an
  out-of-band change.** The source caches it; COMPAT-040 records the actual
  window ([KI-020](./KNOWN_ISSUES.md#ki-020)) and COMPAT-044 shows that the real
  admin paths do close it.
- **DTO validation is not asserted in the route suite.** `tsx`/esbuild does not
  emit the parameter metadata `ValidationPipe` needs, so validation does not run
  in that harness; asserting it would test the harness. It is covered directly
  against `class-validator` in `test/public-watch-exchange.test.ts`.

## 9. How the fakes stay honest

The fake Prisma client in the harness applies only the filters, ordering and
limits that the services put in their own query arguments — the
`shareLinkVideos` `where`, the `orderBy`, the `take`, the `currentViews.lt`
guard. Each predicate is applied *only when asked for*, so dropping `websiteId`
or `status` from a query surfaces as a real authorization failure rather than as
a blanket "nothing resolves". It reimplements no production logic.

Three things are not faked at all:

- `LOCAL_FILE` Range behaviour — the media-delivery suite runs the real
  `LocalVideoStorageService` against a `mkdtemp` storage root.
- Media grants — the real `PublicMediaGrantService`, verified through the
  production media authorization path.
- Cache invalidation — the real `AdminWebsitesService` and `VideosService`,
  sharing one real `MemoryCacheService` instance with `PublicService`, exactly
  as the Nest container wires them.

Four things are not faked at all — `LocalVideoStorageService`, the grant
service, the admin/video services above, and, in COMPAT-035 and COMPAT-050, the
Nest + Express HTTP server itself.

One test-only shim exists, in `test/share-link-compat-http-harness.ts`:
`design:paramtypes` is defined on `PublicController` before a testing module
compiles it, because tsx/esbuild does not implement `emitDecoratorMetadata`
while the production build does. It supplies the same list the compiler emits.

**Constructor arity is not pinned as a compatibility contract.** Adding a
dependency to a controller breaks no share link, so it must never fail a release
gate. The helper cannot invent an injection token for a parameter it has never
seen, so when that happens it throws an error whose first words are
`TEST HARNESS MAINTENANCE REQUIRED (not a compatibility regression)` and which
names the file to update. Triage it as harness maintenance.

## 10. Test-data safety

No production tokens, aliases, hosts, customer records or secrets. Every fixture
is deterministic and synthetic; the peppers and grant secret are obvious test
placeholders. No suite opens a database connection. The route suite binds an
ephemeral port on `127.0.0.1` and closes it in `after()`; the media-delivery
suite removes its temporary storage root in `afterEach()`.

## 11. Related documents

- [`../../project-docs/SHARE_LINK_COMPATIBILITY.md`](../../project-docs/SHARE_LINK_COMPATIBILITY.md) — the contract
- [SHARE_LINK_COMPATIBILITY_MUTATION_REPORT.md](./SHARE_LINK_COMPATIBILITY_MUTATION_REPORT.md) — mutation evidence
- `scripts/test/share-link-compat-mutations/` — the reproducible mutation runner:
  `npx tsx scripts/test/share-link-compat-mutations/run.ts` (audit-only; never part of `yarn test` or CI)
- [`features/share-links.md`](./features/share-links.md) — how share links work
- [`SECURITY_MODEL.md`](./SECURITY_MODEL.md) §4 — the public authorization chain
- [`API_CONTRACTS.md`](./API_CONTRACTS.md) §3 — the public response contract
- [`TESTING.md`](./TESTING.md) — how to run the suite
- [`KNOWN_ISSUES.md`](./KNOWN_ISSUES.md) — KI-015 and KI-020, both referenced above

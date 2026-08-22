# Share-Link Compatibility Suite — Mutation Report

Status: CURRENT
Last verified: 2026-08-22
Verified against: a full run of `scripts/test/share-link-compat-mutations/run.ts` on 2026-08-22

A green suite only means something if it can go red. This records the mutation
evidence for every release-blocking protection in
`test/share-link-compat-*.test.ts`.

**The mutations are no longer described in prose — they are executable.** The
runner and the mutation definitions are committed test-only tooling, so anyone
auditing this claim can reproduce it exactly rather than trusting a transcript.

## 1. Reproducing this report

```bash
npx tsx scripts/test/share-link-compat-mutations/run.ts
```

One id, or several:

```bash
npx tsx scripts/test/share-link-compat-mutations/run.ts M8
```

| Path | Contents |
|---|---|
| `scripts/test/share-link-compat-mutations/mutations.ts` | One entry per mutation: target file, the exact edit, which suites must fail, and a pattern the failing test title must match |
| `scripts/test/share-link-compat-mutations/run.ts` | The runner |

### Why it is not part of `yarn test`

It edits files under `src/` while it runs. Nothing that mutates source should
execute on every build or in CI. It is an explicit audit command, run
deliberately and pasted here.

### Safety properties the runner enforces

- **One mutation at a time.** Never two files, never two edits.
- **Original bytes captured before any write**, restored in a `finally`, and
  again on `SIGINT` / `SIGTERM` / `uncaughtException`, so an interrupted run
  cannot leave mutated source behind.
- **Restoration verified twice** — SHA-256 of the file against the pre-mutation
  digest, and `git status --porcelain` over `src/`, `prisma/` and
  `package.json` at the end of the run.
- **Refuses to start** if the working tree already has changes under those
  paths, because restoration could not then be distinguished from pre-existing
  edits.
- **Fails the run (exit 1)** when a mutation *survives*, when the wrong test
  fails, or when restoration cannot be verified. A mutation that no longer
  applies cleanly is reported as `APPLY_FAILED` rather than silently skipped.

The failure path is itself verified: a deliberately cosmetic probe mutation was
added temporarily, and the runner reported `SURVIVED … FAILED: 1 mutation(s)
did not behave as required` and exited 1 while still restoring the file. The
probe was then removed.

## 2. Results — full run, 2026-08-22

15 mutations, all **CAUGHT**, all restored.

| # | Mutation | Target | Suite that must fail | Result |
|---|---|---|---|---|
| M1 | `hashShareToken` concatenates token before pepper | `public/utils/share-token.util.ts` | resolution | **CAUGHT** — "keeps a legacy raw token resolvable against its independently stored hash" |
| M2 | Watch share-link lookup no longer scoped by website | `public/public.service.ts` | resolution | **CAUGHT** — "refuses one tenant's credential on another tenant's host" |
| M3 | Watch include no longer orders by `sortOrder` | `public/public.service.ts` | resolution | **CAUGHT** — "returns multi-video shares in sortOrder, not in row order" |
| M4 | `canCachePublicWatchShareLink` no longer excludes view-limited links | `public/public.service.ts` | cache-grants | **CAUGHT** — 3 tests incl. "keeps requiring the grant on every view-limited media request" |
| M5-host | Media cache key drops the host dimension | `public/public.service.ts` | cache-grants | **CAUGHT** — "A - keys the cache by host" |
| M5-credential | Media cache key drops the credential dimension | `public/public.service.ts` | cache-grants | **CAUGHT** — "B - keys the cache by credential" |
| M5-video | Media cache key drops the video dimension | `public/public.service.ts` | cache-grants | **CAUGHT** — "C - keys the cache by video" |
| M6 | Grant no longer bound to the share-link id | `public/public-media-grant.service.ts` | cache-grants | **CAUGHT** — "refuses a grant from another share link on the same host and video" |
| M7 | Grant expiry no longer verified | `public/public-media-grant.service.ts` | cache-grants | **CAUGHT** — "refuses a grant whose own expiry has passed, while the share stays valid" |
| **M8** | **DB_BLOB controller drops the HEAD short-circuit** | `public/public.controller.ts` | **http** | **CAUGHT** — see §3 |
| M8c | DB_BLOB controller stops passing `headOnly` to the service | `public/public.controller.ts` | http, media-delivery | **CAUGHT** — both HEAD contracts |
| M9 | DB_BLOB ranged responses report `200` instead of `206` | `public/public.service.ts` | media-delivery, http | **CAUGHT** — Range wire contract |
| M10 | `revokeShareLink()` no longer invalidates public caches | `admin-websites/admin-websites.service.ts` | cache-grants | **CAUGHT** — "share revocation through AdminWebsitesService invalidates cached media authorization" |
| M11 | `VideosService` no longer clears `media:metadata:` | `videos/videos.service.ts` | cache-grants | **CAUGHT** — "disabling a video through VideosService invalidates cached media authorization" |
| M12 | `AppModule` no longer imports `PublicModule` | `app.module.ts` | routes | **CAUGHT** — "keeps PublicModule registered in AppModule" |

Closing line of the run:

```
git working tree clean under src/: YES

All mutations were caught and every file was restored.
```

## 3. M8 — reclassified: CAUGHT REGRESSION

**The previous revision of this report classified M8 as an equivalent mutation.
That conclusion was wrong and is withdrawn.**

The earlier suite exercised the controller through a hand-written response
double, which recorded `setHeader` calls verbatim. A double cannot reproduce
what Express does *after* the controller returns, and Express does something
load-bearing here. Verified empirically against Express 5.2.1:

```
res.setHeader("Content-Length", "10");
res.send(Buffer.alloc(0));          // Express RESETS Content-Length to 0
```

| Route shape | HEAD status | HEAD `Content-Length` |
|---|---|---|
| with the controller's `if (method === "HEAD") res.end()` | 200 | **10** |
| without it (mutation M8) | 200 | **0** |

So the short-circuit is observable production behaviour: without it a `HEAD`
reports a resource length of zero, and a client that probes with `HEAD` before
issuing Range requests is told the resource is empty.

`test/share-link-compat-http.test.ts` (COMPAT-035) now runs the real
`PublicController` and real `PublicService` over a real Nest + Express server on
an ephemeral loopback port, so the mutation is detected:

```
M8   DB_BLOB controller drops the HEAD short-circuit, so Express rewrites Content-Length to 0
     -> CAUGHT (4 failing test(s)); restored=OK
        failing: A - full HEAD reports the full resource length and sends no body
        failing: B - ranged HEAD reports the range length and sends no body
        failing: keeps HEAD and GET reporting the same headers for the same request
        failing: COMPAT-035 DB_BLOB media over real Nest + Express
```

No production code was changed. The lesson is recorded in the suite header: a
response double is adequate for asserting what a controller *sets*, and
inadequate for asserting what a client *receives*.

## 4. What the mutation set still does not cover

- **`LOCAL_FILE` Range arithmetic inside `LocalVideoStorageService`** is not
  mutated. The media-delivery suite exercises the real implementation against a
  real temporary file, and M9 mutates the equivalent DB_BLOB path.
- **Provider mapping (COMPAT-020…024)** is not mutated. Each assertion is a
  direct equality against the stored fixture value, so a mapping change is
  detected by construction.
- **Controller route decorators (COMPAT-050)** are not mutated; M12 covers the
  module-wiring half of that surface, and the route paths are asserted directly
  including near-miss paths that must 404.

## 5. Adding a mutation

Add an entry to `mutations.ts` with an `apply` that asserts it matched exactly
one site, the suites that must fail, and a title pattern that must appear among
the failures. Then run the runner and paste the result into §2. If a mutation
ever reports `APPLY_FAILED` after a refactor, fix the mutation — do not delete
it.

# Canonical Video Share Links — Definitions, Operations, Adoption

## Link purposes

| Purpose | Shape | Rules |
|---|---|---|
| CANONICAL_VIDEO | exactly one website + one video | one mapping per pair (DB-unique), stable alias, snapshotted host/protocol, no expiresAt/maxViews, never silently replaced |
| REVIEW_BUNDLE | one website + many videos | created via the generic share-link endpoint; each call may create a new link; **not** the canonical URL of any member video |
| TEMPORARY_ACCESS | generic link with expiry/maxViews | unchanged legacy behavior, revocable |

Canonical URL format (byte-for-byte stable, recorded in DMCA filings):

```txt
<protocol>://<snapshotted-host>/#/s/<alias>/videos
```

It is built only from the `CanonicalVideoShareLink` snapshot — never from the
currently preferred/primary domain. A canonical URL does not prove copyright
ownership and does not guarantee DMCA acceptance; the checksum in the evidence
snapshot proves content integrity only.

## API

```txt
POST /api/v1/admin/websites/:websiteId/videos/:videoId/canonical-share-link   (idempotent create-or-get)
GET  /api/v1/admin/websites/:websiteId/videos/:videoId/canonical-share-link   (read-only, reports evidenceDrift)
```

- Same pair → same ShareLink id, alias, and identical publicUrl; outcome
  `REUSED`. Canonical callers never receive `rawToken` or `tokenHash`; the
  alias in `publicUrl` is the public credential used by this workflow.
- Stable conflict codes: `CANONICAL_LINK_REVOKED`, `CANONICAL_LINK_INACTIVE`,
  `CANONICAL_DOMAIN_UNAVAILABLE`, `CANONICAL_EVIDENCE_DRIFT`,
  `CANONICAL_EVIDENCE_INCOMPLETE`, `CANONICAL_VIDEO_NOT_SHAREABLE`. No silent
  replacement, ever.

At creation time the API generates a raw token only transiently in memory to
calculate the stored `tokenHash`, then discards it before response
serialization. Neither value is logged or included in canonical audit
metadata. The generic review-bundle endpoint retains its legacy one-time
`rawToken` response. Public resolution remains alias-first with the legacy
`tokenHash` fallback unchanged. Gate 2 verification did not access Production.

The DB_BLOB evidence snapshot selects the nullable SHA-256 persisted on
`VideoBinaryAsset` together with its size and MIME. The fingerprint includes
that checksum, so replacing bytes with different content is detected even
when size and MIME are unchanged. Size plus MIME is never accepted as an
integrity substitute. New DB_BLOB uploads and replacements populate the hash;
a legacy null-checksum DB_BLOB returns `409 CANONICAL_EVIDENCE_INCOMPLETE`
before create/adoption writes, and an existing incomplete mapping is not
silently regenerated or reused. Gate 3B performed no blob scan, automatic
backfill, database integration proof, or Production access; the isolated
Gate 3C-1 proof below subsequently verified that contract without backfill.

LOCAL_FILE continues to use its persisted file checksum. DIRECT_URL, provider
upload (including Cloudinary), and EMBED retain their URL/provider identity
fields; those identifiers support deterministic comparison but do not prove
that remote bytes behind an unchanged identifier are immutable. Checksums are
integrity evidence, not ownership or copyright proof.

## Mutation policy while a canonical mapping exists

| Mutation | Policy |
|---|---|
| thumbnail/description/filterKey/viewCount edits | ALLOWED_WITHOUT_DRIFT |
| title / duration / publishedAt / playback / provider / embed identity edit | MARKS_DRIFT → POST returns `CANONICAL_EVIDENCE_DRIFT` until owner review |
| LOCAL_FILE / DB_BLOB binary replacement | MARKS_DRIFT (DB_BLOB detects checksum change even with unchanged size/MIME) |
| video disable / assignment deactivate | OWNER action; POST returns `CANONICAL_VIDEO_NOT_SHAREABLE`; URL preserved |
| video purge | BLOCKED (`VIDEO_HAS_CANONICAL_SHARE_LINK`, DB FK Restrict backs it) |
| domain host rename / unassign | BLOCKED (`DOMAIN_HAS_ACTIVE_CANONICAL_LINKS`); disable/transfer are transitively blocked because they require unassign first; domain delete is DB-Restricted |
| share-link revoke | allowed (owner incident action); mapping stays; POST returns `CANONICAL_LINK_REVOKED` |
| isPrimary toggle | allowed — canonical resolution never depends on primary flag |

Drift/revoked resolution is an OWNER decision. Rotation (new alias for a pair)
is intentionally **not implemented**; if ever needed it must be a separate
step-up-authenticated OWNER endpoint that audits old and new ids.

## Legacy history is now resolved AUTOMATICALLY (changed 2026-08-28)

> **The operator no longer chooses which historical link becomes canonical for
> an ordinary duplicate pair, and `409 CANONICAL_LINK_AMBIGUOUS` is no longer
> emitted.** The previous policy refused the moment two exact single-video links
> existed for a pair, which made "Get link" unusable for exactly the pairs that
> most needed it and routed the operator into a **local-only** remediation
> script that has no production-safe equivalent.

For a pair with **no** mapping, `createOrGetCanonical()` resolves it in one
deterministic step:

| Exact single-video links | Result |
|---|---|
| 0 | A new canonical link is created. **The only case that mints one** |
| ≥ 1 | The **NEWEST** (`createdAt DESC`, `id DESC`) becomes the identity. Audited `CANONICAL_SHARE_LINK_AUTO_ADOPT` |

> **THE WINNER'S STATUS IS NOT A SELECTION INPUT.** A `REVOKED` / `DISABLED` /
> `EXPIRED` newest link is still the pair's identity: it is pinned and the
> request then fails closed with that link's own code. **No older ACTIVE link is
> promoted, and no fresh link is minted.** Doing either would silently return
> access an owner deliberately removed — which is the entire reason the selection
> ignores status.

Three structural faults refuse the pin and write **nothing** — no mapping, no
replacement link, and no fallback to an older candidate:

| `409` code | Meaning | Operator action |
|---|---|---|
| `CANONICAL_HISTORICAL_ALIAS_MISSING` | the newest link has no usable alias | restore the alias on that link, then retry |
| `CANONICAL_HISTORICAL_OPTIONS_PRESENT` | the newest link carries `expiresAt` or `maxViews` | clear the limit on that link, or resolve the pair deliberately. Do **not** work around it by revoking the link — that only changes which conflict you get |
| `CANONICAL_HISTORICAL_INTEGRITY_CONFLICT` | the newest link already anchors a different pair | owner review. `shareLinkId` is unique, so this cannot arise by design |

**Nothing about legacy rows is rewritten** — no delete, revoke, rename,
re-alias, re-scope or re-budget. Automatic resolution only chooses which
existing row becomes canonical.

**An existing mapping is never repointed.** A newer duplicate appearing later
does not displace it, whatever its state.

## Audit — see the outcome before it happens

```bash
yarn audit:canonical-share-links --counts-only   # summary + predicted outcomes
yarn audit:canonical-share-links                 # masked per-pair worksheet
```

The audit is **dry run only — there is deliberately no `--apply`**. The request
path adopts lazily and correctly on its own, so a bulk writer would add a second
way to create permanent, `onDelete: Restrict` provenance rows without adding any
capability. It is read-only, masks ids and aliases, never selects `tokenHash`,
and in production requires `AUDIT_CONFIRM_READ_ONLY=yes` on a read-only
connection.

It reports, per pair:

| `resolution` | Meaning |
|---|---|
| `ALREADY_CANONICAL` | pinned; never repointed |
| `ADOPT_HISTORICAL` | the newest link is pinnable and `ACTIVE` — it will just work |
| `ADOPT_HISTORICAL_THEN_DENY` | the newest link is pinnable but revoked/disabled/expired. It **will** be pinned and the request **will** then deny. Intended — but review it before an operator meets it live |
| `BLOCKED_OWNER_REVIEW` | a structural fault blocks the pin; see `pinBlocker`. Nothing is written |
| `MINT_NEW` | the pair has **no** exact history at all |

plus `winner` (masked), `winnerStatus`, `pinBlocker`, `historical` count, and a
separate list of pairs holding a duplicate created **after** their canonical
mapping — not a correctness problem, since an existing mapping always wins, but
each one is a second circulating URL for a video that should have one.

> **The prediction is binding.** It is computed by the same
> `selectCanonicalAutoAdoptable()` the request path uses
> (`src/admin-websites/utils/canonical-adoption-policy.util.ts`), not by a
> second implementation of the same intent, so the report cannot name a
> different winner than the code picks.

**No backfill run is required.** Lazy adoption on the normal create/get path is
correct on its own; the audit exists so an operator can review the estate first.

See `canonical-share-link-adoption-worksheet.md` for the remaining cases that
still need a human.

### Manual adoption — now only for the cases policy will not decide

Automatic resolution covers ordinary duplicate history. `adoptExistingShareLink()`
remains for the deliberate cases it deliberately does **not** cover: choosing a
link the policy would reject (one already cited in DMCA records that has since
been given an expiry, say), or pinning a specific link ahead of the newest
eligible one. It is **local operator tooling and has never been an HTTP
endpoint**; production adoption remains a manual operator procedure performed
after a backup.

> **It cannot repoint an existing mapping.** `shareLinkId` and
> `(websiteId, videoId)` are both unique, so adoption fails once a pair is
> already mapped. Moving canonical identity after the fact is not implemented in
> either direction — see the rotation note above.

```bash
yarn remediate:local:adopt-canonical \
  --website-id <id> --video-id <id> --share-link-id <id> \
  --admin-id <adminUserId> --confirm-local
```

Adoption verifies: link belongs to the website, contains exactly the target
video, has an alias, no expiry/maxViews, ACTIVE assignment, READY/playable
video, a known ACTIVE domain, and no existing mapping. A DB_BLOB must already
have a valid persisted SHA-256; legacy null evidence is refused before the
mapping or success audit write. Successful adoption snapshots evidence and
writes the audit row in the same transaction. There is no bulk mode and no
automatic blob read/backfill.

## Destructive proof isolation (mandatory after the 2026-07-19 dev-DB incident)

Destructive database proofs are **forbidden** against `video_share_cms_dev`.
They run only against a disposable local database whose name ends with
`_test`/`_scratch`, via:

```bash
cp .env.test.example .env.test           # once; local Docker credentials
DOTENV_CONFIG_PATH=.env.test APP_ENV=test yarn prisma migrate deploy
ALLOW_DESTRUCTIVE_DB_TESTS=I_UNDERSTAND_THIS_DELETES_FIXTURES \
  yarn test:integration:canonical-fk

# Gate 3C-1: real compiled API + MySQL DB_BLOB evidence proof
ALLOW_DESTRUCTIVE_DB_TESTS=I_UNDERSTAND_THIS_DELETES_FIXTURES \
  yarn test:integration:canonical-db-evidence
```

`scripts/safety/assert-destructive-test-database.ts` hard-refuses anything
else: wrong APP_ENV, non-local host, non `_test`/`_scratch` database (dev is
rejected even with the confirmation), missing/incorrect typed confirmation, or
malformed URL — validated on the EFFECTIVE env, because `load-env` gives
`.env.local` override priority whenever `.env` sets `APP_ENV=local` (an
exported `DATABASE_URL` is silently replaced; `DOTENV_CONFIG_PATH` is the only
deterministic selector).

Fixture contract enforced by `scripts/test/canonical-fk-proof.ts`: unique
run-scoped ids → create via Prisma → count-verify every row **before** any
destructive statement → assert the expected P2003 block and row survival →
revoke-retention check → dependency-order cleanup → zero-leftover check; any
deviation exits non-zero. Never suppress stderr or exit codes around database
commands.

`test:integration:canonical-db-evidence` builds and starts the real compiled
Nest API on a disposable local port. Both the parent harness and API child
validate the effective datasource; the harness additionally requires the
exact database name `video_share_cms_test` and all 19 repository migrations.
It creates a unique `gate3c1_<timestamp>_<random>` fixture graph and proves:

- a real multipart DB_BLOB upload persists exact bytes, size, MIME, and a
  server-computed SHA-256, then canonical POST creates exactly one link,
  relation, mapping, and success audit without returning `rawToken` or
  `tokenHash`;
- unchanged content returns `REUSED`, identical alias/public URL and
  `evidenceDrift=false` without new canonical writes;
- a real multipart replacement with equal size and MIME but different bytes
  changes the checksum, makes POST return `409 CANONICAL_EVIDENCE_DRIFT`, and
  makes the read-only GET retain the original identity with
  `evidenceDrift=true` without overwriting its snapshot;
- a run-scoped legacy DB_BLOB with null checksum makes both canonical create
  and the existing adoption service return
  `CANONICAL_EVIDENCE_INCOMPLETE`, with zero mapping/success-audit writes and
  the generic legacy link unchanged.

Cleanup runs in `finally`, targets only run-derived identifiers, restores all
test-table aggregate counts, stops the API child, and verifies no proof-owned
database connection remains. The 2026-07-19 proof started and ended with zero
rows in all fixture tables. Count-only shared-dev snapshots before and after
were identical; Production was not accessed. This proof does not backfill or
remediate legacy null checksums — that remains Gate 3C-2 owner/operator work.

Incident record: on 2026-07-19 a Gate-1 proof deleted one dev website and one
dev video (fixture inserts had silently failed; DELETEs then ran against real
ids). The rows were **not recovered** — the five ACTIVE assignments added
afterwards are recovery fixtures, not original data.

## Migration and rollback

- Migration `20260718113156_canonical_video_share_links` is additive
  (CREATE TABLE + FKs). Legacy ShareLink rows are untouched; nothing is
  auto-marked canonical.
- Corrective migration `restrict_canonical_record_deletes` switches the
  Website and ShareLink foreign keys from Cascade to **Restrict**, making the
  final delete policy all-Restrict on all four relations. Rationale: canonical
  provenance must never disappear via a cascade — the database is the final
  boundary even against future code paths or direct SQL. The normal lifecycle
  (website disable, share-link revoke, video disable) is status-only and
  unaffected; deleting any parent of a canonical mapping now fails (MySQL
  1451) until the mapping is removed deliberately first. Verified live: all
  four parent DELETEs blocked; revoke allowed with the mapping retained.
- Production: `yarn db:migrate:deploy` after backup, then restart. Rollback =
  redeploy the previous API build; the table is ignored by the old build and
  the Restrict FKs are backward-compatible (the old build never hard-deletes
  these parents). Do not drop the table while any canonical URL is in a
  filing.

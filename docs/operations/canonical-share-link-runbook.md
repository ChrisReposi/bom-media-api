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
  `CANONICAL_VIDEO_NOT_SHAREABLE`. No silent replacement, ever.

At creation time the API generates a raw token only transiently in memory to
calculate the stored `tokenHash`, then discards it before response
serialization. Neither value is logged or included in canonical audit
metadata. The generic review-bundle endpoint retains its legacy one-time
`rawToken` response. Public resolution remains alias-first with the legacy
`tokenHash` fallback unchanged. Gate 2 verification did not access Production.

Gate 3A adds a nullable, persisted SHA-256 for the exact bytes stored in each
`VideoBinaryAsset`. New DB_BLOB uploads and replacements populate it; legacy
rows may remain null and no Production backfill was run. The checksum supports
integrity comparison, not ownership proof. Canonical evidence does not consume
this DB_BLOB field in Gate 3A; selecting it, defining legacy-null behavior, and
using it for fingerprint/drift comparison are explicitly deferred to Gate 3B.

## Mutation policy while a canonical mapping exists

| Mutation | Policy |
|---|---|
| thumbnail/description/filterKey/viewCount edits | ALLOWED_WITHOUT_DRIFT |
| title / duration / publishedAt / playback / provider / embed identity edit | MARKS_DRIFT → POST returns `CANONICAL_EVIDENCE_DRIFT` until owner review |
| LOCAL_FILE / DB_BLOB binary replacement | MARKS_DRIFT (checksum/size change) |
| video disable / assignment deactivate | OWNER action; POST returns `CANONICAL_VIDEO_NOT_SHAREABLE`; URL preserved |
| video purge | BLOCKED (`VIDEO_HAS_CANONICAL_SHARE_LINK`, DB FK Restrict backs it) |
| domain host rename / unassign | BLOCKED (`DOMAIN_HAS_ACTIVE_CANONICAL_LINKS`); disable/transfer are transitively blocked because they require unassign first; domain delete is DB-Restricted |
| share-link revoke | allowed (owner incident action); mapping stays; POST returns `CANONICAL_LINK_REVOKED` |
| isPrimary toggle | allowed — canonical resolution never depends on primary flag |

Drift/revoked resolution is an OWNER decision. Rotation (new alias for a pair)
is intentionally **not implemented**; if ever needed it must be a separate
step-up-authenticated OWNER endpoint that audits old and new ids.

## Legacy audit and adoption (owner-driven, never automatic)

```bash
yarn audit:canonical-share-links --counts-only   # summary
yarn audit:canonical-share-links                 # masked owner worksheet
```

The audit is read-only, masks ids/aliases, never selects tokenHash, and in
production requires `AUDIT_CONFIRM_READ_ONLY=yes` on a read-only connection.
See `canonical-share-link-adoption-worksheet.md` for the decision procedure.

Adoption of one chosen legacy link (local tooling; production adoption is a
manual operator procedure after backup):

```bash
yarn remediate:local:adopt-canonical \
  --website-id <id> --video-id <id> --share-link-id <id> \
  --admin-id <adminUserId> --confirm-local
```

Adoption verifies: link belongs to the website, contains exactly the target
video, has an alias, no expiry/maxViews, ACTIVE assignment, READY/playable
video, a known ACTIVE domain, and no existing mapping; it snapshots evidence
and writes the audit row in the same transaction. There is no bulk mode.

## Destructive proof isolation (mandatory after the 2026-07-19 dev-DB incident)

Destructive database proofs are **forbidden** against `video_share_cms_dev`.
They run only against a disposable local database whose name ends with
`_test`/`_scratch`, via:

```bash
cp .env.test.example .env.test           # once; local Docker credentials
DOTENV_CONFIG_PATH=.env.test APP_ENV=test yarn prisma migrate deploy
ALLOW_DESTRUCTIVE_DB_TESTS=I_UNDERSTAND_THIS_DELETES_FIXTURES \
  yarn test:integration:canonical-fk
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

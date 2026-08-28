# Canonical Adoption — Owner Review Worksheet

> **SCOPE CHANGED 2026-08-28.** Ordinary pre-canonical duplicate history is no
> longer an owner decision. `createOrGetCanonical()` resolves it
> deterministically — the **newest eligible** exact single-video link is adopted,
> or a fresh canonical link is minted when none is eligible — and
> `409 CANONICAL_LINK_AMBIGUOUS` is no longer emitted. Legacy rows are never
> rewritten either way.
>
> This worksheet is now for **review before the fact** and for the narrow cases
> the policy deliberately will not decide. Most pairs need no entry at all.

## 1. Review the estate (read-only, writes nothing)

```bash
yarn audit:canonical-share-links --counts-only
```

```bash
yarn audit:canonical-share-links
```

The report names, per pair, the outcome the next single-video "Get link" will
produce and the exact link it will adopt. It is computed by the same policy
function the request path uses, so it cannot disagree with the code. There is
deliberately **no `--apply`**: lazy adoption on the normal create/get path is
correct on its own, and a bulk writer would add a second way to create
permanent, `onDelete: Restrict` provenance rows without adding any capability.

| `resolution` | Meaning | Action needed |
|---|---|---|
| `ALREADY_CANONICAL` | The pair is pinned. It is never repointed | None — unless §3 applies |
| `ADOPT_HISTORICAL` | The named `winner` will be adopted, unchanged | None — unless §2 applies |
| `MINT_NEW` | No historical link is safe to make permanent; a fresh one will be created and every legacy row left untouched | None — unless §2 applies |

## 2. When a human still has to decide

Only three situations. If a pair is not one of these, leave it alone and let the
next "Get link" resolve it.

### 2.1 The URL already cited in DMCA filings is NOT the predicted winner

The policy picks the newest **eligible** link. It cannot know which URL was
filed. If provenance records name a different link — most often an older one, or
one that has since been given an expiry or a view budget — that link must be
adopted deliberately, **before** anyone presses "Get link" for that pair.

Record:

```txt
Website (masked id + name):
Video (masked id + title):
Predicted winner (from audit):
Link actually cited in filings (masked id + alias):
Evidence (filing reference / date):
Why the policy would not choose it:  NEWER_ELIGIBLE_EXISTS | HAS_EXPIRY |
                                     HAS_MAX_VIEWS | REVOKED | ALIAS_MISSING
Decision:                            ADOPT <link> | ACCEPT_PREDICTED
Executed (command + date + operator):
```

> **A link with an expiry or a view budget cannot be adopted as-is.** Clear the
> limit first, or accept the predicted winner. A canonical link is permanent and
> unlimited by construction; adopting one that expires would let the pair's one
> identity die on a timer.

> **A `REVOKED` link is never adopted, by policy or by hand.** If the cited URL
> is revoked, that is an OWNER incident decision — document it here and resolve
> it explicitly rather than reviving the link as a side effect.

### 2.2 A `DB_BLOB` video with no persisted SHA-256

`DEFER`. Size plus MIME is not an integrity substitute, and creation refuses
with `409 CANONICAL_EVIDENCE_INCOMPLETE` before writing a mapping or a success
audit row. Nothing reads or backfills the blob implicitly. Explicit bounded
remediation is a separate operator decision.

### 2.3 An existing mapping that cannot be used

A pair reported `ALREADY_CANONICAL` whose "Get link" still returns a
`CANONICAL_LINK_*` `409`. Its mapping is pinned to a link that is revoked,
disabled, expired, domain-drifted or evidence-drifted.

> **Some of these are residue from a fixed defect.** Before 2026-08-28 the
> mapping was committed **before** usability was checked, so an unusable
> historical link could become a pair's permanent identity
> ([KNOWN_ISSUES.md KI-022](../KNOWN_ISSUES.md#ki-022)). New mappings cannot be
> created this way any more, but existing ones remain.

Repointing an existing mapping is **not implemented in either direction** — it
changes provenance, so it is not something a request path or a script may do
silently. Record the pair, the current mapping, the reason, and the owner
decision; resolve it as an explicit, backed-up manual procedure.

## 3. Duplicates created after a mapping was pinned

The audit lists these separately. Canonical identity is **not** at risk — an
existing mapping always wins — but each row is a second circulating URL for a
video that is supposed to have exactly one. Review whether the extra link should
be revoked. Nothing revokes it automatically.

## 4. Execution

Manual adoption is local operator tooling and has never been an HTTP endpoint:

```bash
yarn remediate:local:adopt-canonical --website-id <id> --video-id <id> --share-link-id <id> --admin-id <adminUserId> --confirm-local
```

It verifies that the link belongs to the website, contains exactly the target
video, has an alias, has no expiry or `maxViews`, that the assignment is ACTIVE
and the video READY and playable, that a known ACTIVE domain exists, and that no
mapping already exists for the pair. It writes a `CANONICAL_SHARE_LINK_ADOPT`
audit row in the same transaction — distinct from the
`CANONICAL_SHARE_LINK_AUTO_ADOPT` the request path writes, so the trail can
always answer "did a person choose this?". There is no bulk mode and no
automatic blob read or backfill.

Production execution happens only after a database backup, using the documented
manual operator procedure in `canonical-share-link-runbook.md`.

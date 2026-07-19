# Canonical Adoption — Owner Review Worksheet

Run `yarn audit:canonical-share-links` and work through every pair that has
links but no canonical mapping. The OWNER decides; the system never
auto-selects oldest/newest/most-viewed.

For each website+video pair record:

```txt
Website (masked id + name):
Video (masked id + title):
Classification (from audit):        NO_LINKS | SINGLE_CANDIDATE |
                                    DUPLICATE_ACTIVE_LINKS | ACTIVE_PLUS_REVOKED |
                                    REVOKED_ONLY | MULTI_VIDEO_ONLY
Link already cited in DMCA records? yes → that link is the adoption candidate
                                    no  → prefer POST create-or-get (fresh canonical)
Candidate link (masked id/alias):
Candidate has expiry/maxViews?      yes → reject candidate or clear limits first
Candidate alias present?            required
Assignment ACTIVE + video READY?    required
DB_BLOB persisted SHA-256 present?  required; null → DEFER for explicit remediation
Decision:                           ADOPT <link> | CREATE_NEW | DEFER
Executed (command + date + operator):
```

Decision rules:

- `SINGLE_CANDIDATE`: adopt it **only if** it is the URL already used in
  filings; otherwise either choice is fine — prefer CREATE_NEW for a clean
  snapshot.
- `DUPLICATE_ACTIVE_LINKS`: identify which URL was actually cited; adopt that
  one. The others remain legacy links (revoke manually if undesired).
- `ACTIVE_PLUS_REVOKED` / `REVOKED_ONLY`: never adopt a revoked link; if the
  cited link is revoked, this is an OWNER incident decision — document it.
- `MULTI_VIDEO_ONLY`: bundles cannot be canonical; CREATE_NEW.
- `NO_LINKS`: CREATE_NEW via the canonical endpoint when needed.
- Any `DB_BLOB` with a null checksum: `DEFER`. Size plus MIME is not an
  integrity substitute; adoption must not read/backfill the blob or write a
  canonical mapping implicitly. Explicit bounded remediation is a Gate 3C
  operator decision.

Every executed adoption writes an `CANONICAL_SHARE_LINK_ADOPT` audit row in
the same transaction. Production execution happens only after a database
backup, using the documented manual operator procedure.

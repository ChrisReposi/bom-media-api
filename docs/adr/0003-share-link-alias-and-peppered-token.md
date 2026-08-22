# ADR 0003 — Share links use a stored alias plus a peppered token hash

Status: ACCEPTED
Last verified: 2026-08-21
Verified against: `src/admin-websites/utils/share-url.util.ts`, `src/public/public.service.ts`, `src/public/utils/share-token.util.ts`, `prisma/schema.prisma` (`ShareLink`), migration `20260617000000_add_share_link_alias`

## Context

Share links are given to non-technical viewers, are pasted into chat apps, and
must be revocable. A 43-character `base64url` token is unusable as a
human-facing URL. Storing raw tokens would make a database leak equivalent to
leaking every customer's content.

## Decision

Each `ShareLink` carries two credentials with different jobs.

- **`tokenHash`** — `sha256(SHARE_TOKEN_PEPPER + rawToken)` where `rawToken` is
  `"s_" + randomBytes(32).base64url`. The raw token is returned **once**, at
  creation, and never stored.
- **`alias`** — `randomBytes(5).base64url` (about seven characters), stored in
  clear, globally unique, used for the customer-facing URL
  `https://<domain>/s/<alias>#/videos`.

Public resolution tries `alias` first, then `tokenHash`, and both lookups are
scoped by `websiteId`, so a credential only works on its own website's domains.

## Alternatives

- **Raw token in the URL only.** Ugly, and hostile to real-world sharing.
  Rejected as the primary form; still supported for compatibility.
- **Alias only, no token.** Removes the high-entropy credential entirely and
  makes the whole scheme depend on a seven-character secret. Rejected.
- **Hash the alias too.** Then the alias could not be looked up, since it must
  be found by exact value. Would require a second index of pre-hashed aliases
  for no real gain given the other checks. Rejected.
- **Signed, stateless share URLs.** No revocation without a store. Rejected.

## Consequences

- The alias is a low-entropy secret **by design**, and the risk is contained by
  the rest of the chain: website scoping, `ACTIVE` domain and website, share-link
  status/expiry/`maxViews`, per-video assignment, and `publicWatch` rate limits.
  Guessing attempts appear in `AccessLog` as `INVALID_LINK`.
- The raw token is unrecoverable after creation; a client that loses it must
  rely on the alias or create a new link.
- Rotating `SHARE_TOKEN_PEPPER` invalidates every raw token but **not** aliases,
  so alias-form links keep working — this asymmetry must be understood before
  rotation.
- Both forms must remain accepted publicly; deployed customer bundles use both.

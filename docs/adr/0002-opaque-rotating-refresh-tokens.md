# ADR 0002 — Opaque, single-use, rotating refresh tokens

Status: ACCEPTED
Last verified: 2026-08-21
Verified against: `src/admin-auth/admin-auth.service.ts` (`refresh`), `prisma/schema.prisma` (`AdminRefreshToken`), `.env.example`

## Context

Refresh tokens are long-lived (30 days by default) and are held by a browser.
They are the highest-value credential in the admin surface. Two risks matter:
theft of the stored value, and theft of the database.

## Decision

Refresh tokens are opaque random strings, stored only as peppered hashes, and
are single-use with rotation.

- Generated as `randomBytes(REFRESH_TOKEN_BYTES >= 32).base64url` — no structure,
  nothing to parse, no signature to forge.
- Persisted as `sha256(REFRESH_TOKEN_PEPPER + raw)`. A database leak alone does
  not yield usable tokens, because the pepper lives in the environment.
- Each refresh revokes the presented token inside a `Serializable` transaction,
  claiming it with a conditional `updateMany(revokedAt: null → now)`, and issues
  a replacement bound to the same session.
- Presenting an already-revoked token, or losing the claim race, revokes the
  **entire session** and writes an `ADMIN_REFRESH_REPLAY` audit row.
- The session's `expiresAt` slides forward on each successful rotation.

`JWT_REFRESH_SECRET` / `JWT_REFRESH_EXPIRES_IN` are retired and read by nothing.

## Alternatives

- **JWT refresh tokens.** Self-validating, but revocation needs a database read
  anyway, and a leaked signing key is catastrophic. Rejected.
- **Long-lived non-rotating refresh tokens.** Simpler clients; a stolen token
  stays valid for its full lifetime and theft is undetectable. Rejected.
- **Plain hash without a pepper.** A database dump plus a wordlist becomes
  viable for low-entropy inputs, and there is no way to invalidate en masse.
  Rejected.
- **Rotation without replay detection.** Rotation alone does not tell you that
  theft occurred; the replay signal is the point. Rejected.

## Consequences

- Refresh-token theft is self-limiting: the first use by either party
  invalidates the session for both, and leaves an audit trail.
- Clients must handle concurrent refreshes. The admin SPA de-duplicates them
  into a single in-flight promise; a naive client can log itself out.
- Rotating `REFRESH_TOKEN_PEPPER` logs every admin out — an intentional
  break-glass control.
- `AdminRefreshToken` accumulates one row per rotation until pruned.

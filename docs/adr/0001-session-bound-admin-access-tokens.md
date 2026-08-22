# ADR 0001 — Session-bound admin access tokens

Status: ACCEPTED
Last verified: 2026-08-21
Verified against: `src/admin-auth/guards/admin-access-token.guard.ts`, `src/admin-auth/admin-auth.service.ts`, `prisma/schema.prisma` (`AdminSession`), migration `20260614190000_admin_sessions`

## Context

A stateless JWT cannot be revoked before it expires. With a 15-minute access
token, logout, a password change, an account disable or a detected token theft
would all leave a window in which a stolen token still worked. For an admin
surface that can create share links and purge videos, that window is not
acceptable.

## Decision

Every admin access token carries a session id (`sid`) and the database is the
authority on whether that session is still valid.

- Login creates an `AdminSession` row; the JWT payload is
  `{ sub, sid, jti, username, role, type: "admin_access" }`.
- `AdminAccessTokenGuard` verifies the signature **and then** loads the session,
  rejecting when it is missing, belongs to another admin, is revoked, is
  expired, or the admin is not `ACTIVE` / is soft-deleted.
- Logout, password change, refresh replay and account-state changes revoke the
  session, which invalidates its unexpired access tokens on the next request.
  All four are implemented correctly in the backend. **Logout is not currently
  reached by the admin SPA** — it is sent without a Bearer token and rejected
  with `401`, so that particular revocation path does not fire in practice
  (`../KNOWN_ISSUES.md` KI-016). The mechanism is sound; the caller is not.
- `lastUsedAt` is touched at most once per 60 seconds per session.

## Alternatives

- **Pure stateless JWT.** Simplest and no per-request read, but no revocation.
  Rejected.
- **Token version counter on `AdminUser`.** Revokes all of a user's tokens at
  once but cannot revoke a single device, and still needs a per-request read.
  Rejected as strictly less capable for the same cost.
- **Very short access tokens (about 1 minute).** Shrinks but does not close the
  window, and multiplies refresh traffic. Rejected.
- **Opaque server-side sessions only.** Loses the self-describing payload the
  guard uses before touching the database. Rejected.

## Consequences

- One indexed primary-key read per authenticated request. Acceptable, and it is
  what makes immediate revocation possible.
- The database is on the critical path for every admin request.
- `AdminSession` accumulates rows; `yarn cleanup:admin-sessions` exists, but
  nothing schedules it (see `../KNOWN_ISSUES.md`).
- Session self-service (list and revoke) becomes possible and is implemented.
- Any new admin surface must go through this guard; verifying the JWT alone is
  not sufficient.

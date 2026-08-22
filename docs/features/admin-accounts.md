# Feature: Admin account management

Status: CURRENT (disabled by default in production)
Last verified: 2026-08-21
Verified against: `src/admin-accounts/admin-accounts.controller.ts`, `src/admin-accounts/admin-accounts.service.ts`, `src/admin-auth/admin-credential.service.ts`, `src/config/env.validation.ts`

Lets an `OWNER` create and manage `ADMIN` and `STAFF` accounts through the API.

## 1. Gating

Two independent gates:

1. **Role** — the whole controller is
   `@UseGuards(AdminAccessTokenGuard, AdminRolesGuard)` and every handler is
   `@AdminRoles(AdminRole.OWNER)`.
2. **Feature flag** — `ensureEnabled()` checks
   `ADMIN_ACCOUNT_MANAGEMENT_ENABLED`, which defaults to **false in
   production**. When disabled every route returns
   `503 ADMIN_ACCOUNT_MANAGEMENT_DISABLED`.

All write routes use the strict `login` throttle profile (5 per 60 s).

## 2. Operations

| Route | Service method | Effect |
|---|---|---|
| `GET /admin/accounts` | `list` | List managed accounts |
| `POST /admin/accounts` | `create` | Create an `ADMIN` or `STAFF` account, returns a one-time temporary password |
| `PATCH /admin/accounts/:id/role` | `changeRole` | Change between `ADMIN` and `STAFF` |
| `PATCH /admin/accounts/:id/status` | `changeStatus` | `ACTIVE` ↔ `DISABLED` |
| `POST /admin/accounts/:id/revoke-sessions` | `revokeSessions` | Revoke every session and refresh token for that admin |
| `POST /admin/accounts/:id/reset-password` | `resetPassword` | Issue a new temporary password |
| `DELETE /admin/accounts/:id` | `delete` | Soft delete (`deletedAt`) |

> **`OWNER` accounts are out of scope.** `ensureManagedRole()` accepts only
> `ADMIN` and `STAFF`, so this API cannot create, promote, demote or delete an
> owner. The first owner comes from `prisma/seed.ts` or the one-time
> `POST /admin/auth/register`.

## 3. Temporary passwords

`create` and `resetPassword` both:

- generate `randomBytes(18).base64url` via
  `AdminCredentialService.generateTemporaryPassword()`;
- store it bcrypt-hashed (12 rounds);
- set `mustChangePassword: true` and
  `temporaryPasswordExpiresAt = now + ADMIN_TEMP_PASSWORD_TTL_HOURS`
  (default 24, clamped 1–168);
- return the plaintext **once**, in that response only.

Consequences for the holder:

- Login succeeds while the temporary password is unexpired; after expiry login
  fails with `403 ADMIN_TEMP_PASSWORD_EXPIRED`.
- While `mustChangePassword` is set, `AdminAccessTokenGuard` returns
  `403 ADMIN_PASSWORD_CHANGE_REQUIRED` for every guarded route **except** those
  marked `@AllowPasswordChangeRequired()`: `logout`, `me` and
  `change-own-password`.
- `change-own-password` clears the flag and `temporaryPasswordExpiresAt`, and
  revokes all of that admin's sessions.

> **The admin SPA does not implement this flow.** `mustChangePassword`,
> `ADMIN_PASSWORD_CHANGE_REQUIRED` and `change-own-password` have zero
> references in `bom-media-admin/src`, so an account created here is effectively
> locked out of the UI. This is the reason the feature flag defaults to off in
> production. See [KNOWN_ISSUES.md](../KNOWN_ISSUES.md#ki-004).

## 4. Password policy

`AdminCredentialService.validateNewPassword()` rejects, with stable codes:

| Rule | Code |
|---|---|
| Length outside 12–128 | `ADMIN_PASSWORD_POLICY_VIOLATION` |
| Same as the current password | `ADMIN_PASSWORD_REUSED` |
| Equal to the username (normalised) | `ADMIN_PASSWORD_POLICY_VIOLATION` |

Usernames are normalised with `NFC` + trim + lowercase before storage and
comparison, so `Admin` and `admin` are the same account.

## 5. Disable, revoke, delete

| Action | Effect on live sessions |
|---|---|
| `changeStatus` → `DISABLED` | Rejected on the next request: the guard, login and refresh all check `status === ACTIVE` |
| `revokeSessions` | All sessions and refresh tokens revoked; access tokens die on next use |
| `delete` (soft) | `deletedAt` set; the guard, login and refresh all reject |

There is no hard delete. Audit rows keep `adminId` and survive
(`onDelete: SetNull`).

## 6. Auditing

Every operation writes an `AdminAuditLog` row with the acting owner's id, the
target's `entityId`, the outcome, hashed IP and truncated user agent. Temporary
passwords are never logged or persisted in plaintext.

## 7. Operating without the API

While the flag is off, use the documented procedures instead:
`../operations/admin-account-management-runbook.md`, plus
`yarn audit:admin-accounts` (read-only) and
`yarn smoke:local:admin-accounts` (local).

## 8. Before enabling in production

1. Implement the forced password-change flow in the admin SPA (KI-004).
2. Confirm `ADMIN_TEMP_PASSWORD_TTL_HOURS` matches how quickly a new admin can
   realistically be onboarded.
3. Agree a secure channel for delivering the one-time password — never email it
   alongside the username, and never paste it into a ticket.
4. Confirm `AUTH_LOGIN_THROTTLE_LIMIT` is appropriate; account writes share that
   profile.
5. Set `ADMIN_ACCOUNT_MANAGEMENT_ENABLED=true` deliberately, and consider
   turning it off again once onboarding is complete.

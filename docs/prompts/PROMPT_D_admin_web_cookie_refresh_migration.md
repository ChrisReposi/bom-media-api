# PROMPT D — Admin Web Cookie-Based Refresh Migration

Optional but strongly recommended next pass.

## Goal

Reduce token leakage by moving the refresh token out of browser-readable storage.

## Target Design

- Access token may remain short-lived and memory-resident.
- Refresh token should move to `HttpOnly; Secure; SameSite` cookie if topology allows.
- Add CSRF protection suitable for AJAX/API use.
- Do not break local development unnecessarily.
- Preserve temporary compatibility mode only if necessary.

## Inspect First

Backend: admin login, refresh, logout, CORS, cookie parsing, auth DTOs and response types.

Admin Web: auth slice, Redux Persist config, session bootstrap, Axios interceptors, logout button, route guards.

Deployment topology: Admin Web origin, API origin, same-site vs cross-site status, Cloudflare/Hostinger proxy behavior.

## Implement

1. Backend support for cookie-based refresh and logout.
2. Admin Web changes to stop persisting refresh token in Redux Persist/localStorage.
3. Access token kept in memory where possible.
4. Boot-time refresh uses cookie, not stored refresh token.
5. CSRF protection appropriate to the chosen model.
6. Clear local vs production behavior.
7. Compatibility fallback only if needed and gated by env.

## Acceptance Criteria

- Admin login works.
- Refresh works after page reload.
- Logout clears cookie-backed session.
- Browser-readable refresh token storage is removed or deprecated behind a flag.
- API typecheck/build pass.
- Admin Web typecheck/build pass.
- Documentation explains local vs production behavior.

If cookie auth is not practical yet, document the blocker and produce a migration design for later.

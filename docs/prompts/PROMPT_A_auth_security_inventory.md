# PROMPT A — Auth/Security Inventory

You are working on a real NestJS + Prisma + MySQL backend called BOM Media API / Video Share CMS.

Your job in this step is analysis first, not blind coding.

Repository context:
- Use Yarn only.
- Prefer the current source tree over historical markdown if they conflict.
- Historical notes are useful context, but live source code is the source of truth.
- Do not introduce unnecessary architectural rewrites.
- Do not work on DRM, video-provider migration, or upload redesign in this step.
- Assume the product decision is:
  - public websites must NOT contain mini-admin production logic,
  - admin-web is the only production admin surface,
  - large production videos must NOT be stored in MySQL,
  - backend hardening of login/session/auth is the priority.

Inspect these files first and summarize the current behavior exactly as implemented:
- `src/main.ts`
- `src/app.module.ts`
- `src/app.controller.ts`
- `src/app.service.ts`
- `src/admin-auth/admin-auth.module.ts`
- `src/admin-auth/admin-auth.service.ts`
- `src/admin-auth/admin-auth.controller.ts`
- `src/admin-auth/admin-access-token.guard.ts`
- `src/admin-auth/current-admin.decorator.ts`
- `src/admin-auth/*.dto.ts`
- `src/admin-auth/*.type.ts`
- `src/database/database.module.ts`
- `src/database/prisma.service.ts`
- `prisma/schema.prisma`
- `package.json`
- `.env`
- any env config / validation files used by the app
- any security/cors/public-watch files that affect auth, rate limit, or logging

Important analysis goals:
1. Describe the current login flow, refresh flow, logout flow, and access-token guard flow exactly as implemented.
2. Identify where refresh tokens are created, hashed, rotated, revoked, and validated.
3. Identify whether access tokens can be invalidated immediately on logout or password change, or only after expiry.
4. Identify whether the app is currently proxy-aware for real client IP extraction behind Cloudflare/reverse proxy.
5. Identify whether Nest throttling already exists or not.
6. Identify whether docs are correctly disabled in production or just env-controlled.
7. Identify current Prisma pool settings and whether they are hard-coded.
8. Identify all current auth/security env variables.
9. Identify any mismatch between old markdown/session logs and current code that could mislead implementation.
10. Produce a short implementation plan for the next step with exact files to modify, DB migration needs, API contract impact, admin-web impact if any, and test plan.

Output format:
- Current behavior
- Risks and gaps
- Implementation plan
- Contract changes
- Files to change
- Verification plan

Do not code yet unless a trivial typo blocks analysis.

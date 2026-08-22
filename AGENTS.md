# AGENTS.md — bom-media-api

Status: CURRENT
Last verified: 2026-08-21
Verified against: `package.json`, `src/**`, `prisma/schema.prisma`, `.github/workflows/ci.yml`

Concise repository map for Codex and other reviewing agents. Detailed knowledge
lives in `docs/`. This file must stay short.

## Release-Blocking Compatibility Rule

Changes affecting share links, public watch APIs, host/domain resolution,
WebsiteVideo/ShareLinkVideo authorization, media grants, or playback
must preserve existing valid production share links.

Authoritative contract:

`../project-docs/SHARE_LINK_COMPATIBILITY.md`

Codex reviews must classify an unintended break of existing valid
production share links as HIGH or CRITICAL depending on blast radius.

## Repository responsibility

Standalone NestJS backend for BOM Media / Video Share CMS. Sole owner of admin
authentication and authorization, the MySQL/MariaDB schema, video assets and
storage, websites/domains/domain groups, share links, public share-link
resolution, protected media streaming, access logs and admin audit logs.

Consumers: `bom-media-admin` (admin SPA) and `public_website` (static public
SPA). Public websites are display-only and hold no admin capability.

## Important directories

| Path                  | Contents                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/admin-auth/`     | Login, refresh rotation, logout, password change, sessions, `AdminAccessTokenGuard`, `AdminRolesGuard` |
| `src/admin-accounts/` | OWNER-only admin account CRUD, temporary passwords                                                     |
| `src/admin-websites/` | Websites, domains, domain groups, video assignment, share links, canonical share links                 |
| `src/videos/`         | Video CRUD, Cloudinary upload, embed, DB blob, chunked local-file upload, purge, view growth           |
| `src/videos/storage/` | `LOCAL_FILE` filesystem storage + HTTP Range streaming                                                 |
| `src/public/`         | Public watch/exchange, protected media streaming, HMAC media grants                                    |
| `src/security/`       | Dynamic CORS origin resolution, throttle profiles                                                      |
| `src/cache/`          | Process-local in-memory cache                                                                          |
| `src/config/`         | Env loading, `registerAs("api")` config, strict env validation                                         |
| `src/common/`         | Global exception filter, request-security utils, MariaDB diagnostics                                   |
| `prisma/`             | `schema.prisma`, 19 migrations, seed                                                                   |
| `test/`               | 28 `node:test` suites (no DB required)                                                                 |
| `scripts/`            | Audits, diagnostics, remediation, smoke, DB-backed integration proofs                                  |
| `docs/`               | Authoritative documentation (see below)                                                                |

## Authoritative documentation

- `docs/README.md` — index and reading order
- `docs/ARCHITECTURE.md` — modules, request lifecycle, traced flows
- `docs/REPO_MAP.md` — file-level entry-point map
- `docs/ENGINEERING_STANDARDS.md` — code conventions, PR expectations
- `docs/SECURITY_MODEL.md` — trust boundaries and security invariants
- `docs/DATA_MODEL.md` — domain model, relations, invariants, migrations
- `docs/API_CONTRACTS.md` — contracts consumed by admin and public clients
- `docs/ENVIRONMENT.md` — every env var, purpose, default, required-in-prod
- `docs/TESTING.md`, `docs/DEPLOYMENT.md`, `docs/OBSERVABILITY.md`
- `docs/KNOWN_ISSUES.md` — evidence-backed current issues
- `docs/adr/`, `docs/features/`, `docs/runbooks/`
- `../project-docs/` — cross-application documentation

Source-of-truth order when documents disagree: **live source code** →
`docs/` → `AGENTS.md` / `CLAUDE.md` → `PLAN.md` → `session-log.md` → older
markdown. Never implement from stale notes when the code says otherwise.

## Verified setup / build / test commands

```bash
yarn install --frozen-lockfile
```

| Purpose                           | Command                                                           |
| --------------------------------- | ----------------------------------------------------------------- |
| Typecheck                         | `yarn typecheck`                                                  |
| Lint                              | `yarn lint`                                                       |
| Unit tests                        | `yarn test`                                                       |
| Build                             | `yarn build` (runs `prisma generate` then `nest build`)           |
| Format check                      | `yarn format:check`                                               |
| Typecheck + lint + format + build | `yarn check` — **does NOT run tests**; run `yarn test` separately |
| Prisma validate                   | `yarn db:validate` (local env)                                    |
| Prisma client                     | `yarn prisma generate`                                            |

`yarn build` and `yarn test` require `prisma generate` to have run at least once
(`src/generated/prisma` is gitignored). Yarn only — never npm or pnpm.

## Architectural invariants

- Backend authorization is authoritative; client-side checks are cosmetic.
- `AdminRolesGuard` denies handlers without `@AdminRoles*()` metadata.
- Access tokens carry `sid`; every request re-validates the `AdminSession` row.
  Revoking a session invalidates unexpired access tokens immediately. Note the
  SPA logout integration currently fails to reach that revocation —
  `docs/KNOWN_ISSUES.md` KI-016.
- Refresh tokens are opaque, single-use and rotated. Reuse of a revoked token
  revokes the whole session (`ADMIN_REFRESH_REPLAY`).
- Share tokens and refresh tokens exist in the database only as peppered
  SHA-256 hashes. The raw share token is returned exactly once, at creation.
- Public watch requires: `ACTIVE` domain → `ACTIVE` website → `ACTIVE` share
  link (not expired, under `maxViews`) → `ShareLinkVideo` membership → `ACTIVE`
  `WebsiteVideo` assignment → `VideoStatus.READY` → playable asset.
- That chain governs **backend-served media only** (`DB_BLOB`, `LOCAL_FILE`,
  local thumbnails). `DIRECT_URL`, Cloudinary and `EMBED` URLs are returned
  verbatim and are outside it. Details and caching caveats:
  `docs/SECURITY_MODEL.md` sections 4.1 and 4.2.
- View-limited share links additionally require a valid HMAC media grant on
  backend-served media routes; unlimited links neither carry nor require one.
- Every public denial returns the identical `INVALID_LINK` body. The specific
  reason exists only in `AccessLog`.
- `CanonicalVideoShareLink` relations are `onDelete: Restrict` by design.
- The in-memory cache is process-local, not shared, and cleared on restart.

## Security constraints

- Never commit or print real secret values; document secrets by name only.
- Never log tokens, peppers, Authorization headers, cookies or raw client IPs.
- Keep public share errors generic and non-enumerable.
- Keep `ValidationPipe` strict (`whitelist` + `forbidNonWhitelisted`).
- Keep Swagger disabled in production.
- Add or update tests for any auth, session, role or share-link change.

## Migration constraints

- Migrations only via `prisma/migrations/`. Never `prisma db push` on a shared
  database. Never `migrate reset` or `DROP` on production.
- Migrations must be additive and compatible with the running build; the deploy
  order is build → `yarn db:migrate:deploy` → restart.
- Destructive test scripts are gated by
  `scripts/safety/assert-destructive-test-database.ts`. Do not bypass it.

## Definition of done

- `yarn typecheck`, `yarn lint`, `yarn test`, `yarn build` pass.
- Tests cover the changed security/authorization behaviour.
- Relevant `docs/` pages updated in the same change.
- No secrets anywhere in the diff.

## Code review instructions

Review for, in order: (1) authorization correctness — guard/role metadata,
session revalidation, ownership and assignment checks; (2) data-integrity
invariants — unique constraints, delete behaviour, transaction isolation;
(3) information leakage — error specificity on public routes, logging,
response shaping; (4) contract compatibility — does this break
`bom-media-admin` or `public_website` (`docs/API_CONTRACTS.md`)?;
(5) migration safety; (6) documentation drift.

Flag any change that documents planned behaviour as if it already exists.
**No Bunny-specific integration exists** — no service, API client, TUS upload,
webhook, signed playback, metadata sync or provider-specific purge. The enum
member is persistable and plays back generically; see
`docs/features/bunny-stream.md` for the exact CURRENT vs NOT IMPLEMENTED split.
Treat both "Bunny is implemented" and "Bunny has zero code paths" as
inaccurate.

## Reporting tests

State one of `PASS`, `FAIL`, `NOT RUN`, `BLOCKED` per command, with the exact
command. If a command was not executed, report **NOT RUN**. Never infer a pass.
If a command fails for environmental reasons, report `FAIL` or `BLOCKED` and
name the environmental cause; do not modify unrelated code to force a pass.

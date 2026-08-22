# Repository Map

Status: CURRENT
Last verified: 2026-08-21
Verified against: directory listing of `src/`, `prisma/`, `test/`, `scripts/`

Where to look first for a given concern. Paths are relative to the repository
root.

## Top level

| Path | Purpose |
|---|---|
| `src/` | Application source |
| `prisma/` | Schema, migrations, seed |
| `test/` | `node:test` suites (no database required) |
| `scripts/` | Audit, diagnostic, remediation, smoke and DB-backed proof scripts |
| `docker/`, `docker-compose.local.yml`, `docker-compose.mariadb-test.yml` | Local MySQL and MariaDB test containers |
| `.github/workflows/ci.yml` | Backend CI — the `backend / validate` check. Sibling workflows live in `bom-media-admin` and `public_website` |
| `nest-cli.json`, `tsconfig*.json`, `eslint.config.mjs`, `.prettierrc.json` | Build and quality tooling |
| `prisma.config.ts` | Prisma 7 config; wires `loadApiEnv()` and the seed command |
| `.env.example`, `.env.local.example`, `.env.test.example` | Environment templates (placeholders only) |
| `PLAN.md`, `session-log.md` | Historical direction and working log — **not** contracts |
| `codex-interrupted-memory-cache*.patch` | Two committed UTF-16 patch artefacts (~260 KB). The memory-cache feature they describe already exists in `src/cache/`. Repo hygiene item — see [KNOWN_ISSUES.md](./KNOWN_ISSUES.md#ki-007) |

## Bootstrap and configuration

| Concern | File |
|---|---|
| Process bootstrap, helmet, CORS, pipes, Swagger | `src/main.ts` |
| Module graph, Pino config and redaction, throttler wiring | `src/app.module.ts` |
| Typed config object (`registerAs("api")`) | `src/config/env.config.ts` |
| Strict env validation and production requirements | `src/config/env.validation.ts` |
| `.env` / `.env.local` loading rules | `src/config/load-env.ts` |
| Prefix / port / Swagger path defaults | `src/common/constants/api.constants.ts` |

## Authentication and authorization

| Concern | File |
|---|---|
| Login, refresh rotation, logout, password change, sessions | `src/admin-auth/admin-auth.service.ts` |
| HTTP surface for the above | `src/admin-auth/admin-auth.controller.ts` |
| Password hashing, username normalisation, password policy, temporary passwords | `src/admin-auth/admin-credential.service.ts` |
| Access-token verification + session revalidation | `src/admin-auth/guards/admin-access-token.guard.ts` |
| Role enforcement (deny-by-default) | `src/admin-auth/guards/admin-roles.guard.ts` |
| Role metadata helpers (`AdminReadRoles`, `AdminWriteRoles`) | `src/admin-auth/decorators/admin-roles.decorator.ts` |
| `@AllowPasswordChangeRequired()` escape hatch | `src/admin-auth/decorators/allow-password-change-required.decorator.ts` |
| `@CurrentAdmin()`, `@CurrentAdminSessionId()` | `src/admin-auth/decorators/` |
| Access-token payload shape | `src/admin-auth/types/admin-token-payload.type.ts` |

## Admin account management (OWNER only)

| Concern | File |
|---|---|
| Account CRUD, role/status changes, session revocation, password reset | `src/admin-accounts/admin-accounts.service.ts` |
| HTTP surface + role metadata | `src/admin-accounts/admin-accounts.controller.ts` |

## Videos

| Concern | File |
|---|---|
| All video business logic (~3.5k lines) | `src/videos/videos.service.ts` |
| HTTP surface, multer config, upload limits | `src/videos/videos.controller.ts` |
| Local filesystem storage, Range streaming, path safety | `src/videos/storage/local-video-storage.service.ts` |
| Duration/format probing with SSRF defence | `src/videos/metadata/video-metadata.service.ts` |
| Capped, deduped public view growth | `src/videos/video-view-growth.service.ts` |
| Embed URL parsing/allowlisting | `src/videos/utils/video-embed.util.ts` |
| Cloudinary URL helpers | `src/videos/utils/cloudinary-video.util.ts` |
| Slug generation, checksums, search, filter keys | `src/videos/utils/*.util.ts` |
| Cloudinary SDK wrapper | `src/cloudinary/cloudinary.service.ts` |

## Websites, domains, share links

| Concern | File |
|---|---|
| Websites, domains, domain groups, assignments, share links (~3.3k lines) | `src/admin-websites/admin-websites.service.ts` |
| HTTP surface + role metadata for all of the above | `src/admin-websites/admin-websites.controller.ts` |
| Canonical (provenance) share links | `src/admin-websites/canonical-share-link.service.ts` |
| Share token/alias generation and public URL building | `src/admin-websites/utils/share-url.util.ts` |
| Domain normalisation | `src/admin-websites/utils/normalize-domain.util.ts`, `src/common/utils/domain.util.ts` |
| Stable share-link error codes | `src/admin-websites/utils/share-link-errors.util.ts` |

## Public surface

| Concern | File |
|---|---|
| Public endpoints, streaming, no-store headers | `src/public/public.controller.ts` |
| Share-link resolution, authorization, media reads (~1.6k lines) | `src/public/public.service.ts` |
| HMAC media grants | `src/public/public-media-grant.service.ts` |
| Share-token hashing | `src/public/utils/share-token.util.ts` |
| Host normalisation | `src/public/utils/normalize-host.util.ts` |
| Access-log hashing/truncation | `src/public/utils/access-log.util.ts` |
| Public response shape and reason codes | `src/public/types/public-watch-response.type.ts` |

## Security, infrastructure, cross-cutting

| Concern | File |
|---|---|
| Dynamic CORS (static allowlist ∪ ACTIVE DB domains) | `src/security/cors-origin.service.ts` |
| Named throttle profiles | `src/security/throttle.config.ts`, `src/security/throttle-profile.decorator.ts` |
| Prisma client + MariaDB adapter/pool | `src/database/prisma.service.ts` |
| Process-local TTL cache | `src/cache/memory-cache.service.ts` |
| Global exception filter | `src/common/filters/global-exception.filter.ts` |
| Client IP resolution, value hashing, truncation | `src/common/utils/request-security.util.ts` |
| Safe route templates for logs | `src/common/http/safe-request-route.util.ts` |
| Sanitised database error context | `src/common/errors/safe-database-error-context.util.ts` |
| MariaDB collation diagnostics (opt-in) | `src/common/diagnostics/*` |
| Health and readiness | `src/health/health.service.ts` |

## Database

| Path | Purpose |
|---|---|
| `prisma/schema.prisma` | Single source of truth for the data model |
| `prisma/migrations/` | 19 migrations, `20260529163942_init` → `20260719090000_add_video_binary_asset_checksum` |
| `prisma/seed.ts` | Bootstraps the first OWNER from `ADMIN_BOOTSTRAP_*` |
| `src/generated/prisma/` | Generated client — **gitignored**, must run `prisma generate` |

## Tests and scripts

| Path | Purpose |
|---|---|
| `test/*.test.ts` | 28 suites: auth hardening, security hardening, share-link scope, canonical share links, local storage, purge, caching, exception filter, view growth, upload concurrency, … |
| `test/test-env.ts` | Injects test environment before suites run |
| `scripts/audit/` | Read-only audits (share-link assignments, admin accounts, canonical links) |
| `scripts/diagnostics/` | Admin video query isolation |
| `scripts/smoke/` | Local smoke flows |
| `scripts/remediate/` | Guarded data remediation (local) |
| `scripts/test/` | DB-backed integration proofs (canonical FK, DB-blob evidence, MariaDB protocol) |
| `scripts/safety/assert-destructive-test-database.ts` | Guard that blocks destructive scripts outside a test DB |
| `scripts/backup/`, `scripts/storage/` | Example shell scripts and checklists |

## Finding an endpoint fast

Route prefixes map one-to-one onto controllers:

| Prefix | Controller |
|---|---|
| `/api/v1/health` | `src/health/health.controller.ts` |
| `/api/v1/admin/auth/*` | `src/admin-auth/admin-auth.controller.ts` |
| `/api/v1/admin/accounts/*` | `src/admin-accounts/admin-accounts.controller.ts` |
| `/api/v1/admin/videos/*` | `src/videos/videos.controller.ts` |
| `/api/v1/admin/{websites,domains,domain-groups,share-links}/*` | `src/admin-websites/admin-websites.controller.ts` |
| `/api/v1/public/*` | `src/public/public.controller.ts` |

# apps/api/AGENTS.md — NestJS API Rules

## Scope

This app is the central backend API for the entire platform.

## Stack

- NestJS
- Prisma
- MySQL/MariaDB
- JWT
- class-validator DTOs
- Swagger
- Pino logger
- Helmet
- CORS
- ValidationPipe
- Global exception filter

## Required API Modules

Implement modules in this general direction:

```txt
auth
admins
videos
websites
website-domains
website-videos
share-links
public-watch
access-logs
admin-audit-logs
health
```

## API Prefix

Use:

```txt
/api/v1
```

Swagger path:

```txt
/docs
```

Swagger should be enabled only when allowed by env.

## Security Requirements

- Hash admin passwords.
- Never return passwordHash.
- Never log tokens.
- Never store raw share token.
- Store share token hash.
- Public token validation must be constant enough for MVP and not leak detailed reasons.
- Rate-limit login and public watch endpoints.
- Verify hostname/domain on public watch.

## Prisma Requirements

- Use MySQL provider.
- Add useful indexes.
- Prefer soft disable/status over hard delete for important records.
- Use migrations.
- Add seed script for initial admin.

## Response Style

Prefer consistent response shape:

```ts
{
  success: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
  };
  meta?: unknown;
}
```

Keep public errors generic.

## Public Watch Flow

Input:

```txt
host
token
```

Output if valid:

```txt
website
videos
```

Output if invalid:

```txt
valid: false
videos: []
```

Do not reveal whether the token existed, expired, revoked, or belonged to another website.

## Video Provider

Use an abstraction:

```ts
interface VideoProviderService {
  resolvePlayback(input): Promise<ResolvedPlayback>;
  createSignedPlaybackUrl?(input): Promise<SignedPlayback>;
}
```

MVP can start with manual URL mode.

## Testing

At minimum, add tests around:

- token hashing and validation
- domain mismatch rejection
- expired link rejection
- max views rejection
- revoked link rejection

# BOM Media API — Codex Agent Rules

## Scope

This repository is the standalone backend API for BOM Media / Video Share CMS.

The current product direction is:

- One centralized NestJS API.
- One MySQL/MariaDB database.
- One React Admin Web production admin surface.
- Many custom static public websites.
- Public websites must not ship mini-admin production logic.
- Admin Web is the only production admin UI for upload, video management, websites, domains, and share links.
- Large production videos must not be stored in MySQL.
- Hostinger NVMe local file storage may be used for production video files when customers do not want third-party media storage.
- MySQL stores metadata, permissions, paths, share links, access logs, and audit logs.

## Stack

- NestJS
- Prisma 7
- MySQL/MariaDB
- @prisma/adapter-mariadb
- JWT access tokens
- Opaque refresh tokens
- bcryptjs password hashing in the current live source tree
- class-validator DTOs
- Swagger
- Pino logger
- Helmet
- CORS
- ValidationPipe
- Yarn only

## Source of Truth Order

When context conflicts, use this order:

1. Current live source code.
2. `AGENTS.md`.
3. `PLAN.md`.
4. `docs/*`.
5. `session-log.md`.
6. Historical markdown, old prompts, or chat summaries.

Never blindly implement from old session notes if current code says otherwise.

## Commands

Use Yarn only. Do not use npm or pnpm. Do not create `package-lock.json` or `pnpm-lock.yaml`.

Common checks:

```bash
yarn typecheck
yarn build
yarn lint
yarn format:check
```

If this is a workspace repo, prefer workspace scripts:

```bash
yarn workspace @video-share/api typecheck
yarn workspace @video-share/api build
yarn workspace @video-share/api lint
yarn workspace @video-share/api format:check
yarn workspace @video-share/api db:generate
yarn workspace @video-share/api db:validate
yarn workspace @video-share/api db:migrate:dev
yarn workspace @video-share/api db:migrate:deploy
yarn workspace @video-share/api db:seed
```

## Security Rules

- Never commit real secrets.
- Never print real `.env` secret values in summaries.
- Never log passwords, raw refresh tokens, raw JWTs, raw share tokens, cookie values, authorization headers, Cloudinary secrets, or pepper values.
- Never store raw share tokens.
- Never store raw refresh tokens.
- Public token errors must remain generic.
- Do not reveal whether a public token existed, expired, was revoked, or belonged to another website.
- Keep DTO validation strict.
- Keep production Swagger disabled unless explicitly and safely gated.
- Add tests for auth/session/security changes whenever practical.
- Prefer soft-disable/status fields over destructive deletes for important data.
- Permanent deletes must be guarded, audited, and explicit.

## Production Security Direction

Prioritize:

1. Session-bound admin access token invalidation.
2. Backend logout that revokes refresh token and active session.
3. Password change that revokes all active sessions.
4. NestJS throttling for auth/public-watch endpoints.
5. Cloudflare WAF/rate-limit runbook.
6. Proxy-aware IP handling behind Cloudflare/Hostinger.
7. Prisma pool tuning for Hostinger MySQL.
8. Secret rotation runbooks.
9. Off-site DB backups and restore tests.
10. Admin Web as the only admin surface.

Do not work on DRM, Cloudinary/R2/S3 migration, or full upload redesign unless explicitly requested.

## Video Storage Direction

Production default:

- `VIDEO_DB_STORAGE_ENABLED=false`
- `DB_BLOB` is fallback only for small test/internal files.
- Large production videos should use Hostinger private NVMe file storage when avoiding third-party costs, or Cloudinary/Cloudflare Stream/R2 later when scaling.

For Hostinger NVMe storage:

- Store physical files outside public web root.
- MySQL stores metadata/path/permission only.
- Backend streams through token/session-protected endpoints.
- Support HTTP Range requests.
- Default limit: 500MB/file.
- Optional hard max: 1GB/file via env after testing.
- DB_BLOB fallback should stay around 100MB by default.

## Codex Workflow

Before implementation:

1. Inspect live files.
2. Summarize current behavior.
3. Identify risks and gaps.
4. List exact files to change.
5. Mention migration/API/admin-web impact.
6. State verification plan.

After implementation:

1. Summarize exact changes.
2. List files changed.
3. List commands run.
4. State what passed/failed.
5. Note manual actions still required.
6. Update `session-log.md`.

# CLAUDE.md — bom-media-api

Status: CURRENT
Last verified: 2026-08-21
Verified against: `package.json`, `src/**`, `prisma/schema.prisma`, `.github/workflows/ci.yml`

## What this repository is

The single backend for the BOM Media / Video Share CMS. It owns **all**
authentication, authorization, persistence, video management, website/domain
management, share links, public share-link resolution and protected media
streaming. Two clients consume it:

- `../bom-media-admin` — React admin console (the only production admin UI).
- `../public_website` — static public SPA, share-token access only.

Nothing else is allowed to write to the database.

## Non-negotiable architectural rules

1. **The backend is the only authority.** Frontend role checks are UX. Every
   authorization decision is made here.
2. **Never store raw credentials.** Refresh tokens and share tokens are stored
   only as peppered SHA-256 hashes. Passwords are bcrypt (12 rounds).
3. **Public errors stay generic.** Never reveal whether a share token existed,
   expired, was revoked, or belongs to another website.
4. **Admin routes are deny-by-default.** `AdminRolesGuard` denies any handler
   with no `@AdminRoles*()` metadata. Adding a route without role metadata makes
   it unreachable — that is intentional.
5. **Public media requires host + token + assignment.** A video is only public
   when its `WebsiteVideo` assignment is `ACTIVE` for the website resolved from
   the request `host`, and the share link is `ACTIVE`. This governs
   **backend-served** media only — `DIRECT_URL`, Cloudinary and `EMBED` URLs are
   handed to the browser verbatim and cannot be revoked. See
   @docs/SECURITY_MODEL.md sections 4.1 and 4.2 before writing anything about
   media revocation.
6. **Yarn only.** Never create `package-lock.json` or `pnpm-lock.yaml`.
7. **Prefer status/soft-disable over hard delete** for websites, domains, share
   links and videos. Permanent deletes must stay guarded, confirmed and audited.

## Which docs to read for which task

| Task                                             | Read first                               |
| ------------------------------------------------ | ---------------------------------------- |
| Anything at all                                  | @docs/README.md                          |
| Finding code                                     | @docs/REPO_MAP.md                        |
| Flows, module boundaries                         | @docs/ARCHITECTURE.md                    |
| Auth, guards, tokens, CORS, CSP, rate limits     | @docs/SECURITY_MODEL.md                  |
| Prisma models, relations, invariants, migrations | @docs/DATA_MODEL.md                      |
| Changing any endpoint a client uses              | @docs/API_CONTRACTS.md                   |
| Adding/renaming env vars                         | @docs/ENVIRONMENT.md                     |
| Running or adding tests                          | @docs/TESTING.md                         |
| Build/release/rollback                           | @docs/DEPLOYMENT.md                      |
| Logging, health, audit/access logs               | @docs/OBSERVABILITY.md                   |
| Before assuming something is broken              | @docs/KNOWN_ISSUES.md                    |
| Video sources/providers                          | @docs/features/video-pipeline.md         |
| Share links end to end                           | @docs/features/share-links.md            |
| Cross-repo behaviour                             | `../project-docs/SYSTEM_ARCHITECTURE.md` |

## Commands (verified against `package.json`)

```bash
yarn install --frozen-lockfile
```

```bash
yarn check
```

`yarn check` runs `typecheck` → `lint` → `format:check` → `build`. Individually:

```bash
yarn typecheck
```

```bash
yarn lint
```

```bash
yarn test
```

```bash
yarn build
```

Database (local only — all of these load `.env.local`):

```bash
yarn db:validate
```

```bash
yarn db:migrate:dev
```

Production migration is `yarn db:migrate:deploy` and is operator-run only.

## Share-Link Backward Compatibility

Existing production share links are a backward-compatibility contract.

Any change affecting share-link creation, resolution, authorization,
domain/website binding, public watch APIs, media grants, playback mapping,
or video-provider behavior MUST preserve existing valid production links.

Read before modifying any related code:

@../project-docs/SHARE_LINK_COMPATIBILITY.md

Breaking existing valid production share links is a release-blocking regression.

That contract is enforced by `test/share-link-compat-*.test.ts`. A failure there
is release blocking - never weaken, skip or delete one of those tests to make a
build pass. The COMPAT-ID map and the failure policy are in

@docs/SHARE_LINK_COMPATIBILITY_TESTS.md

## Security non-negotiables

- Never print, log or copy real values of: `DATABASE_URL`, `JWT_ACCESS_SECRET`,
  `REFRESH_TOKEN_PEPPER`, `SHARE_TOKEN_PEPPER`, `PUBLIC_MEDIA_GRANT_SECRET`,
  `ACCESS_LOG_IP_PEPPER`, `ADMIN_REGISTER_SECRET`,
  `ADMIN_CHANGE_PASSWORD_SECRET`, `CLOUDINARY_API_SECRET`, or any `BUNNY_*`/
  `MUX_*` key.
- Never log Authorization headers, cookies, raw JWTs, raw refresh tokens, raw
  share tokens or media grants. Pino redaction is configured in
  `src/app.module.ts`; do not weaken it.
- IP addresses are stored only as peppered hashes (`ipHash`). Never persist a
  raw client IP.
- Do not enable Swagger in production. It requires both
  `API_INTERNAL_DOCS_ENABLED=true` and `API_DOCS_ALLOW_IN_PRODUCTION=true`.
- Do not weaken `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`,
  `transform` are all on).

## Database / migration rules

- Schema changes go through `prisma/migrations/` only. Never
  `prisma db push` against a shared or production database.
- Never run `prisma migrate reset`, `db push --force-reset`, or any `DROP` on
  production. `scripts/safety/assert-destructive-test-database.ts` guards
  destructive test scripts — do not bypass it.
- Migrations must be additive and backward compatible with the currently
  deployed API build. Deploys are: build → `db:migrate:deploy` → restart.
- `CanonicalVideoShareLink` uses `onDelete: Restrict` on all four relations.
  That is a deliberate provenance invariant — do not change it to cascade.

## Scope discipline

- Do not refactor unrelated modules, upgrade dependencies, or reformat files you
  did not otherwise change.
- Do not implement Bunny Stream. **No Bunny-specific integration exists** — the
  enum member is persistable and plays back generically, but there is no
  service, client, upload, webhook, signing or purge support (see
  @docs/features/bunny-stream.md, status PLANNED).
- If a fix needs a change in `bom-media-admin` or `public_website`, state it;
  do not edit those repos from here.

## Definition of done

1. `yarn typecheck`, `yarn lint`, `yarn test`, `yarn build` all pass.
2. `yarn format:check` passes (on a LF checkout — see @docs/KNOWN_ISSUES.md).
   Note `yarn check` does **not** run tests; run `yarn test` separately.
3. Tests added or updated for any auth, authorization, share-link or media
   access change.
4. Documentation updated **in the same change** when you touch architecture,
   API contracts, env vars, schema/invariants, auth, permissions, deployment,
   video providers, or security assumptions.
5. No secrets in code, docs, logs or commit messages.
6. Report tests you did not run as **NOT RUN** — never as passing.

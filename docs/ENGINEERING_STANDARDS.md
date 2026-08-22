# Engineering Standards

Status: CURRENT
Last verified: 2026-08-21
Verified against: `eslint.config.mjs`, `.prettierrc.json`, `tsconfig*.json`, `src/**` conventions, `.github/workflows/ci.yml`

## 1. Language and tooling

- TypeScript 5.9, CommonJS output, NestJS 11 decorators and DI.
- Yarn 1 only. Never `npm`/`pnpm`; never commit `package-lock.json` or
  `pnpm-lock.yaml` (both are gitignored).
- Prettier: `printWidth: 80`, double quotes, `trailingComma: "all"`.
- ESLint with `@typescript-eslint`. `yarn lint` currently reports 0 errors and
  92 `consistent-type-imports` warnings; the script sets no `--max-warnings`, so
  warnings do not fail CI. **Do not add new warnings**, and prefer
  `import type { … }` in new code.

## 2. File and naming conventions

Follow the surrounding code — these patterns are consistent across `src/`:

| Kind | Pattern | Example |
|---|---|---|
| Controller | `<feature>.controller.ts` | `admin-websites.controller.ts` |
| Service | `<feature>.service.ts` | `public.service.ts` |
| Module | `<feature>.module.ts` | `videos.module.ts` |
| DTO | `dto/<verb>-<noun>.dto.ts` | `dto/create-share-link.dto.ts` |
| Response type | `types/<noun>-response.type.ts` | `types/video-response.type.ts` |
| Utility | `utils/<noun>.util.ts` | `utils/share-url.util.ts` |
| Guard / decorator | `guards/`, `decorators/` | `guards/admin-roles.guard.ts` |
| Test | `test/<subject>.test.ts` | `test/auth-hardening.test.ts` |

Classes `PascalCase`, functions and variables `camelCase`, constants
`SCREAMING_SNAKE_CASE`, files `kebab-case`.

> Several files under `src/admin-websites/dto/` are named `… - Copy.ts`. Those
> are accidental duplicates; do not imitate the pattern and do not import from
> them. See [KNOWN_ISSUES.md](./KNOWN_ISSUES.md#ki-008).

## 3. Controller conventions

Every admin controller must carry, in this order:

```ts
@ApiTags("…")
@ApiBearerAuth()
@UseGuards(AdminAccessTokenGuard, AdminRolesGuard)
@ThrottleProfile(THROTTLE_PROFILES.admin)
@Controller("admin/…")
```

and **every handler** must declare a role: `@AdminReadRoles()`,
`@AdminWriteRoles()` or `@AdminRoles(AdminRole.OWNER)`. A handler with no role
metadata is denied by design — silently unreachable routes are worse than
compile errors, so check this in review.

Controllers stay thin: validate, delegate, shape the response. Business logic
belongs in services.

## 4. DTO and validation

- Every request body and query has a DTO with `class-validator` decorators.
- The global `ValidationPipe` runs with `whitelist`, `forbidNonWhitelisted` and
  `transform`; unknown properties are a `400`. Never relax this per route.
- Bound every string (`@MaxLength`) and every array (`@ArrayMaxSize`).
- Normalise in the DTO with `@Transform` (see `ListVideosQueryDto`) so services
  receive clean input.
- Document with `@ApiProperty` / `@ApiPropertyOptional` — Swagger is generated
  from these.

## 5. Service conventions

- Constructor injection only.
- Use `Serializable` transactions for anything that must not interleave: token
  rotation, share-link creation, assignment replacement, purge.
- Re-read state **inside** the transaction before acting on it; never trust a
  value read before the transaction opened.
- Use conditional `updateMany(...)` to claim a row atomically instead of
  read-then-write (the refresh rotation and the `maxViews` increment are the
  reference implementations).
- Convert `BigInt` to string at the response boundary.
- Tag long multi-step operations with a `stage` so failures are diagnosable
  (`createShareLink` is the reference).

## 6. Error conventions

- Throw Nest `HttpException` subclasses. The global filter shapes the response.
- Admin errors may be specific and actionable, and may carry a stable `code`
  (`ADMIN_PASSWORD_CHANGE_REQUIRED`, `VIDEO_HAS_CANONICAL_SHARE_LINK`, …). Once
  a client depends on a `code`, it is part of the contract.
- **Public errors must stay generic.** Metadata denials use the coarse
  `reasonCode` set; media denials are always `404 "Video not found."`.
- Never leak database, filesystem or provider detail to a client.

## 7. Logging conventions

Structured object first, message second — `logger.error({ … }, "Message.")`.
Log `errorName`, never a raw error message from an external system. Never log
tokens, secrets, raw IPs or full URLs. See [OBSERVABILITY.md](./OBSERVABILITY.md).

## 8. Comment conventions

The codebase comments **why**, not what, and reserves comments for non-obvious
constraints — the `CanonicalVideoShareLink` `Restrict` rationale, the
`buildCanonicalPublicShareUrl` hash-router explanation, the
`AdminRolesGuard` deny-by-default note. Match that density: no narration of
obvious code, but never delete a constraint comment.

## 9. Pull request expectations

1. One concern per PR.
2. `yarn typecheck`, `yarn lint`, `yarn test`, `yarn build` pass locally.
3. Tests added for security-relevant behaviour, failing without the fix.
4. Migration included and reviewed when the schema changed.
5. Documentation updated in the same PR (section 10).
6. No secrets, no `.env` values, no real credentials in the diff or message.
7. State explicitly what you ran and what you did not run.

## 10. Documentation drift prevention

> **Documentation is part of the Definition of Done.**

Update the listed document **in the same pull request** whenever you change:

| Change | Update |
|---|---|
| Module structure or a major flow | `docs/ARCHITECTURE.md`, `docs/REPO_MAP.md` |
| Any endpoint a client calls | `docs/API_CONTRACTS.md` **and** the consuming repo's `docs/API_CONTRACTS.md` |
| An environment variable | `docs/ENVIRONMENT.md` **and** `.env.example` (placeholder only) |
| Prisma schema or an invariant | `docs/DATA_MODEL.md` |
| Auth, guards, roles, tokens | `docs/SECURITY_MODEL.md` **and** `../project-docs/SYSTEM_SECURITY_MODEL.md` |
| Deployment or release process | `docs/DEPLOYMENT.md`, `../project-docs/SYSTEM_DEPLOYMENT.md` |
| Video providers or source types | `docs/features/video-pipeline.md`, `docs/DATA_MODEL.md` |
| Logging, health, audit behaviour | `docs/OBSERVABILITY.md` |
| A decision with lasting consequences | a new `docs/adr/` entry |

Refresh the `Last verified` header of any document you touch. If you discover a
document that contradicts the code, fix the document in that PR or record it in
`docs/KNOWN_ISSUES.md` — never leave a contradiction standing.

## 11. Status discipline

Every architectural statement must be classified: `CURRENT`, `PLANNED`,
`EXPERIMENTAL`, `DEPRECATED` or `RETIRED`.

> **Never document planned behaviour as if it exists.** The canonical example:
> `VideoProvider.BUNNY` exists in the enum and `BUNNY_*` variables exist in
> `.env.example`, but there is **no Bunny implementation**. Bunny is `PLANNED`.
> The same holds for `MUX`.

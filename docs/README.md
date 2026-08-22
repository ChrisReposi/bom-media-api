# bom-media-api — Documentation Index

Status: CURRENT
Last verified: 2026-08-21
Verified against: `src/**`, `prisma/schema.prisma`, `package.json`, `.github/workflows/ci.yml`

Documentation for the BOM Media / Video Share CMS backend. Written for engineers
and for coding agents that need to reach the right file quickly.

## How to read this

Every document carries a status header. Statuses used across this repository:

| Status | Meaning |
|---|---|
| `CURRENT` | Verified against the code as of the stated date |
| `PLANNED` | Intended, **not implemented** |
| `EXPERIMENTAL` | Present but incomplete or not production-confirmed |
| `DEPRECATED` | Present and working, scheduled for replacement |
| `RETIRED` | Removed; kept for history only |

When a document and the code disagree, **the code wins** — then fix the document.

## Core documents

| Document | Answers |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | How the system is put together; traced end-to-end flows |
| [REPO_MAP.md](./REPO_MAP.md) | Where does X live? |
| [ENGINEERING_STANDARDS.md](./ENGINEERING_STANDARDS.md) | Conventions, PR expectations, drift prevention |
| [SECURITY_MODEL.md](./SECURITY_MODEL.md) | Trust boundaries, credentials, security invariants |
| [DATA_MODEL.md](./DATA_MODEL.md) | Domain concepts, relations, invariants, migration rules |
| [API_CONTRACTS.md](./API_CONTRACTS.md) | Endpoints the admin SPA and public site depend on |
| [ENVIRONMENT.md](./ENVIRONMENT.md) | Every environment variable and what it does |
| [TESTING.md](./TESTING.md) | What is tested, how to run it, what is not covered |
| [SHARE_LINK_COMPATIBILITY_TESTS.md](./SHARE_LINK_COMPATIBILITY_TESTS.md) | The release-blocking share-link compatibility suite: COMPAT-ID map and failure policy |
| [SHARE_LINK_COMPATIBILITY_MUTATION_REPORT.md](./SHARE_LINK_COMPATIBILITY_MUTATION_REPORT.md) | Proof that each compatibility protection actually fails when the behaviour it guards is broken |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Build, migrate, release, roll back |
| [OBSERVABILITY.md](./OBSERVABILITY.md) | Logging, health, audit and access logs |
| [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) | Evidence-backed current issues and confirmed mismatches |

## Sub-directories

| Directory | Contents |
|---|---|
| [adr/](./adr/README.md) | Architecture Decision Records |
| [features/](./features/README.md) | Per-feature deep dives and feature specs |
| [runbooks/](./runbooks/README.md) | Index of operational runbooks |
| [generated/](./generated/README.md) | Machine-generated artefacts (OpenAPI etc.) |

## Pre-existing operational documentation

These predate this documentation pass and remain authoritative for their topics:

- `architecture/backend-context.md`, `architecture/local-file-video-storage.md`
- `security/production-auth-hardening.md`, `security/env-security-checklist.md`,
  `security/production-security-verification-checklist.md`,
  `security/secret-rotation-runbook.md`
- `operations/` — production deployment checklist, release runbook, backup and
  restore, Cloudflare hardening, admin account management, canonical share
  links, share-link assignment, local video storage
- `incidents/2026-07-20-production-admin-video-list-500.md`
- `prompts/` — historical task prompts; **not** a description of current
  behaviour. Treat as archive.
- `local-docker-db.md` — local MySQL via Docker Compose

## Cross-repository documentation

System-wide behaviour lives in `../../project-docs/`:

- `SYSTEM_ARCHITECTURE.md`, `SYSTEM_SECURITY_MODEL.md`, `SYSTEM_DEPLOYMENT.md`
- `AI_WORKFLOW.md`, `CUSTOMER_DEPLOYMENT_MODEL.md`, `RELEASE_STRATEGY.md`

## Quick facts

| Fact | Value | Source |
|---|---|---|
| Framework | NestJS 11 | `package.json` |
| ORM | Prisma 7 + `@prisma/adapter-mariadb` | `package.json`, `src/database/prisma.service.ts` |
| Database | MySQL / MariaDB | `prisma/schema.prisma` |
| Global route prefix | `api/v1` (`API_PREFIX`) | `src/common/constants/api.constants.ts` |
| Swagger path | `/docs`, env-gated | `src/main.ts` |
| Package manager | Yarn 1 | `yarn.lock` |
| CI | GitHub Actions, Node 22.22.2, check `backend / validate` | `.github/workflows/ci.yml` |
| Test runner | `node:test` via `tsx` | `package.json` |

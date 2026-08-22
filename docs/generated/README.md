# Generated Artefacts

Status: CURRENT
Last verified: 2026-08-21

Machine-generated documentation artefacts. **Nothing in this directory is
hand-edited** — regenerate instead.

## Current contents

Empty. No generation step writes here yet.

## What belongs here

| Artefact | How it would be produced | Status |
|---|---|---|
| `openapi.json` | Serialise the Swagger document built in `src/main.ts` | Not automated |
| Prisma ERD | A Prisma generator | Not configured |
| Route inventory | Nest router introspection at boot | Not automated |

## OpenAPI today

The specification is built at runtime by `SwaggerModule.createDocument()` and
served at `/docs` **only** when `API_INTERNAL_DOCS_ENABLED=true` and, in
production, `API_DOCS_ALLOW_IN_PRODUCTION=true` as well. There is no committed
snapshot, so there is no risk of a stale committed spec — and no way to diff the
API surface between releases.

To read the spec locally, run the API in development and open `/docs`.

## Rules

1. Never hand-edit a file in this directory.
2. Anything committed here must name the exact command that regenerates it.
3. A generated artefact is not a contract. The contracts that matter are in
   [`../API_CONTRACTS.md`](../API_CONTRACTS.md), which records **consumers** —
   something OpenAPI cannot express.
4. Never commit a generated artefact that embeds secrets, real hostnames or
   customer data.

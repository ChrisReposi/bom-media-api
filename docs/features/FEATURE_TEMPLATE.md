# Feature: <name>

Status: PLANNED | EXPERIMENTAL | CURRENT | DEPRECATED | RETIRED
Last verified: YYYY-MM-DD
Verified against: <files, configuration, or "not yet implemented">
Owner: <who is accountable>

> Copy this file, rename it in kebab-case, and fill in **every** section.
> Sections that do not apply get "None" — do not delete them. A reviewer needs
> to see that the question was asked.

## Goal

What this feature makes possible, in two or three sentences. State the user or
operator outcome, not the implementation.

## Non-goals

What this deliberately does not do. Prevents scope creep during review.

## Existing behaviour

What the system does today, with file paths. If the answer is "nothing", say so
explicitly.

## Target behaviour

What the system will do once this ships. Present tense is only allowed here
once the status is `CURRENT`.

## Architecture

Where this lives: modules, services, boundaries, the request/data flow. A small
diagram beats prose. Name the files that will change.

## Backend impact

New or changed endpoints, DTOs, guards, services, background work. Note anything
that alters the authorization chain.

## Admin impact

Changes needed in `bom-media-admin`: API client, state, routes, UI, permission
presentation. "None" if untouched.

## Public impact

Changes needed in `public_website`: response fields consumed, playback,
routing, CSP. Remember that deployed customer bundles may be older than the
backend.

## Database impact

New or changed models, fields, indexes, enums. Deletion behaviour. Which
invariants in `../DATA_MODEL.md` are affected or added.

## Environment variables

Every new variable: name, purpose, default, whether required in production,
whether it is a secret. Values never appear here.

## Security considerations

Trust boundaries crossed, credentials introduced, authorization changes, new
attack surface, what must never be logged. Which invariants in
`../SECURITY_MODEL.md` are affected, and any new invariant this adds.

## Performance considerations

Expected request volume, payload sizes, N+1 risk, caching, streaming, bandwidth,
storage growth, connection-pool impact.

## Migration

Prisma migration plan, backfill strategy, and how it stays compatible with the
currently running build (expand → backfill → contract). Data migration for
existing records.

## Backward compatibility

What breaks for existing clients. Which contracts in `../API_CONTRACTS.md`
change. How older deployed public-site bundles keep working.

## Rollback

How to undo this if it fails in production. Is a code-only rollback enough? If a
migration is involved, what is the recovery path?

## Observability

New log events, audit actions, health checks, metrics. How an operator confirms
this is working, and how they diagnose it when it is not.

## Acceptance criteria

Numbered, individually verifiable statements. Someone other than the author must
be able to check each one.

1. …
2. …

## Required tests

Specific suites and cases, including the failure paths — unauthorized, expired,
revoked, wrong host, over-limit. Each security-relevant test must fail without
the implementation.

## Open questions

Anything unresolved. An unanswered question here is better than an assumption
buried in code.

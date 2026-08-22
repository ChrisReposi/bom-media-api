# ADR 0006 — MariaDB adapter with an explicit protocol control

Status: ACCEPTED
Last verified: 2026-08-21
Verified against: `src/database/prisma.service.ts`, `src/config/env.config.ts`, `src/common/diagnostics/*`, `src/common/errors/parse-mariadb-collation-conflict.util.ts`, `docs/incidents/2026-07-20-production-admin-video-list-500.md`

## Context

Production runs on Hostinger-managed MariaDB rather than upstream MySQL. On
2026-07-20 the production `/admin/videos` list returned HTTP 500 while the same
build worked locally. The differences were server-side — collation handling and
binary-protocol behaviour on the managed host — not application logic.

## Decision

Use Prisma 7 with `@prisma/adapter-mariadb`, driven by explicit,
environment-controlled connection settings, plus targeted diagnostics.

- The adapter is built from `DATABASE_URL` with `DB_CONNECTION_LIMIT`,
  `DB_CONNECT_TIMEOUT_MS`, `DB_ACQUIRE_TIMEOUT_MS` and
  `DB_IDLE_TIMEOUT_SECONDS`.
- `DB_MARIADB_USE_TEXT_PROTOCOL` switches the adapter to the text protocol as an
  operator-controllable mitigation, defaulting to `false`.
- A read-only collation probe runs after `listen()` **only** when
  `DIAG_MARIADB_COLLATION_PROBE` equals the exact literal
  `I_UNDERSTAND_THIS_ONLY_READS_SESSION_METADATA`.
- `parse-mariadb-collation-conflict.util.ts` recognises the collation-conflict
  signature, and `safe-database-error-context.util.ts` puts sanitised database
  context into 5xx logs without exposing SQL or query arguments.

## Alternatives

- **Default Prisma MySQL engine.** Less control over pool and protocol on a
  managed MariaDB host, and it is where the incident occurred. Rejected.
- **Hard-code the text protocol.** Removes a diagnostic dimension and may cost
  performance where the binary protocol is fine. Rejected.
- **Always-on collation probing.** Runs queries nobody asked for on every boot.
  Rejected in favour of the explicit opt-in literal.
- **Migrate off managed MariaDB.** Out of scope; conflicts with the Hostinger
  hosting model.

## Consequences

- Protocol behaviour is switchable at runtime without a code change, which is
  what an operator needs mid-incident.
- Pool sizing is explicit and conservative, appropriate for shared hosting.
- The diagnostic surface is guarded by a literal that cannot be enabled by
  accident.
- Local development against MySQL may not reproduce MariaDB-only behaviour;
  `yarn docker:mariadb-test:up` and `yarn test:integration:mariadb-video-queries`
  exist for that reason.

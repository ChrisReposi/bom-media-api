# Architecture Decision Records

Status: CURRENT
Last verified: 2026-08-21

Backend-scoped decisions. Cross-application decisions (customer deployment
model, release strategy, video-storage direction) live in
[`../../../project-docs/adr/`](../../../project-docs/adr/README.md).

## Format

Every ADR has exactly these sections: **Context**, **Decision**,
**Alternatives**, **Consequences**, **Status**.

| Status | Meaning |
|---|---|
| `PROPOSED` | Written down; evidence is not yet sufficient to call it final |
| `ACCEPTED` | The decision is implemented and load-bearing in the code |
| `SUPERSEDED` | Replaced; must link to the ADR that replaces it |
| `REJECTED` | Considered and deliberately not taken |

An ADR is only `ACCEPTED` when the code demonstrably implements it. Record
intentions as `PROPOSED`.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](./0001-session-bound-admin-access-tokens.md) | Session-bound admin access tokens | ACCEPTED |
| [0002](./0002-opaque-rotating-refresh-tokens.md) | Opaque, single-use, rotating refresh tokens | ACCEPTED |
| [0003](./0003-share-link-alias-and-peppered-token.md) | Share links use a stored alias plus a peppered token hash | ACCEPTED |
| [0004](./0004-hmac-media-grants-for-view-limited-links.md) | HMAC media grants for view-limited share links | ACCEPTED |
| [0005](./0005-canonical-share-link-restrict-deletes.md) | Canonical share links use RESTRICT deletes | ACCEPTED |
| [0006](./0006-mariadb-adapter-protocol-controls.md) | MariaDB adapter with an explicit protocol control | ACCEPTED |
| [0007](./0007-video-storage-direction.md) | Third-party video storage/delivery direction | PROPOSED |

## Numbering

Four digits, incrementing, never reused. Filename:
`NNNN-kebab-case-title.md`.

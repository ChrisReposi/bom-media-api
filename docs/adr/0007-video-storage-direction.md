# ADR 0007 — Third-party video storage and delivery direction

Status: PROPOSED
Last verified: 2026-08-21
Verified against: `src/videos/**`, `prisma/schema.prisma` (`VideoProvider`, `VideoSourceType`), `.env.example`, `PLAN.md`, `AGENTS.md`

## Context

Five storage strategies exist in the code today: remote `DIRECT_URL`,
third-party `EMBED`, Cloudinary `UPLOAD`, database `DB_BLOB`, and self-hosted
`LOCAL_FILE` on Hostinger NVMe.

`LOCAL_FILE` currently avoids third-party media cost, but the backend serves
every byte itself: each viewer's Range requests occupy a Node process and the
host's bandwidth, and `LOCAL_VIDEO_MIN_FREE_SPACE_MB` exists precisely because
the disk is finite and shared with everything else on the plan.

`VideoProvider` already reserves `BUNNY` and `MUX`, and `.env.example` reserves
`BUNNY_STREAM_*` and `MUX_*` variables. **Neither has any implementation.**

## Decision (proposed)

Treat a third-party video storage and delivery provider as the intended primary
path for production video, keeping `LOCAL_FILE` as a supported self-hosted
option and `DB_BLOB` as a small fallback only.

Constraints any provider integration must satisfy:

- It plugs in behind the existing `VideoProvider` / `VideoSourceType` model; the
  public watch response keeps returning URL fields the client uses verbatim.
- Public access authorization stays in this backend: domain → website → share
  link → assignment → `READY`. A provider URL must never become an
  unauthenticated bypass, which means signed, expiring provider URLs.
- Per-customer isolation: each customer deployment uses its own provider
  account/library and its own credentials.
- Secrets are referenced by name only in documentation and supplied per
  deployment.

## Alternatives

- **Stay on `LOCAL_FILE` indefinitely.** No third-party cost and complete
  control, but the origin serves all video bandwidth, storage is capped by the
  plan, and backup/restore must keep the database and filesystem consistent.
  Viable for small deployments; does not scale.
- **Expand `DB_BLOB`.** Rejected on the merits and already constrained in code
  to 100 MB with a production guard.
- **Cloudinary as the primary video CDN.** Already implemented and working, but
  positioned in the current direction as image/thumbnail and legacy video
  support rather than the primary video path.
- **Self-hosted object storage plus a CDN.** More moving parts to operate for
  the same outcome as a managed provider.

## Consequences

- New per-customer secrets and a per-customer provider account.
- A migration path is needed for existing `LOCAL_FILE` and `DB_BLOB` assets;
  both must keep working during and after any transition.
- Playback authorization becomes a two-step exchange (authorize here, then hand
  out a short-lived provider URL), so `docs/SECURITY_MODEL.md` and
  `docs/API_CONTRACTS.md` will need updating.
- Until such an integration exists, `BUNNY` and `MUX` remain `PLANNED`
  placeholders and must be documented as such.

## Status note

`PROPOSED`, not `ACCEPTED`. The direction is supported by `PLAN.md`, `AGENTS.md`
and the reserved enum/env names, but no provider integration exists and no
commercial decision is recorded in the repository. See
[`../features/bunny-stream.md`](../features/bunny-stream.md) and
`../../../project-docs/adr/`.

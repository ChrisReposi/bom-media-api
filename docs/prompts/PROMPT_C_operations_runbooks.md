# PROMPT C — Operations and Production Runbooks

Now do the operational/documentation pass for BOM Media API.

You are not allowed to pretend that Cloudflare dashboard settings, backup jobs, or secret rotation were completed outside the repo.

## Goal

Produce production hardening runbooks for BOM Media API.

## Must Cover

1. Secret rotation runbook: Cloudinary secret, JWT access secret, refresh-token pepper/session secret material, share-token pepper, access-log IP pepper, order of rotation, rollback notes, forced re-login impact, share-link invalidation impact, emergency compromise procedure.
2. Cloudflare runbook: WAF/rate limits for admin auth and public watch, Admin Web behind Cloudflare Access, origin protection via Tunnel or equivalent, exact paths/hosts to protect, starter thresholds, manual dashboard steps.
3. Production env policy: docs off, DB_BLOB off, required placeholders, CORS/admin origins, Prisma pool env, trust proxy guidance.
4. Backup and restore: off-site backup, logical dump, restore-test checklist, frequency, RPO/RTO placeholders, evidence checklist.
5. Security verification: login, refresh rotation, logout revoke, password change revoke, 429 throttling, docs disabled, DB_BLOB disabled, audit log safety, log redaction, proxy/IP correctness, dynamic CORS, public watch generic errors.

## Deliverables

Create/update:

- `docs/security/production-auth-hardening.md`
- `docs/security/env-security-checklist.md`
- `docs/operations/cloudflare-hardening-runbook.md`
- `docs/operations/backup-restore-runbook.md`
- `docs/operations/production-deployment-checklist.md`
- `session-log.md`

Style: concrete, repo-specific, manual steps clearly marked, placeholders only, no real secrets.

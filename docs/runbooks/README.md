# Runbooks

Status: CURRENT
Last verified: 2026-08-21

Index of operational procedures. The runbooks themselves predate this
documentation pass and live in `../operations/` and `../security/`; this page
exists so there is one place to start from.

## Release and deployment

| Task | Runbook |
|---|---|
| Pre-flight before any production deploy | [`../operations/production-deployment-checklist.md`](../operations/production-deployment-checklist.md) |
| Step-by-step release execution | [`../operations/production-release-runbook.md`](../operations/production-release-runbook.md) |
| Deployment shape, rollback model | [`../DEPLOYMENT.md`](../DEPLOYMENT.md) |

## Security

| Task | Runbook |
|---|---|
| Rotating any secret | [`../security/secret-rotation-runbook.md`](../security/secret-rotation-runbook.md) |
| Pre-deploy environment review | [`../security/env-security-checklist.md`](../security/env-security-checklist.md) |
| Post-deploy security verification | [`../security/production-security-verification-checklist.md`](../security/production-security-verification-checklist.md) |
| Auth hardening background | [`../security/production-auth-hardening.md`](../security/production-auth-hardening.md) |
| Edge hardening (WAF, rate limits, Access) | [`../operations/cloudflare-hardening-runbook.md`](../operations/cloudflare-hardening-runbook.md) |

## Data and storage

| Task | Runbook |
|---|---|
| Backup and restore | [`../operations/backup-restore-runbook.md`](../operations/backup-restore-runbook.md) |
| Hostinger private storage setup | [`../operations/local-video-storage-runbook.md`](../operations/local-video-storage-runbook.md) |
| Local storage smoke test | [`../operations/local-video-storage-smoke-test.md`](../operations/local-video-storage-smoke-test.md) |
| Storage architecture | [`../architecture/local-file-video-storage.md`](../architecture/local-file-video-storage.md) |
| Example storage scripts | `../../scripts/storage/`, `../../scripts/backup/` |

## Accounts and access

| Task | Runbook |
|---|---|
| Creating/managing admin accounts | [`../operations/admin-account-management-runbook.md`](../operations/admin-account-management-runbook.md) |
| Feature behaviour and gating | [`../features/admin-accounts.md`](../features/admin-accounts.md) |
| Expired session cleanup | `yarn cleanup:admin-sessions` |

## Share links

| Task | Runbook |
|---|---|
| Canonical share-link operations | [`../operations/canonical-share-link-runbook.md`](../operations/canonical-share-link-runbook.md) |
| Canonical adoption worksheet | [`../operations/canonical-share-link-adoption-worksheet.md`](../operations/canonical-share-link-adoption-worksheet.md) |
| Share-link assignment (production) | [`../operations/share-link-assignment-production-runbook.md`](../operations/share-link-assignment-production-runbook.md) |
| Assignment remediation worksheet | [`../operations/share-link-assignment-remediation-worksheet.md`](../operations/share-link-assignment-remediation-worksheet.md) |

## Incidents

| Task | Reference |
|---|---|
| Admin video list 500 (2026-07-20) | [`../incidents/2026-07-20-production-admin-video-list-500.md`](../incidents/2026-07-20-production-admin-video-list-500.md) |
| Related decision | [`../adr/0006-mariadb-adapter-protocol-controls.md`](../adr/0006-mariadb-adapter-protocol-controls.md) |
| Diagnostic script | `yarn diagnose:admin-video-queries` |
| What is logged and where | [`../OBSERVABILITY.md`](../OBSERVABILITY.md) |

## Local development

| Task | Reference |
|---|---|
| Local MySQL via Docker | [`../local-docker-db.md`](../local-docker-db.md) |
| MariaDB test container | `yarn docker:mariadb-test:up` / `:down` |
| Running tests | [`../TESTING.md`](../TESTING.md) |

## Rules for every runbook

1. Every destructive step names its backup or rollback first.
2. Placeholders (`<API_RELEASE_PATH>`) are never guessed — the operator fills
   them in.
3. Never print secrets, tokens or `DATABASE_URL` to a terminal or a log.
4. `prisma migrate reset`, `db push --force-reset`, `DROP COLUMN` during a
   release window, and `git reset --hard` on a production checkout are
   forbidden.
5. Record what was actually run and what it returned.

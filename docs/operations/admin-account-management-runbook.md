# Admin account management rollout and rollback

## Safety gates

- Keep `ADMIN_ACCOUNT_MANAGEMENT_ENABLED=false` during the migration and first API restart.
- Do not rotate existing auth secrets as part of this rollout.
- Back up MySQL and record a restore point before `yarn db:migrate:deploy`.
- Run `yarn audit:admin-accounts` with a read-only database principal. Exit `2` requires OWNER review; exit `1` is an execution failure.
- Confirm exactly one non-deleted OWNER, no normalized username conflicts, and no logically deleted ACTIVE accounts.

## Staging rollout

1. Review the additive migration SQL and MySQL/MariaDB index-lock behavior.
2. Run `yarn db:migrate:deploy` with the Production environment.
3. Deploy the API with account management disabled; smoke existing login, refresh, logout, and the deprecated password endpoint.
4. Enable the feature in staging and run `yarn smoke:local:admin-accounts` only against a disposable local environment. For staging, execute the equivalent authenticated HTTP flow without printing credentials.
5. Deploy Admin Web and verify OWNER-only account fetch, forced password change, one-time temporary-password handling, own-session revoke, and multi-tab refresh/logout/identity switching.
6. Enable Production only after OWNER approval and monitor account-management 401/403/409/429/5xx plus session growth.

## Session retention

`yarn cleanup:admin-sessions` is dry-run by default. It reports expired/revoked rows older than 90 days. Apply is bounded and requires an exact environment confirmation, for example:

```txt
yarn cleanup:admin-sessions --apply --confirm-env=production --retention-days=90 --batch-size=100 --max-batches=10
```

The cleanup never selects or deletes active sessions, account rows, or audit logs. Take a backup and review dry-run counts before applying.

## Rollback

1. Disable `ADMIN_ACCOUNT_MANAGEMENT_ENABLED` first.
2. Roll back Admin Web before API code; keep the additive schema and indexes.
3. Do not remove a deployed migration.
4. If any created account still has `mustChangePassword=true`, keep forced-change enforcement or disable and revoke that account before using older API code.
5. Correct logical-delete mistakes with an approved forward-fix. Never physical-delete the retained account/audit/upload history.

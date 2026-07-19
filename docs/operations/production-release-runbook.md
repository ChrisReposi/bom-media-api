# Production Release Runbook — 2026-07-18 Hardening Release

Applies to the paired release branches `release/2026-07-18-production-hardening`
in `bom-media-api` and `bom-media-admin`. All commands below are for the
**operator** to run manually. Replace every `<PLACEHOLDER>` before use; never
guess production paths or process names.

Placeholders used throughout:

```txt
<API_RELEASE_PATH>          absolute path of the API release directory on Hostinger
<ADMIN_RELEASE_PATH>        absolute path of the Admin static site directory
<PM2_APP_NAME>              PM2 app name, if PM2 is used
<HOSTINGER_NODE_APP_NAME>   Hostinger Node application name, if hPanel-managed
<PRODUCTION_DATABASE_NAME>  production MySQL database name
<BACKUP_DIRECTORY>          backup destination outside the release directories
<CLOUDFLARE_ZONE>           Cloudflare zone for the admin/public hostnames
```

Forbidden at every step:

```txt
prisma migrate reset
prisma db push --force-reset
DROP COLUMN during the incident/release window
git reset --hard on production checkouts
uploading Admin dist file-by-file (must be atomic)
printing secrets, tokens, or DATABASE_URL to terminals or logs
```

## 1. Current release identification

- Record the deployed API identity **before** touching anything:
  - `curl -s https://<API_HOST>/api/v1/health` — after this release the payload
    includes `release.commit` / `release.builtAt` when the operator injected
    `APP_BUILD_SHA` / `APP_BUILD_TIME` at deploy time. On the current
    production build this field will be absent — that absence itself confirms
    the old build is running.
- Record Admin identity: load the admin site with DevTools → Network, note
  `index.html` asset hashes (`assets/index-*.js`, `videoFormatters-*.js`).

## 2. Read-only production audit

- API log grep (read-only): look for `P2022` (schema drift signature) vs
  timeout/pool errors around `/admin/videos` 500s.
- `yarn db:migrate:status` against production (read-only) from the release
  checkout — expect the pre-release DB to be missing the newest migrations:
  `20260714050000_production_hardening_indexes`,
  `20260716130000_admin_account_management`.
- Confirm which endpoint the production Dashboard calls (Network tab):
  `/admin/videos` = old build; `/admin/websites/:id/videos` = new build.

## 3. Database backup

```bash
mysqldump --single-transaction --routines --triggers \
  <PRODUCTION_DATABASE_NAME> > <BACKUP_DIRECTORY>/pre-2026-07-18-release.sql
```

Verify the dump is non-empty and restorable per
`docs/operations/backup-restore-runbook.md` before continuing.

## 4. Media filesystem backup

- Snapshot or rsync the LOCAL_FILE storage root to `<BACKUP_DIRECTORY>`
  (paths per `docs/operations/local-video-storage-runbook.md`). Do not move or
  rename the live storage root.

## 5. Rollback artifact preparation

- Keep the currently deployed API build directory and the currently deployed
  Admin `dist` as-is (rename to `*-rollback-<date>` copies in
  `<BACKUP_DIRECTORY>`; do not delete).

## 6. API deployment

- Build from `release/2026-07-18-production-hardening` (API HEAD `e3d0ffc`):
  `yarn install --frozen-lockfile && yarn build`.
- Inject release identity into the production environment before start:

```txt
APP_BUILD_SHA=<short commit SHA of the deployed build>
APP_BUILD_TIME=<ISO timestamp of the build, e.g. 2026-07-18T00:00:00.000Z>
APP_RELEASE_VERSION=2026.07.18   # optional
```

- Deploy the build output to `<API_RELEASE_PATH>` atomically (upload to a new
  directory, switch, never edit in place).

## 7. Migration deploy

```bash
cd <API_RELEASE_PATH>
yarn db:migrate:deploy
```

Additive-only migrations. Then re-run `yarn db:migrate:status` — it must
report no pending migrations.

## 8. Node process restart

- PM2: `pm2 restart <PM2_APP_NAME>` — or restart
  `<HOSTINGER_NODE_APP_NAME>` from hPanel. Confirm the process start time
  changed.

## 9. API smoke (all read paths first, then one write cycle)

```txt
GET  /api/v1/health                      → 200, release.commit matches deployed SHA
GET  /api/v1/health/ready                → 200, database ok, storage ok
GET  /admin/videos?page=1&limit=20&status=READY&sortBy=createdAt&sortOrder=desc → 200
GET  /admin/videos?...&search=sml        → 200 (not 500)
GET  /admin/videos?...&search=s%25l      → 200, matches LITERALLY (no wildcard explosion)
POST /admin/videos/upload-local/init  (small fixture, filterKey=sml) → 201
POST chunks + complete                   → 201, response filterKey = "sml"
GET  /admin/videos/:id                   → filterKey = "sml"
PATCH /admin/videos/:id {"durationSeconds":42} → 200, filterKey STILL "sml"
PATCH /admin/videos/:id {"filterKey":null}     → 200, filterKey null
GET  /admin/websites/:websiteId/videos?assignmentStatus=ACTIVE&eligibleForShareLink=true → 200
```

Clean up the smoke fixture via disable (DELETE) + purge with exact-ID
confirmation.

## 10. Admin atomic deployment

- Build from `release/2026-07-18-production-hardening` (Admin HEAD after this
  session): `yarn install --frozen-lockfile && yarn build && yarn smoke:build`.
- Upload the **whole `dist/` directory atomically** to
  `<ADMIN_RELEASE_PATH>` (new directory + switch). Never mix old and new
  hashed chunks — mixed chunks reproduce the filterKey-loss symptom class.

## 11. Cloudflare purge

- Purge `<CLOUDFLARE_ZONE>` cache for the admin hostname after the atomic
  switch. Verify `CF-Cache-Status` on `index.html` is not serving the old
  HTML, and that hashed assets return the new hashes.

## 12. Browser acceptance

```txt
index.html references only new asset hashes; no 404 chunks; no mixed hashes
Dashboard picker calls /admin/websites/:id/videos (not /admin/videos)
CreateVideo LOCAL_FILE with Key lọc video = SML → video shows filterKey sml
   without opening EditVideoModal
single/multiple selection modes behave per spec; website switch clears selection
role gating: STAFF read-only, ADMIN write, OWNER account management + purge
forced-password route works; Settings account management OWNER-only
logout, token refresh, and cross-tab logout behave
no console errors on /login, /, /videos, /videos/:id, /websites, /domains, /settings
```

## 13. Rollback decision tree

```txt
Admin-only visual/JS issue        → restore previous Admin dist (static, instant),
                                    purge Cloudflare again. API stays.
API 5xx after deploy              → restart once; if persistent, redeploy previous
                                    API build. Migrations are additive: the old
                                    build runs fine against the migrated schema.
Schema-level issue                → do NOT roll back the schema during the window;
                                    additive columns/indexes are backward-safe.
                                    Never DROP COLUMN as an incident response.
filterKey/search regressions      → verify /health release.commit first: if the
                                    old build is still running, the deploy did not
                                    switch — fix the switch, don't touch code.
When NOT to rollback              → single-user errors, cache artifacts (purge
                                    first), or anything explained by a stale
                                    browser session (hard refresh / private window).
```

# Deployment

Status: CURRENT
Last verified: 2026-08-21
Verified against: `package.json`, `.github/workflows/ci.yml`, `tsconfig.hostinger.json`, `docs/operations/*`

Step-by-step operator procedures live in
[`./operations/production-deployment-checklist.md`](./operations/production-deployment-checklist.md)
and [`./operations/production-release-runbook.md`](./operations/production-release-runbook.md).
This document explains the shape of the deployment and the constraints that make
it safe.

## 1. Artefact

A plain Node process. `yarn build` runs `prisma generate` then `nest build`,
producing `dist/`, started with:

```bash
node dist/main.js
```

`yarn start` and `yarn start:prod` both run exactly that. There is no
containerised production image in this repository; the Docker Compose files are
for **local MySQL/MariaDB only**.

`tsconfig.hostinger.json` exists for the Hostinger Node build target.

## 2. Target topology

Status of this section: **UNVERIFIED EXTERNAL INFRASTRUCTURE**. The diagram below
is the intended operational shape, reconstructed from the operations runbooks. No
part of it is configured or verified by this repository — see
[../../project-docs/SYSTEM_DEPLOYMENT.md](../../project-docs/SYSTEM_DEPLOYMENT.md)
for the classification scheme.

```
Internet
  └─ Cloudflare (DNS, WAF, rate limiting, Access for admin hostnames)
       ├─ admin hostname   → static bundle from bom-media-admin/dist
       ├─ customer domains → static public_website bundle
       │                       /_api/*   must be proxied to the API's /api/v1/*
       │                       /_media/* proxied when used
       └─ api hostname     → Node process (this repository)
                               └─ MySQL / MariaDB (Hostinger managed)
                               └─ private NVMe at LOCAL_FILE_STORAGE_ROOT
```

> **`/_api` proxy — EXTERNAL / NOT REPRESENTED IN REPOSITORY.** Repository-level
> proxy implementation not found. The public application expects `/_api` when no
> explicit API base is configured; actual production proxy/routing is external
> and unverified from this workspace. It is expected to exist as a Cloudflare
> Worker, a host rewrite or an equivalent, and should be verified per deployment.
> See [KNOWN_ISSUES.md](./KNOWN_ISSUES.md#ki-001) and
> `../../public_website/docs/DEPLOYMENT.md`.

## 3. Release sequence

```
1. Merge to main only after CI is green.
2. Tag the release (semantic version).
3. On the target host, from a clean checkout of the tag:
     yarn install --frozen-lockfile
     yarn db:generate
     yarn build
4. Back up the database (see the backup runbook). Non-negotiable.
5. yarn db:migrate:deploy
6. Restart the API process.
7. Verify (section 5).
```

Injecting `APP_RELEASE_VERSION`, `APP_BUILD_SHA` and `APP_BUILD_TIME` at build
time makes `/health` self-identifying, which is how an operator confirms which
build is live. Do this.

> **INVARIANT: merging to `main` does not deploy anybody.** Rollout to each
> customer deployment is a separate, deliberate operator action. See
> `../../project-docs/RELEASE_STRATEGY.md` and
> `../../project-docs/CUSTOMER_DEPLOYMENT_MODEL.md`.

## 4. Migration safety

- Only `yarn db:migrate:deploy` in production. Never `migrate dev`, never
  `db push`, never `migrate reset`.
- Migrations must be **additive and compatible with the currently running
  build**, because the process keeps serving during step 5. Expand → backfill →
  contract, across releases.
- Never `DROP COLUMN` during a release or incident window.
- Take the backup first, every time.
- Confirm state with `yarn db:migrate:status` (read-only) before and after.

## 5. Post-deploy verification (minimum)

- `GET /api/v1/health` returns `ok` **and the expected `release`**.
- `GET /api/v1/health/ready` reports `database: ok` and the expected `storage`.
- `/docs` is **not** reachable.
- Admin login, refresh and logout work; a logged-out access token is rejected.
- Repeated bad logins trigger `429`.
- A known-good public share link resolves; an invalid one stays generic.
- Media requests return `200`/`206`; seeking does not produce `403`/`404`/`429`.
- For a view-limited link, media URLs carry a `grant` and playback can seek.
- Removing a `WebsiteVideo` assignment immediately denies that video publicly.
- `STAFF` writes return `403`; `ADMIN` purge returns `403`; OWNER purge still
  requires confirmation.

The full list is in `./operations/production-deployment-checklist.md`.

## 6. Rollback

| Situation | Action |
|---|---|
| Code-only regression, no migration | Redeploy the previous tag and restart. Fast and safe |
| Regression after an additive migration | Redeploy the previous tag. The extra columns/tables are ignored by the old build — **this is why migrations must be additive** |
| Regression after a destructive migration | No code rollback is possible. Restore from backup. Avoid ever being here |
| Bad configuration | Correct the environment and restart; no rebuild needed |

Prisma has no down-migrations here. Recovery for a destructive change is a
database restore, which is why the pre-deploy backup is mandatory.

## 7. Environment at deploy time

Provided by the host's process environment (Hostinger panel, PM2 ecosystem file
or systemd unit) — never by a committed file. `.env*` files are gitignored.
Required and production-required variables are listed in
[ENVIRONMENT.md](./ENVIRONMENT.md). The process **fails fast** on invalid
configuration, so a bad deploy shows up immediately in the process log rather
than at first request.

Production expectations: `API_INTERNAL_DOCS_ENABLED=false`,
`API_DOCS_ALLOW_IN_PRODUCTION=false`, `VIDEO_DB_STORAGE_ENABLED=false`,
`ADMIN_REGISTER_ENABLED=false`, `ADMIN_ACCOUNT_MANAGEMENT_ENABLED=false` unless
onboarding, `ADMIN_WEB_ORIGIN` a non-local HTTPS origin, and `TRUST_PROXY_*`
matching the real ingress path.

## 8. Local file storage at deploy time

When `LOCAL_FILE_STORAGE_ENABLED=true`:

- `LOCAL_FILE_STORAGE_ROOT` must be absolute, outside every public web root, and
  writable by the API user. Startup rejects public-web-root-looking paths.
- The directory is **not** part of the code deploy; it must survive releases.
- Database backups and filesystem backups must be coordinated to the same
  window, and restore tests must cover both together. A restored database with
  missing files produces broken videos with valid-looking metadata.
- Schedule temp-upload cleanup using `LOCAL_VIDEO_STALE_UPLOAD_MAX_AGE_HOURS`
  and the examples in `scripts/storage/`.

## 9. Cloudflare and edge

**UNVERIFIED EXTERNAL INFRASTRUCTURE.** None of the following is configured,
required or checked by this repository. Treat each as an operational assumption
to confirm per deployment, not as a property of the system:

- WAF and rate-limiting rules in front of the API.
- Cloudflare Access on admin hostnames.
- Raw-origin ingress restricted (Tunnel or origin firewall).
- Range requests passed through intact — required for `206` playback.
- `LOCAL_VIDEO_CHUNK_SIZE_MB` kept below the edge request-size limit.

See `./operations/cloudflare-hardening-runbook.md`.

## 10. Scaling note

The in-memory cache and the throttler counters are **per process**. Running more
than one Node process multiplies effective rate limits and gives each process an
independent cache. Multi-process deployment requires a shared store first —
`PLANNED`, not implemented.

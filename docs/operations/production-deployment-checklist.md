# Production Deployment Checklist

Use this checklist with:

- [Secret Rotation Runbook](../security/secret-rotation-runbook.md)
- [Environment Security Checklist](../security/env-security-checklist.md)
- [Production Security Verification Checklist](../security/production-security-verification-checklist.md)
- [Cloudflare Hardening Runbook](./cloudflare-hardening-runbook.md)
- [Backup And Restore Runbook](./backup-restore-runbook.md)
- [Local File Video Storage](../architecture/local-file-video-storage.md)
- [Hostinger LOCAL_FILE Storage Runbook](./local-video-storage-runbook.md)
- [LOCAL_FILE Storage Smoke Test](./local-video-storage-smoke-test.md)

## Before Deploy

- [ ] No real secrets committed.
- [ ] `.env` is managed outside git.
- [ ] `API_INTERNAL_DOCS_ENABLED=false`.
- [ ] `API_DOCS_ALLOW_IN_PRODUCTION=false`.
- [ ] `VIDEO_DB_STORAGE_ENABLED=false`.
- [ ] `VIDEO_DB_STORAGE_ALLOW_PRODUCTION_OVERRIDE=false`.
- [ ] If `LOCAL_FILE_STORAGE_ENABLED=true`, `LOCAL_FILE_STORAGE_ROOT` is private, writable by the API user, and outside public web roots.
- [ ] `LOCAL_VIDEO_UPLOAD_MAX_MB=500` unless staging evidence approves a temporary higher value.
- [ ] `LOCAL_VIDEO_UPLOAD_HARD_MAX_MB=1024` or lower.
- [ ] `LOCAL_VIDEO_CHUNK_SIZE_MB` stays below Cloudflare/upstream request-size limits.
- [ ] `LOCAL_VIDEO_MIN_FREE_SPACE_MB` keeps a 10GB-20GB reserve.
- [ ] `VIDEO_VIEW_GROWTH_ENABLED` is set intentionally for the environment.
- [ ] `VIDEO_VIEW_MAX_INCREMENT_PER_EVENT<=99` and hourly cap/dedupe envs are reviewed.
- [ ] In-memory cache envs are set intentionally: `MEMORY_CACHE_ENABLED`, `MEMORY_CACHE_MAX_ENTRIES`, `MEMORY_CACHE_DEFAULT_TTL_SECONDS`, `MEMORY_CACHE_INFLIGHT_TTL_MS`.
- [ ] Admin/public metadata cache TTLs are conservative: `ADMIN_VIDEOS_LIST_CACHE_TTL_SECONDS`, `ADMIN_WEBSITES_LIST_CACHE_TTL_SECONDS`, `PUBLIC_WATCH_METADATA_CACHE_TTL_SECONDS`, `MEDIA_METADATA_CACHE_TTL_SECONDS`.
- [ ] Team understands the in-memory cache is process-local, cleared on restart, and not shared across Hostinger Node processes.
- [ ] Local file storage free-space and backup policy reviewed.
- [ ] Filesystem backup for `LOCAL_FILE_STORAGE_ROOT/videos` exists or is scheduled outside this repo.
- [ ] DB backup and local file backup are coordinated to the same time window.
- [ ] Restore test covers DB metadata and physical LOCAL_FILE files together.
- [ ] Temp upload cleanup procedure is documented and dry-run reviewed.
- [ ] `ADMIN_REGISTER_ENABLED=false` unless controlled onboarding is required.
- [ ] `PUBLIC_MEDIA_GRANT_SECRET` is an independent secret of at least 32 characters and grant TTL is 5 minutes to 24 hours.
- [ ] Cloudinary secret rotated if ever exposed.
- [ ] JWT/refresh/share peppers rotated as planned.
- [ ] Database backup taken.
- [ ] Off-site database backup exists.
- [ ] Restore test recently completed and evidence recorded.
- [ ] Prisma migration reviewed.
- [ ] If deploying video grouping/purge hardening, confirm the additive `VideoAsset.filterKey` migration is included and reviewed.
- [ ] Auth/session migration reviewed; existing admins will need to log in again.
- [ ] Admin Web is the only admin surface.
- [ ] Public sites do not ship mini-admin production logic.
- [ ] Cloudflare Access policy protects admin-web hostname.
- [ ] Cloudflare WAF/rate-limit rules reviewed.
- [ ] Raw origin is protected by Tunnel or origin firewall where possible.
- [ ] Trust proxy env and `TRUSTED_PROXY_CIDRS` match the actual Cloudflare/Hostinger path; raw origin ingress is restricted.
- [ ] DB pool envs are conservative for the production MySQL host.

## Deploy

- [ ] `yarn install --frozen-lockfile`
- [ ] `yarn db:generate`
- [ ] `yarn build`
- [ ] `yarn db:migrate:deploy`
- [ ] restart API process

## After Deploy

- [ ] `GET /api/v1/health` OK.
- [ ] `GET /api/v1/health/ready` confirms database and private storage readiness without exposing a path.
- [ ] `/docs` is not publicly available.
- [ ] Admin login works.
- [ ] Refresh works.
- [ ] Logout revokes session.
- [ ] Password change revokes sessions.
- [ ] Old access token fails after logout/password change.
- [ ] Repeated bad login attempts trigger throttling.
- [ ] Public watch valid test link works.
- [ ] Public watch invalid link remains generic.
- [ ] Limited public watch returns grant-bearing media URLs; tampered/missing/wrong-host grants fail generically while the final admitted watch can seek.
- [ ] Removing a website video assignment immediately denies that video's watch/media access.
- [ ] STAFF write operations and ADMIN purge return `403`; OWNER purge remains guarded by confirmation.
- [ ] Admin `/admin/videos` works with no `filterKey`, with `filterKey=sml`, and with combined `search` + `filterKey`.
- [ ] Public watch max-view-limited links are not served from stale cache.
- [ ] Public watch valid unlimited links still increment `currentViews` and write access logs on repeat requests.
- [ ] Public video view endpoint is called once after playback starts and does not fire on Range requests.
- [ ] Public view count grows within configured caps and `publishedAt` remains unchanged.
- [ ] Dynamic CORS still allows active public domains.
- [ ] LOCAL_FILE admin preview works with Range requests.
- [ ] LOCAL_FILE public share playback works through token-protected public URL.
- [ ] LOCAL_FILE thumbnail/video responses still stream fresh content; only metadata is cached.
- [ ] LOCAL_FILE thumbnail upload/update renders in Admin Web and public watch.
- [ ] LOCAL_FILE purge deletes database metadata and owned local files best-effort.
- [ ] LOCAL_FILE purge response reports delete attempts/results, `bytesReclaimed`, and `orphanCleanupRequired` without exposing storage paths.
- [ ] LOCAL_FILE purge rejects active website assignments and requires the video to already be `DISABLED`.
- [ ] Purging a disabled video with old share-link rows disables related active share links and detaches only that video's `ShareLinkVideo` rows.
- [ ] Public watch for share links disabled by video disable/purge remains generic and returns no playable videos.
- [ ] Soft-disable confirms status changes without deleting LOCAL_FILE video/thumbnail files.
- [ ] `tmp/uploads` does not grow unexpectedly after upload/cancel/complete tests.
- [ ] Pino logs do not expose tokens.
- [ ] Audit logs contain safe metadata only.
- [ ] `VIDEO_DB_STORAGE_ENABLED=false` confirmed in production.

## Rollback

- [ ] Keep previous build artifact available.
- [ ] Know whether migration is backward-compatible.
- [ ] Session migration is additive, but old access tokens without `sid` are intentionally invalid after deploy.
- [ ] If migration is not safely reversible, restore backup into staging first.
- [ ] Document exact rollback command/process for the hosting environment.

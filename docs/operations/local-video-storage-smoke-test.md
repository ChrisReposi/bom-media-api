# LOCAL_FILE Storage Smoke Test

Use this checklist in staging before production launch, after changing LOCAL_FILE env values, and after changing Admin Web upload behavior.

Do not run first-time 500MB/1GB tests directly in production. Do not paste real tokens, DB URLs, server paths, or secrets into this file.

## Pre-Flight

- [ ] `LOCAL_FILE_STORAGE_ENABLED=true`.
- [ ] `LOCAL_FILE_STORAGE_ROOT` points to a private writable path outside public web roots.
- [ ] `LOCAL_VIDEO_UPLOAD_MAX_MB=500` unless intentionally testing a higher staging limit.
- [ ] `LOCAL_VIDEO_UPLOAD_HARD_MAX_MB=1024`.
- [ ] `LOCAL_VIDEO_CHUNK_SIZE_MB` is below Cloudflare/upstream request-size limits.
- [ ] `LOCAL_VIDEO_MIN_FREE_SPACE_MB` leaves a 10GB-20GB reserve.
- [ ] `VIDEO_DB_STORAGE_ENABLED=false` in production-like env.
- [ ] `/docs` is off in production-like env.
- [ ] Cloudflare/proxy path preserves Range headers for media routes.
- [ ] DB backup and filesystem backup procedures are documented before purge testing.

## Local Dev Smoke Test

1. Start the local database and API with local env.
2. Confirm the API starts without leaking absolute storage root paths in logs.
3. Confirm storage root exists and is writable by the API process.
4. Upload a small MP4/WebM via Admin Web LOCAL_FILE mode.
5. Confirm upload progress increments chunk by chunk.
6. Confirm complete creates a `LOCAL_FILE` video.
7. Confirm MySQL stores metadata and relative storage keys only.
8. Confirm no video bytes are stored in `VideoBinaryAsset`.
9. Confirm admin video list shows `LOCAL_FILE`.
10. Confirm admin preview endpoint plays and seeks.
11. Upload a thumbnail with the video.
12. Confirm thumbnail renders in Admin Web.
13. Replace thumbnail with `PATCH /api/v1/admin/videos/:id/thumbnail-local`.
14. Confirm old owned local thumbnail is removed or marked for orphan review.

## Public Playback Smoke Test

1. Assign the video to a website/domain.
2. Create a share link for the READY LOCAL_FILE video.
3. Open the public link in a clean browser profile.
4. Confirm public watch returns the video item.
5. Confirm the public item includes a protected `publicPlaybackUrl`.
6. Confirm thumbnail URL is API-provided and does not expose filesystem paths.
7. Confirm native playback starts.
8. Seek in the browser player.
9. Confirm the media request returns `206 Partial Content` for Range requests.
10. Seek backward/forward quickly several times.
11. Confirm normal seeking does not trigger `429 Too Many Requests`.
12. Confirm local cross-origin testing does not show `ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`.
13. Press play and confirm the public view endpoint is called at most once for that video during the page/session window.
14. Confirm the displayed video view count increases by a small amount under 100.
15. Confirm repeated seeking/Range requests do not call the view endpoint or increment views.
16. Confirm `publishedAt` remains unchanged in the database while the UI renders a relative label.
17. Confirm invalid token/domain mismatch returns a generic unavailable state.

## Purge/Reclaim Smoke Test

Use staging fixture data only.

1. Create a LOCAL_FILE video not assigned to websites or share links.
2. Record storage root size and the video/thumbnail relative keys privately.
3. Soft-disable the video.
4. Confirm soft disable does not delete physical files.
5. Run guarded purge with `confirmVideoId`.
6. Confirm purge succeeds.
7. Confirm purge response includes:
   - `storage.localVideoDeleteAttempted=true`
   - `storage.localVideoDeleted=true`
   - `storage.localThumbnailDeleteAttempted=true` if an owned local thumbnail existed
   - `storage.localThumbnailDeleted=true` if an owned local thumbnail existed
   - `storage.bytesReclaimed` as a string
   - `storage.orphanCleanupRequired=false`
8. Confirm DB row is gone.
9. Confirm owned local video file is deleted.
10. Confirm owned local thumbnail file is deleted.
11. Confirm audit log contains safe metadata only, including storage delete results and no absolute paths.
12. Attempt purge on a video still assigned/shared.
13. Confirm API rejects it.
14. If a fixture intentionally points to a missing file, confirm purge returns `orphanCleanupRequired=true` and does not expose paths.

Example size checks, using placeholders:

```bash
du -sh /home/<hostinger-user>/bom-media-storage
du -sh /home/<hostinger-user>/bom-media-storage/videos
du -sh /home/<hostinger-user>/bom-media-storage/tmp
```

Before bulk purge or cleanup, run the dry-run storage scripts and take coordinated DB + filesystem backups.

## Near-Limit 500MB Test

Run in staging with enough disk space.

1. Upload a 450MB-500MB video.
2. Confirm chunks stay below configured chunk size.
3. Confirm progress remains stable.
4. Confirm complete step succeeds.
5. Confirm final file size on disk matches expected size.
6. Confirm DB metadata points to a relative storage key.
7. Confirm no large row appears in `VideoBinaryAsset`.
8. Confirm admin preview works.
9. Confirm public playback and seek work.
10. Confirm backup archive includes the file.

## Optional 1GB Staging Test

Only after 500MB test passes.

1. Set `LOCAL_VIDEO_UPLOAD_MAX_MB=1024` in staging.
2. Restart the API.
3. Confirm free disk reserve is still acceptable.
4. Upload a 900MB-1GB file.
5. Confirm chunk uploads are not blocked by Cloudflare/body-size limits.
6. Confirm complete/preview/public playback/seek work.
7. Confirm backup and restore time is acceptable.
8. Revert `LOCAL_VIDEO_UPLOAD_MAX_MB=500` unless production approval exists.

## Restore Smoke Test

1. Restore MySQL backup into a test database.
2. Restore `videos/` content from filesystem backup into a test storage root. The live storage layout keeps local thumbnails under `videos/<videoId>/thumbnails/`.
3. Start API with test env pointing at restored DB and storage root.
4. Confirm admin login.
5. Confirm video list includes LOCAL_FILE metadata.
6. Confirm physical files exist for tested video IDs.
7. Confirm admin preview.
8. Confirm public playback through a test share link.
9. Confirm thumbnails render.
10. Record restore evidence in `docs/operations/backup-restore-runbook.md` template.

## Blockers

Block production rollout if any of these are true:

- Storage root is inside a public web root.
- DB_BLOB is enabled in production.
- Public playback exposes raw filesystem paths or storage keys.
- Range requests fail through Cloudflare/proxy.
- DB backup exists but filesystem backup does not.
- Restore test has not verified local files and DB metadata together.
- Purge can delete assigned/shared videos.
- Purge leaves known local files without a manual cleanup plan.

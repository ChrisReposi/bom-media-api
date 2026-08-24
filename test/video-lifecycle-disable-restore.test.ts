/**
 * VIDEO LIFECYCLE - DISABLE / RESTORE REVERSIBILITY.
 *
 * WHY THIS EXISTS. `disableActiveShareLinksForVideo()` sweeps every ACTIVE
 * share link containing a video to `DISABLED` when that video is disabled, so
 * an already-distributed credential cannot keep playing an administratively
 * unavailable video. That half was correct. The other half did not exist:
 * `ShareLinkStatus.DISABLED` was written in exactly ONE place and read in NONE,
 * so it was a one-way trapdoor. One "Vo hieu hoa" click permanently destroyed
 * every existing share link for that video, and "Kich hoat lai" could not bring
 * any of them back. Disable silently behaved like a PURGE of share-link
 * availability, which is precisely what disable must NOT be.
 *
 * The contract asserted here is MODEL A - relationship-preserving disable:
 *
 *   READY    --disable--> DISABLED   relations retained, public fails closed
 *   DISABLED --restore--> READY      relations effective again
 *   PURGE                            the ONLY destructive operation
 *
 * The reversibility is deliberately NARROW, and the narrowness is the safety
 * property. Every one of these is asserted below:
 *
 *   - REVOKED links never revive - revocation is an operator decision.
 *   - EXPIRED links never become playable - expiry is a clock fact.
 *   - View-exhausted links never regain budget - `currentViews` is untouched.
 *   - `alias` / `tokenHash` / `expiresAt` / `maxViews` / `websiteId` are never
 *     rewritten, so a production evidence URL keeps working exactly as issued.
 *   - A multi-video link returns only when NO member is still disabled.
 *   - Domain binding still denies a foreign host.
 *
 * Nothing here performs a real network request, and no Bunny collaborator is
 * supplied to the harness - so any Bunny call on the disable or restore path
 * would throw, which is itself the proof that neither path touches a provider.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AssignmentStatus,
  ShareLinkStatus,
  VideoStatus,
} from "../src/generated/prisma/client";
import type { UpdateVideoDto } from "../src/videos/dto/update-video.dto";
import {
  bunnyStreamVideo,
  createCompatHarness,
  directUrlVideo,
  FOREIGN_HOST,
  LEGACY_ALIAS,
  LEGACY_HOST,
  LEGACY_RAW_TOKEN,
  localFileVideo,
  SHARE_LINK_ID,
  WEBSITE_ID,
  type CompatHarness,
} from "./share-link-compat-harness";

const ADMIN_ID = "admin-lifecycle-1";

/** The admin sends `PATCH /admin/videos/:id { status }` for BOTH directions. */
function statusPatch(status: VideoStatus): UpdateVideoDto {
  return { status } as UpdateVideoDto;
}

function disable(harness: CompatHarness, videoId: string): Promise<unknown> {
  return harness.videos.updateVideo(
    videoId,
    statusPatch(VideoStatus.DISABLED),
    ADMIN_ID,
  );
}

function restore(harness: CompatHarness, videoId: string): Promise<unknown> {
  return harness.videos.updateVideo(
    videoId,
    statusPatch(VideoStatus.READY),
    ADMIN_ID,
  );
}

function link(harness: CompatHarness, id = SHARE_LINK_ID) {
  const record = harness.prisma.shareLinks.find((entry) => entry.id === id);
  assert.ok(record !== undefined, `missing share link ${id}`);

  return record;
}

function firstVideo(harness: CompatHarness) {
  const video = harness.prisma.videos[0];
  assert.ok(video !== undefined, "harness has no videos");

  return video;
}

function watch(
  harness: CompatHarness,
  token = LEGACY_ALIAS,
  host = LEGACY_HOST,
) {
  return harness.service.resolvePublicWatch({ host, token });
}

describe("WEB-RESTORE - website assignment survives the disable/restore cycle", () => {
  it("WEB-RESTORE-01/02 disable sets DISABLED and PRESERVES the WebsiteVideo row", async () => {
    const harness = createCompatHarness({ videos: [directUrlVideo()] });
    const video = firstVideo(harness);

    await disable(harness, video.id);

    assert.equal(video.status, VideoStatus.DISABLED);
    // The relation is the whole point of MODEL A: disable must not detach.
    assert.equal(video.websiteVideos.length, 1);
    assert.equal(video.websiteVideos[0]?.websiteId, WEBSITE_ID);
    assert.equal(video.websiteVideos[0]?.status, AssignmentStatus.ACTIVE);
  });

  it("WEB-RESTORE-02 disable PRESERVES the ShareLinkVideo membership row", async () => {
    const harness = createCompatHarness({ videos: [directUrlVideo()] });
    const video = firstVideo(harness);
    const membershipBefore = link(harness).shareLinkVideos.map(
      (row) => row.videoId,
    );

    await disable(harness, video.id);

    assert.deepEqual(
      link(harness).shareLinkVideos.map((row) => row.videoId),
      membershipBefore,
    );
  });

  it("WEB-RESTORE-03 restore returns the video to READY", async () => {
    const harness = createCompatHarness({ videos: [directUrlVideo()] });
    const video = firstVideo(harness);

    await disable(harness, video.id);
    await restore(harness, video.id);

    assert.equal(video.status, VideoStatus.READY);
  });

  it("WEB-RESTORE-05 the surviving assignment is effective again, not duplicated", async () => {
    const harness = createCompatHarness({ videos: [directUrlVideo()] });
    const video = firstVideo(harness);

    await disable(harness, video.id);
    await restore(harness, video.id);

    assert.equal(video.websiteVideos.length, 1);
    assert.equal(video.websiteVideos[0]?.status, AssignmentStatus.ACTIVE);
  });

  it("WEB-RESTORE-06/07 re-assigning a restored video is idempotent - no duplicate row", async () => {
    const harness = createCompatHarness({ videos: [directUrlVideo()] });
    const video = firstVideo(harness);

    await disable(harness, video.id);
    await restore(harness, video.id);
    // The dashboard composer re-asserts the assignment before creating a link.
    await harness.adminWebsites.assignSingleVideo(
      WEBSITE_ID,
      video.id,
      ADMIN_ID,
    );

    assert.equal(video.websiteVideos.length, 1);
    assert.equal(video.websiteVideos[0]?.status, AssignmentStatus.ACTIVE);
  });

  it("a DISABLED video is refused for NEW assignment - new usage stays blocked", async () => {
    const harness = createCompatHarness({ videos: [directUrlVideo()] });
    const video = firstVideo(harness);

    await disable(harness, video.id);

    await assert.rejects(
      () =>
        harness.adminWebsites.assignSingleVideo(WEBSITE_ID, video.id, ADMIN_ID),
      /READY and playable/,
    );
  });
});

describe("SHARE-RESTORE - an existing share link resumes after restore", () => {
  it("SHARE-RESTORE-01 the link works while the video is READY", async () => {
    const harness = createCompatHarness({ videos: [directUrlVideo()] });

    const response = await watch(harness);

    assert.equal(response.valid, true);
    assert.equal(response.reasonCode, "OK");
  });

  it("SHARE-RESTORE-02 disable FAILS CLOSED for the existing link", async () => {
    const harness = createCompatHarness({ videos: [directUrlVideo()] });

    await disable(harness, firstVideo(harness).id);

    assert.equal(link(harness).status, ShareLinkStatus.DISABLED);
    const response = await watch(harness);
    assert.equal(response.valid, false);
    assert.equal(response.reasonCode, "INVALID_LINK");
  });

  it("SHARE-RESTORE-03 restore lets the SAME link resolve again", async () => {
    const harness = createCompatHarness({ videos: [directUrlVideo()] });
    const video = firstVideo(harness);

    await disable(harness, video.id);
    await restore(harness, video.id);

    assert.equal(link(harness).status, ShareLinkStatus.ACTIVE);
    const response = await watch(harness);
    assert.equal(response.valid, true);
    assert.equal(response.reasonCode, "OK");
    assert.deepEqual(
      response.videos.map((entry) => entry.id),
      [video.id],
    );
  });

  it("SHARE-RESTORE-03 the raw token credential also still resolves", async () => {
    const harness = createCompatHarness({ videos: [directUrlVideo()] });
    const video = firstVideo(harness);

    await disable(harness, video.id);
    await restore(harness, video.id);

    const response = await watch(harness, LEGACY_RAW_TOKEN);
    assert.equal(response.valid, true);
  });

  it("SHARE-RESTORE-04/05/06 alias, token, expiry, maxViews and views are untouched", async () => {
    const expiresAt = new Date("2999-01-01T00:00:00.000Z");
    const harness = createCompatHarness({
      videos: [directUrlVideo()],
      shareLink: { maxViews: 5, currentViews: 2, expiresAt },
    });
    const video = firstVideo(harness);
    const before = { ...link(harness) };

    await disable(harness, video.id);
    await restore(harness, video.id);

    const after = link(harness);
    assert.equal(after.alias, before.alias);
    assert.equal(after.tokenHash, before.tokenHash);
    assert.equal(after.websiteId, before.websiteId);
    assert.equal(after.maxViews, 5);
    assert.equal(after.currentViews, 2, "the view budget must NOT be reset");
    assert.equal(after.expiresAt?.toISOString(), expiresAt.toISOString());
  });

  it("SHARE-RESTORE-07 an explicitly REVOKED link does NOT revive", async () => {
    const harness = createCompatHarness({
      videos: [directUrlVideo()],
      shareLink: { status: ShareLinkStatus.REVOKED },
    });
    const video = firstVideo(harness);

    await disable(harness, video.id);
    await restore(harness, video.id);

    assert.equal(link(harness).status, ShareLinkStatus.REVOKED);
    const response = await watch(harness);
    assert.equal(response.valid, false);
    assert.equal(response.reasonCode, "INVALID_LINK");
  });

  it("SHARE-RESTORE-08 a link already marked EXPIRED does NOT revive", async () => {
    const harness = createCompatHarness({
      videos: [directUrlVideo()],
      shareLink: { status: ShareLinkStatus.EXPIRED },
    });
    const video = firstVideo(harness);

    await disable(harness, video.id);
    await restore(harness, video.id);

    assert.equal(link(harness).status, ShareLinkStatus.EXPIRED);
  });

  it("SHARE-RESTORE-08 an ACTIVE link past its expiry resumes ACTIVE but stays DENIED", async () => {
    // Expiry is a clock fact held in `expiresAt`, not in `status`. Reactivation
    // restores the status the link had and nothing else, so the expiry gate
    // still decides - which is why the expiry column must not be rewritten.
    const harness = createCompatHarness({
      videos: [directUrlVideo()],
      shareLink: { expiresAt: new Date("2000-01-01T00:00:00.000Z") },
    });
    const video = firstVideo(harness);

    await disable(harness, video.id);
    await restore(harness, video.id);

    assert.equal(link(harness).status, ShareLinkStatus.ACTIVE);
    const response = await watch(harness);
    assert.equal(response.valid, false);
    // The client only ever sees the uniform denial; the specific cause is an
    // internal access-log code, which is where the expiry gate is observable.
    assert.equal(response.reasonCode, "INVALID_LINK");
    assert.equal(harness.prisma.accessLogs.at(-1)?.reasonCode, "EXPIRED_LINK");
  });

  it("SHARE-RESTORE-05 a view-exhausted link resumes ACTIVE but stays DENIED", async () => {
    const harness = createCompatHarness({
      videos: [directUrlVideo()],
      shareLink: { maxViews: 3, currentViews: 3 },
    });
    const video = firstVideo(harness);

    await disable(harness, video.id);
    await restore(harness, video.id);

    assert.equal(link(harness).currentViews, 3);
    const response = await watch(harness);
    assert.equal(response.valid, false);
    assert.equal(response.reasonCode, "INVALID_LINK");
    assert.equal(
      harness.prisma.accessLogs.at(-1)?.reasonCode,
      "VIEW_LIMIT_REACHED",
    );
  });

  it("SHARE-RESTORE-09 a foreign host is still denied after restore", async () => {
    const harness = createCompatHarness({ videos: [directUrlVideo()] });
    const video = firstVideo(harness);

    await disable(harness, video.id);
    await restore(harness, video.id);

    const response = await watch(harness, LEGACY_ALIAS, FOREIGN_HOST);
    assert.equal(response.valid, false);
  });

  it("moving DISABLED to FAILED instead of READY does NOT revive the link", async () => {
    // Only a return to READY earns the links back: nothing else makes the video
    // publicly resolvable, so nothing else may un-darken a live credential.
    const harness = createCompatHarness({ videos: [directUrlVideo()] });
    const video = firstVideo(harness);

    await disable(harness, video.id);
    await harness.videos.updateVideo(
      video.id,
      statusPatch(VideoStatus.FAILED),
      ADMIN_ID,
    );

    assert.equal(link(harness).status, ShareLinkStatus.DISABLED);
  });

  it("an unrelated link on another video is never touched in either direction", async () => {
    const first = directUrlVideo({ id: "video-first" });
    const second = directUrlVideo({ id: "video-second", slug: "video-second" });
    const harness = createCompatHarness({
      videos: [first],
      standaloneVideos: [second],
      extraShareLinks: [{ videoIds: [second.id], alias: "Other12" }],
    });
    const other = harness.prisma.shareLinks.find(
      (entry) => entry.id !== SHARE_LINK_ID,
    );
    assert.ok(other !== undefined, "missing the second share link");

    await disable(harness, first.id);
    assert.equal(other.status, ShareLinkStatus.ACTIVE);

    await restore(harness, first.id);
    assert.equal(other.status, ShareLinkStatus.ACTIVE);
  });
});

describe("SHARE-RESTORE - multi-video links return only when every member is back", () => {
  it("restoring one of two disabled members leaves the link DARK", async () => {
    const a = directUrlVideo({ id: "video-a", slug: "video-a" });
    const b = directUrlVideo({ id: "video-b", slug: "video-b" });
    const harness = createCompatHarness({ videos: [a, b] });

    await disable(harness, a.id);
    await disable(harness, b.id);
    assert.equal(link(harness).status, ShareLinkStatus.DISABLED);

    await restore(harness, a.id);

    assert.equal(
      link(harness).status,
      ShareLinkStatus.DISABLED,
      "video B is still DISABLED, so the link must stay closed",
    );
    const response = await watch(harness);
    assert.equal(response.valid, false);
  });

  it("restoring the LAST disabled member brings the link back", async () => {
    const a = directUrlVideo({ id: "video-a", slug: "video-a" });
    const b = directUrlVideo({ id: "video-b", slug: "video-b" });
    const harness = createCompatHarness({ videos: [a, b] });

    await disable(harness, a.id);
    await disable(harness, b.id);
    await restore(harness, a.id);
    await restore(harness, b.id);

    assert.equal(link(harness).status, ShareLinkStatus.ACTIVE);
    const response = await watch(harness);
    assert.equal(response.valid, true);
    assert.deepEqual(response.videos.map((entry) => entry.id).sort(), [
      "video-a",
      "video-b",
    ]);
  });
});

describe("the dedicated /disable route and the PATCH restore interoperate", () => {
  it("a link darkened by disableVideo() is revived by the restore PATCH", async () => {
    const harness = createCompatHarness({ videos: [directUrlVideo()] });
    const video = firstVideo(harness);

    await harness.videos.disableVideo(video.id, ADMIN_ID);
    assert.equal(video.status, VideoStatus.DISABLED);
    assert.equal(link(harness).status, ShareLinkStatus.DISABLED);

    await restore(harness, video.id);

    assert.equal(link(harness).status, ShareLinkStatus.ACTIVE);
    assert.equal((await watch(harness)).valid, true);
  });
});

describe("LOCAL-RESTORE - LOCAL_FILE lifecycle", () => {
  it("LOCAL-RESTORE-01/02 disable never touches LocalFileAsset, and restore resumes", async () => {
    const harness = createCompatHarness({ videos: [localFileVideo()] });
    const video = firstVideo(harness);
    assert.ok(video.localFileAsset !== null, "fixture needs a local file");
    const assetBefore = { ...video.localFileAsset };

    await disable(harness, video.id);
    assert.deepEqual({ ...video.localFileAsset }, assetBefore);
    assert.equal((await watch(harness)).valid, false);

    await restore(harness, video.id);

    assert.deepEqual({ ...video.localFileAsset }, assetBefore);
    assert.equal(video.status, VideoStatus.READY);
  });

  it("LOCAL-RESTORE-03/04 a restored LOCAL_FILE is assignable and its link resumes", async () => {
    const harness = createCompatHarness({ videos: [localFileVideo()] });
    const video = firstVideo(harness);

    await disable(harness, video.id);
    await restore(harness, video.id);
    await harness.adminWebsites.assignSingleVideo(
      WEBSITE_ID,
      video.id,
      ADMIN_ID,
    );

    assert.equal(video.websiteVideos.length, 1);
    const response = await watch(harness);
    assert.equal(response.valid, true);
    assert.equal(response.videos.length, 1);
  });
});

describe("BUNNY-RESTORE - provider state is untouched by the reversible lifecycle", () => {
  it("BUNNY-RESTORE-01/02/03 disable and restore make no provider call and keep the identifiers", async () => {
    // No `bunnyStream` collaborator is supplied, so ANY Bunny call on either
    // path would throw here. Passing is the proof that neither deletes a remote
    // asset (02) nor creates a new one (03).
    const harness = createCompatHarness({ videos: [bunnyStreamVideo()] });
    const video = firstVideo(harness);
    const identifiers = {
      provider: video.provider,
      providerAssetId: video.providerAssetId,
      playbackId: video.playbackId,
      metadataJson: JSON.stringify(video.metadataJson),
    };

    await disable(harness, video.id);
    await restore(harness, video.id);

    assert.equal(video.status, VideoStatus.READY);
    assert.equal(video.provider, identifiers.provider);
    assert.equal(video.providerAssetId, identifiers.providerAssetId);
    assert.equal(video.playbackId, identifiers.playbackId);
    assert.equal(JSON.stringify(video.metadataJson), identifiers.metadataJson);
  });

  it("BUNNY-RESTORE-04 restore does NOT clear a confirmed remoteMissing marker", async () => {
    // The marker lives in `metadataJson.bunnyStream.remoteMissing` and is only
    // ever cleared by an authoritative Bunny GET. A generic status change must
    // not launder a known-deleted remote asset into a healthy one.
    const video = bunnyStreamVideo();
    const metadata = video.metadataJson as {
      bunnyStream: Record<string, unknown>;
    };
    metadata.bunnyStream.remoteMissing = {
      at: "2026-01-01T00:00:00.000Z",
      reason: "AUTHORITATIVE_404",
    };
    const harness = createCompatHarness({ videos: [video] });

    await disable(harness, video.id);
    await restore(harness, video.id);

    const after = firstVideo(harness).metadataJson as {
      bunnyStream: { remoteMissing?: unknown };
    };
    assert.ok(
      after.bunnyStream.remoteMissing !== undefined,
      "a generic restore must never clear remoteMissing",
    );
  });
});

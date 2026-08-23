/**
 * HOSTINGER NVMe (`LOCAL_FILE`) AND BUNNY STREAM RUNNING SIDE BY SIDE.
 *
 * The product deliberately supports BOTH self-hosted local storage and Bunny
 * Stream at the same time. They are two parallel storage/playback providers
 * that share only common `VideoAsset` metadata and the share-link authorization
 * chain — they must never own the same bytes, and never fall through into each
 * other's code path.
 *
 *                          VideoAsset
 *                              │
 *                  ┌───────────┴───────────┐
 *              LOCAL_FILE                BUNNY
 *                  │                       │
 *          Hostinger NVMe              Bunny Stream
 *                  │                       │
 *          local Range media          signed iframe
 *                  └───────────┬───────────┘
 *                        share authorization
 *
 * This suite proves the isolation behaviourally rather than asserting it in
 * prose. Nothing here performs a real network request or touches a real disk.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  VideoProvider,
  VideoSourceType,
  VideoStatus,
} from "../src/generated/prisma/client";
import {
  classifyBunnyVideoAsset,
  readBunnyVideoAsset,
} from "../src/bunny/bunny-video-asset.util";
import {
  bunnyStreamVideo,
  BUNNY_VIDEO_GUID,
  createCompatHarness,
  dbBlobVideo,
  LEGACY_ALIAS,
  LEGACY_HOST,
  localFileVideo,
  parseMediaUrl,
} from "./share-link-compat-harness";

const LIBRARY_ID = "987654";

/** Signs, and reports whether local storage was ever consulted for a Bunny id. */
function createBunnySpy() {
  const spy = {
    signCount: 0,
    signedVideoIds: [] as string[],
    isEnabled: (): boolean => true,
    canSignEmbedUrl: (): boolean => true,
    createSignedEmbedUrl: (videoId: string) => {
      spy.signCount += 1;
      spy.signedVideoIds.push(videoId);
      return {
        embedUrl: `https://iframe.mediadelivery.net/embed/${LIBRARY_ID}/${videoId}?token=deadbeef&expires=1`,
        token: "deadbeef",
        expires: 1,
      };
    },
    getVideo: async () => {
      throw new Error("public playback must never call the Bunny API");
    },
  };

  return spy;
}

/* ------------------------------------------------------------------ *
 * The provider/sourceType matrix itself
 * ------------------------------------------------------------------ */

describe("LOCAL_FILE and Bunny occupy disjoint provider shapes", () => {
  it("a LOCAL_FILE asset is never classified as Bunny", () => {
    const local = localFileVideo();

    assert.equal(local.sourceType, VideoSourceType.LOCAL_FILE);
    assert.notEqual(local.provider, VideoProvider.BUNNY);
    assert.equal(classifyBunnyVideoAsset(local).kind, "not-bunny");
    assert.equal(readBunnyVideoAsset(local), null);
  });

  it("a Bunny asset carries NO local byte relation", () => {
    const bunny = bunnyStreamVideo();

    assert.equal(bunny.provider, VideoProvider.BUNNY);
    assert.equal(bunny.sourceType, VideoSourceType.EMBED);
    assert.equal(classifyBunnyVideoAsset(bunny).kind, "bunny");
    // THE LOAD-BEARING PROPERTY: the two never own the same bytes. A Bunny
    // asset has no NVMe file and no DB blob, so every local-storage branch is
    // structurally unreachable for it.
    assert.equal(bunny.localFileAsset ?? null, null);
    assert.equal(bunny.localThumbnailAsset ?? null, null);
    assert.equal(bunny.binaryAsset ?? null, null);
  });

  it("the two shapes cannot be confused by the strict classifier", () => {
    // A LOCAL_FILE row hand-relabelled `provider: BUNNY` is still not Bunny:
    // the predicate requires sourceType EMBED plus matching identifiers.
    const mislabelled = localFileVideo({
      id: "video-local-mislabelled",
      provider: VideoProvider.BUNNY,
    });
    assert.equal(classifyBunnyVideoAsset(mislabelled).kind, "not-bunny");

    // And a Bunny row cannot acquire local playback by carrying a stray URL.
    const bunnyWithStrayUrl = bunnyStreamVideo({
      playbackUrl: "/api/v1/admin/videos/video-bunny-stream/local-file",
    });
    assert.equal(classifyBunnyVideoAsset(bunnyWithStrayUrl).kind, "bunny");
    assert.equal(bunnyWithStrayUrl.localFileAsset ?? null, null);
  });
});

/* ------------------------------------------------------------------ *
 * Mixed share link — the real coexistence case
 * ------------------------------------------------------------------ */

describe("one share link can carry a LOCAL_FILE and a Bunny video at once", () => {
  it("serves each through its OWN playback mechanism, with no crossover", async () => {
    const bunnyStream = createBunnySpy();
    const { service } = createCompatHarness({
      videos: [localFileVideo(), bunnyStreamVideo()],
      bunnyStream,
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.valid, true);
    assert.equal(response.videos.length, 2);

    const local = response.videos.find(
      (video) => video.sourceType === VideoSourceType.LOCAL_FILE,
    );
    const bunny = response.videos.find(
      (video) => video.sourceType === VideoSourceType.EMBED,
    );
    assert.ok(local);
    assert.ok(bunny);

    // LOCAL_FILE -> a token-bound backend route on this API, no embed URL.
    const localUrl = parseMediaUrl(local.publicPlaybackUrl);
    assert.ok(localUrl);
    assert.match(localUrl.pathname, /\/local-file$/);
    assert.equal(local.embedUrl, null);
    assert.equal(local.playbackUrl, null);

    // BUNNY -> a signed Bunny iframe, no backend media route at all.
    assert.match(String(bunny.embedUrl), /^https:\/\/iframe\.mediadelivery\.net\//);
    assert.equal(bunny.publicPlaybackUrl ?? null, null);
    assert.equal(bunny.binaryPlaybackUrl ?? null, null);
    assert.equal(bunny.localFileAsset ?? null, null);

    // Exactly one signature, for the Bunny video only.
    assert.equal(bunnyStream.signCount, 1);
    assert.deepEqual(bunnyStream.signedVideoIds, [BUNNY_VIDEO_GUID]);
  });

  it("never routes a Bunny asset into the local media path", async () => {
    const bunnyStream = createBunnySpy();
    const { service, localStorage } = createCompatHarness({
      videos: [localFileVideo(), bunnyStreamVideo()],
      bunnyStream,
    });

    await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    // Resolution itself reads no bytes for either provider.
    const storage = localStorage as {
      fullReadCalls: string[];
      rangeReadCalls: unknown[];
    };
    assert.deepEqual(storage.fullReadCalls, []);
    assert.deepEqual(storage.rangeReadCalls, []);
  });

  it("never routes a LOCAL_FILE asset into Bunny signing", async () => {
    const bunnyStream = createBunnySpy();
    const { service } = createCompatHarness({
      videos: [localFileVideo(), dbBlobVideo()],
      bunnyStream,
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.valid, true);
    assert.equal(
      bunnyStream.signCount,
      0,
      "a share with no Bunny video must mint no Bunny credential",
    );
    assert.doesNotMatch(
      JSON.stringify(response),
      /iframe\.mediadelivery\.net/,
      "no Bunny URL may appear in a purely local share",
    );
  });

  it("keeps serving the LOCAL_FILE video when the Bunny one is unavailable", async () => {
    // Provider independence in the failure direction: a Bunny problem must not
    // take the NVMe-hosted sibling down with it.
    const bunnyStream = createBunnySpy();
    const { service } = createCompatHarness({
      videos: [
        localFileVideo(),
        bunnyStreamVideo({ status: VideoStatus.FAILED }),
      ],
      bunnyStream,
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.valid, true);
    assert.deepEqual(
      response.videos.map((video) => video.sourceType),
      [VideoSourceType.LOCAL_FILE],
    );
    assert.equal(bunnyStream.signCount, 0);
  });

  it("keeps serving the Bunny video when the LOCAL_FILE one is unavailable", async () => {
    const bunnyStream = createBunnySpy();
    const { service } = createCompatHarness({
      videos: [
        localFileVideo({ status: VideoStatus.DISABLED }),
        bunnyStreamVideo(),
      ],
      bunnyStream,
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.valid, true);
    assert.deepEqual(
      response.videos.map((video) => video.sourceType),
      [VideoSourceType.EMBED],
    );
    assert.equal(bunnyStream.signCount, 1);
  });
});

/* ------------------------------------------------------------------ *
 * Security isolation
 * ------------------------------------------------------------------ */

describe("neither provider leaks the other's secrets or internals", () => {
  it("no Bunny credential and no storage key appears in a mixed response", async () => {
    const bunnyStream = createBunnySpy();
    const { service } = createCompatHarness({
      videos: [localFileVideo(), bunnyStreamVideo()],
      bunnyStream,
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });
    const serialized = JSON.stringify(response);

    // A local filesystem storageKey must never reach a public client, and in
    // particular must never appear alongside the Bunny playback URL.
    assert.doesNotMatch(serialized, /videos\/video-local-file\/source/);
    assert.doesNotMatch(serialized, /storageKey/);
    // Admin-only URLs stored on legacy rows stay suppressed.
    assert.doesNotMatch(serialized, /\/admin\/videos\//);
  });

  it("the Bunny signed URL is bound to the Bunny id, never a local video id", async () => {
    const bunnyStream = createBunnySpy();
    const { service } = createCompatHarness({
      videos: [localFileVideo(), bunnyStreamVideo()],
      bunnyStream,
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });
    const bunny = response.videos.find(
      (video) => video.sourceType === VideoSourceType.EMBED,
    );

    assert.ok(String(bunny?.embedUrl).includes(BUNNY_VIDEO_GUID));
    assert.doesNotMatch(String(bunny?.embedUrl), /video-local-file/);
  });
});

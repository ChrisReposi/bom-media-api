/**
 * BUNNY STREAM — thumbnail (poster) persistence on status sync.
 *
 * WHY THIS EXISTS. A Bunny record created by `initBunnyVideoUpload()` has no
 * thumbnail: Bunny only produces one once encoding has run. Nothing used to
 * write one back, so `VideoAsset.thumbnailUrl` stayed NULL forever and both the
 * admin list and the public reviewer page fell back to a placeholder.
 *
 * `syncBunnyVideoStatus()` is the point where authoritative Bunny metadata is
 * already in hand, so the poster is persisted there rather than re-fetched from
 * Bunny on every page load.
 *
 * Two properties are load-bearing and are both asserted here:
 *   1. an EMPTY local thumbnail is filled from Bunny;
 *   2. an EXISTING local thumbnail is never overwritten by a later sync.
 *
 * Nothing here performs a real network request.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUNNY_VIDEO_STATUS } from "../src/bunny/bunny-stream.constants";
import {
  EmbedProvider,
  VideoProvider,
  VideoSourceType,
  VideoStatus,
} from "../src/generated/prisma/client";
import { BunnyStreamService } from "../src/bunny/bunny-stream.service";
import { VideosService } from "../src/videos/videos.service";

const LIBRARY_ID = "987654";
const PULL_ZONE_HOSTNAME = "vz-example.b-cdn.net";
const VIDEO_GUID = "11111111-2222-3333-4444-555555555555";
const VIDEO_ID = "video-bunny-sync";
const THUMBNAIL_FILE_NAME = "thumbnail.jpg";
/** The URL the production code must BUILD - not one any mock hands it. */
const BUNNY_THUMBNAIL = `https://${PULL_ZONE_HOSTNAME}/${VIDEO_GUID}/${THUMBNAIL_FILE_NAME}`;
const OPERATOR_THUMBNAIL = "https://cdn.example.test/operator-chosen.jpg";

type FakeVideoRow = {
  id: string;
  title: string;
  slug: string | null;
  description: string | null;
  status: VideoStatus;
  provider: VideoProvider;
  sourceType: VideoSourceType;
  providerAssetId: string | null;
  playbackId: string | null;
  playbackUrl: string | null;
  embedProvider: EmbedProvider | null;
  embedUrl: string | null;
  embedCloudName: string | null;
  embedPublicId: string | null;
  embedAllow: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  viewCount: bigint;
  publishedAt: Date | null;
  filterKey: string | null;
  metadataJson: unknown;
  createdAt: Date;
  updatedAt: Date;
};

function bunnyRow(overrides: Partial<FakeVideoRow> = {}): FakeVideoRow {
  return {
    id: VIDEO_ID,
    title: "Test Bunny Video",
    slug: "test-bunny-video",
    description: null,
    status: VideoStatus.READY,
    provider: VideoProvider.BUNNY,
    sourceType: VideoSourceType.EMBED,
    providerAssetId: VIDEO_GUID,
    playbackId: VIDEO_GUID,
    playbackUrl: null,
    embedProvider: EmbedProvider.GENERIC_IFRAME,
    embedUrl: `https://iframe.mediadelivery.net/embed/${LIBRARY_ID}/${VIDEO_GUID}`,
    embedCloudName: null,
    embedPublicId: null,
    embedAllow: null,
    thumbnailUrl: null,
    durationSeconds: 1,
    viewCount: 0n,
    publishedAt: null,
    filterKey: null,
    metadataJson: {
      bunnyStream: { videoId: VIDEO_GUID, libraryId: LIBRARY_ID },
    },
    createdAt: new Date("2026-08-23T00:00:00.000Z"),
    updatedAt: new Date("2026-08-23T00:00:00.000Z"),
    ...overrides,
  };
}

function createHarness(params: {
  row?: FakeVideoRow;
  /** What Bunny's Get Video reports. `null` = still encoding, no poster yet. */
  remoteThumbnailFileName?: string | null;
  remoteStatus?: number;
  pullZoneHostname?: string | undefined;
}): {
  service: VideosService;
  updates: Array<Record<string, unknown>>;
  row: FakeVideoRow;
} {
  const row = params.row ?? bunnyRow();
  const updates: Array<Record<string, unknown>> = [];

  const prisma = {
    videoAsset: {
      findUnique: async () => row,
      findUniqueOrThrow: async () => row,
      update: async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        return { ...row, ...args.data };
      },
    },
    adminAuditLog: { create: async () => ({}) },
  };

  // The REAL client builds the URL, so this suite proves production
  // construction rather than a mock's opinion of it. Only the HTTP boundary is
  // faked, and its payload carries `thumbnailFileName` exactly as Bunny's Get
  // Video documents - with NO pre-built URL field anywhere.
  const realBunny = new BunnyStreamService({
    get: (key: string): string | undefined =>
      ({
        BUNNY_STREAM_ENABLED: "true",
        BUNNY_STREAM_LIBRARY_ID: LIBRARY_ID,
        BUNNY_STREAM_PULL_ZONE_HOSTNAME:
          "pullZoneHostname" in params
            ? params.pullZoneHostname
            : PULL_ZONE_HOSTNAME,
      })[key],
  } as never);

  const bunny = {
    ensureEnabled: () => undefined,
    getVideo: async () => ({
      guid: VIDEO_GUID,
      libraryId: Number(LIBRARY_ID),
      title: "Test Bunny Video",
      status: params.remoteStatus ?? BUNNY_VIDEO_STATUS.FINISHED,
      encodeProgress: 100,
      length: 1,
      width: 1920,
      height: 1032,
      storageSize: 2961462,
      thumbnailFileName:
        params.remoteThumbnailFileName === undefined
          ? THUMBNAIL_FILE_NAME
          : params.remoteThumbnailFileName,
    }),
    mapProcessingState: (status: number | null) =>
      status === BUNNY_VIDEO_STATUS.FINISHED ? "READY" : "PROCESSING",
    buildThumbnailUrl: (videoId: string, fileName: string | null) =>
      realBunny.buildThumbnailUrl(videoId, fileName),
  };

  const service = new VideosService(
    prisma as never,
    {} as never,
    { get: () => undefined } as never,
    {} as never,
    {} as never,
    undefined,
    bunny as never,
  );

  return { service, updates, row };
}

describe("Bunny status sync persists the poster", () => {
  it("BUILDS the URL from thumbnailFileName + configured pull-zone hostname", async () => {
    const harness = createHarness({});

    const result = await harness.service.syncBunnyVideoStatus(
      VIDEO_ID,
      "admin-1",
    );

    assert.equal(harness.updates.length, 1);
    assert.equal(harness.updates[0].thumbnailUrl, BUNNY_THUMBNAIL);
    assert.equal(result.video.thumbnailUrl, BUNNY_THUMBNAIL);
  });

  it("persists the poster even when the status did not change", async () => {
    // The regression this guards: an already-READY asset syncs with
    // statusChanged=false, and previously nothing was written at all.
    const harness = createHarness({
      row: bunnyRow({ status: VideoStatus.READY, durationSeconds: 1 }),
    });

    const result = await harness.service.syncBunnyVideoStatus(
      VIDEO_ID,
      "admin-1",
    );

    assert.equal(result.statusChanged, false);
    assert.equal(harness.updates.length, 1);
    assert.equal(harness.updates[0].thumbnailUrl, BUNNY_THUMBNAIL);
  });

  it("NEVER overwrites a thumbnail an operator already set", async () => {
    const harness = createHarness({
      row: bunnyRow({ thumbnailUrl: OPERATOR_THUMBNAIL }),
    });

    const result = await harness.service.syncBunnyVideoStatus(
      VIDEO_ID,
      "admin-1",
    );

    for (const update of harness.updates) {
      assert.equal(
        "thumbnailUrl" in update,
        false,
        "sync must not write thumbnailUrl over an existing value",
      );
    }
    assert.equal(result.video.thumbnailUrl, OPERATOR_THUMBNAIL);
  });

  it("treats a whitespace-only stored thumbnail as empty", async () => {
    const harness = createHarness({ row: bunnyRow({ thumbnailUrl: "   " }) });

    await harness.service.syncBunnyVideoStatus(VIDEO_ID, "admin-1");

    assert.equal(harness.updates[0].thumbnailUrl, BUNNY_THUMBNAIL);
  });

  it("degrades gracefully when Bunny has no thumbnail yet", async () => {
    // Still encoding: no poster exists remotely. The sync must succeed and
    // simply leave the column null, which the UI renders as its placeholder.
    const harness = createHarness({
      row: bunnyRow({ status: VideoStatus.PROCESSING }),
      remoteThumbnailFileName: null,
      remoteStatus: BUNNY_VIDEO_STATUS.PROCESSING,
    });

    const result = await harness.service.syncBunnyVideoStatus(
      VIDEO_ID,
      "admin-1",
    );

    for (const update of harness.updates) {
      assert.equal("thumbnailUrl" in update, false);
    }
    assert.equal(result.video.thumbnailUrl, null);
  });

  it("REFUSES a hostile thumbnailFileName without failing the sync", async () => {
    // A path-bearing or traversal file name must never reach the URL, and must
    // never take the sync down with it - status handling has to keep working.
    for (const fileName of ["../secret", "foo/bar.jpg", "foo\bar.jpg", ".."]) {
      const harness = createHarness({ remoteThumbnailFileName: fileName });

      const result = await harness.service.syncBunnyVideoStatus(
        VIDEO_ID,
        "admin-1",
      );

      for (const update of harness.updates) {
        assert.equal(
          "thumbnailUrl" in update,
          false,
          `expected ${JSON.stringify(fileName)} to be refused`,
        );
      }
      assert.equal(result.video.thumbnailUrl, null);
      assert.equal(result.bunnyStatus, BUNNY_VIDEO_STATUS.FINISHED);
    }
  });

  it("degrades to no poster when the pull-zone hostname is not configured", async () => {
    // Boot validation makes this loud when Bunny is enabled; if it somehow
    // happens at runtime the sync must still succeed with no thumbnail rather
    // than persist a broken URL.
    const harness = createHarness({ pullZoneHostname: undefined });

    const result = await harness.service.syncBunnyVideoStatus(
      VIDEO_ID,
      "admin-1",
    );

    for (const update of harness.updates) {
      assert.equal("thumbnailUrl" in update, false);
    }
    assert.equal(result.video.thumbnailUrl, null);
  });

  it("stores a poster URL, never a short-lived playback credential", async () => {
    const harness = createHarness({});

    await harness.service.syncBunnyVideoStatus(VIDEO_ID, "admin-1");

    const stored = String(harness.updates[0].thumbnailUrl);
    assert.doesNotMatch(stored, /[?&]token=/);
    assert.doesNotMatch(stored, /[?&]expires=/);
    assert.equal(new URL(stored).protocol, "https:");
  });
});

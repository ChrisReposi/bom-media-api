/**
 * SHARE-LINK BACKWARD COMPATIBILITY - provider and public response mapping.
 *
 * COMPAT-020 DIRECT_URL · COMPAT-021 EMBED · COMPAT-022 LOCAL_FILE
 * COMPAT-023 DB_BLOB · COMPAT-024 CLOUDINARY
 *
 * A FAILURE IN THIS FILE IS RELEASE BLOCKING. See
 * `docs/SHARE_LINK_COMPATIBILITY_TESTS.md`.
 *
 * Scope note: backend-served media (`DB_BLOB`, `LOCAL_FILE`) and
 * provider-served media (`DIRECT_URL`, `UPLOAD`, `EMBED`) are deliberately kept
 * separate here. Provider URLs carry no token, host binding or grant, and the
 * backend is not in their playback path. These tests therefore assert what
 * revocation *does* reach - future watch resolution - and never claim that an
 * already-disclosed provider URL stops working. That is a documented design
 * characteristic (SECURITY_MODEL.md section 4.1, KNOWN_ISSUES.md KI-015).
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EmbedProvider,
  ShareLinkStatus,
  VideoSourceType,
} from "../src/generated/prisma/client";
import {
  cloudinaryDirectUrlVideo,
  cloudinaryEmbedVideo,
  cloudinaryUploadVideo,
  createCompatHarness,
  dbBlobVideo,
  directUrlVideo,
  embedVideo,
  LEGACY_ALIAS,
  LEGACY_HOST,
  localFileVideo,
  PUBLIC_DENIAL_RESPONSE,
  parseMediaUrl,
  propertyNames,
  readGrant,
  readQueryParam,
} from "./share-link-compat-harness";

/**
 * The public video property SET. Order is deliberately not asserted - key
 * ordering is not something any client can depend on, so pinning it would
 * fail a release for a cosmetic change.
 */
const PUBLIC_VIDEO_PROPERTIES = [
  "binaryAsset",
  "binaryPlaybackUrl",
  "description",
  "durationSeconds",
  "embedAllow",
  "embedProvider",
  "embedUrl",
  "id",
  "localFileAsset",
  "playbackUrl",
  "publicPlaybackUrl",
  "publicThumbnailUrl",
  "publishedAt",
  "sourceType",
  "thumbnailUrl",
  "title",
  "viewCount",
];

async function resolveOne(video: Parameters<typeof createCompatHarness>[0]["videos"][number]) {
  const { service, prisma } = createCompatHarness({ videos: [video] });
  const response = await service.resolvePublicWatch({
    host: LEGACY_HOST,
    token: LEGACY_ALIAS,
  });
  const publicVideo = response.videos[0];
  assert.ok(publicVideo, "the fixture video must resolve");

  return { response, video: publicVideo, service, prisma };
}

describe("public video response shape", () => {
  it("keeps the public video field set stable for every source type", async () => {
    for (const fixture of [
      directUrlVideo(),
      embedVideo(),
      localFileVideo(),
      dbBlobVideo(),
      cloudinaryUploadVideo(),
    ]) {
      const { video } = await resolveOne(fixture);

      assert.deepEqual(
        propertyNames(video),
        PUBLIC_VIDEO_PROPERTIES,
        `property set drifted for ${fixture.sourceType}`,
      );
      // `provider` is stored but has never been part of the public contract.
      assert.equal(Object.hasOwn(video, "provider"), false);
    }
  });

  it("keeps BigInt columns serialized as strings", async () => {
    const { video } = await resolveOne(dbBlobVideo());

    assert.equal(video.viewCount, "1234");
    assert.equal(video.binaryAsset?.sizeBytes, "10");
    assert.equal(video.publishedAt, "2026-01-15T00:00:00.000Z");
  });
});

describe("COMPAT-020 DIRECT_URL playback mapping", () => {
  it("keeps returning the stored DIRECT_URL playback URL verbatim", async () => {
    const fixture = directUrlVideo();
    const { video } = await resolveOne(fixture);

    assert.equal(video.sourceType, VideoSourceType.DIRECT_URL);
    assert.equal(video.playbackUrl, fixture.playbackUrl);
    assert.equal(video.thumbnailUrl, fixture.thumbnailUrl);
    assert.equal(video.publicThumbnailUrl, fixture.thumbnailUrl);
    // No backend media route and no grant is issued for provider media.
    assert.equal(video.binaryPlaybackUrl, null);
    assert.equal(video.publicPlaybackUrl, null);
    assert.equal(video.binaryAsset, null);
    assert.equal(video.localFileAsset, null);
    assert.equal(video.embedUrl, null);
  });

  it("keeps nulling DIRECT_URL values that point at an admin route", async () => {
    const { video } = await resolveOne(
      directUrlVideo({
        playbackUrl: "https://api.example.com/api/v1/admin/videos/x/local-file",
        thumbnailUrl: "/api/v1/admin/videos/x/thumbnail",
      }),
    );

    assert.equal(video.playbackUrl, null);
    assert.equal(video.thumbnailUrl, null);
    assert.equal(video.publicThumbnailUrl, null);
  });

  it("attaches no grant to DIRECT_URL media on a view-limited link", async () => {
    const { service } = createCompatHarness({
      videos: [directUrlVideo()],
      shareLink: { maxViews: 5 },
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });
    const video = response.videos[0];

    assert.ok(video);
    assert.equal(video.playbackUrl?.includes("grant="), false);
    assert.equal(video.playbackUrl?.includes("host="), false);
  });

  it("stops issuing DIRECT_URL playback URLs once the link is revoked", async () => {
    // What revocation reaches: future watch resolution. It does NOT invalidate
    // a provider URL a browser already holds - see KI-015.
    const { service } = createCompatHarness({
      videos: [directUrlVideo()],
      shareLink: { status: ShareLinkStatus.REVOKED },
    });

    assert.deepEqual(
      await service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
      }),
      PUBLIC_DENIAL_RESPONSE,
    );
  });
});

describe("COMPAT-021 EMBED playback mapping", () => {
  it("keeps returning the stored embed URL, provider and allow attribute", async () => {
    const fixture = embedVideo();
    const { video } = await resolveOne(fixture);

    assert.equal(video.sourceType, VideoSourceType.EMBED);
    assert.equal(video.embedUrl, fixture.embedUrl);
    assert.equal(video.embedProvider, EmbedProvider.YOUTUBE_NOCOOKIE);
    assert.equal(video.embedAllow, fixture.embedAllow);
    assert.equal(video.thumbnailUrl, fixture.thumbnailUrl);
    // Embeds carry no backend playback route.
    assert.equal(video.playbackUrl, null);
    assert.equal(video.binaryPlaybackUrl, null);
    assert.equal(video.publicPlaybackUrl, null);
    assert.equal(video.binaryAsset, null);
    assert.equal(video.localFileAsset, null);
  });

  it("keeps an EMBED video playable only while it has a non-empty embed URL", async () => {
    for (const embedUrl of [null, "", "   "]) {
      const { service } = createCompatHarness({
        videos: [embedVideo({ embedUrl })],
      });

      assert.deepEqual(
        await service.resolvePublicWatch({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
        }),
        PUBLIC_DENIAL_RESPONSE,
      );
    }
  });
});

describe("COMPAT-022 LOCAL_FILE playback mapping", () => {
  it("keeps serving LOCAL_FILE through the token-bound backend route", async () => {
    const { video } = await resolveOne(localFileVideo());

    assert.equal(video.sourceType, VideoSourceType.LOCAL_FILE);
    const playback = parseMediaUrl(video.publicPlaybackUrl);
    assert.equal(
      playback.pathname,
      `/api/v1/public/watch/${LEGACY_ALIAS}/videos/video-local-file/local-file`,
    );
    assert.equal(playback.params.host, LEGACY_HOST);

    const thumbnail = parseMediaUrl(video.thumbnailUrl);
    assert.equal(
      thumbnail.pathname,
      `/api/v1/public/watch/${LEGACY_ALIAS}/videos/video-local-file/thumbnail`,
    );
    assert.equal(thumbnail.params.host, LEGACY_HOST);
    assert.equal(video.publicThumbnailUrl, video.thumbnailUrl);
    // The stored admin URL is never surfaced.
    assert.equal(video.playbackUrl, null);
    assert.equal(video.binaryPlaybackUrl, null);
    assert.deepEqual(video.localFileAsset, {
      mimeType: "video/mp4",
      sizeBytes: "10",
    });
    assert.equal(video.binaryAsset, null);
  });

  it("drops the LOCAL_FILE thumbnail rather than falling back to an admin URL", async () => {
    const { video } = await resolveOne(
      localFileVideo({ localThumbnailAsset: null }),
    );

    assert.equal(video.thumbnailUrl, null);
    assert.equal(video.publicThumbnailUrl, null);
    assert.ok(video.publicPlaybackUrl);
  });

  it("serves the LOCAL_FILE bytes for an authorized request", async () => {
    const { service, localStorage } = createCompatHarness({
      videos: [localFileVideo()],
    });

    const result = await service.getPublicLocalVideoFile({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
      videoId: "video-local-file",
    });

    assert.equal(result.mimeType, "video/mp4");
    assert.deepEqual(
      (localStorage as { rangeReadCalls: Array<{ storageKey: string }> })
        .rangeReadCalls[0]?.storageKey,
      "videos/video-local-file/source/video.mp4",
    );
  });
});

describe("COMPAT-023 DB_BLOB playback mapping", () => {
  it("keeps serving DB_BLOB through the token-bound backend binary route", async () => {
    const { video } = await resolveOne(dbBlobVideo());

    assert.equal(video.sourceType, VideoSourceType.DB_BLOB);
    const binary = parseMediaUrl(video.binaryPlaybackUrl);
    assert.equal(
      binary.pathname,
      `/api/v1/public/watch/${LEGACY_ALIAS}/videos/video-db-blob/binary`,
    );
    assert.equal(binary.params.host, LEGACY_HOST);
    assert.equal(video.publicPlaybackUrl, video.binaryPlaybackUrl);
    assert.equal(video.playbackUrl, null);
    assert.deepEqual(video.binaryAsset, {
      mimeType: "video/mp4",
      sizeBytes: "10",
    });
    assert.equal(video.localFileAsset, null);
    // DB_BLOB keeps its externally stored thumbnail URL.
    assert.equal(
      video.thumbnailUrl,
      "https://media.example.com/legacy/db-thumb.jpg",
    );
  });

  it("serves the DB_BLOB bytes for an authorized request", async () => {
    const { service } = createCompatHarness({ videos: [dbBlobVideo()] });

    const result = await service.getPublicDatabaseVideoBinary({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
      videoId: "video-db-blob",
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.mimeType, "video/mp4");
    assert.equal(result.contentLength, 10);
    assert.equal(result.data?.toString("utf8"), "0123456789");
  });
});

describe("COMPAT-024 Cloudinary playback mapping", () => {
  it("keeps existing Cloudinary upload playback on the stored secure_url", async () => {
    const fixture = cloudinaryUploadVideo();
    const { video } = await resolveOne(fixture);

    // Cloudinary uploads are stored as sourceType UPLOAD; the public mapping
    // keys off sourceType, so they take the provider/direct branch.
    assert.equal(video.sourceType, VideoSourceType.UPLOAD);
    assert.equal(video.playbackUrl, fixture.playbackUrl);
    assert.equal(video.thumbnailUrl, fixture.thumbnailUrl);
    assert.equal(video.binaryPlaybackUrl, null);
    assert.equal(video.publicPlaybackUrl, null);
    assert.equal(video.binaryAsset, null);
    assert.equal(video.localFileAsset, null);
  });

  it("keeps existing Cloudinary direct playback mapping", async () => {
    const fixture = cloudinaryDirectUrlVideo();
    const { video } = await resolveOne(fixture);

    assert.equal(video.sourceType, VideoSourceType.DIRECT_URL);
    assert.equal(video.playbackUrl, fixture.playbackUrl);
    assert.equal(video.publicPlaybackUrl, null);
  });

  it("keeps existing Cloudinary player embeds resolvable", async () => {
    const fixture = cloudinaryEmbedVideo();
    const { video } = await resolveOne(fixture);

    assert.equal(video.sourceType, VideoSourceType.EMBED);
    assert.equal(video.embedProvider, EmbedProvider.CLOUDINARY_PLAYER);
    assert.equal(video.embedUrl, fixture.embedUrl);
    assert.equal(video.embedAllow, fixture.embedAllow);
    assert.equal(video.playbackUrl, null);
    assert.equal(video.publicPlaybackUrl, null);
  });

  it("issues no backend grant for any Cloudinary shape on a view-limited link", async () => {
    const { service } = createCompatHarness({
      videos: [
        cloudinaryUploadVideo(),
        cloudinaryDirectUrlVideo(),
        cloudinaryEmbedVideo(),
      ],
      shareLink: { maxViews: 3 },
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.videos.length, 3);
    for (const video of response.videos) {
      assert.equal(readGrant(video.playbackUrl), null);
      assert.equal(readGrant(video.embedUrl), null);
      assert.equal(readQueryParam(video.playbackUrl, "host"), null);
      assert.equal(video.publicPlaybackUrl, null);
      assert.equal(video.binaryPlaybackUrl, null);
    }
  });

  it("keeps the mixed-provider share returning every authorized video", async () => {
    const { service } = createCompatHarness({
      videos: [
        cloudinaryUploadVideo(),
        directUrlVideo(),
        embedVideo(),
        localFileVideo(),
        dbBlobVideo(),
      ],
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.deepEqual(
      response.videos.map((video) => [video.id, video.sourceType]),
      [
        ["video-cloudinary-upload", VideoSourceType.UPLOAD],
        ["video-direct-url", VideoSourceType.DIRECT_URL],
        ["video-embed", VideoSourceType.EMBED],
        ["video-local-file", VideoSourceType.LOCAL_FILE],
        ["video-db-blob", VideoSourceType.DB_BLOB],
      ],
    );
  });
});

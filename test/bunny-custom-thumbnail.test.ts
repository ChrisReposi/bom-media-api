/**
 * BUNNY STREAM — custom thumbnail upload (`POST /admin/videos/:id/bunny/thumbnail`).
 *
 * WHY THIS EXISTS. The create form always let an operator pick a thumbnail, but
 * the Bunny branch discarded it, so the only way to get a custom poster was to
 * open the Bunny dashboard by hand. This endpoint automates that step.
 *
 * The properties that matter, and are all asserted here:
 *   - only a fully valid, READY Bunny asset can trigger a Bunny write;
 *   - the image is validated by declared type AND magic bytes;
 *   - the stored URL is BUILT from the `thumbnailFileName` Bunny reports after
 *     the fact - never `thumbnail.jpg`, never a pre-built URL field;
 *   - a Bunny failure is propagated, never reported as success;
 *   - no Bunny secret reaches the response.
 *
 * Nothing here performs a real network request.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ADMIN_ROLES_METADATA } from "../src/admin-auth/decorators/admin-roles.decorator";
import { AdminAccessTokenGuard } from "../src/admin-auth/guards/admin-access-token.guard";
import { AdminRolesGuard } from "../src/admin-auth/guards/admin-roles.guard";
import { BunnyStreamService } from "../src/bunny/bunny-stream.service";
import {
  AdminRole,
  VideoProvider,
  VideoSourceType,
  VideoStatus,
} from "../src/generated/prisma/client";
import { VideosController } from "../src/videos/videos.controller";
import { VideosService } from "../src/videos/videos.service";

const LIBRARY_ID = "987654";
const PULL_ZONE_HOSTNAME = "vz-example.b-cdn.net";
const VIDEO_GUID = "11111111-2222-3333-4444-555555555555";
const VIDEO_ID = "video-bunny-thumb";
/** A custom upload commonly lands under a generated name, not `thumbnail.jpg`. */
const CUSTOM_FILE_NAME = "thumbnail_abcd.jpg";
const EXPECTED_URL = `https://${PULL_ZONE_HOSTNAME}/${VIDEO_GUID}/${CUSTOM_FILE_NAME}`;

/** Minimal valid JPEG header, so magic-byte validation passes. */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]);
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);
const WEBP_BYTES = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP", "ascii"),
]);

function uploadedFile(
  overrides: Partial<Express.Multer.File> = {},
): Express.Multer.File {
  return {
    fieldname: "thumbnail",
    originalname: "poster.jpg",
    encoding: "7bit",
    mimetype: "image/jpeg",
    size: JPEG_BYTES.length,
    buffer: JPEG_BYTES,
    stream: undefined as never,
    destination: "",
    filename: "",
    path: "",
    ...overrides,
  } as Express.Multer.File;
}

type FakeVideoRow = {
  id: string;
  status: VideoStatus;
  provider: VideoProvider;
  sourceType: VideoSourceType;
  providerAssetId: string | null;
  playbackId: string | null;
  metadataJson: unknown;
  thumbnailUrl: string | null;
  title: string;
  slug: string | null;
  description: string | null;
  playbackUrl: string | null;
  embedProvider: null;
  embedUrl: string | null;
  embedCloudName: string | null;
  embedPublicId: string | null;
  embedAllow: string | null;
  durationSeconds: number | null;
  viewCount: bigint;
  publishedAt: Date | null;
  filterKey: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function bunnyRow(overrides: Partial<FakeVideoRow> = {}): FakeVideoRow {
  return {
    id: VIDEO_ID,
    status: VideoStatus.READY,
    provider: VideoProvider.BUNNY,
    sourceType: VideoSourceType.EMBED,
    providerAssetId: VIDEO_GUID,
    playbackId: VIDEO_GUID,
    metadataJson: { bunnyStream: { videoId: VIDEO_GUID } },
    thumbnailUrl: null,
    title: "Test Bunny Video",
    slug: "test-bunny-video",
    description: null,
    playbackUrl: null,
    embedProvider: null,
    embedUrl: `https://iframe.mediadelivery.net/embed/${LIBRARY_ID}/${VIDEO_GUID}`,
    embedCloudName: null,
    embedPublicId: null,
    embedAllow: null,
    durationSeconds: 1,
    viewCount: 0n,
    publishedAt: null,
    filterKey: null,
    createdAt: new Date("2026-08-23T00:00:00.000Z"),
    updatedAt: new Date("2026-08-23T00:00:00.000Z"),
    ...overrides,
  };
}

function createHarness(params: {
  row?: FakeVideoRow | null;
  remoteThumbnailFileName?: string | null;
  setThumbnailFails?: boolean;
} = {}): {
  service: VideosService;
  updates: Array<Record<string, unknown>>;
  setThumbnailCalls: Array<{ videoId: string; bytes: Buffer }>;
} {
  const row = params.row === undefined ? bunnyRow() : params.row;
  const updates: Array<Record<string, unknown>> = [];
  const setThumbnailCalls: Array<{ videoId: string; bytes: Buffer }> = [];

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

  // The REAL client builds the CDN URL, so this proves production construction
  // rather than a mock's opinion of it.
  const realBunny = new BunnyStreamService({
    get: (key: string): string | undefined =>
      ({
        BUNNY_STREAM_ENABLED: "true",
        BUNNY_STREAM_LIBRARY_ID: LIBRARY_ID,
        BUNNY_STREAM_PULL_ZONE_HOSTNAME: PULL_ZONE_HOSTNAME,
      })[key],
  } as never);

  const bunny = {
    ensureEnabled: () => undefined,
    setVideoThumbnail: async (videoId: string, bytes: Buffer) => {
      if (params.setThumbnailFails === true) {
        throw new Error("Bunny Stream request failed.");
      }
      setThumbnailCalls.push({ videoId, bytes });
    },
    // Bunny's Get Video reports the file name AFTER the fact. No pre-built URL
    // field exists in this payload, matching the real contract.
    getVideo: async () => ({
      guid: VIDEO_GUID,
      thumbnailFileName:
        params.remoteThumbnailFileName === undefined
          ? CUSTOM_FILE_NAME
          : params.remoteThumbnailFileName,
    }),
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

  return { service, updates, setThumbnailCalls };
}

async function expectRejection(
  promise: Promise<unknown>,
): Promise<{ message: string; status: number | undefined }> {
  try {
    await promise;
  } catch (error: unknown) {
    const typed = error as { message?: string; getStatus?: () => number };
    return { message: typed.message ?? "", status: typed.getStatus?.() };
  }

  assert.fail("Expected the thumbnail upload to be refused.");
}

/* ------------------------------------------------------------------ *
 * Happy path
 * ------------------------------------------------------------------ */

describe("Bunny custom thumbnail - success", () => {
  it("forwards the bytes and stores the URL BUILT from thumbnailFileName", async () => {
    const harness = createHarness();

    const result = await harness.service.setBunnyVideoThumbnail(
      VIDEO_ID,
      uploadedFile(),
      "admin-1",
    );

    assert.equal(harness.setThumbnailCalls.length, 1);
    assert.equal(harness.setThumbnailCalls[0]?.videoId, VIDEO_GUID);
    assert.ok(harness.setThumbnailCalls[0]?.bytes.equals(JPEG_BYTES));
    assert.equal(result.thumbnailUrl, EXPECTED_URL);
    assert.equal(result.thumbnailPersisted, true);
    assert.equal(harness.updates[0]?.thumbnailUrl, EXPECTED_URL);
  });

  it("uses the reported file name, never an invented thumbnail.jpg", async () => {
    const harness = createHarness({
      remoteThumbnailFileName: "thumbnail_ba67a0b0.jpg",
    });

    const result = await harness.service.setBunnyVideoThumbnail(
      VIDEO_ID,
      uploadedFile(),
      "admin-1",
    );

    assert.ok(String(result.thumbnailUrl).endsWith("/thumbnail_ba67a0b0.jpg"));
    assert.equal(String(result.thumbnailUrl).includes("/thumbnail.jpg"), false);
  });

  it("REPLACES an existing poster - the operator chose a new one", async () => {
    const harness = createHarness({
      row: bunnyRow({ thumbnailUrl: "https://old.example/poster.jpg" }),
    });

    const result = await harness.service.setBunnyVideoThumbnail(
      VIDEO_ID,
      uploadedFile(),
      "admin-1",
    );

    assert.equal(result.thumbnailUrl, EXPECTED_URL);
  });

  it("accepts PNG and WebP as well as JPEG", async () => {
    for (const [mimetype, buffer] of [
      ["image/png", PNG_BYTES],
      ["image/webp", WEBP_BYTES],
    ] as const) {
      const harness = createHarness();

      const result = await harness.service.setBunnyVideoThumbnail(
        VIDEO_ID,
        uploadedFile({ mimetype, buffer, size: buffer.length }),
        "admin-1",
      );

      assert.equal(result.thumbnailPersisted, true);
    }
  });

  it("returns no Bunny secret", async () => {
    const harness = createHarness();

    const result = await harness.service.setBunnyVideoThumbnail(
      VIDEO_ID,
      uploadedFile(),
      "admin-1",
    );

    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /AccessKey/i);
    assert.deepEqual(Object.keys(result).sort(), [
      "message",
      "thumbnailPersisted",
      "thumbnailUrl",
      "video",
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Classification — no cross-provider Bunny writes
 * ------------------------------------------------------------------ */

describe("Bunny custom thumbnail - classification gate", () => {
  it("REFUSES a non-Bunny video and calls Bunny zero times", async () => {
    const harness = createHarness({
      row: bunnyRow({
        provider: VideoProvider.MANUAL,
        sourceType: VideoSourceType.DIRECT_URL,
        providerAssetId: null,
        playbackId: null,
        metadataJson: null,
      }),
    });

    const failure = await expectRejection(
      harness.service.setBunnyVideoThumbnail(
        VIDEO_ID,
        uploadedFile(),
        "admin-1",
      ),
    );

    assert.equal(harness.setThumbnailCalls.length, 0);
    assert.equal(failure.status, 400);
    assert.match(failure.message, /not backed by Bunny Stream/i);
  });

  it("REFUSES a malformed Bunny record and calls Bunny zero times", async () => {
    for (const row of [
      bunnyRow({ playbackId: "mismatched" }),
      bunnyRow({ providerAssetId: null }),
      bunnyRow({ metadataJson: {} }),
      bunnyRow({ metadataJson: { bunnyStream: { videoId: "other" } } }),
    ]) {
      const harness = createHarness({ row });

      const failure = await expectRejection(
        harness.service.setBunnyVideoThumbnail(
          VIDEO_ID,
          uploadedFile(),
          "admin-1",
        ),
      );

      assert.equal(harness.setThumbnailCalls.length, 0);
      assert.match(failure.message, /malformed/i);
    }
  });

  it("REFUSES an unknown video id", async () => {
    const harness = createHarness({ row: null });

    const failure = await expectRejection(
      harness.service.setBunnyVideoThumbnail(
        VIDEO_ID,
        uploadedFile(),
        "admin-1",
      ),
    );

    assert.equal(harness.setThumbnailCalls.length, 0);
    assert.equal(failure.status, 404);
  });

  it("REFUSES a video that is not yet READY", async () => {
    // Ordering guard: `thumbnailTime` makes Bunny extract its own thumbnail
    // during encoding, so a custom image set earlier can be overwritten.
    for (const status of [
      VideoStatus.PROCESSING,
      VideoStatus.DRAFT,
      VideoStatus.FAILED,
      VideoStatus.DISABLED,
    ]) {
      const harness = createHarness({ row: bunnyRow({ status }) });

      const failure = await expectRejection(
        harness.service.setBunnyVideoThumbnail(
          VIDEO_ID,
          uploadedFile(),
          "admin-1",
        ),
      );

      assert.equal(harness.setThumbnailCalls.length, 0);
      assert.match(failure.message, /READY/);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Image validation
 * ------------------------------------------------------------------ */

describe("Bunny custom thumbnail - file validation", () => {
  it("REJECTS an unsupported type", async () => {
    for (const mimetype of [
      "image/svg+xml",
      "application/pdf",
      "text/html",
      "application/octet-stream",
    ]) {
      const harness = createHarness();

      const failure = await expectRejection(
        harness.service.setBunnyVideoThumbnail(
          VIDEO_ID,
          uploadedFile({ mimetype }),
          "admin-1",
        ),
      );

      assert.equal(harness.setThumbnailCalls.length, 0);
      assert.match(failure.message, /not supported/i);
    }
  });

  it("REJECTS content whose magic bytes contradict the declared type", async () => {
    // A renamed executable, or an SVG relabelled image/png.
    const harness = createHarness();

    const failure = await expectRejection(
      harness.service.setBunnyVideoThumbnail(
        VIDEO_ID,
        uploadedFile({
          mimetype: "image/png",
          buffer: Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"/>"),
        }),
        "admin-1",
      ),
    );

    assert.equal(harness.setThumbnailCalls.length, 0);
    assert.match(failure.message, /does not match its declared type/i);
  });

  it("REJECTS an oversize image", async () => {
    const harness = createHarness();
    // Default cap is 5 MB; 11 MB is over the hard ceiling too.
    const huge = Buffer.concat([
      JPEG_BYTES,
      Buffer.alloc(11 * 1024 * 1024, 0x00),
    ]);

    const failure = await expectRejection(
      harness.service.setBunnyVideoThumbnail(
        VIDEO_ID,
        uploadedFile({ buffer: huge, size: huge.length }),
        "admin-1",
      ),
    );

    assert.equal(harness.setThumbnailCalls.length, 0);
    assert.match(failure.message, /too large/i);
  });

  it("REJECTS a missing or empty file", async () => {
    for (const file of [
      undefined,
      uploadedFile({ buffer: Buffer.alloc(0), size: 0 }),
    ]) {
      const harness = createHarness();

      await expectRejection(
        harness.service.setBunnyVideoThumbnail(VIDEO_ID, file, "admin-1"),
      );

      assert.equal(harness.setThumbnailCalls.length, 0);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Failure and recovery
 * ------------------------------------------------------------------ */

describe("Bunny custom thumbnail - failure handling", () => {
  it("does NOT claim success when Bunny rejects the upload", async () => {
    const harness = createHarness({ setThumbnailFails: true });

    await expectRejection(
      harness.service.setBunnyVideoThumbnail(
        VIDEO_ID,
        uploadedFile(),
        "admin-1",
      ),
    );

    // Nothing persisted on a remote failure.
    assert.equal(harness.updates.length, 0);
  });

  it("reports honestly when Bunny has no file name yet, without failing", async () => {
    // Remote set succeeded; the poster URL simply is not resolvable yet. The
    // video must be untouched and a later sync backfills it.
    const harness = createHarness({ remoteThumbnailFileName: null });

    const result = await harness.service.setBunnyVideoThumbnail(
      VIDEO_ID,
      uploadedFile(),
      "admin-1",
    );

    assert.equal(harness.setThumbnailCalls.length, 1);
    assert.equal(result.thumbnailUrl, null);
    assert.equal(result.thumbnailPersisted, false);
    assert.equal(harness.updates.length, 0);
    assert.equal(result.video.status, VideoStatus.READY);
  });

  it("never persists a guessed file name", async () => {
    const harness = createHarness({ remoteThumbnailFileName: null });

    await harness.service.setBunnyVideoThumbnail(
      VIDEO_ID,
      uploadedFile(),
      "admin-1",
    );

    for (const update of harness.updates) {
      assert.equal("thumbnailUrl" in update, false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Authorization
 * ------------------------------------------------------------------ */

describe("Bunny custom thumbnail - authorization", () => {
  it("inherits the admin access-token and roles guards", () => {
    const guards = (Reflect.getMetadata(GUARDS_METADATA, VideosController) ??
      []) as unknown[];

    assert.ok(guards.includes(AdminAccessTokenGuard));
    assert.ok(guards.includes(AdminRolesGuard));
  });

  it("is a WRITE-role route - STAFF cannot set a thumbnail", () => {
    const roles = Reflect.getMetadata(
      ADMIN_ROLES_METADATA,
      VideosController.prototype.setBunnyVideoThumbnail,
    ) as AdminRole[] | undefined;

    assert.deepEqual(roles, [AdminRole.OWNER, AdminRole.ADMIN]);
  });
});

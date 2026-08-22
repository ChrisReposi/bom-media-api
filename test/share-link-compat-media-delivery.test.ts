/**
 * SHARE-LINK BACKWARD COMPATIBILITY - backend media delivery.
 *
 * COMPAT-009 seeking does not consume extra views
 * COMPAT-030 LOCAL_FILE full request · COMPAT-031 LOCAL_FILE Range
 * COMPAT-032 LOCAL_FILE invalid Range · COMPAT-033 HEAD
 * COMPAT-034 DB_BLOB Range and controller wire contract
 *
 * A FAILURE IN THIS FILE IS RELEASE BLOCKING. See
 * `docs/SHARE_LINK_COMPATIBILITY_TESTS.md`.
 *
 * The LOCAL_FILE cases run against the **real** `LocalVideoStorageService` on a
 * temporary storage root, so the Range arithmetic under test is the production
 * implementation rather than a fake. Both media routes are additionally driven
 * through the **real** `PublicController` methods, so the status codes, headers
 * and bytes asserted here are the ones a deployed public site actually sees.
 *
 * Header lookups are case-insensitive: HTTP header names are not case-sensitive
 * and pinning their casing would fail a release for a cosmetic change.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Request, Response } from "express";
import type { ApiEnvironmentConfig } from "../src/config/env.config";
import { LocalVideoStorageService } from "../src/videos/storage/local-video-storage.service";
import { PublicController } from "../src/public/public.controller";
import {
  createCompatHarness,
  dbBlobVideo,
  LEGACY_ALIAS,
  LEGACY_HOST,
  localFileVideo,
  readGrant,
  readStream,
} from "./share-link-compat-harness";

const LOCAL_VIDEO_KEY = "videos/video-local-file/source/video.mp4";
const LOCAL_THUMBNAIL_KEY = "videos/video-local-file/thumbnails/thumb.jpg";
const FILE_BYTES = "0123456789";

/** Range forms that the current parser refuses, for both stored sources. */
const UNSUPPORTED_RANGES = [
  "bytes=20-30", // beyond the end
  "bytes=abc", // unparseable
  "bytes=-", // no bounds
  "bytes=0-1,4-5", // multi-range is not supported
  "items=0-1", // non-bytes unit
];

class StorageConfigService {
  constructor(private readonly root: string) {}

  getOrThrow<T = unknown>(key: string): T {
    if (key !== "api") {
      throw new Error(`${key} missing`);
    }

    return {
      localFileStorage: {
        enabled: true,
        root: this.root,
        videoUploadMaxMb: 500,
        videoUploadHardMaxMb: 1024,
        videoChunkSizeMb: 50,
        uploadSessionTtlMinutes: 120,
        minFreeSpaceMb: 1,
        staleUploadMaxAgeHours: 24,
        thumbnailUploadMaxMb: 10,
      },
    } satisfies Partial<ApiEnvironmentConfig> as T;
  }
}

/**
 * Minimal Express-compatible response that records the wire contract.
 * Header names are stored lower-cased so assertions are case-insensitive.
 */
class RecordingResponse extends Writable {
  private readonly headerMap = new Map<string, string>();
  statusCode = 200;
  private readonly chunks: Buffer[] = [];

  setHeader(name: string, value: unknown): this {
    this.headerMap.set(name.toLowerCase(), String(value));

    return this;
  }

  getHeader(name: string): string | undefined {
    return this.headerMap.get(name.toLowerCase());
  }

  hasHeader(name: string): boolean {
    return this.headerMap.has(name.toLowerCase());
  }

  status(code: number): this {
    this.statusCode = code;

    return this;
  }

  send(body?: Buffer): this {
    if (body !== undefined && body.length > 0) {
      this.chunks.push(body);
    }
    this.end();

    return this;
  }

  body(): Buffer {
    return Buffer.concat(this.chunks);
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }
}

class ControllerConfigService {
  getOrThrow<T = unknown>(key: string): T {
    if (key !== "api") {
      throw new Error(`${key} missing`);
    }

    return {
      trustProxyEnabled: false,
      trustProxyCloudflareOnly: false,
    } satisfies Partial<ApiEnvironmentConfig> as T;
  }
}

function createRequest(method: "GET" | "HEAD", rangeHeader?: string): Request {
  return {
    method,
    headers: rangeHeader === undefined ? {} : { range: rangeHeader },
    socket: {},
  } as unknown as Request;
}

function createController(service: unknown): PublicController {
  return new PublicController(
    service as never,
    new ControllerConfigService() as never,
  );
}

/** Asserts the no-store family every public response must carry. */
function assertNoStoreHeaders(response: RecordingResponse): void {
  assert.equal(
    response.getHeader("cache-control"),
    "private, no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  assert.equal(response.getHeader("x-content-type-options"), "nosniff");
}

/* ================================================================== *
 * DB_BLOB - real controller wire contract (COMPAT-033 / COMPAT-034)
 * ================================================================== */

describe("COMPAT-034 DB_BLOB controller wire contract", () => {
  function dbBlobController() {
    const harness = createCompatHarness({ videos: [dbBlobVideo()] });

    return { ...harness, controller: createController(harness.service) };
  }

  async function callBinary(
    method: "GET" | "HEAD",
    rangeHeader?: string,
  ): Promise<{
    response: RecordingResponse;
    prisma: ReturnType<typeof dbBlobController>["prisma"];
  }> {
    const { controller, prisma } = dbBlobController();
    const response = new RecordingResponse();

    await controller.streamPublicDatabaseVideo(
      LEGACY_ALIAS,
      "video-db-blob",
      LEGACY_HOST,
      undefined,
      createRequest(method, rangeHeader),
      response as unknown as Response,
    );

    return { response, prisma };
  }

  it("A - keeps the full GET wire contract", async () => {
    const { response } = await callBinary("GET");

    assert.equal(response.statusCode, 200);
    assert.equal(response.getHeader("accept-ranges"), "bytes");
    assert.equal(response.getHeader("content-type"), "video/mp4");
    assert.equal(response.getHeader("content-length"), "10");
    assert.equal(response.hasHeader("content-range"), false);
    assert.equal(response.body().toString(), FILE_BYTES);
    assertNoStoreHeaders(response);
  });

  it("B - keeps the Range GET wire contract", async () => {
    const { response } = await callBinary("GET", "bytes=2-5");

    assert.equal(response.statusCode, 206);
    assert.equal(response.getHeader("accept-ranges"), "bytes");
    assert.equal(response.getHeader("content-type"), "video/mp4");
    assert.equal(response.getHeader("content-length"), "4");
    assert.equal(response.getHeader("content-range"), "bytes 2-5/10");
    assert.equal(response.body().toString(), "2345");
  });

  it("C - keeps the full HEAD contract and reads no blob bytes", async () => {
    const { response, prisma } = await callBinary("HEAD");

    assert.equal(response.statusCode, 200);
    assert.equal(response.getHeader("accept-ranges"), "bytes");
    assert.equal(response.getHeader("content-type"), "video/mp4");
    assert.equal(response.getHeader("content-length"), "10");
    assert.equal(response.body().length, 0);
    // The blob SUBSTRING query is skipped entirely for a HEAD - this is a real
    // guarantee of the current implementation, not an incidental detail.
    assert.equal(prisma.counters.queryRaw, 0);
  });

  it("D - keeps the ranged HEAD contract with no body", async () => {
    const { response, prisma } = await callBinary("HEAD", "bytes=2-5");

    assert.equal(response.statusCode, 206);
    assert.equal(response.getHeader("content-length"), "4");
    assert.equal(response.getHeader("content-range"), "bytes 2-5/10");
    assert.equal(response.body().length, 0);
    assert.equal(prisma.counters.queryRaw, 0);
  });

  it("E - keeps the 416 contract: Content-Range but no Content-Length", async () => {
    for (const rangeHeader of UNSUPPORTED_RANGES) {
      const { response } = await callBinary("GET", rangeHeader);

      assert.equal(response.statusCode, 416, `range: ${rangeHeader}`);
      assert.equal(response.getHeader("accept-ranges"), "bytes");
      assert.equal(response.getHeader("content-type"), "video/mp4");
      assert.equal(response.getHeader("content-range"), "bytes */10");
      // Documented in API_CONTRACTS.md section 3.2: the controller ends the
      // response before Content-Length is written.
      assert.equal(
        response.hasHeader("content-length"),
        false,
        `range: ${rangeHeader}`,
      );
      assert.equal(response.body().length, 0);
    }
  });

  it("keeps DB_BLOB Range semantics byte-accurate at the service layer", async () => {
    const { service } = createCompatHarness({ videos: [dbBlobVideo()] });

    const suffix = await service.getPublicDatabaseVideoBinary({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
      videoId: "video-db-blob",
      rangeHeader: "bytes=-3",
    });
    assert.equal(suffix.statusCode, 206);
    assert.equal(suffix.contentRange, "bytes 7-9/10");
    assert.equal(suffix.data?.toString(), "789");

    const openEnded = await service.getPublicDatabaseVideoBinary({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
      videoId: "video-db-blob",
      rangeHeader: "bytes=4-",
    });
    assert.equal(openEnded.contentRange, "bytes 4-9/10");
    assert.equal(openEnded.data?.toString(), "456789");
  });
});

/* ================================================================== *
 * LOCAL_FILE - real storage service + real controller
 * ================================================================== */

describe("LOCAL_FILE media delivery compatibility", () => {
  let root: string;
  let scratch: string;
  let storage: LocalVideoStorageService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "compat-media-root-"));
    scratch = await mkdtemp(join(tmpdir(), "compat-media-scratch-"));
    storage = new LocalVideoStorageService(
      new StorageConfigService(root) as never,
    );
    await storage.ensureRootReady();

    const videoSource = join(scratch, "video.mp4");
    await writeFile(videoSource, Buffer.from(FILE_BYTES));
    await storage.storeThumbnailFile({
      temporaryPath: videoSource,
      storageKey: LOCAL_VIDEO_KEY,
    });

    const thumbnailSource = join(scratch, "thumb.jpg");
    await writeFile(thumbnailSource, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    await storage.storeThumbnailFile({
      temporaryPath: thumbnailSource,
      storageKey: LOCAL_THUMBNAIL_KEY,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  function createLocalHarness(
    shareLink?: Parameters<typeof createCompatHarness>[0]["shareLink"],
  ) {
    return createCompatHarness({
      videos: [localFileVideo()],
      localVideoStorage: storage,
      ...(shareLink === undefined ? {} : { shareLink }),
    });
  }

  async function callLocalFile(
    method: "GET" | "HEAD",
    rangeHeader?: string,
  ): Promise<RecordingResponse> {
    const { service } = createLocalHarness();
    const controller = createController(service);
    const response = new RecordingResponse();

    await controller.streamPublicLocalVideo(
      LEGACY_ALIAS,
      "video-local-file",
      LEGACY_HOST,
      undefined,
      createRequest(method, rangeHeader),
      response as unknown as Response,
    );

    return response;
  }

  /* ---------------- COMPAT-030 ---------------- */

  describe("COMPAT-030 LOCAL_FILE full request", () => {
    it("keeps returning 200 with the whole file when no Range is sent", async () => {
      const { service } = createLocalHarness();

      const result = await service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-local-file",
      });

      assert.equal(result.statusCode, 200);
      assert.equal(result.mimeType, "video/mp4");
      assert.equal(result.contentLength, 10);
      assert.equal(result.contentRange, null);
      assert.equal((await readStream(result.stream)).toString(), FILE_BYTES);
    });

    it("keeps the 200 wire headers the public site depends on", async () => {
      const response = await callLocalFile("GET");

      assert.equal(response.statusCode, 200);
      assert.equal(response.getHeader("accept-ranges"), "bytes");
      assert.equal(response.getHeader("content-type"), "video/mp4");
      assert.equal(response.getHeader("content-length"), "10");
      assert.equal(response.hasHeader("content-range"), false);
      assert.equal(response.body().toString(), FILE_BYTES);
      assertNoStoreHeaders(response);
    });
  });

  /* ---------------- COMPAT-031 ---------------- */

  describe("COMPAT-031 LOCAL_FILE Range requests", () => {
    it("keeps returning 206 for a satisfiable single byte range", async () => {
      const { service } = createLocalHarness();

      const result = await service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-local-file",
        rangeHeader: "bytes=2-5",
      });

      assert.equal(result.statusCode, 206);
      assert.equal(result.contentLength, 4);
      assert.equal(result.contentRange, "bytes 2-5/10");
      assert.equal((await readStream(result.stream)).toString(), "2345");
    });

    it("keeps supporting suffix and open-ended ranges", async () => {
      const { service } = createLocalHarness();

      const suffix = await service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-local-file",
        rangeHeader: "bytes=-3",
      });
      assert.equal(suffix.statusCode, 206);
      assert.equal(suffix.contentRange, "bytes 7-9/10");
      assert.equal((await readStream(suffix.stream)).toString(), "789");

      const openEnded = await service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-local-file",
        rangeHeader: "bytes=4-",
      });
      assert.equal(openEnded.statusCode, 206);
      assert.equal(openEnded.contentRange, "bytes 4-9/10");
      assert.equal((await readStream(openEnded.stream)).toString(), "456789");
    });

    it("keeps the 206 wire headers, including Content-Range", async () => {
      const response = await callLocalFile("GET", "bytes=2-5");

      assert.equal(response.statusCode, 206);
      assert.equal(response.getHeader("accept-ranges"), "bytes");
      assert.equal(response.getHeader("content-length"), "4");
      assert.equal(response.getHeader("content-range"), "bytes 2-5/10");
      assert.equal(response.body().toString(), "2345");
    });
  });

  /* ---------------- COMPAT-032 ---------------- */

  describe("COMPAT-032 LOCAL_FILE unsatisfiable Range", () => {
    it("keeps returning 416 metadata for every unsupported range form", async () => {
      const { service } = createLocalHarness();

      for (const rangeHeader of [...UNSUPPORTED_RANGES, "bytes=5-2"]) {
        const result = await service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-local-file",
          rangeHeader,
        });

        assert.equal(result.statusCode, 416, `range: ${rangeHeader}`);
        assert.equal(result.contentLength, 0, `range: ${rangeHeader}`);
        assert.equal(
          result.contentRange,
          "bytes */10",
          `range: ${rangeHeader}`,
        );
        assert.equal(result.stream, null, `range: ${rangeHeader}`);
      }
    });

    it("keeps the 416 wire contract: Content-Range but no Content-Length", async () => {
      const response = await callLocalFile("GET", "bytes=20-30");

      assert.equal(response.statusCode, 416);
      assert.equal(response.getHeader("accept-ranges"), "bytes");
      assert.equal(response.getHeader("content-type"), "video/mp4");
      assert.equal(response.getHeader("content-range"), "bytes */10");
      assert.equal(response.hasHeader("content-length"), false);
      assert.equal(response.body().length, 0);
    });
  });

  /* ---------------- COMPAT-033 ---------------- */

  describe("COMPAT-033 LOCAL_FILE HEAD requests", () => {
    it("keeps HEAD returning headers with no body", async () => {
      const response = await callLocalFile("HEAD");

      assert.equal(response.statusCode, 200);
      assert.equal(response.getHeader("accept-ranges"), "bytes");
      assert.equal(response.getHeader("content-type"), "video/mp4");
      assert.equal(response.getHeader("content-length"), "10");
      assert.equal(response.body().length, 0);
    });

    it("keeps ranged HEAD returning range headers with no body", async () => {
      const response = await callLocalFile("HEAD", "bytes=2-5");

      assert.equal(response.statusCode, 206);
      assert.equal(response.getHeader("content-length"), "4");
      assert.equal(response.getHeader("content-range"), "bytes 2-5/10");
      assert.equal(response.body().length, 0);
    });
  });

  /* ---------------- COMPAT-009 ---------------- */

  describe("COMPAT-009 seeking does not consume extra views", () => {
    it("charges one view for the watch resolution and none for LOCAL_FILE Range requests", async () => {
      const { service, prisma } = createLocalHarness({ maxViews: 1 });

      const watch = await service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
      });
      assert.equal(watch.valid, true);
      assert.equal(prisma.shareLinkRecord.currentViews, 1);

      const grant = readGrant(watch.videos[0]?.publicPlaybackUrl);
      assert.ok(grant, "a view-limited link must issue a media grant");

      const viewsAfterWatch = prisma.shareLinkRecord.currentViews;

      // A seeking viewer: many byte ranges over the same admitted session.
      for (const rangeHeader of [
        "bytes=0-1",
        "bytes=2-5",
        "bytes=4-",
        "bytes=-3",
        "bytes=6-9",
      ]) {
        const result = await service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-local-file",
          grant,
          rangeHeader,
        });

        assert.equal(result.statusCode, 206, `range: ${rangeHeader}`);
        await readStream(result.stream);
      }

      // Observable outcome only: the budget is untouched, so the link is still
      // exactly one view in and a second viewer can still be admitted.
      assert.equal(
        prisma.shareLinkRecord.currentViews,
        viewsAfterWatch,
        "media requests must never consume a view",
      );
      // No AccessLog row is written for media requests either.
      assert.equal(prisma.accessLogs.length, 1);
    });

    it("charges no view for DB_BLOB Range requests", async () => {
      const { service, prisma } = createCompatHarness({
        videos: [dbBlobVideo()],
        shareLink: { maxViews: 1 },
      });

      const watch = await service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
      });
      const grant = readGrant(watch.videos[0]?.publicPlaybackUrl);
      assert.ok(grant);

      for (const rangeHeader of ["bytes=0-1", "bytes=2-5", "bytes=6-9"]) {
        const result = await service.getPublicDatabaseVideoBinary({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-db-blob",
          grant,
          rangeHeader,
        });
        assert.equal(result.statusCode, 206);
      }

      // Observable: one view spent on the watch resolution, none on the ranges.
      assert.equal(prisma.shareLinkRecord.currentViews, 1);
      // ...and the budget of 1 is now genuinely spent for anyone else.
      const second = await service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
      });
      assert.equal(second.valid, false);
      assert.equal(prisma.shareLinkRecord.currentViews, 1);
    });

    it("keeps serving an admitted viewer after the view budget is spent", async () => {
      // Current, deliberate behaviour: media routes check status and expiry but
      // not maxViews - the grant is what binds media access. Documented in
      // SECURITY_MODEL.md section 4.
      const { service, prisma } = createLocalHarness({ maxViews: 1 });

      const watch = await service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
      });
      const grant = readGrant(watch.videos[0]?.publicPlaybackUrl);
      assert.ok(grant);

      // The budget is now spent: a new viewer cannot resolve.
      const second = await service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
      });
      assert.equal(second.valid, false);
      assert.equal(prisma.shareLinkRecord.currentViews, 1);

      // ...but the already-admitted viewer keeps seeking with their grant.
      const result = await service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-local-file",
        grant,
        rangeHeader: "bytes=2-5",
      });
      assert.equal(result.statusCode, 206);
      await readStream(result.stream);
    });
  });
});

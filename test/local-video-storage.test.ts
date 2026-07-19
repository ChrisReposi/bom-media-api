import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BadRequestException } from "@nestjs/common";
import type { ApiEnvironmentConfig } from "../src/config/env.config";
import { LocalVideoStorageService } from "../src/videos/storage/local-video-storage.service";

class FakeConfigService {
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

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

describe("LocalVideoStorageService", () => {
  let root: string;
  let scratch: string;
  let service: LocalVideoStorageService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "local-video-root-"));
    scratch = await mkdtemp(join(tmpdir(), "local-video-scratch-"));
    service = new LocalVideoStorageService(
      new FakeConfigService(root) as never,
    );
    await service.ensureRootReady();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  it("rejects path traversal storage keys", () => {
    assert.throws(
      () => service.resolveStoragePath("../outside.mp4"),
      BadRequestException,
    );
    assert.throws(
      () => service.resolveStoragePath("videos/../../outside.mp4"),
      BadRequestException,
    );
  });

  it("rejects symlink components and file targets under the storage root", async () => {
    await mkdir(join(root, "videos"), { recursive: true });
    const outsideFile = join(scratch, "outside.mp4");
    await writeFile(outsideFile, Buffer.from("outside"));
    await symlink(scratch, join(root, "videos", "escaped-directory"));
    await symlink(outsideFile, join(root, "videos", "escaped-file.mp4"));

    assert.throws(
      () =>
        service.createFullReadStream("videos/escaped-directory/outside.mp4"),
      BadRequestException,
    );
    assert.throws(
      () => service.createFullReadStream("videos/escaped-file.mp4"),
      BadRequestException,
    );
  });

  it("uses distinct exclusive candidates for duplicate chunk indices", async () => {
    const firstPath = join(scratch, "first");
    const secondPath = join(scratch, "second");
    await writeFile(firstPath, Buffer.from("first"));
    await writeFile(secondPath, Buffer.from("second"));
    const tempStorageKey = service.buildUploadTempKey("upload-duplicate");

    const first = await service.saveUploadedChunk({
      temporaryPath: firstPath,
      tempStorageKey,
      chunkIndex: 0,
    });
    const second = await service.saveUploadedChunk({
      temporaryPath: secondPath,
      tempStorageKey,
      chunkIndex: 0,
    });

    assert.notEqual(first.storageKey, second.storageKey);
    assert.equal(
      (
        await readStream(service.createFullReadStream(first.storageKey).stream)
      ).toString(),
      "first",
    );
    assert.equal(
      (
        await readStream(service.createFullReadStream(second.storageKey).stream)
      ).toString(),
      "second",
    );
  });

  it("merges chunks atomically while retaining source chunks for recovery", async () => {
    const firstChunkPath = join(scratch, "chunk-0");
    const secondChunkPath = join(scratch, "chunk-1");
    await writeFile(firstChunkPath, Buffer.from("first-"));
    await writeFile(secondChunkPath, Buffer.from("second"));

    const tempStorageKey = service.buildUploadTempKey("upload-1");
    const first = await service.saveUploadedChunk({
      temporaryPath: firstChunkPath,
      tempStorageKey,
      chunkIndex: 0,
    });
    const second = await service.saveUploadedChunk({
      temporaryPath: secondChunkPath,
      tempStorageKey,
      chunkIndex: 1,
    });

    const final = await service.mergeChunksToFinalFile({
      chunkStorageKeys: [first.storageKey, second.storageKey],
      finalStorageKey: service.buildFinalVideoKey("video-1", "demo.mp4"),
    });

    assert.equal(final.sizeBytes, BigInt("first-second".length));
    assert.equal(
      final.checksumSha256,
      createHash("sha256").update("first-second").digest("hex"),
    );

    await assert.doesNotReject(
      stat(service.resolveStoragePath(first.storageKey)),
    );
    await assert.doesNotReject(
      stat(service.resolveStoragePath(second.storageKey)),
    );

    const full = service.createFullReadStream(final.storageKey);
    assert.equal(
      (await readStream(full.stream)).toString("utf8"),
      "first-second",
    );
  });

  it("keeps source chunks and removes staging output after merge failure", async () => {
    const sourcePath = join(scratch, "chunk");
    await writeFile(sourcePath, Buffer.from("recoverable"));
    const tempStorageKey = service.buildUploadTempKey("upload-failure");
    const chunk = await service.saveUploadedChunk({
      temporaryPath: sourcePath,
      tempStorageKey,
      chunkIndex: 0,
    });
    const finalStorageKey = service.buildFinalVideoKey(
      "video-failure",
      "demo.mp4",
    );

    await assert.rejects(
      service.mergeChunksToFinalFile({
        chunkStorageKeys: [chunk.storageKey, `${tempStorageKey}/missing.part`],
        finalStorageKey,
      }),
    );
    await assert.doesNotReject(
      stat(service.resolveStoragePath(chunk.storageKey)),
    );
    await assert.rejects(stat(service.resolveStoragePath(finalStorageKey)));
  });

  it("supports HTTP range reads", async () => {
    const sourcePath = join(scratch, "video.mp4");
    await writeFile(sourcePath, Buffer.from("0123456789"));

    const stored = await service.storeThumbnailFile({
      temporaryPath: sourcePath,
      storageKey: "videos/video-1/source/sample.mp4",
    });

    const result = service.createRangeReadStream({
      storageKey: stored.storageKey,
      rangeHeader: "bytes=2-5",
    });

    assert.equal(result.statusCode, 206);
    assert.equal(result.contentLength, 4);
    assert.equal(result.contentRange, "bytes 2-5/10");
    assert.ok(result.stream);
    assert.equal((await readStream(result.stream)).toString("utf8"), "2345");
  });

  it("returns 416 metadata for invalid ranges", async () => {
    const sourcePath = join(scratch, "video.mp4");
    await writeFile(sourcePath, Buffer.from("0123456789"));

    const stored = await service.storeThumbnailFile({
      temporaryPath: sourcePath,
      storageKey: "videos/video-1/source/sample.mp4",
    });

    const result = service.createRangeReadStream({
      storageKey: stored.storageKey,
      rangeHeader: "bytes=20-30",
    });

    assert.equal(result.statusCode, 416);
    assert.equal(result.contentLength, 0);
    assert.equal(result.contentRange, "bytes */10");
    assert.equal(result.stream, null);
  });
});

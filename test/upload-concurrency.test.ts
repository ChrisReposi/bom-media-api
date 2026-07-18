import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConflictException } from "@nestjs/common";
import { VideoUploadSessionStatus } from "../src/generated/prisma/client";
import { VideosService } from "../src/videos/videos.service";

function activeUpload() {
  return {
    id: "upload-1",
    adminId: "admin-1",
    title: "Video",
    slug: null,
    description: null,
    originalFilename: "video.mp4",
    mimeType: "video/mp4",
    totalBytes: 4n,
    totalChunks: 1,
    chunkSizeBytes: 4,
    checksumSha256: null,
    tempStorageKey: "tmp/uploads/upload-1",
    finalStorageKey: null,
    metadataJson: null,
    status: VideoUploadSessionStatus.ACTIVE,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    chunks: [
      {
        chunkIndex: 0,
        sizeBytes: 4n,
        checksumSha256: null,
        storageKey: "tmp/uploads/upload-1/chunk-0-candidate.part",
      },
    ],
  };
}

describe("local upload state ownership", () => {
  it("does not mark the winning completion FAILED when its CAS loses", async () => {
    const upload = activeUpload();
    let failedStateWrites = 0;
    let mergeCalls = 0;
    const prisma = {
      videoUploadSession: {
        findMany: async () => [],
        findUnique: async () => upload,
        updateMany: async (args: {
          data: { status: VideoUploadSessionStatus };
        }) => {
          if (args.data.status === VideoUploadSessionStatus.FAILED) {
            failedStateWrites += 1;
          }
          return { count: 0 };
        },
      },
    };
    const localStorage = {
      getStaleUploadMaxAgeHours: () => 24,
      ensureAvailableCapacity: () => undefined,
      mergeChunksToFinalFile: async () => {
        mergeCalls += 1;
        throw new Error("merge must not run");
      },
      deleteStorageKeyBestEffort: async () => false,
      deleteDirectoryBestEffort: async () => false,
    };
    const service = new VideosService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      localStorage as never,
    );

    await assert.rejects(
      service.completeLocalVideoUpload("upload-1", {}, undefined, "admin-1"),
      ConflictException,
    );
    assert.equal(mergeCalls, 0);
    assert.equal(failedStateWrites, 0);
  });

  it("does not expire or delete a session that is already COMPLETING", async () => {
    const upload = {
      ...activeUpload(),
      status: VideoUploadSessionStatus.COMPLETING,
    };
    let deletedDirectories = 0;
    const prisma = {
      videoUploadSession: {
        findMany: async (args: {
          where: { status: { in: VideoUploadSessionStatus[] } };
        }) => {
          assert.equal(
            args.where.status.in.includes(VideoUploadSessionStatus.COMPLETING),
            false,
          );
          return [];
        },
        findUnique: async () => upload,
      },
    };
    const localStorage = {
      getStaleUploadMaxAgeHours: () => 24,
      deleteDirectoryBestEffort: async () => {
        deletedDirectories += 1;
        return true;
      },
    };
    const service = new VideosService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      localStorage as never,
    );

    await assert.rejects(
      service.cancelLocalVideoUpload("upload-1", "admin-1"),
      ConflictException,
    );
    assert.equal(deletedDirectories, 0);
  });
});

describe("disk-backed Cloudinary upload cleanup", () => {
  it("removes video and thumbnail temp files when streaming upload fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cloudinary-upload-"));
    const videoPath = join(directory, "video.mp4");
    const thumbnailPath = join(directory, "thumbnail.jpg");
    await writeFile(videoPath, Buffer.from("video"));
    await writeFile(thumbnailPath, Buffer.from("thumbnail"));
    const service = new VideosService(
      {} as never,
      {
        uploadVideo: async () => Promise.reject(new Error("upload aborted")),
      } as never,
      { get: () => undefined } as never,
      {} as never,
      {} as never,
    );

    try {
      await assert.rejects(
        service.uploadVideo(
          { title: "Video" },
          {
            path: videoPath,
            size: 5,
            mimetype: "video/mp4",
            originalname: "video.mp4",
          } as Express.Multer.File,
          {
            path: thumbnailPath,
            size: 9,
            mimetype: "image/jpeg",
            originalname: "thumbnail.jpg",
          } as Express.Multer.File,
          "admin-1",
        ),
        /upload aborted/,
      );
      await assert.rejects(stat(videoPath));
      await assert.rejects(stat(thumbnailPath));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

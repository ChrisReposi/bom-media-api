import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, it } from "node:test";
import {
  VideoProvider,
  VideoSourceType,
  VideoStatus,
  type VideoAsset,
} from "../src/generated/prisma/client";
import { computeSha256Hex } from "../src/videos/utils/video-checksum.util";
import { VideosService } from "../src/videos/videos.service";

type BinaryWrite = {
  mimeType: string;
  sizeBytes: bigint;
  data: Buffer;
  checksumSha256: string;
};

type BinaryRecord = Omit<BinaryWrite, "checksumSha256"> & {
  checksumSha256: string | null;
};

type FakeVideoRecord = VideoAsset & {
  binaryAsset: {
    mimeType: string;
    sizeBytes: bigint;
  } | null;
  localFileAsset: null;
  localThumbnailAsset: null;
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert.equal(typeof value, "object", `${label} must be an object`);
  assert.notEqual(value, null, `${label} must not be null`);
  return value as Record<string, unknown>;
}

function readBinaryWrite(value: unknown): BinaryWrite {
  const record = asRecord(value, "binary write");
  assert.equal(typeof record.mimeType, "string");
  assert.equal(typeof record.sizeBytes, "bigint");
  assert.ok(record.data instanceof Uint8Array);
  assert.equal(typeof record.checksumSha256, "string");

  return {
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    data: Buffer.from(record.data),
    checksumSha256: record.checksumSha256,
  };
}

class FakePrismaService {
  video: FakeVideoRecord | null = null;
  binary: BinaryRecord | null = null;
  uploadWrite: BinaryWrite | null = null;
  replacementCreateWrite: BinaryWrite | null = null;
  replacementUpdateWrite: BinaryWrite | null = null;

  readonly videoAsset = {
    findUnique: async (args: {
      where: { id?: string; slug?: string };
    }): Promise<FakeVideoRecord | { id: string } | null> => {
      if (args.where.slug !== undefined) {
        return this.video?.slug === args.where.slug
          ? { id: this.video.id }
          : null;
      }

      return this.video?.id === args.where.id ? this.video : null;
    },
    create: async (args: {
      data: Record<string, unknown>;
    }): Promise<FakeVideoRecord> => {
      const binaryRelation = asRecord(
        args.data.binaryAsset,
        "binary create relation",
      );
      const write = readBinaryWrite(binaryRelation.create);
      this.uploadWrite = write;
      this.binary = write;

      const now = new Date("2026-07-19T00:00:00.000Z");
      this.video = {
        id: "video-db-1",
        title: String(args.data.title),
        slug: String(args.data.slug),
        description: (args.data.description as string | null) ?? null,
        provider: args.data.provider as VideoProvider,
        sourceType: args.data.sourceType as VideoSourceType,
        providerAssetId: null,
        playbackId: null,
        playbackUrl: null,
        embedProvider: null,
        embedUrl: null,
        embedCloudName: null,
        embedPublicId: null,
        embedAllow: null,
        thumbnailUrl: (args.data.thumbnailUrl as string | null) ?? null,
        durationSeconds: (args.data.durationSeconds as number | null) ?? null,
        viewCount: args.data.viewCount as bigint,
        publishedAt: (args.data.publishedAt as Date | null) ?? null,
        status: args.data.status as VideoStatus,
        filterKey: (args.data.filterKey as string | null) ?? null,
        metadataJson: null,
        createdAt: now,
        updatedAt: now,
        binaryAsset: {
          mimeType: write.mimeType,
          sizeBytes: write.sizeBytes,
        },
        localFileAsset: null,
        localThumbnailAsset: null,
      };

      return this.video;
    },
    update: async (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<FakeVideoRecord> => {
      assert.ok(this.video);
      assert.equal(args.where.id, this.video.id);
      const binaryRelation = asRecord(
        args.data.binaryAsset,
        "binary update relation",
      );
      const upsert = asRecord(binaryRelation.upsert, "binary upsert");
      this.replacementCreateWrite = readBinaryWrite(upsert.create);
      this.replacementUpdateWrite = readBinaryWrite(upsert.update);
      this.binary = this.replacementUpdateWrite;
      this.video = {
        ...this.video,
        durationSeconds:
          (args.data.durationSeconds as number | null | undefined) ??
          this.video.durationSeconds,
        status:
          (args.data.status as VideoStatus | undefined) ?? this.video.status,
        binaryAsset: {
          mimeType: this.binary.mimeType,
          sizeBytes: this.binary.sizeBytes,
        },
        updatedAt: new Date("2026-07-19T00:01:00.000Z"),
      };

      return this.video;
    },
  };

  readonly videoBinaryAsset = {
    findUnique: async (args: { where: { videoId: string } }) => {
      if (this.video?.id !== args.where.videoId || this.binary === null) {
        return null;
      }

      return {
        mimeType: this.binary.mimeType,
        sizeBytes: this.binary.sizeBytes,
        data: this.binary.data,
      };
    },
  };

  readonly adminAuditLog = {
    create: async () => ({ id: "audit-1" }),
  };

  async $queryRaw(): Promise<Array<Record<string, unknown>>> {
    return [
      {
        Variable_name: "max_allowed_packet",
        Value: String(1024 * 1024 * 1024),
      },
    ];
  }

  async $transaction<T>(
    callback: (transaction: FakePrismaService) => Promise<T>,
  ): Promise<T> {
    return callback(this);
  }
}

class FakeConfigService {
  get<T>(key: string): T | undefined {
    const values: Record<string, unknown> = {
      VIDEO_DB_STORAGE_ENABLED: true,
      VIDEO_DB_UPLOAD_MAX_MB: "100",
      API_PREFIX: "api/v1",
    };

    return values[key] as T | undefined;
  }
}

class FakeVideoMetadataService {
  async probeLocalVideoFile(): Promise<{ durationSeconds: number | null }> {
    return { durationSeconds: null };
  }
}

const scratchDirectories = new Set<string>();

async function createDatabaseUploadFile(
  bytes: Buffer,
): Promise<Express.Multer.File> {
  const directory = await mkdtemp(join(tmpdir(), "db-video-checksum-test-"));
  scratchDirectories.add(directory);
  const path = join(directory, "video.mp4");
  await writeFile(path, bytes);

  return {
    fieldname: "file",
    originalname: "video.mp4",
    encoding: "7bit",
    mimetype: "video/mp4",
    size: bytes.length,
    destination: directory,
    filename: "video.mp4",
    path,
    buffer: Buffer.alloc(0),
    stream: Readable.from(bytes),
  };
}

function createVideosService(): {
  prisma: FakePrismaService;
  service: VideosService;
} {
  const prisma = new FakePrismaService();
  const service = new VideosService(
    prisma as never,
    {} as never,
    new FakeConfigService() as never,
    new FakeVideoMetadataService() as never,
    {} as never,
  );

  return { prisma, service };
}

afterEach(async () => {
  await Promise.all(
    [...scratchDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  scratchDirectories.clear();
});

describe("database video SHA-256 persistence", () => {
  it("computes deterministic lowercase SHA-256 without mutating input", () => {
    const bytes = Buffer.from("checksum-source");
    const before = Buffer.from(bytes);
    const sameBytes = Buffer.from("checksum-source");
    const differentSameLengthBytes = Buffer.from("checksum-target");

    const checksum = computeSha256Hex(bytes);
    assert.equal(checksum, computeSha256Hex(sameBytes));
    assert.notEqual(checksum, computeSha256Hex(differentSameLengthBytes));
    assert.match(checksum, /^[a-f0-9]{64}$/);
    assert.equal(
      computeSha256Hex(Buffer.alloc(0)),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    assert.deepEqual(bytes, before);
  });

  it("persists the exact new DB_BLOB bytes and checksum atomically", async () => {
    const { prisma, service } = createVideosService();
    const bytes = Buffer.from("new-db-video-bytes");
    const file = await createDatabaseUploadFile(bytes);

    const response = await service.uploadDatabaseVideo(
      { title: "Database video", durationSeconds: 12 },
      file,
      undefined,
      "admin-1",
    );

    assert.ok(prisma.uploadWrite);
    assert.deepEqual(prisma.uploadWrite.data, bytes);
    assert.equal(prisma.uploadWrite.sizeBytes, BigInt(bytes.length));
    assert.equal(prisma.uploadWrite.mimeType, "video/mp4");
    assert.equal(prisma.uploadWrite.checksumSha256, computeSha256Hex(bytes));
    assert.match(prisma.uploadWrite.checksumSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(prisma.uploadWrite).sort(), [
      "checksumSha256",
      "data",
      "mimeType",
      "sizeBytes",
    ]);
    assert.deepEqual(response.binaryAsset, {
      mimeType: "video/mp4",
      sizeBytes: String(bytes.length),
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        response.binaryAsset,
        "checksumSha256",
      ),
      false,
    );
  });

  it("atomically changes checksum when equal-size DB_BLOB bytes are replaced", async () => {
    const { prisma, service } = createVideosService();
    const originalBytes = Buffer.from("same-size-original");
    const replacementBytes = Buffer.from("same-size-replaced");
    assert.equal(originalBytes.length, replacementBytes.length);

    await service.uploadDatabaseVideo(
      { title: "Replaceable database video", durationSeconds: 12 },
      await createDatabaseUploadFile(originalBytes),
      undefined,
      "admin-1",
    );
    const originalChecksum = prisma.uploadWrite?.checksumSha256;

    const response = await service.replaceDatabaseVideoBinary(
      "video-db-1",
      { durationSeconds: 12 },
      await createDatabaseUploadFile(replacementBytes),
      undefined,
      "admin-1",
    );

    assert.ok(prisma.replacementCreateWrite);
    assert.ok(prisma.replacementUpdateWrite);
    for (const write of [
      prisma.replacementCreateWrite,
      prisma.replacementUpdateWrite,
    ]) {
      assert.deepEqual(write.data, replacementBytes);
      assert.equal(write.sizeBytes, BigInt(replacementBytes.length));
      assert.equal(write.mimeType, "video/mp4");
      assert.equal(write.checksumSha256, computeSha256Hex(replacementBytes));
      assert.deepEqual(Object.keys(write).sort(), [
        "checksumSha256",
        "data",
        "mimeType",
        "sizeBytes",
      ]);
    }
    assert.notEqual(originalChecksum, prisma.binary?.checksumSha256);
    assert.equal(
      prisma.binary?.checksumSha256,
      computeSha256Hex(replacementBytes),
    );
    assert.deepEqual(response.binaryAsset, {
      mimeType: "video/mp4",
      sizeBytes: String(replacementBytes.length),
    });
  });

  it("keeps legacy null checksums compatible with existing reads and responses", async () => {
    const schema = await readFile(
      join(process.cwd(), "prisma/schema.prisma"),
      "utf8",
    );
    const migration = await readFile(
      join(
        process.cwd(),
        "prisma/migrations/20260719090000_add_video_binary_asset_checksum/migration.sql",
      ),
      "utf8",
    );
    const uploadDtoSource = await readFile(
      join(process.cwd(), "src/videos/dto/upload-database-video.dto.ts"),
      "utf8",
    );
    const replacementDtoSource = await readFile(
      join(
        process.cwd(),
        "src/videos/dto/replace-database-video-binary.dto.ts",
      ),
      "utf8",
    );
    const responseTypeSource = await readFile(
      join(process.cwd(), "src/videos/types/video-response.type.ts"),
      "utf8",
    );
    const publicResponseTypeSource = await readFile(
      join(process.cwd(), "src/public/types/public-watch-response.type.ts"),
      "utf8",
    );
    assert.match(schema, /checksumSha256\s+String\?\s+@db\.Char\(64\)/);
    assert.match(migration, /ADD COLUMN `checksumSha256` CHAR\(64\) NULL/);
    assert.doesNotMatch(migration, /UPDATE|INSERT|DELETE|DROP|RENAME/i);
    assert.doesNotMatch(uploadDtoSource, /checksumSha256/);
    assert.doesNotMatch(replacementDtoSource, /checksumSha256/);
    const databaseResponseClass = responseTypeSource.match(
      /export class VideoBinaryAssetResponse[\s\S]*?(?=export class VideoLocalFileAssetResponse)/,
    )?.[0];
    assert.ok(databaseResponseClass);
    assert.doesNotMatch(databaseResponseClass, /checksumSha256/);
    assert.doesNotMatch(publicResponseTypeSource, /checksumSha256/);

    const { prisma, service } = createVideosService();
    const bytes = Buffer.from("legacy-db-video");
    prisma.video = {
      id: "legacy-video",
      title: "Legacy database video",
      slug: "legacy-database-video",
      description: null,
      provider: VideoProvider.MANUAL,
      sourceType: VideoSourceType.DB_BLOB,
      providerAssetId: null,
      playbackId: null,
      playbackUrl: null,
      embedProvider: null,
      embedUrl: null,
      embedCloudName: null,
      embedPublicId: null,
      embedAllow: null,
      thumbnailUrl: null,
      durationSeconds: null,
      viewCount: BigInt(0),
      publishedAt: null,
      status: VideoStatus.READY,
      filterKey: null,
      metadataJson: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      binaryAsset: { mimeType: "video/mp4", sizeBytes: BigInt(bytes.length) },
      localFileAsset: null,
      localThumbnailAsset: null,
    };
    prisma.binary = {
      mimeType: "video/mp4",
      sizeBytes: BigInt(bytes.length),
      data: bytes,
      checksumSha256: null,
    };

    const binary = await service.getDatabaseVideoBinary("legacy-video");
    assert.deepEqual(binary.data, bytes);
    assert.equal(binary.mimeType, "video/mp4");
    assert.equal(binary.sizeBytes, BigInt(bytes.length));
    assert.equal(
      Object.prototype.hasOwnProperty.call(binary, "checksumSha256"),
      false,
    );
  });
});

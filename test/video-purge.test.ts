import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BadRequestException } from "@nestjs/common";
import type { ApiEnvironmentConfig } from "../src/config/env.config";
import {
  AssignmentStatus,
  AuditStatus,
  ShareLinkStatus,
  VideoProvider,
  VideoSourceType,
  VideoStatus,
} from "../src/generated/prisma/client";
import { LocalVideoStorageService } from "../src/videos/storage/local-video-storage.service";
import { VideosService } from "../src/videos/videos.service";

type FakeVideoRecord = {
  id: string;
  provider: VideoProvider;
  sourceType: VideoSourceType;
  providerAssetId: string | null;
  thumbnailUrl: string | null;
  metadataJson: unknown;
  status: VideoStatus;
  localFileAsset: {
    storageKey: string;
    sizeBytes: bigint;
  } | null;
  localThumbnailAsset: {
    storageKey: string;
    sizeBytes: bigint;
  } | null;
};

type AuditRecord = {
  action: string;
  entityId: string;
  metadataJson: unknown;
};

type FakeWebsiteVideoRecord = {
  videoId: string;
  status: AssignmentStatus;
};

type FakeShareLinkRecord = {
  id: string;
  status: ShareLinkStatus;
};

type FakeShareLinkVideoRecord = {
  shareLinkId: string;
  videoId: string;
};

class FakePrismaService {
  readonly videos = new Map<string, FakeVideoRecord>();
  readonly audits: AuditRecord[] = [];
  readonly websiteVideos: FakeWebsiteVideoRecord[] = [];
  readonly shareLinks = new Map<string, FakeShareLinkRecord>();
  readonly shareLinkVideos: FakeShareLinkVideoRecord[] = [];
  websiteAssignmentCount = 0;
  shareLinkVideoCount = 0;
  deletedVideoIds: string[] = [];

  videoAsset = {
    findUnique: async (args: { where: { id: string } }) => {
      return this.videos.get(args.where.id) ?? null;
    },
    update: async (args: {
      where: { id: string };
      data: Partial<FakeVideoRecord>;
    }) => {
      const video = this.videos.get(args.where.id);
      assert.ok(video);

      const updated = {
        ...video,
        ...args.data,
      };
      this.videos.set(video.id, updated);

      return updated;
    },
    delete: async (args: { where: { id: string } }) => {
      const video = this.videos.get(args.where.id);
      assert.ok(video);

      this.videos.delete(video.id);
      this.deletedVideoIds.push(video.id);

      return video;
    },
  };

  websiteVideo = {
    count: async (args?: {
      where?: { videoId?: string; status?: AssignmentStatus };
    }): Promise<number> => {
      if (this.websiteVideos.length === 0) {
        return this.websiteAssignmentCount;
      }

      return this.websiteVideos.filter((assignment) => {
        if (
          args?.where?.videoId !== undefined &&
          assignment.videoId !== args.where.videoId
        ) {
          return false;
        }

        if (
          args?.where?.status !== undefined &&
          assignment.status !== args.where.status
        ) {
          return false;
        }

        return true;
      }).length;
    },
  };

  shareLinkVideo = {
    count: async (args?: { where?: { videoId?: string } }): Promise<number> => {
      if (this.shareLinkVideos.length === 0) {
        return this.shareLinkVideoCount;
      }

      return this.shareLinkVideos.filter((relation) => {
        return (
          args?.where?.videoId === undefined ||
          relation.videoId === args.where.videoId
        );
      }).length;
    },
    deleteMany: async (args: {
      where: { videoId: string };
    }): Promise<{ count: number }> => {
      const beforeCount = this.shareLinkVideos.length;
      const remaining = this.shareLinkVideos.filter(
        (relation) => relation.videoId !== args.where.videoId,
      );
      this.shareLinkVideos.length = 0;
      this.shareLinkVideos.push(...remaining);

      return { count: beforeCount - remaining.length };
    },
  };

  shareLink = {
    updateMany: async (args: {
      where: {
        status: ShareLinkStatus;
        shareLinkVideos: { some: { videoId: string } };
      };
      data: { status: ShareLinkStatus };
    }): Promise<{ count: number }> => {
      const relatedShareLinkIds = new Set(
        this.shareLinkVideos
          .filter(
            (relation) =>
              relation.videoId === args.where.shareLinkVideos.some.videoId,
          )
          .map((relation) => relation.shareLinkId),
      );
      let count = 0;

      for (const shareLinkId of relatedShareLinkIds) {
        const shareLink = this.shareLinks.get(shareLinkId);
        if (shareLink?.status === args.where.status) {
          shareLink.status = args.data.status;
          count += 1;
        }
      }

      return { count };
    },
  };

  adminAuditLog = {
    create: async (args: {
      data: {
        action: string;
        entityId: string;
        status: AuditStatus;
        metadataJson: unknown;
      };
    }): Promise<void> => {
      assert.equal(args.data.status, AuditStatus.SUCCESS);
      this.audits.push({
        action: args.data.action,
        entityId: args.data.entityId,
        metadataJson: args.data.metadataJson,
      });
    },
  };

  async $transaction<T>(callback: (tx: this) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

class FakeLocalStorageService {
  readonly deleteCalls: Array<string | null | undefined> = [];
  readonly deleteResults = new Map<string, boolean>();

  async deleteStorageKeyBestEffort(
    storageKey: string | null | undefined,
  ): Promise<boolean> {
    this.deleteCalls.push(storageKey);

    if (!storageKey) {
      return false;
    }

    return this.deleteResults.get(storageKey) ?? true;
  }
}

class FakeCloudinaryService {
  async deleteVideoAsset(): Promise<boolean> {
    return true;
  }
}

class FakeConfigService {
  get<T = string>(): T | undefined {
    return undefined;
  }
}

class FakeLocalStorageConfigService {
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

function createVideo(
  overrides: Partial<FakeVideoRecord> = {},
): FakeVideoRecord {
  return {
    id: "video-1",
    provider: VideoProvider.MANUAL,
    sourceType: VideoSourceType.LOCAL_FILE,
    providerAssetId: null,
    thumbnailUrl: null,
    metadataJson: null,
    status: VideoStatus.DISABLED,
    localFileAsset: {
      storageKey: "videos/video-1/source/video.mp4",
      sizeBytes: 1000n,
    },
    localThumbnailAsset: {
      storageKey: "videos/video-1/thumbnails/thumb.jpg",
      sizeBytes: 25n,
    },
    ...overrides,
  };
}

function addShareLinkRelation(
  prisma: FakePrismaService,
  params: {
    shareLinkId: string;
    videoId: string;
    status?: ShareLinkStatus;
  },
): void {
  prisma.shareLinks.set(params.shareLinkId, {
    id: params.shareLinkId,
    status: params.status ?? ShareLinkStatus.ACTIVE,
  });
  prisma.shareLinkVideos.push({
    shareLinkId: params.shareLinkId,
    videoId: params.videoId,
  });
}

function createVideosService(params?: {
  prisma?: FakePrismaService;
  localStorage?: FakeLocalStorageService;
}): {
  prisma: FakePrismaService;
  localStorage: FakeLocalStorageService;
  service: VideosService;
} {
  const prisma = params?.prisma ?? new FakePrismaService();
  const localStorage = params?.localStorage ?? new FakeLocalStorageService();
  const service = new VideosService(
    prisma as never,
    new FakeCloudinaryService() as never,
    new FakeConfigService() as never,
    {} as never,
    localStorage as never,
  );

  return { prisma, localStorage, service };
}

describe("VideosService purge reclaim behavior", () => {
  it("rejects a purge confirmation mismatch", async () => {
    const { service } = createVideosService();

    await assert.rejects(
      service.purgeVideo(
        "video-1",
        { confirmVideoId: "wrong-video" },
        "admin-1",
      ),
      BadRequestException,
    );
  });

  it("rejects purge while assigned to a website", async () => {
    const { prisma, service } = createVideosService();
    prisma.videos.set("video-1", createVideo());
    prisma.websiteVideos.push({
      videoId: "video-1",
      status: AssignmentStatus.ACTIVE,
    });

    await assert.rejects(
      service.purgeVideo("video-1", { confirmVideoId: "video-1" }, "admin-1"),
      BadRequestException,
    );
    assert.deepEqual(prisma.deletedVideoIds, []);
  });

  it("rejects purge unless the video is already disabled", async () => {
    const { prisma, service } = createVideosService();
    prisma.videos.set("video-1", createVideo({ status: VideoStatus.READY }));

    await assert.rejects(
      service.purgeVideo("video-1", { confirmVideoId: "video-1" }, "admin-1"),
      BadRequestException,
    );
    assert.deepEqual(prisma.deletedVideoIds, []);
  });

  it("purges a disabled video with old share-link rows by disabling and detaching them", async () => {
    const { prisma, service } = createVideosService();
    prisma.videos.set("video-1", createVideo());
    prisma.videos.set("video-2", createVideo({ id: "video-2" }));
    addShareLinkRelation(prisma, {
      shareLinkId: "share-1",
      videoId: "video-1",
      status: ShareLinkStatus.ACTIVE,
    });
    addShareLinkRelation(prisma, {
      shareLinkId: "share-2",
      videoId: "video-2",
      status: ShareLinkStatus.ACTIVE,
    });

    const result = await service.purgeVideo(
      "video-1",
      { confirmVideoId: "video-1" },
      "admin-1",
    );

    assert.equal(result.status, "PURGED");
    assert.equal(
      prisma.shareLinks.get("share-1")?.status,
      ShareLinkStatus.DISABLED,
    );
    assert.equal(
      prisma.shareLinks.get("share-2")?.status,
      ShareLinkStatus.ACTIVE,
    );
    assert.deepEqual(prisma.shareLinkVideos, [
      { shareLinkId: "share-2", videoId: "video-2" },
    ]);
    assert.deepEqual(prisma.deletedVideoIds, ["video-1"]);
    assert.equal(result.safety.hadShareLinks, true);
    assert.equal(result.safety.disabledShareLinkCount, 1);
    assert.equal(result.safety.detachedShareLinkVideoCount, 1);
  });

  it("purges LOCAL_FILE metadata and reports video/thumbnail reclaim", async () => {
    const { prisma, localStorage, service } = createVideosService();
    prisma.videos.set("video-1", createVideo());

    const result = await service.purgeVideo(
      "video-1",
      { confirmVideoId: "video-1" },
      "admin-1",
    );

    assert.equal(result.status, "PURGED");
    assert.equal(result.videoId, "video-1");
    assert.equal(result.sourceType, VideoSourceType.LOCAL_FILE);
    assert.deepEqual(result.safety, {
      hadWebsiteAssignments: false,
      hadShareLinks: false,
      activeWebsiteAssignmentCount: 0,
      disabledShareLinkCount: 0,
      detachedShareLinkVideoCount: 0,
    });
    assert.deepEqual(result.storage, {
      localVideoDeleteAttempted: true,
      localVideoDeleted: true,
      localThumbnailDeleteAttempted: true,
      localThumbnailDeleted: true,
      bytesReclaimed: "1025",
      orphanCleanupRequired: false,
    });
    assert.deepEqual(result.remote, {
      remoteAssetDeleteAttempted: false,
      remoteAssetDeleted: false,
    });
    assert.deepEqual(localStorage.deleteCalls, [
      "videos/video-1/source/video.mp4",
      "videos/video-1/thumbnails/thumb.jpg",
    ]);
    assert.equal(prisma.audits.length, 1);
    assert.equal(prisma.audits[0]?.action, "VIDEO_PURGE");
    assert.deepEqual(prisma.audits[0]?.metadataJson, {
      provider: VideoProvider.MANUAL,
      sourceType: VideoSourceType.LOCAL_FILE,
      hadWebsiteAssignments: false,
      hadShareLinks: false,
      activeWebsiteAssignmentCount: 0,
      disabledShareLinkCount: 0,
      detachedShareLinkVideoCount: 0,
      deleteRemoteAsset: false,
      remoteAssetDeleteAttempted: false,
      remoteAssetDeleted: false,
      ownedCloudinaryThumbnailDeleted: false,
      localVideoDeleteAttempted: true,
      localVideoDeleted: true,
      localThumbnailDeleteAttempted: true,
      localThumbnailDeleted: true,
      bytesReclaimed: "1025",
      orphanCleanupRequired: false,
    });
  });

  it("reports orphan cleanup required when a referenced local file is already missing", async () => {
    const localStorage = new FakeLocalStorageService();
    localStorage.deleteResults.set("videos/video-1/source/video.mp4", false);
    localStorage.deleteResults.set("videos/video-1/thumbnails/thumb.jpg", true);
    const { prisma, service } = createVideosService({ localStorage });
    prisma.videos.set("video-1", createVideo());

    const result = await service.purgeVideo(
      "video-1",
      { confirmVideoId: "video-1" },
      "admin-1",
    );

    assert.deepEqual(result.storage, {
      localVideoDeleteAttempted: true,
      localVideoDeleted: false,
      localThumbnailDeleteAttempted: true,
      localThumbnailDeleted: true,
      bytesReclaimed: "25",
      orphanCleanupRequired: true,
    });
  });

  it("soft disable does not delete local files", async () => {
    const { prisma, localStorage, service } = createVideosService();
    prisma.videos.set("video-1", createVideo({ status: VideoStatus.READY }));

    const result = await service.disableVideo("video-1", "admin-1");

    assert.equal(result.message, "Video disabled successfully.");
    assert.equal(prisma.videos.get("video-1")?.status, VideoStatus.DISABLED);
    assert.deepEqual(localStorage.deleteCalls, []);
  });

  it("soft disable disables related active share links but not unrelated links", async () => {
    const { prisma, service } = createVideosService();
    prisma.videos.set("video-1", createVideo({ status: VideoStatus.READY }));
    prisma.videos.set(
      "video-2",
      createVideo({ id: "video-2", status: VideoStatus.READY }),
    );
    addShareLinkRelation(prisma, {
      shareLinkId: "share-1",
      videoId: "video-1",
      status: ShareLinkStatus.ACTIVE,
    });
    addShareLinkRelation(prisma, {
      shareLinkId: "share-2",
      videoId: "video-2",
      status: ShareLinkStatus.ACTIVE,
    });

    await service.disableVideo("video-1", "admin-1");

    assert.equal(prisma.videos.get("video-1")?.status, VideoStatus.DISABLED);
    assert.equal(
      prisma.shareLinks.get("share-1")?.status,
      ShareLinkStatus.DISABLED,
    );
    assert.equal(
      prisma.shareLinks.get("share-2")?.status,
      ShareLinkStatus.ACTIVE,
    );
  });

  it("soft disable remediates old active share links for already disabled videos", async () => {
    const { prisma, service } = createVideosService();
    prisma.videos.set("video-1", createVideo({ status: VideoStatus.DISABLED }));
    addShareLinkRelation(prisma, {
      shareLinkId: "share-1",
      videoId: "video-1",
      status: ShareLinkStatus.ACTIVE,
    });

    await service.disableVideo("video-1", "admin-1");

    assert.equal(
      prisma.shareLinks.get("share-1")?.status,
      ShareLinkStatus.DISABLED,
    );
  });
});

describe("LocalVideoStorageService delete safety", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "purge-storage-root-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("does not delete outside the storage root for traversal keys", async () => {
    const outsidePath = join(tmpdir(), `outside-${Date.now()}.txt`);
    await writeFile(outsidePath, "keep");
    const service = new LocalVideoStorageService(
      new FakeLocalStorageConfigService(root) as never,
    );

    const deleted = await service.deleteStorageKeyBestEffort("../outside.txt");

    assert.equal(deleted, false);
    assert.equal(await readFile(outsidePath, "utf8"), "keep");
    await rm(outsidePath, { force: true });
  });
});

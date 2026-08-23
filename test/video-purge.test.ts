import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BadRequestException, ConflictException } from "@nestjs/common";
import type { ApiEnvironmentConfig } from "../src/config/env.config";
import {
  AssignmentStatus,
  AuditStatus,
  ShareLinkStatus,
  VideoProvider,
  VideoSourceType,
  VideoStatus,
} from "../src/generated/prisma/client";
import { BunnyStreamService } from "../src/bunny/bunny-stream.service";
import { LocalVideoStorageService } from "../src/videos/storage/local-video-storage.service";
import { VideosService } from "../src/videos/videos.service";

type FakeVideoRecord = {
  id: string;
  provider: VideoProvider;
  sourceType: VideoSourceType;
  providerAssetId: string | null;
  playbackId: string | null;
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
  status: AuditStatus;
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

  /** Canonical mappings block purge; tests opt in via this counter. */
  canonicalLinkCount = 0;

  canonicalVideoShareLink = {
    count: async (): Promise<number> => this.canonicalLinkCount,
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
      this.audits.push({
        action: args.data.action,
        entityId: args.data.entityId,
        status: args.data.status,
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
    playbackId: null,
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
  /**
   * Optional Bunny collaborator. Omitted by every legacy purge test, which is
   * itself the proof that no legacy purge path needs one.
   */
  bunnyStream?: unknown;
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
    undefined,
    params?.bunnyStream as never,
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

  it("rejects purge while the video anchors a canonical share link", async () => {
    const { prisma, service } = createVideosService();
    prisma.videos.set("video-1", createVideo());
    prisma.canonicalLinkCount = 1;

    await assert.rejects(
      service.purgeVideo("video-1", { confirmVideoId: "video-1" }, "admin-1"),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException);
        const body = error.getResponse() as { code?: string };
        assert.equal(body.code, "VIDEO_HAS_CANONICAL_SHARE_LINK");
        return true;
      },
    );
    assert.deepEqual(prisma.deletedVideoIds, []);
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
    assert.equal(prisma.audits.length, 2);
    assert.equal(prisma.audits[0]?.action, "VIDEO_PURGE_COMMIT");
    assert.equal(prisma.audits[0]?.status, AuditStatus.SUCCESS);
    assert.equal(prisma.audits[1]?.action, "VIDEO_PURGE_STORAGE");
    assert.equal(prisma.audits[1]?.status, AuditStatus.SUCCESS);
    assert.deepEqual(prisma.audits[1]?.metadataJson, {
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
    assert.equal(prisma.audits[0]?.action, "VIDEO_PURGE_COMMIT");
    assert.equal(prisma.audits[1]?.action, "VIDEO_PURGE_STORAGE");
    assert.equal(prisma.audits[1]?.status, AuditStatus.FAIL);
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

/* ------------------------------------------------------------------ *
 * Bunny Stream purge
 *
 * PROVIDER ISOLATION. The Bunny delete branch must fire for Bunny-backed
 * assets and for nothing else, and it must never report a success Bunny did
 * not give.
 * ------------------------------------------------------------------ */

const BUNNY_GUID = "11111111-2222-3333-4444-555555555555";

function createBunnyStreamStub(
  options: { result?: boolean; throws?: boolean } = {},
) {
  const stub = {
    deletedVideoIds: [] as string[],
    async deleteVideo(videoId: string): Promise<boolean> {
      stub.deletedVideoIds.push(videoId);

      if (options.throws === true) {
        throw new Error("bunny unreachable");
      }

      return options.result ?? true;
    },
  };

  return stub;
}

function createBunnyVideo(
  overrides: Partial<FakeVideoRecord> = {},
): FakeVideoRecord {
  return createVideo({
    id: "video-bunny",
    provider: VideoProvider.BUNNY,
    sourceType: VideoSourceType.EMBED,
    providerAssetId: BUNNY_GUID,
    playbackId: BUNNY_GUID,
    metadataJson: {
      bunnyStream: { videoId: BUNNY_GUID, libraryId: "987654" },
    },
    localFileAsset: null,
    localThumbnailAsset: null,
    ...overrides,
  });
}

describe("VideosService purge — Bunny Stream", () => {
  it("deletes the Bunny asset when remote deletion is requested", async () => {
    const bunnyStream = createBunnyStreamStub();
    const { prisma, service } = createVideosService({ bunnyStream });
    prisma.videos.set("video-bunny", createBunnyVideo());

    const response = await service.purgeVideo(
      "video-bunny",
      { confirmVideoId: "video-bunny", deleteRemoteAsset: true },
      "admin-1",
    );

    assert.deepEqual(bunnyStream.deletedVideoIds, [BUNNY_GUID]);
    assert.equal(response.remote.remoteAssetDeleteAttempted, true);
    assert.equal(response.remote.remoteAssetDeleted, true);
    assert.deepEqual(prisma.deletedVideoIds, ["video-bunny"]);
  });

  it("leaves the Bunny asset alone when remote deletion is not requested", async () => {
    const bunnyStream = createBunnyStreamStub();
    const { prisma, service } = createVideosService({ bunnyStream });
    prisma.videos.set("video-bunny", createBunnyVideo());

    const response = await service.purgeVideo(
      "video-bunny",
      { confirmVideoId: "video-bunny" },
      "admin-1",
    );

    assert.deepEqual(bunnyStream.deletedVideoIds, []);
    assert.equal(response.remote.remoteAssetDeleteAttempted, false);
    assert.equal(response.remote.remoteAssetDeleted, false);
  });

  it("reports the failure instead of claiming Bunny deleted the asset", async () => {
    const bunnyStream = createBunnyStreamStub({ result: false });
    const { prisma, service } = createVideosService({ bunnyStream });
    prisma.videos.set("video-bunny", createBunnyVideo());

    const response = await service.purgeVideo(
      "video-bunny",
      { confirmVideoId: "video-bunny", deleteRemoteAsset: true },
      "admin-1",
    );

    assert.equal(response.remote.remoteAssetDeleteAttempted, true);
    assert.equal(response.remote.remoteAssetDeleted, false);

    const storageAudit = prisma.audits.find(
      (audit) => audit.action === "VIDEO_PURGE_STORAGE",
    );
    assert.equal(storageAudit?.status, AuditStatus.FAIL);
  });

  it("reports the failure when Bunny throws rather than answering", async () => {
    const bunnyStream = createBunnyStreamStub({ throws: true });
    const { prisma, service } = createVideosService({ bunnyStream });
    prisma.videos.set("video-bunny", createBunnyVideo());

    const response = await service.purgeVideo(
      "video-bunny",
      { confirmVideoId: "video-bunny", deleteRemoteAsset: true },
      "admin-1",
    );

    assert.equal(response.remote.remoteAssetDeleted, false);
    assert.equal(
      prisma.audits.find((audit) => audit.action === "VIDEO_PURGE_STORAGE")
        ?.status,
      AuditStatus.FAIL,
    );
  });

  it("never calls Bunny for a non-Bunny asset, whatever the provider", async () => {
    for (const video of [
      createVideo({ id: "video-local" }),
      createVideo({
        id: "video-cloudinary",
        provider: VideoProvider.CLOUDINARY,
        sourceType: VideoSourceType.UPLOAD,
        providerAssetId: "cloud/asset",
        localFileAsset: null,
        localThumbnailAsset: null,
      }),
      createVideo({
        id: "video-embed",
        sourceType: VideoSourceType.EMBED,
        localFileAsset: null,
        localThumbnailAsset: null,
      }),
      // Labelled BUNNY but carrying no marker: a legacy DIRECT_URL record.
      createVideo({
        id: "video-legacy-bunny-label",
        provider: VideoProvider.BUNNY,
        sourceType: VideoSourceType.DIRECT_URL,
        localFileAsset: null,
        localThumbnailAsset: null,
      }),
    ]) {
      const bunnyStream = createBunnyStreamStub();
      const { prisma, service } = createVideosService({ bunnyStream });
      prisma.videos.set(video.id, video);

      await service.purgeVideo(
        video.id,
        { confirmVideoId: video.id, deleteRemoteAsset: true },
        "admin-1",
      );

      assert.deepEqual(
        bunnyStream.deletedVideoIds,
        [],
        `${video.id} must not reach the Bunny delete branch`,
      );
    }
  });

  it("still respects every existing purge safeguard for a Bunny asset", async () => {
    const bunnyStream = createBunnyStreamStub();
    const { prisma, service } = createVideosService({ bunnyStream });
    prisma.videos.set(
      "video-bunny",
      createBunnyVideo({ status: VideoStatus.READY }),
    );

    await assert.rejects(
      service.purgeVideo(
        "video-bunny",
        { confirmVideoId: "video-bunny", deleteRemoteAsset: true },
        "admin-1",
      ),
      BadRequestException,
    );
    assert.deepEqual(bunnyStream.deletedVideoIds, []);
    assert.deepEqual(prisma.deletedVideoIds, []);
  });

  it("refuses to purge a Bunny asset that is still assigned to an active website", async () => {
    const bunnyStream = createBunnyStreamStub();
    const { prisma, service } = createVideosService({ bunnyStream });
    prisma.videos.set("video-bunny", createBunnyVideo());
    prisma.websiteVideos.push({
      videoId: "video-bunny",
      status: AssignmentStatus.ACTIVE,
    });

    await assert.rejects(
      service.purgeVideo(
        "video-bunny",
        { confirmVideoId: "video-bunny", deleteRemoteAsset: true },
        "admin-1",
      ),
      BadRequestException,
    );
    assert.deepEqual(bunnyStream.deletedVideoIds, []);
  });
});

/* ------------------------------------------------------------------ *
 * BLOCKER 3 — purge must not reach Bunny while the feature is disabled
 *
 * These drive the REAL `BunnyStreamService` (not a stub) with
 * `BUNNY_STREAM_ENABLED=false` and a `globalThis.fetch` spy, so "no network
 * request" is proved rather than assumed.
 * ------------------------------------------------------------------ */

class DisabledBunnyConfigService {
  constructor(private readonly values: Record<string, string | undefined>) {}

  get<T = string>(key: string): T | undefined {
    return this.values[key] as T | undefined;
  }
}

describe("VideosService purge — Bunny disabled", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: string[] = [];

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = (async (input: string | URL) => {
      fetchCalls.push(String(input));
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("makes no Bunny request and does not claim the remote asset was deleted", async () => {
    // Credentials are deliberately present: the gate must be the ENABLED flag,
    // not the absence of configuration.
    const bunnyStream = new BunnyStreamService(
      new DisabledBunnyConfigService({
        BUNNY_STREAM_ENABLED: "false",
        BUNNY_STREAM_LIBRARY_ID: "987654",
        BUNNY_STREAM_API_KEY: "purge-test-api-key",
        BUNNY_STREAM_TOKEN_SECURITY_KEY: "purge-test-token-security-key",
      }) as never,
    );
    const { prisma, service } = createVideosService({ bunnyStream });
    prisma.videos.set("video-bunny", createBunnyVideo());

    const response = await service.purgeVideo(
      "video-bunny",
      { confirmVideoId: "video-bunny", deleteRemoteAsset: true },
      "admin-1",
    );

    assert.deepEqual(fetchCalls, [], "no Bunny HTTP request may be issued");
    assert.notEqual(
      response.remote.remoteAssetDeleted,
      true,
      "a disabled deployment must never claim remote deletion succeeded",
    );
    assert.equal(response.remote.remoteAssetDeleteAttempted, true);
    assert.equal(
      prisma.audits.find((audit) => audit.action === "VIDEO_PURGE_STORAGE")
        ?.status,
      AuditStatus.FAIL,
      "the existing purge convention must record the cleanup failure",
    );
    // The database row is still purged; only the remote cleanup failed.
    assert.deepEqual(prisma.deletedVideoIds, ["video-bunny"]);
  });

  it("still enforces every purge safeguard while Bunny is disabled", async () => {
    const bunnyStream = new BunnyStreamService(
      new DisabledBunnyConfigService({
        BUNNY_STREAM_ENABLED: "false",
      }) as never,
    );
    const { prisma, service } = createVideosService({ bunnyStream });
    prisma.videos.set(
      "video-bunny",
      createBunnyVideo({ status: VideoStatus.READY }),
    );

    await assert.rejects(
      service.purgeVideo(
        "video-bunny",
        { confirmVideoId: "video-bunny", deleteRemoteAsset: true },
        "admin-1",
      ),
      BadRequestException,
    );
    assert.deepEqual(fetchCalls, []);
    assert.deepEqual(prisma.deletedVideoIds, []);
  });

  it("leaves legacy provider purge behaviour untouched while Bunny is disabled", async () => {
    const bunnyStream = new BunnyStreamService(
      new DisabledBunnyConfigService({
        BUNNY_STREAM_ENABLED: "false",
      }) as never,
    );
    const { prisma, service } = createVideosService({ bunnyStream });
    prisma.videos.set(
      "video-cloudinary",
      createVideo({
        id: "video-cloudinary",
        provider: VideoProvider.CLOUDINARY,
        sourceType: VideoSourceType.UPLOAD,
        providerAssetId: "cloud/asset",
        localFileAsset: null,
        localThumbnailAsset: null,
      }),
    );

    const response = await service.purgeVideo(
      "video-cloudinary",
      { confirmVideoId: "video-cloudinary", deleteRemoteAsset: true },
      "admin-1",
    );

    // FakeCloudinaryService confirms the delete, unaffected by the Bunny gate.
    assert.equal(response.remote.remoteAssetDeleted, true);
    assert.deepEqual(fetchCalls, []);
  });
});

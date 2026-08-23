import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from "@nestjs/common";
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
import {
  BUNNY_STREAM_UNAVAILABLE_FOR_PURGE,
  BUNNY_STREAM_UNAVAILABLE_FOR_PURGE_MESSAGE,
  VideosService,
} from "../src/videos/videos.service";

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
    deleteMany: async (args: {
      where: { videoId: string };
    }): Promise<{ count: number }> => {
      const before = this.websiteVideos.length;
      const remaining = this.websiteVideos.filter(
        (assignment) => assignment.videoId !== args.where.videoId,
      );
      this.websiteVideos.length = 0;
      this.websiteVideos.push(...remaining);
      // Mirrors the real cascade/deleteMany: rows of EVERY status go, and the
      // synthetic counter used by fixtures that never populate the array is
      // cleared too so a later count() reflects the deletion.
      const deleted = before - remaining.length;
      if (deleted === 0 && this.websiteAssignmentCount > 0) {
        const synthetic = this.websiteAssignmentCount;
        this.websiteAssignmentCount = 0;
        return { count: synthetic };
      }

      return { count: deleted };
    },

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

  it("PURGES a DISABLED video that is still assigned to an ACTIVE website", async () => {
    // CHANGED DELIBERATELY. This used to throw "Video cannot be permanently
    // deleted while it is assigned to active websites.", which forced an
    // operator to visit every website and unassign by hand before removing a
    // video they had ALREADY disabled. The DISABLED requirement below is the
    // real safety property; an assignment is relationship state the purge
    // cleans up, exactly like ShareLinkVideo.
    const { prisma, service } = createVideosService();
    prisma.videos.set("video-1", createVideo());
    prisma.websiteVideos.push({
      videoId: "video-1",
      status: AssignmentStatus.ACTIVE,
    });

    const response = await service.purgeVideo(
      "video-1",
      { confirmVideoId: "video-1" },
      "admin-1",
    );

    assert.deepEqual(prisma.deletedVideoIds, ["video-1"]);
    // Reported truthfully rather than zeroed out now that it no longer blocks.
    assert.equal(response.safety.hadWebsiteAssignments, true);
    assert.equal(response.safety.activeWebsiteAssignmentCount, 1);
    assert.equal(response.safety.detachedWebsiteAssignmentCount, 1);
    assert.deepEqual(
      prisma.websiteVideos,
      [],
      "the assignment row must be cleaned up by the purge transaction",
    );
  });

  it("cleans up EVERY assignment, whatever its status, for a purged video", async () => {
    const { prisma, service } = createVideosService();
    prisma.videos.set("video-1", createVideo());
    prisma.websiteVideos.push(
      { videoId: "video-1", status: AssignmentStatus.ACTIVE },
      { videoId: "video-1", status: AssignmentStatus.ACTIVE },
      { videoId: "video-1", status: AssignmentStatus.DISABLED },
      // A different video's assignment must survive untouched.
      { videoId: "video-other", status: AssignmentStatus.ACTIVE },
    );

    const response = await service.purgeVideo(
      "video-1",
      { confirmVideoId: "video-1" },
      "admin-1",
    );

    assert.equal(response.safety.activeWebsiteAssignmentCount, 2);
    assert.equal(response.safety.detachedWebsiteAssignmentCount, 3);
    assert.deepEqual(
      prisma.websiteVideos.map((assignment) => assignment.videoId),
      ["video-other"],
      "only the purged video's assignments may be removed",
    );
  });

  it("STILL rejects a READY video that is assigned, because it is not DISABLED", async () => {
    // The relaxation is scoped to the assignment blocker only. The DISABLED
    // precondition is untouched and is what still protects a live video.
    const { prisma, service } = createVideosService();
    prisma.videos.set("video-1", createVideo({ status: VideoStatus.READY }));
    prisma.websiteVideos.push({
      videoId: "video-1",
      status: AssignmentStatus.ACTIVE,
    });

    await assert.rejects(
      service.purgeVideo("video-1", { confirmVideoId: "video-1" }, "admin-1"),
      (error: unknown) => {
        assert.ok(error instanceof BadRequestException);
        assert.match(String(error.message), /must be disabled/i);
        return true;
      },
    );
    assert.deepEqual(prisma.deletedVideoIds, []);
    assert.equal(
      prisma.websiteVideos.length,
      1,
      "a rejected purge must not touch the assignment",
    );
  });

  it("STILL rejects a DISABLED video that anchors canonical provenance", async () => {
    // Canonical protection is explicitly NOT weakened by this change.
    const { prisma, service } = createVideosService();
    prisma.videos.set("video-1", createVideo());
    prisma.websiteVideos.push({
      videoId: "video-1",
      status: AssignmentStatus.ACTIVE,
    });
    prisma.canonicalLinkCount = 1;

    await assert.rejects(
      service.purgeVideo("video-1", { confirmVideoId: "video-1" }, "admin-1"),
      ConflictException,
    );
    assert.deepEqual(prisma.deletedVideoIds, []);
    assert.equal(prisma.websiteVideos.length, 1);
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
      detachedWebsiteAssignmentCount: 0,
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
      detachedWebsiteAssignmentCount: 0,
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
  options: {
    result?: boolean;
    throws?: boolean;
    notFound?: boolean;
    /**
     * Models `BUNNY_STREAM_ENABLED`. The real service exposes `isEnabled()` and
     * the purge availability guard calls it before any remote delete, so the
     * stub has to model it or it would not represent production.
     */
    enabled?: boolean;
  } = {},
) {
  const stub = {
    deletedVideoIds: [] as string[],
    isEnabled(): boolean {
      return options.enabled ?? true;
    },
    async deleteVideo(videoId: string): Promise<boolean> {
      stub.deletedVideoIds.push(videoId);

      if (options.throws === true) {
        throw new Error("bunny unreachable");
      }

      // `BunnyStreamService.deleteVideo()` swallows a 404 and resolves true -
      // the remote asset is gone either way. Modelled here so the purge path
      // is exercised exactly as production sees it.
      if (options.notFound === true) {
        return true;
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

  it("treats an EXPLICIT deleteRemoteAsset:false exactly like omitting it", async () => {
    // The admin console now always sends the field rather than omitting it when
    // false, so the explicit form is part of the contract this suite defends.
    // Both spellings must mean "local-only purge, Bunny untouched".
    const bunnyStream = createBunnyStreamStub();
    const { prisma, service } = createVideosService({ bunnyStream });
    prisma.videos.set("video-bunny", createBunnyVideo());

    const response = await service.purgeVideo(
      "video-bunny",
      { confirmVideoId: "video-bunny", deleteRemoteAsset: false },
      "admin-1",
    );

    assert.deepEqual(
      bunnyStream.deletedVideoIds,
      [],
      "an explicit false must issue no Bunny DELETE",
    );
    assert.equal(response.remote.remoteAssetDeleteAttempted, false);
    assert.equal(response.remote.remoteAssetDeleted, false);
    // The local-only purge still completes - that compatibility is preserved.
    assert.deepEqual(prisma.deletedVideoIds, ["video-bunny"]);
  });

  it("performs the remote-first DELETE for an EXPLICIT deleteRemoteAsset:true", async () => {
    // The other half of the contract, and the payload the admin console now
    // sends by default for every Bunny video.
    const bunnyStream = createBunnyStreamStub();
    const { prisma, service } = createVideosService({ bunnyStream });
    prisma.videos.set("video-bunny", createBunnyVideo());

    const response = await service.purgeVideo(
      "video-bunny",
      { confirmVideoId: "video-bunny", deleteRemoteAsset: true },
      "admin-1",
    );

    assert.deepEqual(bunnyStream.deletedVideoIds, [BUNNY_GUID]);
    assert.equal(response.remote.remoteAssetDeleted, true);
    assert.deepEqual(prisma.deletedVideoIds, ["video-bunny"]);
  });

  it("ABORTS the local purge when Bunny does not confirm the delete", async () => {
    // REMOTE FIRST. An unconfirmed remote delete must leave the local row
    // intact: "remote gone + local row here" is reconcilable, "local row gone
    // + remote here" is an invisible billable orphan.
    const bunnyStream = createBunnyStreamStub({ result: false });
    const { prisma, service } = createVideosService({ bunnyStream });
    prisma.videos.set("video-bunny", createBunnyVideo());

    await assert.rejects(
      service.purgeVideo(
        "video-bunny",
        { confirmVideoId: "video-bunny", deleteRemoteAsset: true },
        "admin-1",
      ),
      ServiceUnavailableException,
    );

    assert.deepEqual(
      prisma.deletedVideoIds,
      [],
      "the local row must survive an unconfirmed remote delete",
    );
    assert.ok(
      prisma.videos.has("video-bunny"),
      "the record must still be present and reconcilable",
    );
    assert.equal(
      prisma.audits.find(
        (audit) => audit.action === "VIDEO_BUNNY_REMOTE_DELETE",
      )?.status,
      AuditStatus.FAIL,
      "the aborted remote delete must be audited truthfully",
    );
    assert.equal(
      prisma.audits.some((audit) => audit.action === "VIDEO_PURGE_COMMIT"),
      false,
      "no purge may be recorded as committed",
    );
  });

  it("ABORTS the local purge when Bunny throws rather than answering", async () => {
    const bunnyStream = createBunnyStreamStub({ throws: true });
    const { prisma, service } = createVideosService({ bunnyStream });
    prisma.videos.set("video-bunny", createBunnyVideo());

    await assert.rejects(
      service.purgeVideo(
        "video-bunny",
        { confirmVideoId: "video-bunny", deleteRemoteAsset: true },
        "admin-1",
      ),
      ServiceUnavailableException,
    );

    assert.deepEqual(prisma.deletedVideoIds, []);
    assert.ok(prisma.videos.has("video-bunny"));
    assert.equal(
      prisma.audits.find(
        (audit) => audit.action === "VIDEO_BUNNY_REMOTE_DELETE",
      )?.status,
      AuditStatus.FAIL,
    );
  });

  it("treats a Bunny 404 as already-deleted and completes the local purge", async () => {
    // This is what makes a retry work after a local transaction failure: the
    // second attempt sees 404, counts it as confirmed, and finishes the job.
    const bunnyStream = createBunnyStreamStub({ notFound: true });
    const { prisma, service } = createVideosService({ bunnyStream });
    prisma.videos.set("video-bunny", createBunnyVideo());

    const response = await service.purgeVideo(
      "video-bunny",
      { confirmVideoId: "video-bunny", deleteRemoteAsset: true },
      "admin-1",
    );

    assert.deepEqual(bunnyStream.deletedVideoIds, [BUNNY_GUID]);
    assert.equal(response.remote.remoteAssetDeleted, true);
    assert.deepEqual(prisma.deletedVideoIds, ["video-bunny"]);
  });

  it("deletes the Bunny asset BEFORE the local row, never after", async () => {
    // ORDERING PROOF. The remote delete has to be observable strictly before
    // the local delete, because the whole safety argument rests on it.
    const order: string[] = [];
    const prisma = new FakePrismaService();
    const originalDelete = prisma.videoAsset.delete;
    prisma.videoAsset.delete = async (args: { where: { id: string } }) => {
      order.push("local-delete");
      return originalDelete.call(prisma, args);
    };
    const bunnyStream = {
      deletedVideoIds: [] as string[],
      // Models the real service: the purge availability guard calls this
      // before any remote delete, so an order-of-operations stub needs it too.
      isEnabled(): boolean {
        return true;
      },
      async deleteVideo(videoId: string): Promise<boolean> {
        order.push("remote-delete");
        bunnyStream.deletedVideoIds.push(videoId);
        return true;
      },
    };
    const { service } = createVideosService({ prisma, bunnyStream });
    prisma.videos.set("video-bunny", createBunnyVideo());

    await service.purgeVideo(
      "video-bunny",
      { confirmVideoId: "video-bunny", deleteRemoteAsset: true },
      "admin-1",
    );

    assert.deepEqual(order, ["remote-delete", "local-delete"]);
  });

  it("keeps the local row when the purge transaction fails after a confirmed remote delete", async () => {
    // The honest partial-failure state. Bunny is gone, the row survives, and
    // nothing claims success - the operator retries and the 404 path finishes.
    const prisma = new FakePrismaService();
    prisma.videoAsset.delete = async () => {
      throw new Error("local purge transaction failed");
    };
    const bunnyStream = createBunnyStreamStub();
    const { service } = createVideosService({ prisma, bunnyStream });
    prisma.videos.set("video-bunny", createBunnyVideo());

    await assert.rejects(
      service.purgeVideo(
        "video-bunny",
        { confirmVideoId: "video-bunny", deleteRemoteAsset: true },
        "admin-1",
      ),
    );

    assert.deepEqual(bunnyStream.deletedVideoIds, [BUNNY_GUID]);
    assert.ok(
      prisma.videos.has("video-bunny"),
      "the local record must remain so it can be reconciled and retried",
    );
    assert.equal(
      prisma.audits.some((audit) => audit.action === "VIDEO_PURGE_COMMIT"),
      false,
      "a failed transaction must not record a committed purge",
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

  it("PURGE ISOLATION: a Bunny purge attempts no local file deletion", async () => {
    // A valid Bunny asset owns no NVMe bytes, so the local-storage branch must
    // be structurally unreachable for it - not merely unused by accident.
    const bunnyStream = createBunnyStreamStub();
    const { prisma, localStorage, service } = createVideosService({
      bunnyStream,
    });
    prisma.videos.set("video-bunny", createBunnyVideo());

    const response = await service.purgeVideo(
      "video-bunny",
      { confirmVideoId: "video-bunny", deleteRemoteAsset: true },
      "admin-1",
    );

    assert.deepEqual(bunnyStream.deletedVideoIds, [BUNNY_GUID]);
    assert.equal(response.storage.localVideoDeleteAttempted, false);
    assert.equal(response.storage.localThumbnailDeleteAttempted, false);
    assert.equal(response.storage.bytesReclaimed, "0");
    assert.deepEqual(
      localStorage.deleteCalls.filter(Boolean),
      [],
      "no storage key may be handed to local deletion for a Bunny asset",
    );
  });

  it("PURGE ISOLATION: a LOCAL_FILE purge issues zero Bunny calls", async () => {
    const bunnyStream = createBunnyStreamStub();
    const { prisma, localStorage, service } = createVideosService({
      bunnyStream,
    });
    prisma.videos.set("video-1", createVideo());

    const response = await service.purgeVideo(
      "video-1",
      // Even with remote deletion explicitly requested, a non-Bunny, non-
      // Cloudinary asset must not reach either provider branch.
      { confirmVideoId: "video-1", deleteRemoteAsset: true },
      "admin-1",
    );

    assert.deepEqual(
      bunnyStream.deletedVideoIds,
      [],
      "a LOCAL_FILE purge must never call Bunny",
    );
    assert.equal(response.remote.remoteAssetDeleteAttempted, false);
    assert.equal(response.storage.localVideoDeleteAttempted, true);
    assert.equal(response.storage.localThumbnailDeleteAttempted, true);
    assert.deepEqual(localStorage.deleteCalls.filter(Boolean), [
      "videos/video-1/source/video.mp4",
      "videos/video-1/thumbnails/thumb.jpg",
    ]);
  });

  it("purges a DISABLED, still-assigned Bunny asset REMOTE FIRST", async () => {
    // The assignment no longer blocks, so this must now reach Bunny - and the
    // remote delete must still happen strictly BEFORE the local cleanup.
    const order: string[] = [];
    const prisma = new FakePrismaService();
    const originalDelete = prisma.videoAsset.delete;
    prisma.videoAsset.delete = async (args: { where: { id: string } }) => {
      order.push("local-delete");
      return originalDelete.call(prisma, args);
    };
    const originalDetach = prisma.websiteVideo.deleteMany;
    prisma.websiteVideo.deleteMany = async (args: {
      where: { videoId: string };
    }) => {
      order.push("assignment-cleanup");
      return originalDetach.call(prisma.websiteVideo, args);
    };
    const bunnyStream = {
      deletedVideoIds: [] as string[],
      // Models the real service: the purge availability guard calls this
      // before any remote delete, so an order-of-operations stub needs it too.
      isEnabled(): boolean {
        return true;
      },
      async deleteVideo(videoId: string): Promise<boolean> {
        order.push("remote-delete");
        bunnyStream.deletedVideoIds.push(videoId);
        return true;
      },
    };
    const { service } = createVideosService({ prisma, bunnyStream });
    prisma.videos.set("video-bunny", createBunnyVideo());
    prisma.websiteVideos.push({
      videoId: "video-bunny",
      status: AssignmentStatus.ACTIVE,
    });

    const response = await service.purgeVideo(
      "video-bunny",
      { confirmVideoId: "video-bunny", deleteRemoteAsset: true },
      "admin-1",
    );

    assert.deepEqual(bunnyStream.deletedVideoIds, [BUNNY_GUID]);
    assert.deepEqual(
      order,
      ["remote-delete", "assignment-cleanup", "local-delete"],
      "the assignment must be cleaned INSIDE the transaction, after Bunny confirmed",
    );
    assert.deepEqual(prisma.deletedVideoIds, ["video-bunny"]);
    assert.equal(response.safety.detachedWebsiteAssignmentCount, 1);
  });

  it("keeps the assignment when the Bunny remote delete is not confirmed", async () => {
    // Remote-first failure preservation must survive the relaxation: nothing
    // local may be mutated while the remote delete is unproven.
    const bunnyStream = createBunnyStreamStub({ throws: true });
    const { prisma, service } = createVideosService({ bunnyStream });
    prisma.videos.set("video-bunny", createBunnyVideo());
    prisma.websiteVideos.push({
      videoId: "video-bunny",
      status: AssignmentStatus.ACTIVE,
    });
    addShareLinkRelation(prisma, {
      shareLinkId: "share-1",
      videoId: "video-bunny",
    });

    await assert.rejects(
      service.purgeVideo(
        "video-bunny",
        { confirmVideoId: "video-bunny", deleteRemoteAsset: true },
        "admin-1",
      ),
      ServiceUnavailableException,
    );

    assert.deepEqual(prisma.deletedVideoIds, []);
    assert.equal(
      prisma.websiteVideos.length,
      1,
      "the WebsiteVideo assignment must survive an unconfirmed remote delete",
    );
    assert.equal(
      prisma.shareLinkVideos.length,
      1,
      "ShareLinkVideo relations must survive too - no partial local cleanup",
    );
    assert.equal(
      prisma.shareLinks.get("share-1")?.status,
      ShareLinkStatus.ACTIVE,
      "share links must not be disabled by an aborted purge",
    );
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

    // The disabled gate now ABORTS the purge rather than deleting the local
    // row and orphaning the Bunny asset. `ensureEnabled()` throws before any
    // network read, so no HTTP request is issued either way.
    await assert.rejects(
      service.purgeVideo(
        "video-bunny",
        { confirmVideoId: "video-bunny", deleteRemoteAsset: true },
        "admin-1",
      ),
    );

    assert.deepEqual(fetchCalls, [], "no Bunny HTTP request may be issued");
    assert.deepEqual(
      prisma.deletedVideoIds,
      [],
      "a disabled deployment must not purge the row and orphan the Bunny asset",
    );
    assert.equal(
      prisma.audits.find(
        (audit) => audit.action === "VIDEO_BUNNY_REMOTE_DELETE",
      )?.status,
      AuditStatus.FAIL,
      "the refusal must be audited truthfully",
    );
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

/* ------------------------------------------------------------------ *
 * RUNTIME BLOCKER — a remote-deleting purge when Bunny cannot confirm
 *
 * The reported failure: a DISABLED Bunny video with an ACTIVE WebsiteVideo
 * assignment returned 400 "Bunny Stream is not enabled." on a server where
 * Bunny WAS enabled. The cause was DI, not configuration — the collaborator
 * was imported with `import type`, so Nest silently injected `undefined`
 * (pinned by `test/bunny-di-wiring.test.ts`).
 *
 * These tests pin the BEHAVIOUR either side of that: what a purge does when
 * the collaborator is present, and what it must do when it is not. The
 * remote-first invariant is unchanged throughout — nothing local is ever
 * destroyed before Bunny confirms.
 * ------------------------------------------------------------------ */

describe("VideosService purge — Bunny availability for remote deletion", () => {
  /** The reported combination: DISABLED, still assigned to an ACTIVE website. */
  function seedDisabledAssignedBunnyVideo(prisma: FakePrismaService): void {
    prisma.videos.set("video-bunny", createBunnyVideo());
    prisma.websiteVideos.push({
      videoId: "video-bunny",
      status: AssignmentStatus.ACTIVE,
    });
    // A REAL related share link, so "an aborted purge touched nothing" is a
    // meaningful assertion rather than a vacuous one over an empty set.
    prisma.shareLinks.set("share-link-1", {
      id: "share-link-1",
      status: ShareLinkStatus.ACTIVE,
    });
    prisma.shareLinkVideos.push({
      shareLinkId: "share-link-1",
      videoId: "video-bunny",
    });
  }

  /** Asserts the whole local record survived an aborted purge. */
  function assertLocalStatePreserved(prisma: FakePrismaService): void {
    assert.deepEqual(
      prisma.deletedVideoIds,
      [],
      "the VideoAsset must survive an unconfirmed remote delete",
    );
    assert.equal(
      prisma.websiteVideos.length,
      1,
      "the WebsiteVideo assignment must survive",
    );
    assert.equal(
      prisma.shareLinks.get("share-link-1")?.status,
      ShareLinkStatus.ACTIVE,
      "share-link rows must not be disabled by an aborted purge",
    );
    assert.equal(
      prisma.shareLinkVideos.length,
      1,
      "ShareLinkVideo membership must survive an aborted purge",
    );
    assert.equal(
      prisma.audits.some((audit) => audit.action === "VIDEO_PURGE_COMMIT"),
      false,
      "no VIDEO_PURGE_COMMIT may be written for an aborted purge",
    );
  }

  /* TEST A — the reported case, working. */
  it("A: DISABLED + ACTIVE assignment + Bunny available -> remote first, then local purge", async () => {
    const bunnyStream = createBunnyStreamStub();
    const { prisma, service } = createVideosService({ bunnyStream });
    seedDisabledAssignedBunnyVideo(prisma);

    // Order is the invariant, so it is observed rather than assumed: the
    // remote delete must already have happened when the local delete runs.
    const observedOrder: string[] = [];
    const originalDeleteVideo = bunnyStream.deleteVideo.bind(bunnyStream);
    bunnyStream.deleteVideo = async (videoId: string) => {
      observedOrder.push("remote-delete");
      return originalDeleteVideo(videoId);
    };
    const originalDelete = prisma.videoAsset.delete;
    prisma.videoAsset.delete = async (args: { where: { id: string } }) => {
      observedOrder.push("local-delete");
      return originalDelete.call(prisma.videoAsset, args);
    };

    const response = await service.purgeVideo(
      "video-bunny",
      { confirmVideoId: "video-bunny", deleteRemoteAsset: true },
      "admin-1",
    );

    assert.deepEqual(observedOrder, ["remote-delete", "local-delete"]);
    assert.deepEqual(bunnyStream.deletedVideoIds, [BUNNY_GUID]);
    assert.equal(response.remote.remoteAssetDeleted, true);
    assert.deepEqual(prisma.deletedVideoIds, ["video-bunny"]);

    // The former blocker is gone: an ACTIVE assignment no longer refuses the
    // purge, it is cleaned up inside the local transaction.
    assert.equal(response.safety.detachedWebsiteAssignmentCount, 1);
    assert.equal(prisma.websiteVideos.length, 0);
  });

  /* TEST B — the collaborator is not wired at all (the reported defect). */
  it("B: Bunny collaborator missing -> actionable refusal, nothing local destroyed", async () => {
    // `undefined` is exactly what Nest injected while the import was erased.
    const { prisma, service } = createVideosService({ bunnyStream: undefined });
    seedDisabledAssignedBunnyVideo(prisma);

    await assert.rejects(
      service.purgeVideo(
        "video-bunny",
        { confirmVideoId: "video-bunny", deleteRemoteAsset: true },
        "admin-1",
      ),
      (error: unknown) => {
        assert.ok(error instanceof BadRequestException);
        const body = error.getResponse() as {
          code?: string;
          reason?: string;
          message?: string;
        };
        assert.equal(body.code, BUNNY_STREAM_UNAVAILABLE_FOR_PURGE);
        assert.equal(body.reason, "NOT_WIRED");
        assert.equal(body.message, BUNNY_STREAM_UNAVAILABLE_FOR_PURGE_MESSAGE);
        // The operator must be told the video survived and what to do next.
        assert.match(String(body.message), /local video was kept/i);
        assert.match(String(body.message), /local-only purge/i);
        return true;
      },
    );

    assertLocalStatePreserved(prisma);
    assert.equal(
      prisma.audits.find(
        (audit) => audit.action === "VIDEO_BUNNY_REMOTE_DELETE",
      )?.status,
      AuditStatus.FAIL,
      "the refusal must be audited truthfully",
    );
  });

  /* TEST B2 — the feature is switched off. Same refusal, different reason. */
  it("B2: Bunny disabled -> same stable code, reason NOT_ENABLED, no remote call", async () => {
    const bunnyStream = createBunnyStreamStub({ enabled: false });
    const { prisma, service } = createVideosService({ bunnyStream });
    seedDisabledAssignedBunnyVideo(prisma);

    await assert.rejects(
      service.purgeVideo(
        "video-bunny",
        { confirmVideoId: "video-bunny", deleteRemoteAsset: true },
        "admin-1",
      ),
      (error: unknown) => {
        assert.ok(error instanceof BadRequestException);
        const body = error.getResponse() as { code?: string; reason?: string };
        assert.equal(body.code, BUNNY_STREAM_UNAVAILABLE_FOR_PURGE);
        assert.equal(body.reason, "NOT_ENABLED");
        return true;
      },
    );

    assert.deepEqual(
      bunnyStream.deletedVideoIds,
      [],
      "a disabled deployment must issue no remote delete",
    );
    assertLocalStatePreserved(prisma);
  });

  /* TEST C — explicit local-only purge still works with Bunny unavailable. */
  it("C: deleteRemoteAsset:false + Bunny unavailable -> ZERO Bunny calls, local purge succeeds", async () => {
    const bunnyStream = createBunnyStreamStub({ enabled: false });
    const { prisma, service } = createVideosService({ bunnyStream });
    seedDisabledAssignedBunnyVideo(prisma);

    const response = await service.purgeVideo(
      "video-bunny",
      { confirmVideoId: "video-bunny", deleteRemoteAsset: false },
      "admin-1",
    );

    // The availability guard is never consulted: prepareBunnyRemoteDelete()
    // returns null first, so an opted-out purge cannot be blocked by Bunny.
    assert.deepEqual(bunnyStream.deletedVideoIds, []);
    assert.equal(response.remote.remoteAssetDeleteAttempted, false);
    assert.equal(response.remote.remoteAssetDeleted, false);

    // Every other safeguard still applied, and cleanup still happened.
    assert.deepEqual(prisma.deletedVideoIds, ["video-bunny"]);
    assert.equal(response.safety.detachedWebsiteAssignmentCount, 1);
    assert.equal(prisma.websiteVideos.length, 0);
  });

  it("C2: local-only purge still refuses a video that is not DISABLED", async () => {
    const bunnyStream = createBunnyStreamStub({ enabled: false });
    const { prisma, service } = createVideosService({ bunnyStream });
    prisma.videos.set(
      "video-bunny",
      createBunnyVideo({ status: VideoStatus.READY }),
    );

    await assert.rejects(
      service.purgeVideo(
        "video-bunny",
        { confirmVideoId: "video-bunny", deleteRemoteAsset: false },
        "admin-1",
      ),
      BadRequestException,
    );
    assert.deepEqual(prisma.deletedVideoIds, []);
    assert.deepEqual(bunnyStream.deletedVideoIds, []);
  });

  /* TEST D — Bunny answers 404. Already gone counts as confirmed. */
  it("D: remote DELETE 404 -> treated as already deleted, local purge proceeds", async () => {
    const bunnyStream = createBunnyStreamStub({ notFound: true });
    const { prisma, service } = createVideosService({ bunnyStream });
    seedDisabledAssignedBunnyVideo(prisma);

    const response = await service.purgeVideo(
      "video-bunny",
      { confirmVideoId: "video-bunny", deleteRemoteAsset: true },
      "admin-1",
    );

    assert.deepEqual(bunnyStream.deletedVideoIds, [BUNNY_GUID]);
    assert.equal(response.remote.remoteAssetDeleted, true);
    assert.deepEqual(prisma.deletedVideoIds, ["video-bunny"]);
    assert.equal(prisma.websiteVideos.length, 0);
  });

  /* TEST E — transient Bunny failure. Retriable, nothing local destroyed. */
  it("E: remote DELETE 5xx/timeout -> retriable failure, all local state preserved", async () => {
    const bunnyStream = createBunnyStreamStub({ throws: true });
    const { prisma, service } = createVideosService({ bunnyStream });
    seedDisabledAssignedBunnyVideo(prisma);

    await assert.rejects(
      service.purgeVideo(
        "video-bunny",
        { confirmVideoId: "video-bunny", deleteRemoteAsset: true },
        "admin-1",
      ),
      (error: unknown) => {
        // A transient failure is NOT the unavailable-for-purge code: retrying
        // is the right response, and the message says the record was kept.
        assert.ok(error instanceof ServiceUnavailableException);
        assert.match(String(error.message), /retry the purge/i);
        return true;
      },
    );

    assert.deepEqual(bunnyStream.deletedVideoIds, [BUNNY_GUID]);
    assertLocalStatePreserved(prisma);
  });

  /* TEST F / G — what the Admin console actually sends. */
  it("F: the Admin default request (deleteRemoteAsset:true) deletes remotely", async () => {
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
  });

  it("G: an explicit opt-out (deleteRemoteAsset:false) retains the Bunny asset", async () => {
    const bunnyStream = createBunnyStreamStub();
    const { prisma, service } = createVideosService({ bunnyStream });
    prisma.videos.set("video-bunny", createBunnyVideo());

    const response = await service.purgeVideo(
      "video-bunny",
      { confirmVideoId: "video-bunny", deleteRemoteAsset: false },
      "admin-1",
    );

    assert.deepEqual(
      bunnyStream.deletedVideoIds,
      [],
      "an opt-out must never reach Bunny",
    );
    assert.equal(response.remote.remoteAssetDeleteAttempted, false);
    assert.deepEqual(prisma.deletedVideoIds, ["video-bunny"]);
  });
});

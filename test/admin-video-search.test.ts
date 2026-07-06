import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { MemoryCacheService } from "../src/cache/memory-cache.service";
import type { MemoryCacheRuntimeConfig } from "../src/cache/memory-cache.types";
import {
  AuditStatus,
  VideoProvider,
  VideoSourceType,
  VideoUploadSessionStatus,
  VideoStatus,
  type Prisma,
} from "../src/generated/prisma/client";
import { ListVideosQueryDto } from "../src/videos/dto/list-videos-query.dto";
import {
  ADMIN_VIDEO_SEARCH_MAX_LENGTH,
  normalizeAdminVideoSearch,
} from "../src/videos/utils/video-search.util";
import {
  VIDEO_FILTER_KEY_MAX_LENGTH,
  isValidVideoFilterKey,
  normalizeVideoFilterKey,
} from "../src/videos/utils/video-filter-key.util";
import { VideosService } from "../src/videos/videos.service";

type FakeVideoRecord = {
  id: string;
  title: string;
  slug: string | null;
  description: string | null;
  provider: VideoProvider;
  sourceType: VideoSourceType;
  providerAssetId: string | null;
  playbackId: string | null;
  playbackUrl: string | null;
  embedProvider: null;
  embedUrl: string | null;
  embedCloudName: string | null;
  embedPublicId: string | null;
  embedAllow: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  viewCount: bigint;
  publishedAt: Date | null;
  status: VideoStatus;
  filterKey: string | null;
  metadataJson: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
  binaryAsset: null;
  localFileAsset: null;
  localThumbnailAsset: null;
};

type FakeVideoWhere = {
  status?: VideoStatus;
  provider?: VideoProvider;
  filterKey?: string;
  OR?: Array<{
    title?: { contains: string };
    slug?: { contains: string };
  }>;
};

type FakeVideoOrderBy = Record<string, "asc" | "desc">;

class FakePrismaService {
  readonly videos: FakeVideoRecord[];
  findManyCalls = 0;
  countCalls = 0;
  updateCalls = 0;
  disabledShareLinkCount = 0;
  throwOnFindMany = false;
  lastUploadSessionData: Record<string, unknown> | null = null;
  lastFindManyArgs: {
    where?: FakeVideoWhere;
    orderBy?: FakeVideoOrderBy;
    skip?: number;
    take?: number;
  } | null = null;

  constructor(videos: FakeVideoRecord[]) {
    this.videos = videos;
  }

  videoAsset = {
    findMany: async (args: {
      where?: FakeVideoWhere;
      orderBy?: FakeVideoOrderBy;
      skip?: number;
      take?: number;
    }): Promise<FakeVideoRecord[]> => {
      this.findManyCalls += 1;
      if (this.throwOnFindMany) {
        throw new Error("findMany failed");
      }
      this.lastFindManyArgs = args;

      const filtered = this.filterVideos(args.where);
      const sorted = this.sortVideos(filtered, args.orderBy);

      return sorted.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? 20));
    },
    count: async (args: { where?: FakeVideoWhere }): Promise<number> => {
      this.countCalls += 1;

      return this.filterVideos(args.where).length;
    },
    findUnique: async (args: { where: { id?: string; slug?: string } }) => {
      if (args.where.slug !== undefined) {
        return (
          this.videos.find((video) => video.slug === args.where.slug) ?? null
        );
      }

      return this.videos.find((video) => video.id === args.where.id) ?? null;
    },
    create: async (args: {
      data: Partial<FakeVideoRecord> & {
        title: string;
        slug: string;
        provider: VideoProvider;
        sourceType: VideoSourceType;
        status: VideoStatus;
      };
    }): Promise<FakeVideoRecord> => {
      const video = createVideo(`created-${this.videos.length + 1}`, {
        ...args.data,
      });
      this.videos.push(video);

      return video;
    },
    update: async (args: {
      where: { id: string };
      data: Partial<FakeVideoRecord>;
    }) => {
      this.updateCalls += 1;
      const index = this.videos.findIndex(
        (video) => video.id === args.where.id,
      );
      assert.notEqual(index, -1);
      const updated = {
        ...this.videos[index],
        ...args.data,
      } as FakeVideoRecord;
      this.videos[index] = updated;

      return updated;
    },
  };

  videoUploadSession = {
    findMany: async (): Promise<[]> => [],
    updateMany: async (): Promise<{ count: number }> => ({ count: 0 }),
    create: async (args: { data: Record<string, unknown> }) => {
      this.lastUploadSessionData = args.data;

      return {
        ...args.data,
        status: VideoUploadSessionStatus.ACTIVE,
        chunks: [],
      };
    },
  };

  adminAuditLog = {
    create: async (args: {
      data: {
        action: string;
        status: AuditStatus;
      };
    }): Promise<void> => {
      assert.equal(args.data.status, AuditStatus.SUCCESS);
    },
  };

  shareLink = {
    updateMany: async (): Promise<{ count: number }> => {
      const count = this.disabledShareLinkCount;
      this.disabledShareLinkCount = 0;

      return { count };
    },
  };

  async $transaction<T extends readonly unknown[]>(
    promises: T,
  ): Promise<{ [K in keyof T]: Awaited<T[K]> }>;
  async $transaction<T>(callback: (tx: this) => Promise<T>): Promise<T>;
  async $transaction<T>(
    input: readonly unknown[] | ((tx: this) => Promise<T>),
  ): Promise<T | unknown[]> {
    if (typeof input === "function") {
      return input(this);
    }

    return Promise.all(input);
  }

  private filterVideos(where: FakeVideoWhere | undefined): FakeVideoRecord[] {
    return this.videos.filter((video) => {
      if (where?.status !== undefined && video.status !== where.status) {
        return false;
      }

      if (where?.provider !== undefined && video.provider !== where.provider) {
        return false;
      }

      if (
        where?.filterKey !== undefined &&
        video.filterKey !== where.filterKey
      ) {
        return false;
      }

      if (where?.OR !== undefined && where.OR.length > 0) {
        return where.OR.some((condition) => {
          const titleSearch = condition.title?.contains;
          if (
            titleSearch !== undefined &&
            video.title.toLowerCase().includes(titleSearch.toLowerCase())
          ) {
            return true;
          }

          const slugSearch = condition.slug?.contains;
          return (
            slugSearch !== undefined &&
            video.slug !== null &&
            video.slug.toLowerCase().includes(slugSearch.toLowerCase())
          );
        });
      }

      return true;
    });
  }

  private sortVideos(
    videos: FakeVideoRecord[],
    orderBy: FakeVideoOrderBy | undefined,
  ): FakeVideoRecord[] {
    if (orderBy === undefined) {
      return [...videos];
    }

    const [field, direction] = Object.entries(orderBy)[0] ?? [];
    if (field === undefined || direction === undefined) {
      return [...videos];
    }

    return [...videos].sort((firstVideo, secondVideo) => {
      const firstValue = readSortableVideoValue(firstVideo, field);
      const secondValue = readSortableVideoValue(secondVideo, field);
      const comparison =
        firstValue < secondValue ? -1 : firstValue > secondValue ? 1 : 0;

      return direction === "asc" ? comparison : -comparison;
    });
  }
}

class FakeLocalVideoStorageService {
  assertEnabled(): void {}

  async ensureRootReady(): Promise<void> {}

  sanitizeOriginalFilename(value: string): string {
    return value.trim();
  }

  buildUploadTempKey(uploadId: string): string {
    return `uploads/${uploadId}`;
  }

  getUploadSessionTtlMinutes(): number {
    return 60;
  }

  getStaleUploadMaxAgeHours(): number {
    return 24;
  }

  getUploadMaxBytes(): number {
    return 1024 * 1024 * 1024;
  }

  getChunkSizeBytes(): number {
    return 10 * 1024 * 1024;
  }

  async deleteDirectoryBestEffort(): Promise<void> {}
}

class FakeConfigService {
  get<T = string>(): T | undefined {
    return undefined;
  }
}

const defaultMemoryCacheConfig: MemoryCacheRuntimeConfig = {
  enabled: true,
  maxEntries: 1000,
  defaultTtlSeconds: 60,
  inflightTtlMs: 5000,
  adminVideosListTtlSeconds: 30,
  adminWebsitesListTtlSeconds: 60,
  publicWatchMetadataTtlSeconds: 10,
  mediaMetadataTtlSeconds: 300,
};

class FakeMemoryCacheConfigService {
  get<T = unknown>(key: string): T | undefined {
    if (key === "api") {
      return { memoryCache: defaultMemoryCacheConfig } as T;
    }

    return undefined;
  }
}

function createMemoryCache(): MemoryCacheService {
  return new MemoryCacheService(new FakeMemoryCacheConfigService() as never);
}

function readSortableVideoValue(
  video: FakeVideoRecord,
  field: string,
): string | number {
  if (field === "title") {
    return video.title;
  }

  const value = video[field as keyof FakeVideoRecord];

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "number" || typeof value === "string") {
    return value;
  }

  return "";
}

function createVideo(
  id: string,
  overrides: Partial<FakeVideoRecord> = {},
): FakeVideoRecord {
  return {
    id,
    title: `Video ${id}`,
    slug: `video-${id}`,
    description: null,
    provider: VideoProvider.MANUAL,
    sourceType: VideoSourceType.DIRECT_URL,
    providerAssetId: null,
    playbackId: null,
    playbackUrl: "https://cdn.example.test/video.mp4",
    embedProvider: null,
    embedUrl: null,
    embedCloudName: null,
    embedPublicId: null,
    embedAllow: null,
    thumbnailUrl: null,
    durationSeconds: null,
    viewCount: 0n,
    publishedAt: null,
    status: VideoStatus.READY,
    filterKey: null,
    metadataJson: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    binaryAsset: null,
    localFileAsset: null,
    localThumbnailAsset: null,
    ...overrides,
  };
}

function createVideosService(videos = createVideoFixtures()): {
  prisma: FakePrismaService;
  service: VideosService;
  memoryCache: MemoryCacheService;
} {
  const prisma = new FakePrismaService(videos);
  const memoryCache = createMemoryCache();
  const service = new VideosService(
    prisma as never,
    {} as never,
    new FakeConfigService() as never,
    {} as never,
    new FakeLocalVideoStorageService() as never,
    memoryCache,
  );

  return { prisma, service, memoryCache };
}

function createVideoFixtures(): FakeVideoRecord[] {
  return [
    createVideo("ready-1", {
      title: "I Fell For You",
      slug: "i-fell-for-you",
      filterKey: "sml",
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
      updatedAt: new Date("2026-01-04T00:00:00.000Z"),
    }),
    createVideo("ready-2", {
      title: "Another Ready Clip",
      slug: "another-ready-clip",
      filterKey: "msa",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
      updatedAt: new Date("2026-01-05T00:00:00.000Z"),
    }),
    createVideo("disabled-1", {
      title: "I Fell Disabled",
      slug: "i-fell-disabled",
      status: VideoStatus.DISABLED,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-06T00:00:00.000Z"),
    }),
  ];
}

describe("admin video search normalization", () => {
  it("normalizes whitespace, unicode form, and max length", () => {
    assert.equal(normalizeAdminVideoSearch("  i   fell  "), "i fell");
    assert.equal(normalizeAdminVideoSearch("e\u0301"), "é");
    assert.equal(
      normalizeAdminVideoSearch("x".repeat(ADMIN_VIDEO_SEARCH_MAX_LENGTH + 5))
        .length,
      ADMIN_VIDEO_SEARCH_MAX_LENGTH,
    );
    assert.equal(normalizeAdminVideoSearch(null), "");
  });
});

describe("video filter key normalization", () => {
  it("normalizes valid grouping keys", () => {
    assert.equal(normalizeVideoFilterKey("sml"), "sml");
    assert.equal(normalizeVideoFilterKey("msa"), "msa");
    assert.equal(normalizeVideoFilterKey("Judge Judy"), "judge_judy");
    assert.equal(normalizeVideoFilterKey("coryxkenshin"), "coryxkenshin");
    assert.equal(
      normalizeVideoFilterKey("  true-crimecentral  "),
      "true_crimecentral",
    );
    assert.equal(normalizeVideoFilterKey("   "), undefined);
  });

  it("validates allowed, unsafe, reserved, and long keys", () => {
    for (const key of ["sml", "msa", "judge_judy", "coryxkenshin"]) {
      assert.equal(isValidVideoFilterKey(key), true);
    }

    for (const key of [
      "../secret",
      "sml/movies",
      "sml_movies!!!",
      "all",
      "x".repeat(VIDEO_FILTER_KEY_MAX_LENGTH + 1),
    ]) {
      assert.equal(isValidVideoFilterKey(key), false);
    }
  });
});

describe("VideosService admin list search", () => {
  it("returns a normal page when search is absent, empty, or whitespace", async () => {
    const { service } = createVideosService();

    const noSearch = await service.listVideos({
      page: 1,
      limit: 24,
      status: VideoStatus.READY,
      sortBy: "createdAt",
      sortOrder: "desc",
    });
    const emptySearch = await service.listVideos({
      page: 1,
      limit: 24,
      search: "",
      status: VideoStatus.READY,
      sortBy: "createdAt",
      sortOrder: "desc",
    });
    const whitespaceSearch = await service.listVideos({
      page: 1,
      limit: 24,
      search: "   ",
      status: VideoStatus.READY,
      sortBy: "createdAt",
      sortOrder: "desc",
    });

    assert.equal(noSearch.meta.total, 2);
    assert.equal(emptySearch.meta.total, 2);
    assert.equal(whitespaceSearch.meta.total, 2);
  });

  it("returns an empty page without querying Prisma for one-character search", async () => {
    const { prisma, service } = createVideosService();

    const response = await service.listVideos({
      page: 1,
      limit: 24,
      search: "i",
      status: VideoStatus.READY,
      sortBy: "createdAt",
      sortOrder: "desc",
    });

    assert.deepEqual(response, {
      items: [],
      meta: {
        page: 1,
        limit: 24,
        total: 0,
        totalPages: 0,
      },
    });
    assert.equal(prisma.findManyCalls, 0);
    assert.equal(prisma.countCalls, 0);
  });

  it("searches normal text across title and slug while respecting status", async () => {
    const { service } = createVideosService();

    const response = await service.listVideos({
      page: 1,
      limit: 24,
      search: "i fell",
      status: VideoStatus.READY,
      sortBy: "createdAt",
      sortOrder: "desc",
    });

    assert.deepEqual(
      response.items.map((video) => video.id),
      ["ready-1"],
    );
    assert.equal(response.meta.total, 1);
  });

  it("filters videos by filterKey and combines with status and search", async () => {
    const { service } = createVideosService([
      ...createVideoFixtures(),
      createVideo("ready-3", {
        title: "SML Movie Night",
        slug: "sml-movie-night",
        filterKey: "sml",
      }),
      createVideo("draft-sml", {
        title: "SML Draft",
        slug: "sml-draft",
        filterKey: "sml",
        status: VideoStatus.DRAFT,
      }),
      createVideo("null-key", {
        title: "No Key Ready",
        slug: "no-key-ready",
        filterKey: null,
      }),
    ]);

    const sml = await service.listVideos({
      page: 1,
      limit: 24,
      filterKey: "sml",
      status: VideoStatus.READY,
      sortBy: "createdAt",
      sortOrder: "desc",
    });
    const msa = await service.listVideos({
      page: 1,
      limit: 24,
      filterKey: "msa",
      status: VideoStatus.READY,
      sortBy: "createdAt",
      sortOrder: "desc",
    });
    const all = await service.listVideos({
      page: 1,
      limit: 24,
      status: VideoStatus.READY,
      sortBy: "createdAt",
      sortOrder: "desc",
    });
    const searchedSml = await service.listVideos({
      page: 1,
      limit: 24,
      search: "movie",
      filterKey: "sml",
      status: VideoStatus.READY,
      sortBy: "createdAt",
      sortOrder: "desc",
    });

    assert.deepEqual(sml.items.map((video) => video.id).sort(), [
      "ready-1",
      "ready-3",
    ]);
    assert.deepEqual(
      msa.items.map((video) => video.id),
      ["ready-2"],
    );
    assert.equal(all.meta.total, 4);
    assert.deepEqual(
      searchedSml.items.map((video) => video.id),
      ["ready-3"],
    );
    assert.equal(searchedSml.items[0]?.filterKey, "sml");
  });

  it("stores normalized filterKey on manual and embed create", async () => {
    const { service } = createVideosService([]);

    const manual = await service.createVideo(
      {
        title: "Judge Judy Clip",
        status: VideoStatus.READY,
        filterKey: "Judge Judy",
      } as never,
      "admin-1",
    );
    const embed = await service.createEmbedVideo(
      {
        title: "MSA Embed",
        embedCodeOrUrl: "https://www.youtube.com/embed/test-video",
        status: VideoStatus.READY,
        filterKey: "msa",
      } as never,
      "admin-1",
    );

    assert.equal(manual.filterKey, "judge_judy");
    assert.equal(embed.filterKey, "msa");
  });

  it("updates and clears filterKey only when explicitly provided", async () => {
    const { service } = createVideosService();

    const unchanged = await service.updateVideo(
      "ready-1",
      { title: "Renamed Ready" } as never,
      "admin-1",
    );
    const updated = await service.updateVideo(
      "ready-1",
      { filterKey: "Judge Judy" } as never,
      "admin-1",
    );
    const cleared = await service.updateVideo(
      "ready-1",
      { filterKey: null } as never,
      "admin-1",
    );

    assert.equal(unchanged.filterKey, "sml");
    assert.equal(updated.filterKey, "judge_judy");
    assert.equal(cleared.filterKey, null);
  });

  it("stores normalized filterKey in local upload session metadata", async () => {
    const { service, prisma } = createVideosService([]);

    const response = await service.initLocalVideoUpload(
      {
        title: "Local Judge Judy",
        originalFilename: "judge-judy.mp4",
        mimeType: "video/mp4",
        totalBytes: 1024,
        totalChunks: 1,
        chunkSizeBytes: 1024,
        filterKey: "Judge Judy",
      } as never,
      "admin-1",
    );

    assert.equal(response.message, "Local video upload initialized.");
    assert.equal(
      (prisma.lastUploadSessionData?.metadataJson as Record<string, unknown>)
        .filterKey,
      "judge_judy",
    );
  });

  it("does not throw for the production msa search regression", async () => {
    const { service } = createVideosService();

    const response = await service.listVideos({
      page: 1,
      limit: 20,
      search: "msa",
      status: VideoStatus.READY,
      sortBy: "createdAt",
      sortOrder: "desc",
    });

    assert.deepEqual(response.items, []);
    assert.equal(response.meta.total, 0);
  });

  it("does not throw for special-character searches", async () => {
    const { service } = createVideosService();
    const searches = ["%", "_", "'", '"', "\\", "()", "+", "-", ",", "/"];

    for (const search of searches) {
      await assert.doesNotReject(
        service.listVideos({
          page: 1,
          limit: 24,
          search,
          status: VideoStatus.READY,
          sortBy: "createdAt",
          sortOrder: "desc",
        }),
        `search should not throw for ${search}`,
      );
    }
  });

  it("keeps pagination and sorting behavior", async () => {
    const { service } = createVideosService();

    const firstPage = await service.listVideos({
      page: 1,
      limit: 1,
      status: VideoStatus.READY,
      sortBy: "title",
      sortOrder: "asc",
    });
    const secondPage = await service.listVideos({
      page: 2,
      limit: 1,
      status: VideoStatus.READY,
      sortBy: "title",
      sortOrder: "asc",
    });

    assert.deepEqual(
      firstPage.items.map((video) => video.id),
      ["ready-2"],
    );
    assert.deepEqual(
      secondPage.items.map((video) => video.id),
      ["ready-1"],
    );
    assert.equal(firstPage.meta.totalPages, 2);
  });

  it("falls back to safe default sorting for invalid direct service input", async () => {
    const { prisma, service } = createVideosService();

    await service.listVideos({
      page: 1,
      limit: 24,
      status: VideoStatus.READY,
      sortBy: "__proto__" as never,
      sortOrder: "sideways" as never,
    });

    assert.deepEqual(prisma.lastFindManyArgs?.orderBy, {
      createdAt: "desc",
    });
  });

  it("caches identical successful list queries and separates different params", async () => {
    const { prisma, service } = createVideosService();
    const query = {
      page: 1,
      limit: 24,
      status: VideoStatus.READY,
      sortBy: "createdAt" as const,
      sortOrder: "desc" as const,
    };

    await service.listVideos(query);
    await service.listVideos(query);
    await service.listVideos({ ...query, page: 2 });
    await service.listVideos({ ...query, filterKey: "sml" });
    await service.listVideos({ ...query, filterKey: "msa" });

    assert.equal(prisma.findManyCalls, 4);
    assert.equal(prisma.countCalls, 4);
  });

  it("does not cache failed list queries", async () => {
    const { prisma, service } = createVideosService();
    prisma.throwOnFindMany = true;

    await assert.rejects(
      service.listVideos({
        page: 1,
        limit: 24,
        status: VideoStatus.READY,
        sortBy: "createdAt",
        sortOrder: "desc",
      }),
    );
    await assert.rejects(
      service.listVideos({
        page: 1,
        limit: 24,
        status: VideoStatus.READY,
        sortBy: "createdAt",
        sortOrder: "desc",
      }),
    );

    assert.equal(prisma.findManyCalls, 2);
  });

  it("invalidates admin video list cache after a status mutation", async () => {
    const { prisma, service } = createVideosService();
    const query = {
      page: 1,
      limit: 24,
      status: VideoStatus.READY,
      sortBy: "createdAt" as const,
      sortOrder: "desc" as const,
    };

    await service.listVideos(query);
    await service.listVideos(query);
    assert.equal(prisma.findManyCalls, 1);

    prisma.disabledShareLinkCount = 1;
    await service.disableVideo("ready-1", "admin-1");
    await service.listVideos(query);

    assert.equal(prisma.updateCalls, 1);
    assert.equal(prisma.findManyCalls, 2);
  });
});

describe("ListVideosQueryDto sort validation", () => {
  it("allows updatedAt and rejects arbitrary sort fields", async () => {
    const validDto = plainToInstance(ListVideosQueryDto, {
      sortBy: "updatedAt",
    });
    const invalidDto = plainToInstance(ListVideosQueryDto, {
      sortBy: "viewCount",
    });

    assert.equal((await validate(validDto)).length, 0);
    assert.notEqual((await validate(invalidDto)).length, 0);
  });
});

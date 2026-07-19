import "reflect-metadata";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { NotFoundException } from "@nestjs/common";
import { MemoryCacheService } from "../src/cache/memory-cache.service";
import type { MemoryCacheRuntimeConfig } from "../src/cache/memory-cache.types";
import {
  AccessLogStatus,
  DomainStatus,
  ShareLinkStatus,
  VideoSourceType,
  VideoStatus,
  WebsiteStatus,
} from "../src/generated/prisma/client";
import { PublicMediaGrantService } from "../src/public/public-media-grant.service";
import { PublicService } from "../src/public/public.service";
import { hashShareToken } from "../src/public/utils/share-token.util";

const token = "test-share-token";
const shareAlias = "AbCd123";
const tokenPepper = "test-share-token-pepper";
const tokenHash = hashShareToken({ pepper: tokenPepper, token });
const host = "localhost:5500";

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

type FakeVideo = {
  id: string;
  title: string;
  description: string | null;
  sourceType: VideoSourceType;
  playbackUrl: string | null;
  embedUrl: string | null;
  embedProvider: null;
  embedAllow: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  viewCount: bigint;
  publishedAt: Date | null;
  status: VideoStatus;
  binaryAsset: null;
  localFileAsset: {
    storageKey: string;
    mimeType: string;
    sizeBytes: bigint;
  };
  localThumbnailAsset: {
    storageKey: string;
    mimeType: string;
    sizeBytes: bigint;
  } | null;
};

type FakeShareLink = {
  id: string;
  websiteId: string;
  tokenHash: string;
  alias: string | null;
  status: ShareLinkStatus;
  expiresAt: Date | null;
  maxViews: number | null;
  currentViews: number;
  shareLinkVideos: Array<{
    sortOrder: number;
    video: FakeVideo;
  }>;
};

class FakeConfigService {
  get<T = string>(key: string): T | undefined {
    if (key === "SHARE_TOKEN_PEPPER") {
      return tokenPepper as T;
    }

    if (key === "ACCESS_LOG_IP_PEPPER") {
      return "test-access-log-pepper" as T;
    }

    if (key === "API_PREFIX") {
      return "api/v1" as T;
    }

    if (key === "PUBLIC_MEDIA_GRANT_SECRET") {
      return "test-public-media-grant-secret-at-least-32-bytes" as T;
    }

    if (key === "PUBLIC_MEDIA_GRANT_TTL_SECONDS") {
      return "21600" as T;
    }

    return undefined;
  }

  getOrThrow<T = string>(key: string): T {
    const value = this.get<T>(key);
    if (value === undefined) {
      throw new Error(`${key} missing`);
    }

    return value;
  }
}

class FakeMemoryCacheConfigService {
  get<T = unknown>(key: string): T | undefined {
    if (key === "api") {
      return { memoryCache: defaultMemoryCacheConfig } as T;
    }

    return undefined;
  }
}

class FakePrismaService {
  shareLinkRecord: FakeShareLink;
  websiteDomainFindUniqueCalls = 0;
  shareLinkFindFirstCalls = 0;
  shareLinkUpdateManyCalls = 0;
  assignmentActive = true;
  readonly accessLogs: Array<{
    status: AccessLogStatus;
    reasonCode: string;
  }> = [];

  constructor(video: FakeVideo) {
    this.shareLinkRecord = {
      id: "share-1",
      websiteId: "website-1",
      tokenHash,
      alias: shareAlias,
      status: ShareLinkStatus.ACTIVE,
      expiresAt: null,
      maxViews: null,
      currentViews: 0,
      shareLinkVideos: [{ sortOrder: 0, video }],
    };
  }

  websiteDomain = {
    findUnique: async (args: { where: { domain: string } }) => {
      this.websiteDomainFindUniqueCalls += 1;
      if (args.where.domain !== host) {
        return null;
      }

      return {
        id: "domain-1",
        domain: host,
        status: DomainStatus.ACTIVE,
        website: {
          id: "website-1",
          name: "Test Website",
          slug: "test-website",
          status: WebsiteStatus.ACTIVE,
        },
      };
    },
  };

  shareLink = {
    findFirst: async (args: {
      where: { alias?: string; tokenHash?: string; websiteId: string };
      include?: {
        shareLinkVideos?: {
          where?: { videoId: string };
        };
      };
    }) => {
      this.shareLinkFindFirstCalls += 1;
      if (
        args.where.websiteId !== this.shareLinkRecord.websiteId ||
        (args.where.alias !== undefined &&
          args.where.alias !== this.shareLinkRecord.alias) ||
        (args.where.tokenHash !== undefined &&
          args.where.tokenHash !== this.shareLinkRecord.tokenHash) ||
        (args.where.alias === undefined && args.where.tokenHash === undefined)
      ) {
        return null;
      }

      const requestedVideoId = args.include?.shareLinkVideos?.where?.videoId;
      const shareLinkVideos = !this.assignmentActive
        ? []
        : requestedVideoId === undefined
          ? this.shareLinkRecord.shareLinkVideos
          : this.shareLinkRecord.shareLinkVideos.filter(
              ({ video }) => video.id === requestedVideoId,
            );

      return {
        ...this.shareLinkRecord,
        shareLinkVideos,
      };
    },
    updateMany: async (args: {
      where?: { currentViews?: { lt: number } };
    }): Promise<{ count: number }> => {
      this.shareLinkUpdateManyCalls += 1;
      const limit = args.where?.currentViews?.lt;
      if (limit !== undefined && this.shareLinkRecord.currentViews >= limit) {
        return { count: 0 };
      }
      this.shareLinkRecord.currentViews += 1;

      return { count: 1 };
    },
    findUnique: async () => this.shareLinkRecord,
  };

  accessLog = {
    create: async (args: {
      data: { status: AccessLogStatus; reasonCode: string };
    }): Promise<void> => {
      this.accessLogs.push({
        status: args.data.status,
        reasonCode: args.data.reasonCode,
      });
    },
  };
}

class FakeLocalVideoStorageService {
  createFullReadStream(storageKey: string): {
    contentLength: number;
    stream: NodeJS.ReadableStream;
  } {
    assert.equal(storageKey, "videos/video-1/thumbnails/thumb.jpg");

    return {
      contentLength: 4,
      stream: Readable.from(Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
    };
  }
}

class FakeVideoViewGrowthService {}

function createLocalFileVideo(overrides: Partial<FakeVideo> = {}): FakeVideo {
  return {
    id: "video-1",
    title: "Local video",
    description: null,
    sourceType: VideoSourceType.LOCAL_FILE,
    playbackUrl: "/api/v1/admin/videos/video-1/local-file",
    embedUrl: null,
    embedProvider: null,
    embedAllow: null,
    thumbnailUrl: "/api/v1/admin/videos/video-1/thumbnail",
    durationSeconds: 30,
    viewCount: 123n,
    publishedAt: new Date("2026-06-14T00:00:00.000Z"),
    status: VideoStatus.READY,
    binaryAsset: null,
    localFileAsset: {
      storageKey: "videos/video-1/source/video.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1024n,
    },
    localThumbnailAsset: {
      storageKey: "videos/video-1/thumbnails/thumb.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 4n,
    },
    ...overrides,
  };
}

function createMemoryCache(): MemoryCacheService {
  return new MemoryCacheService(new FakeMemoryCacheConfigService() as never);
}

function createService(
  video: FakeVideo,
  options: { memoryCache?: boolean } = {},
): {
  prisma: FakePrismaService;
  service: PublicService;
} {
  const prisma = new FakePrismaService(video);
  const config = new FakeConfigService();
  const service = new PublicService(
    prisma as never,
    config as never,
    new FakeLocalVideoStorageService() as never,
    new FakeVideoViewGrowthService() as never,
    new PublicMediaGrantService(config as never),
    options.memoryCache === true ? createMemoryCache() : undefined,
  );

  return { prisma, service };
}

describe("PublicService LOCAL_FILE thumbnail serialization", () => {
  it("returns token-gated public thumbnail URLs for image local thumbnails", async () => {
    const { service } = createService(createLocalFileVideo());

    const response = await service.resolvePublicWatch({ host, token });
    const video = response.videos[0];

    assert.equal(response.valid, true);
    assert.ok(video);
    assert.match(
      video.thumbnailUrl ?? "",
      /^\/api\/v1\/public\/watch\/test-share-token\/videos\/video-1\/thumbnail\?host=localhost%3A5500$/,
    );
    assert.equal(video.publicThumbnailUrl, video.thumbnailUrl);
    assert.equal(video.playbackUrl, null);
    assert.match(
      video.publicPlaybackUrl ?? "",
      /^\/api\/v1\/public\/watch\/test-share-token\/videos\/video-1\/local-file\?host=localhost%3A5500$/,
    );

    const publicMediaFields = [
      video.thumbnailUrl,
      video.publicThumbnailUrl,
      video.playbackUrl,
      video.publicPlaybackUrl,
      video.binaryPlaybackUrl,
    ];
    assert.equal(
      publicMediaFields.some((value) => value?.includes("/admin/")),
      false,
    );
  });

  it("resolves public LOCAL_FILE thumbnail and playback URLs by short alias", async () => {
    const { service } = createService(createLocalFileVideo());

    const response = await service.resolvePublicWatch({
      host,
      token: shareAlias,
    });
    const video = response.videos[0];

    assert.equal(response.valid, true);
    assert.ok(video);
    assert.match(
      video.thumbnailUrl ?? "",
      /^\/api\/v1\/public\/watch\/AbCd123\/videos\/video-1\/thumbnail\?host=localhost%3A5500$/,
    );
    assert.match(
      video.publicPlaybackUrl ?? "",
      /^\/api\/v1\/public\/watch\/AbCd123\/videos\/video-1\/local-file\?host=localhost%3A5500$/,
    );
    assert.equal(video.thumbnailUrl?.includes("/admin/"), false);

    const thumbnail = await service.getPublicLocalThumbnail({
      host,
      token: shareAlias,
      videoId: "video-1",
    });

    assert.equal(thumbnail.mimeType, "image/jpeg");
    assert.equal(thumbnail.contentLength, 4);
  });

  it("does not fall back to admin thumbnail URLs for invalid local thumbnail assets", async () => {
    const { service } = createService(
      createLocalFileVideo({
        localThumbnailAsset: {
          storageKey: "videos/video-1/thumbnails/not-a-thumb.mp4",
          mimeType: "video/mp4",
          sizeBytes: 4n,
        },
      }),
    );

    const response = await service.resolvePublicWatch({ host, token });
    const video = response.videos[0];

    assert.equal(response.valid, true);
    assert.ok(video);
    assert.equal(video.thumbnailUrl, null);
    assert.equal(video.publicThumbnailUrl, null);
  });

  it("streams a valid local thumbnail without admin authorization", async () => {
    const { service } = createService(createLocalFileVideo());

    const result = await service.getPublicLocalThumbnail({
      host,
      token,
      videoId: "video-1",
    });

    assert.equal(result.mimeType, "image/jpeg");
    assert.equal(result.contentLength, 4);
  });

  it("keeps invalid public thumbnail requests generic", async () => {
    const { service } = createService(createLocalFileVideo());

    await assert.rejects(
      service.getPublicLocalThumbnail({
        host,
        token: "wrong-token",
        videoId: "video-1",
      }),
      (error: unknown) =>
        error instanceof NotFoundException &&
        error.message === "Video not found.",
    );
  });

  it("rejects oversized media grants before database lookup", async () => {
    const { prisma, service } = createService(createLocalFileVideo());

    await assert.rejects(
      service.getPublicLocalThumbnail({
        host,
        token,
        videoId: "video-1",
        grant: "x".repeat(2049),
      }),
      NotFoundException,
    );
    assert.equal(prisma.websiteDomainFindUniqueCalls, 0);
    assert.equal(prisma.shareLinkFindFirstCalls, 0);
  });

  it("caches safe public watch metadata while preserving view and access-log side effects", async () => {
    const { prisma, service } = createService(createLocalFileVideo(), {
      memoryCache: true,
    });

    const first = await service.resolvePublicWatch({ host, token });
    const second = await service.resolvePublicWatch({ host, token });

    assert.equal(first.valid, true);
    assert.equal(second.valid, true);
    assert.equal(prisma.websiteDomainFindUniqueCalls, 1);
    assert.equal(prisma.shareLinkFindFirstCalls, 2);
    assert.equal(prisma.shareLinkUpdateManyCalls, 2);
    assert.equal(prisma.shareLinkRecord.currentViews, 2);
    assert.deepEqual(
      prisma.accessLogs.map((log) => log.status),
      [AccessLogStatus.ALLOWED, AccessLogStatus.ALLOWED],
    );
  });

  it("does not cache max-view-limited public watch metadata", async () => {
    const { prisma, service } = createService(createLocalFileVideo(), {
      memoryCache: true,
    });
    prisma.shareLinkRecord.maxViews = 10;

    await service.resolvePublicWatch({ host, token });
    await service.resolvePublicWatch({ host, token });

    assert.equal(prisma.shareLinkFindFirstCalls, 4);
    assert.equal(prisma.shareLinkUpdateManyCalls, 2);
    assert.equal(prisma.shareLinkRecord.currentViews, 2);
  });

  it("requires a bound grant for limited-share media after the final view", async () => {
    const { prisma, service } = createService(createLocalFileVideo());
    prisma.shareLinkRecord.maxViews = 1;

    const response = await service.resolvePublicWatch({ host, token });
    const thumbnailUrl = response.videos[0]?.thumbnailUrl;
    assert.ok(thumbnailUrl);
    const grant = new URL(
      thumbnailUrl,
      "https://api.example.com",
    ).searchParams.get("grant");
    assert.ok(grant);
    assert.equal(prisma.shareLinkRecord.currentViews, 1);

    await assert.rejects(
      service.getPublicLocalThumbnail({ host, token, videoId: "video-1" }),
      NotFoundException,
    );
    await assert.doesNotReject(
      service.getPublicLocalThumbnail({
        host,
        token,
        videoId: "video-1",
        grant,
      }),
    );
  });

  it("allows at most one concurrent public watch at the final view", async () => {
    const { prisma, service } = createService(createLocalFileVideo());
    prisma.shareLinkRecord.maxViews = 1;

    const responses = await Promise.all([
      service.resolvePublicWatch({ host, token }),
      service.resolvePublicWatch({ host, token }),
    ]);

    assert.equal(responses.filter((response) => response.valid).length, 1);
    assert.equal(responses.filter((response) => !response.valid).length, 1);
    assert.equal(prisma.shareLinkRecord.currentViews, 1);
  });

  it("invalidates watch and media when the active website assignment is removed", async () => {
    const { prisma, service } = createService(createLocalFileVideo());
    prisma.assignmentActive = false;

    const response = await service.resolvePublicWatch({ host, token });
    assert.deepEqual(response, {
      valid: false,
      reasonCode: "INVALID_LINK",
      website: null,
      videos: [],
    });
    await assert.rejects(
      service.getPublicLocalThumbnail({ host, token, videoId: "video-1" }),
      NotFoundException,
    );
  });

  it("keeps public watch response generic after a share link is disabled", async () => {
    const { service, prisma } = createService(createLocalFileVideo());
    prisma.shareLinkRecord.status = ShareLinkStatus.DISABLED;

    const response = await service.resolvePublicWatch({ host, token });

    assert.equal(response.valid, false);
    assert.equal(response.reasonCode, "INVALID_LINK");
    assert.deepEqual(response.videos, []);
  });

  it("uses the same invalid shape for token, host, expiry, limit, and video failures", async () => {
    const expected = {
      valid: false,
      reasonCode: "INVALID_LINK",
      website: null,
      videos: [],
    } as const;
    const wrongToken = createService(createLocalFileVideo());
    assert.deepEqual(
      await wrongToken.service.resolvePublicWatch({ host, token: "wrong" }),
      expected,
    );

    const wrongHost = createService(createLocalFileVideo());
    assert.deepEqual(
      await wrongHost.service.resolvePublicWatch({
        host: "other.example.com",
        token,
      }),
      expected,
    );

    const expired = createService(createLocalFileVideo());
    expired.prisma.shareLinkRecord.expiresAt = new Date(0);
    assert.deepEqual(
      await expired.service.resolvePublicWatch({ host, token }),
      expected,
    );

    const limited = createService(createLocalFileVideo());
    limited.prisma.shareLinkRecord.maxViews = 1;
    limited.prisma.shareLinkRecord.currentViews = 1;
    assert.deepEqual(
      await limited.service.resolvePublicWatch({ host, token }),
      expected,
    );

    const disabledVideo = createService(
      createLocalFileVideo({ status: VideoStatus.DISABLED }),
    );
    assert.deepEqual(
      await disabledVideo.service.resolvePublicWatch({ host, token }),
      expected,
    );
  });
});

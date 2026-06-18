import "reflect-metadata";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { NotFoundException } from "@nestjs/common";
import {
  AccessLogStatus,
  DomainStatus,
  ShareLinkStatus,
  VideoSourceType,
  VideoStatus,
  WebsiteStatus,
} from "../src/generated/prisma/client";
import { PublicService } from "../src/public/public.service";
import { hashShareToken } from "../src/public/utils/share-token.util";

const token = "test-share-token";
const shareAlias = "AbCd123";
const tokenPepper = "test-share-token-pepper";
const tokenHash = hashShareToken({ pepper: tokenPepper, token });
const host = "localhost:5500";

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

    return undefined;
  }
}

class FakePrismaService {
  shareLinkRecord: FakeShareLink;
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
      const shareLinkVideos =
        requestedVideoId === undefined
          ? this.shareLinkRecord.shareLinkVideos
          : this.shareLinkRecord.shareLinkVideos.filter(
              ({ video }) => video.id === requestedVideoId,
            );

      return {
        ...this.shareLinkRecord,
        shareLinkVideos,
      };
    },
    updateMany: async (): Promise<{ count: number }> => {
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

function createService(video: FakeVideo): {
  prisma: FakePrismaService;
  service: PublicService;
} {
  const prisma = new FakePrismaService(video);
  const service = new PublicService(
    prisma as never,
    new FakeConfigService() as never,
    new FakeLocalVideoStorageService() as never,
    new FakeVideoViewGrowthService() as never,
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
});

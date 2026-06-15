import "reflect-metadata";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { VideoViewGrowthService } from "../src/videos/video-view-growth.service";

type FakeVideo = {
  id: string;
  viewCount: bigint;
  publishedAt: Date | null;
};

type FakeEvent = {
  id: string;
  videoId: string;
  shareLinkId: string;
  websiteId: string;
  viewerHash: string;
  windowStart: Date;
  increment: number;
  createdAt: Date;
};

type FakeBucket = {
  id: string;
  videoId: string;
  bucketStart: Date;
  incrementTotal: number;
};

type GrowthConfig = {
  enabled: boolean;
  maxIncrementPerEvent: number;
  maxIncrementPerVideoHour: number;
  dedupeWindowMinutes: number;
  minWatchSeconds: number;
  randomMinIncrement: number;
};

class FakeConfigService {
  constructor(private readonly growthConfig: GrowthConfig) {}

  getOrThrow<T = unknown>(key: string): T {
    if (key === "api") {
      return {
        videoViewGrowth: this.growthConfig,
      } as T;
    }

    if (key === "ACCESS_LOG_IP_PEPPER") {
      return "test-ip-pepper" as T;
    }

    throw new Error(`${key} missing`);
  }
}

class FakePrismaService {
  readonly videos = new Map<string, FakeVideo>();
  readonly events = new Map<string, FakeEvent>();
  readonly buckets = new Map<string, FakeBucket>();

  private nextEvent = 1;
  private nextBucket = 1;

  videoAsset = {
    findUnique: async (args: {
      where: { id: string };
    }): Promise<FakeVideo | null> => {
      return this.videos.get(args.where.id) ?? null;
    },
    update: async (args: {
      where: { id: string };
      data: { viewCount: { increment: number } };
    }): Promise<FakeVideo> => {
      const video = this.videos.get(args.where.id);
      assert.ok(video);

      const updated = {
        ...video,
        viewCount: video.viewCount + BigInt(args.data.viewCount.increment),
      };
      this.videos.set(video.id, updated);

      return updated;
    },
  };

  videoViewGrowthEvent = {
    findUnique: async (args: {
      where: {
        videoId_viewerHash_windowStart: {
          videoId: string;
          viewerHash: string;
          windowStart: Date;
        };
      };
    }): Promise<{ id: string } | null> => {
      const key = this.eventKey(args.where.videoId_viewerHash_windowStart);
      const event = this.events.get(key);

      return event === undefined ? null : { id: event.id };
    },
    findFirst: async (args: {
      where: { videoId: string; increment: { gt: number } };
    }): Promise<{ createdAt: Date } | null> => {
      const events = Array.from(this.events.values())
        .filter(
          (event) =>
            event.videoId === args.where.videoId &&
            event.increment > args.where.increment.gt,
        )
        .sort(
          (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
        );

      return events[0] ? { createdAt: events[0].createdAt } : null;
    },
    create: async (args: {
      data: Omit<FakeEvent, "id">;
    }): Promise<FakeEvent> => {
      const key = this.eventKey(args.data);
      assert.equal(this.events.has(key), false);

      const event = {
        id: `event-${this.nextEvent++}`,
        ...args.data,
      };
      this.events.set(key, event);

      return event;
    },
  };

  videoViewGrowthBucket = {
    upsert: async (args: {
      where: {
        videoId_bucketStart: {
          videoId: string;
          bucketStart: Date;
        };
      };
      create: {
        videoId: string;
        bucketStart: Date;
        incrementTotal: number;
      };
    }): Promise<{ incrementTotal: number }> => {
      const key = this.bucketKey(args.where.videoId_bucketStart);
      const existing = this.buckets.get(key);

      if (existing !== undefined) {
        return { incrementTotal: existing.incrementTotal };
      }

      const bucket = {
        id: `bucket-${this.nextBucket++}`,
        ...args.create,
      };
      this.buckets.set(key, bucket);

      return { incrementTotal: bucket.incrementTotal };
    },
    updateMany: async (args: {
      where: {
        videoId: string;
        bucketStart: Date;
        incrementTotal: { lte: number };
      };
      data: { incrementTotal: { increment: number } };
    }): Promise<{ count: number }> => {
      const key = this.bucketKey(args.where);
      const bucket = this.buckets.get(key);

      if (
        bucket === undefined ||
        bucket.incrementTotal > args.where.incrementTotal.lte
      ) {
        return { count: 0 };
      }

      bucket.incrementTotal += args.data.incrementTotal.increment;
      this.buckets.set(key, bucket);

      return { count: 1 };
    },
  };

  async $transaction<T>(callback: (tx: this) => Promise<T>): Promise<T> {
    return callback(this);
  }

  private eventKey(params: {
    videoId: string;
    viewerHash: string;
    windowStart: Date;
  }): string {
    return `${params.videoId}:${params.viewerHash}:${params.windowStart.toISOString()}`;
  }

  private bucketKey(params: { videoId: string; bucketStart: Date }): string {
    return `${params.videoId}:${params.bucketStart.toISOString()}`;
  }
}

function createService(params?: { growthConfig?: Partial<GrowthConfig> }): {
  prisma: FakePrismaService;
  service: VideoViewGrowthService;
} {
  const prisma = new FakePrismaService();
  const growthConfig: GrowthConfig = {
    enabled: true,
    maxIncrementPerEvent: 99,
    maxIncrementPerVideoHour: 5000,
    dedupeWindowMinutes: 15,
    minWatchSeconds: 5,
    randomMinIncrement: 1,
    ...params?.growthConfig,
  };
  const service = new VideoViewGrowthService(
    prisma as never,
    new FakeConfigService(growthConfig) as never,
  );

  prisma.videos.set("video-1", {
    id: "video-1",
    viewCount: 1231100n,
    publishedAt: new Date("2026-06-14T00:00:00.000Z"),
  });

  return { prisma, service };
}

describe("VideoViewGrowthService", () => {
  let now: Date;

  beforeEach(() => {
    now = new Date("2026-06-15T11:21:00.000Z");
  });

  it("increments the display view counter under the per-event cap", async () => {
    const { service } = createService();

    const result = await service.recordPublicVideoView({
      videoId: "video-1",
      shareLinkId: "share-1",
      websiteId: "website-1",
      requestMeta: {
        ip: "203.0.113.10",
        userAgent: "Test browser",
      },
      now,
    });

    const increment = Number(result.viewCount) - 1231100;

    assert.equal(result.videoId, "video-1");
    assert.ok(increment >= 1);
    assert.ok(increment <= 99);
    assert.equal(result.publishedAt, "2026-06-14T00:00:00.000Z");
  });

  it("does not increment twice for the same viewer/video/window", async () => {
    const { service } = createService({
      growthConfig: {
        maxIncrementPerEvent: 10,
        randomMinIncrement: 10,
      },
    });
    const request = {
      videoId: "video-1",
      shareLinkId: "share-1",
      websiteId: "website-1",
      requestMeta: {
        ip: "203.0.113.10",
        userAgent: "Test browser",
      },
      now,
    };

    const first = await service.recordPublicVideoView(request);
    const second = await service.recordPublicVideoView(request);

    assert.equal(first.viewCount, "1231110");
    assert.equal(second.viewCount, "1231110");
  });

  it("caps growth per video per hour", async () => {
    const { service } = createService({
      growthConfig: {
        maxIncrementPerEvent: 10,
        maxIncrementPerVideoHour: 15,
        randomMinIncrement: 10,
      },
    });

    await service.recordPublicVideoView({
      videoId: "video-1",
      shareLinkId: "share-1",
      websiteId: "website-1",
      requestMeta: { ip: "203.0.113.10", userAgent: "Browser one" },
      now,
    });
    const second = await service.recordPublicVideoView({
      videoId: "video-1",
      shareLinkId: "share-1",
      websiteId: "website-1",
      requestMeta: { ip: "203.0.113.11", userAgent: "Browser two" },
      now,
    });
    const third = await service.recordPublicVideoView({
      videoId: "video-1",
      shareLinkId: "share-1",
      websiteId: "website-1",
      requestMeta: { ip: "203.0.113.12", userAgent: "Browser three" },
      now,
    });

    assert.equal(second.viewCount, "1231115");
    assert.equal(third.viewCount, "1231115");
  });

  it("returns the current counter without writes when view growth is disabled", async () => {
    const { prisma, service } = createService({
      growthConfig: {
        enabled: false,
      },
    });

    const result = await service.recordPublicVideoView({
      videoId: "video-1",
      shareLinkId: "share-1",
      websiteId: "website-1",
      requestMeta: { ip: "203.0.113.10", userAgent: "Test browser" },
      now,
    });

    assert.equal(result.viewCount, "1231100");
    assert.equal(prisma.events.size, 0);
    assert.equal(prisma.buckets.size, 0);
  });
});

import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AdminWebsitesService } from "../src/admin-websites/admin-websites.service";
import { readDatabaseStage } from "../src/common/errors/safe-database-error-context.util";
import {
  AssignmentStatus,
  AuditStatus,
  Prisma,
  VideoProvider,
  VideoSourceType,
  VideoStatus,
  WebsiteStatus,
} from "../src/generated/prisma/client";

const now = new Date("2026-07-16T00:00:00.000Z");

function video(overrides: Record<string, unknown> = {}) {
  return {
    id: "video-1",
    title: "Video 1",
    slug: "video-1",
    description: null,
    provider: VideoProvider.MANUAL,
    sourceType: VideoSourceType.DIRECT_URL,
    providerAssetId: null,
    playbackId: null,
    playbackUrl: "https://media.example/video.mp4",
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
    binaryAsset: null,
    localFileAsset: null,
    localThumbnailAsset: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function service(prisma: unknown) {
  return new AdminWebsitesService(
    prisma as never,
    { get: () => "test-share-pepper" } as never,
    { clearDomainOriginCache: () => undefined } as never,
  );
}

describe("website video assignment", () => {
  it("scopes the eligible picker query by website and assignment", async () => {
    let findManyArgs: Record<string, unknown> | undefined;
    let countCall = 0;
    const prisma = {
      website: { findUnique: async () => ({ id: "website-1" }) },
      websiteVideo: {
        count: async () => {
          countCall += 1;
          return countCall;
        },
        findMany: async (args: Record<string, unknown>) => {
          findManyArgs = args;
          return [];
        },
      },
      $transaction: async (operations: Array<Promise<unknown>>) =>
        Promise.all(operations),
    };

    const result = await service(prisma).listAssignedVideos("website-1", {
      page: 2,
      limit: 10,
      search: "video",
      status: VideoStatus.READY,
      sourceType: VideoSourceType.DIRECT_URL,
      assignmentStatus: AssignmentStatus.ACTIVE,
      eligibleForShareLink: true,
      sortBy: "createdAt",
      sortOrder: "desc",
    });

    const where = findManyArgs?.where as {
      websiteId?: string;
      status?: AssignmentStatus;
      video?: { is?: Record<string, unknown> };
    };
    assert.equal(where.websiteId, "website-1");
    assert.equal(where.status, AssignmentStatus.ACTIVE);
    assert.equal(where.video?.is?.status, VideoStatus.READY);
    assert.equal(where.video?.is?.sourceType, VideoSourceType.DIRECT_URL);
    assert.equal(findManyArgs?.skip, 10);
    assert.equal(findManyArgs?.take, 10);
    assert.equal(result.meta?.page, 2);
  });

  it("preserves the database error and tags an assigned-list query failure", async () => {
    const databaseError = new Prisma.PrismaClientKnownRequestError(
      "query failed",
      {
        code: "P2024",
        clientVersion: "7.8.0",
        meta: {},
      },
    );
    const prisma = {
      website: { findUnique: async () => ({ id: "website-1" }) },
      websiteVideo: {
        count: async () => 0,
        findMany: async () => [],
      },
      $transaction: async () => {
        throw databaseError;
      },
    };

    let caught: unknown;
    try {
      await service(prisma).listAssignedVideos("website-1", {
        page: 1,
        limit: 24,
      });
    } catch (error) {
      caught = error;
    }

    assert.equal(caught, databaseError);
    assert.equal(
      readDatabaseStage(caught),
      "WEBSITE_ASSIGNED_VIDEO_LIST_QUERY",
    );
  });

  it("assigns once or reactivates idempotently and writes audit in the transaction", async () => {
    let assignment: Record<string, unknown> | null = null;
    let auditWrites = 0;
    let upserts = 0;
    let transactionCalls = 0;
    const playableVideo = video();
    const tx = {
      website: {
        findUnique: async () => ({
          id: "website-1",
          status: WebsiteStatus.ACTIVE,
        }),
      },
      videoAsset: { findUnique: async () => playableVideo },
      websiteVideo: {
        findUnique: async () =>
          assignment === null ? null : { sortOrder: assignment.sortOrder },
        aggregate: async () => ({ _max: { sortOrder: null } }),
        upsert: async () => {
          upserts += 1;
          assignment = {
            id: "assignment-1",
            websiteId: "website-1",
            videoId: "video-1",
            sortOrder: 0,
            isFeatured: false,
            status: AssignmentStatus.ACTIVE,
            createdAt: now,
            updatedAt: now,
            video: playableVideo,
          };
          return assignment;
        },
      },
      adminAuditLog: {
        create: async (args: { data: { status: AuditStatus } }) => {
          auditWrites += 1;
          assert.equal(args.data.status, AuditStatus.SUCCESS);
          return { id: `audit-${auditWrites}` };
        },
      },
    };
    const prisma = {
      $transaction: async (callback: (client: unknown) => Promise<unknown>) => {
        transactionCalls += 1;
        if (transactionCalls === 1) {
          throw new Prisma.PrismaClientKnownRequestError("write conflict", {
            code: "P2034",
            clientVersion: "7.8.0",
          });
        }
        return callback(tx);
      },
    };
    const websiteService = service(prisma);

    const first = await websiteService.assignSingleVideo(
      "website-1",
      "video-1",
      "admin-1",
    );
    const second = await websiteService.assignSingleVideo(
      "website-1",
      "video-1",
      "admin-1",
    );

    assert.equal(first.videoId, "video-1");
    assert.equal(second.id, first.id);
    assert.equal(upserts, 2);
    assert.equal(auditWrites, 2);
    assert.equal(transactionCalls, 3);
  });

  it("rejects a non-playable video before assignment", async () => {
    let upserts = 0;
    const tx = {
      website: {
        findUnique: async () => ({
          id: "website-1",
          status: WebsiteStatus.ACTIVE,
        }),
      },
      videoAsset: {
        findUnique: async () => video({ playbackUrl: "" }),
      },
      websiteVideo: {
        upsert: async () => {
          upserts += 1;
        },
      },
    };
    const prisma = {
      $transaction: async (callback: (client: unknown) => Promise<unknown>) =>
        callback(tx),
    };

    await assert.rejects(
      service(prisma).assignSingleVideo("website-1", "video-1", "admin-1"),
    );
    assert.equal(upserts, 0);
  });
});

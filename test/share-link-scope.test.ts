import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { AdminWebsitesService } from "../src/admin-websites/admin-websites.service";
import {
  AssignmentStatus,
  VideoSourceType,
  VideoStatus,
  WebsiteStatus,
} from "../src/generated/prisma/client";

type CandidateOverrides = {
  id?: string;
  status?: VideoStatus;
  sourceType?: VideoSourceType;
  playbackUrl?: string | null;
  assignmentStatus?: AssignmentStatus | null;
};

function candidate(overrides: CandidateOverrides = {}) {
  const id = overrides.id ?? "video-1";
  const assignmentStatus =
    overrides.assignmentStatus === undefined
      ? AssignmentStatus.ACTIVE
      : overrides.assignmentStatus;

  return {
    id,
    title: id,
    status: overrides.status ?? VideoStatus.READY,
    sourceType: overrides.sourceType ?? VideoSourceType.DIRECT_URL,
    playbackUrl:
      overrides.playbackUrl === undefined
        ? "https://media.example/video.mp4"
        : overrides.playbackUrl,
    embedUrl: null,
    binaryAsset: null,
    localFileAsset: null,
    websiteVideos:
      assignmentStatus === null
        ? []
        : [{ websiteId: "website-1", status: assignmentStatus }],
  };
}

function createHarness(options: {
  preflightVideos: unknown[];
  transactionVideos?: unknown[];
}) {
  let transactionCalls = 0;
  let shareLinkCreateCalls = 0;
  let shareLinkVideoCreateCalls = 0;
  let videoQueryCalls = 0;
  const createdAt = new Date("2026-07-16T00:00:00.000Z");
  const prisma = {
    website: {
      findUnique: async () => ({
        id: "website-1",
        status: WebsiteStatus.ACTIVE,
      }),
    },
    websiteVideo: { findMany: async () => [] },
    videoAsset: {
      findMany: async () => {
        videoQueryCalls += 1;
        return options.preflightVideos;
      },
    },
    websiteDomain: {
      findFirst: async () => ({ domain: "public.example" }),
    },
    adminAuditLog: { create: async () => ({ id: "audit-1" }) },
    $transaction: async (
      callback: (tx: unknown) => Promise<unknown>,
      _transactionOptions?: unknown,
    ) => {
      transactionCalls += 1;
      const tx = {
        website: {
          findUnique: async () => ({ status: WebsiteStatus.ACTIVE }),
        },
        videoAsset: {
          findMany: async () => {
            videoQueryCalls += 1;
            return options.transactionVideos ?? options.preflightVideos;
          },
        },
        shareLink: {
          create: async () => {
            shareLinkCreateCalls += 1;
            return { id: "share-1" };
          },
          findUniqueOrThrow: async () => ({
            id: "share-1",
            websiteId: "website-1",
            alias: "Alias123",
            label: null,
            status: "ACTIVE",
            expiresAt: null,
            maxViews: null,
            currentViews: 0,
            createdAt,
            updatedAt: createdAt,
            lastViewedAt: null,
            shareLinkVideos: options.preflightVideos.map((video, index) => ({
              id: `join-${index}`,
              videoId: (video as { id: string }).id,
              sortOrder: index,
              video,
            })),
          }),
        },
        shareLinkVideo: {
          create: async () => {
            shareLinkVideoCreateCalls += 1;
            return { id: `join-${shareLinkVideoCreateCalls}` };
          },
        },
      };

      return callback(tx);
    },
  };
  const config = {
    get: (key: string) =>
      key === "SHARE_TOKEN_PEPPER" ? "test-share-pepper" : undefined,
  };
  const service = new AdminWebsitesService(
    prisma as never,
    config as never,
    { clearDomainOriginCache: () => undefined } as never,
  );

  return {
    service,
    counts: () => ({
      transactionCalls,
      shareLinkCreateCalls,
      shareLinkVideoCreateCalls,
      videoQueryCalls,
    }),
  };
}

function readBadRequest(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof BadRequestException)) {
    return null;
  }

  const response = error.getResponse();
  return typeof response === "object" && response !== null
    ? (response as Record<string, unknown>)
    : null;
}

describe("share-link website scope", () => {
  it("creates a link only for ACTIVE assigned READY/playable videos", async () => {
    const harness = createHarness({ preflightVideos: [candidate()] });

    const result = await harness.service.createShareLink(
      "website-1",
      { videoIds: ["video-1"] },
      "admin-1",
    );

    assert.equal(result.shareLink.videos[0]?.videoId, "video-1");
    assert.equal(
      Object.prototype.hasOwnProperty.call(result, "rawToken"),
      true,
      "generic review bundles keep their one-time raw-token contract",
    );
    assert.equal(typeof result.rawToken, "string");
    assert.ok(result.rawToken.length > 0);
    assert.deepEqual(harness.counts(), {
      transactionCalls: 1,
      shareLinkCreateCalls: 1,
      shareLinkVideoCreateCalls: 1,
      videoQueryCalls: 2,
    });
  });

  it("returns one stable structured error containing every invalid category", async () => {
    const videos = [
      candidate({ id: "not-ready", status: VideoStatus.DRAFT }),
      candidate({ id: "not-playable", playbackUrl: "" }),
      candidate({ id: "missing-assignment", assignmentStatus: null }),
      candidate({
        id: "inactive-assignment",
        assignmentStatus: AssignmentStatus.DISABLED,
      }),
    ];
    const requested = [
      "not-found",
      "not-ready",
      "not-playable",
      "missing-assignment",
      "inactive-assignment",
    ];
    const harness = createHarness({ preflightVideos: videos });

    await assert.rejects(
      harness.service.createShareLink(
        "website-1",
        { videoIds: requested },
        "admin-1",
      ),
      (error: unknown) => {
        const response = readBadRequest(error);
        const details = response?.details as Record<string, string[]>;

        assert.equal(response?.code, "VIDEO_NOT_ACTIVE_FOR_WEBSITE");
        assert.deepEqual(details.invalidVideoIds, requested);
        assert.deepEqual(details.notFoundVideoIds, ["not-found"]);
        assert.deepEqual(details.notReadyVideoIds, ["not-ready"]);
        assert.deepEqual(details.notPlayableVideoIds, ["not-playable"]);
        assert.deepEqual(details.missingAssignmentVideoIds, [
          "missing-assignment",
        ]);
        assert.deepEqual(details.inactiveAssignmentVideoIds, [
          "inactive-assignment",
        ]);
        return true;
      },
    );

    assert.equal(harness.counts().transactionCalls, 0);
    assert.equal(harness.counts().shareLinkCreateCalls, 0);
  });

  it("rechecks assignments inside the transaction and creates no partial link", async () => {
    const harness = createHarness({
      preflightVideos: [candidate()],
      transactionVideos: [
        candidate({ assignmentStatus: AssignmentStatus.DISABLED }),
      ],
    });

    await assert.rejects(
      harness.service.createShareLink(
        "website-1",
        { videoIds: ["video-1"] },
        "admin-1",
      ),
      (error: unknown) =>
        readBadRequest(error)?.code === "VIDEO_NOT_ACTIVE_FOR_WEBSITE",
    );

    assert.equal(harness.counts().transactionCalls, 1);
    assert.equal(harness.counts().shareLinkCreateCalls, 0);
    assert.equal(harness.counts().shareLinkVideoCreateCalls, 0);
  });

  it("normalizes duplicate IDs before validation and insert", async () => {
    const harness = createHarness({ preflightVideos: [candidate()] });

    await harness.service.createShareLink(
      "website-1",
      { videoIds: [" video-1 ", "video-1"] },
      "admin-1",
    );

    assert.equal(harness.counts().shareLinkVideoCreateCalls, 1);
  });
});

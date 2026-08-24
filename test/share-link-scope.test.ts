import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { AdminWebsitesService } from "../src/admin-websites/admin-websites.service";
import {
  AssignmentStatus,
  VideoProvider,
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
  // Additive Bunny fields. Every default below is unchanged, so existing cases
  // behave exactly as before.
  provider?: VideoProvider;
  embedUrl?: string | null;
  providerAssetId?: string | null;
  playbackId?: string | null;
  metadataJson?: unknown;
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
    provider: overrides.provider ?? VideoProvider.MANUAL,
    sourceType: overrides.sourceType ?? VideoSourceType.DIRECT_URL,
    playbackUrl:
      overrides.playbackUrl === undefined
        ? "https://media.example/video.mp4"
        : overrides.playbackUrl,
    embedUrl: overrides.embedUrl ?? null,
    providerAssetId: overrides.providerAssetId ?? null,
    playbackId: overrides.playbackId ?? null,
    metadataJson: overrides.metadataJson ?? null,
    binaryAsset: null,
    localFileAsset: null,
    websiteVideos:
      assignmentStatus === null
        ? []
        : [{ websiteId: "website-1", status: assignmentStatus }],
  };
}

const BUNNY_GUID = "11111111-2222-3333-4444-555555555555";
const BUNNY_UNSIGNED_EMBED = `https://iframe.mediadelivery.net/embed/987654/${BUNNY_GUID}`;

/** Exactly the shape `initBunnyVideoUpload()` writes. */
function bunnyCandidate(overrides: CandidateOverrides = {}) {
  return candidate({
    id: "video-bunny",
    provider: VideoProvider.BUNNY,
    sourceType: VideoSourceType.EMBED,
    playbackUrl: null,
    embedUrl: BUNNY_UNSIGNED_EMBED,
    providerAssetId: BUNNY_GUID,
    playbackId: BUNNY_GUID,
    metadataJson: { bunnyStream: { videoId: BUNNY_GUID, libraryId: "987654" } },
    ...overrides,
  });
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

/* ------------------------------------------------------------------ *
 * Bunny-backed videos in share links
 *
 * A Bunny asset is `provider: BUNNY` + `sourceType: EMBED` with the stored
 * UNSIGNED embed URL as its stable identity. It must go through exactly the
 * same eligibility gate as every other source type - no Bunny bypass - and
 * share-link creation must never mint or persist a signed playback URL.
 * ------------------------------------------------------------------ */

describe("share links accept Bunny-backed videos", () => {
  it("creates a link for a READY Bunny video ACTIVE-assigned to an ACTIVE website", async () => {
    const harness = createHarness({ preflightVideos: [bunnyCandidate()] });

    const result = await harness.service.createShareLink(
      "website-1",
      { videoIds: ["video-bunny"] } as never,
      "admin-1",
    );

    assert.equal(typeof result.rawToken, "string");
    assert.ok(result.rawToken.length > 0);
    assert.equal(harness.counts().shareLinkCreateCalls, 1);
    assert.equal(harness.counts().shareLinkVideoCreateCalls, 1);
  });

  it("REJECTS a Bunny video that is not assigned to the website", async () => {
    // The exact production failure: the video exists and is READY, but no
    // WebsiteVideo row links it to this website.
    const harness = createHarness({
      preflightVideos: [bunnyCandidate({ assignmentStatus: null })],
    });

    await assert.rejects(
      harness.service.createShareLink(
        "website-1",
        { videoIds: ["video-bunny"] } as never,
        "admin-1",
      ),
      (error: unknown) => {
        const body = readBadRequest(error);
        assert.equal(body?.code, "VIDEO_NOT_ACTIVE_FOR_WEBSITE");
        const details = body?.details as Record<string, string[]>;
        assert.deepEqual(details.missingAssignmentVideoIds, ["video-bunny"]);
        // Proves it is the ASSIGNMENT, not Bunny classification, that failed.
        assert.deepEqual(details.notPlayableVideoIds, []);
        assert.deepEqual(details.notReadyVideoIds, []);
        assert.deepEqual(details.notFoundVideoIds, []);
        return true;
      },
    );
    assert.equal(harness.counts().shareLinkCreateCalls, 0);
  });

  it("REJECTS a Bunny video whose assignment is DISABLED", async () => {
    const harness = createHarness({
      preflightVideos: [
        bunnyCandidate({ assignmentStatus: AssignmentStatus.DISABLED }),
      ],
    });

    await assert.rejects(
      harness.service.createShareLink(
        "website-1",
        { videoIds: ["video-bunny"] } as never,
        "admin-1",
      ),
      (error: unknown) => {
        const details = readBadRequest(error)?.details as Record<
          string,
          string[]
        >;
        assert.deepEqual(details.inactiveAssignmentVideoIds, ["video-bunny"]);
        return true;
      },
    );
    assert.equal(harness.counts().shareLinkCreateCalls, 0);
  });

  it("REJECTS a Bunny video that is still PROCESSING", async () => {
    const harness = createHarness({
      preflightVideos: [bunnyCandidate({ status: VideoStatus.PROCESSING })],
    });

    await assert.rejects(
      harness.service.createShareLink(
        "website-1",
        { videoIds: ["video-bunny"] } as never,
        "admin-1",
      ),
      (error: unknown) => {
        const details = readBadRequest(error)?.details as Record<
          string,
          string[]
        >;
        assert.deepEqual(details.notReadyVideoIds, ["video-bunny"]);
        return true;
      },
    );
    assert.equal(harness.counts().shareLinkCreateCalls, 0);
  });

  it("REJECTS a Bunny EMBED record carrying no embed URL", async () => {
    const harness = createHarness({
      preflightVideos: [bunnyCandidate({ embedUrl: null })],
    });

    await assert.rejects(
      harness.service.createShareLink(
        "website-1",
        { videoIds: ["video-bunny"] } as never,
        "admin-1",
      ),
      (error: unknown) => {
        const details = readBadRequest(error)?.details as Record<
          string,
          string[]
        >;
        assert.deepEqual(details.notPlayableVideoIds, ["video-bunny"]);
        return true;
      },
    );
    assert.equal(harness.counts().shareLinkCreateCalls, 0);
  });

  it("NEVER mints or persists a signed Bunny playback URL at creation time", async () => {
    // Signing belongs to authorized public resolution, strictly after the
    // atomic view consumption. Creating a link must only record relationships.
    // `AdminWebsitesService` is constructed with no Bunny collaborator at all,
    // which is itself the structural proof.
    const harness = createHarness({ preflightVideos: [bunnyCandidate()] });

    const result = await harness.service.createShareLink(
      "website-1",
      { videoIds: ["video-bunny"] } as never,
      "admin-1",
    );

    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /[?&]token=/);
    assert.doesNotMatch(serialized, /[?&]expires=/);
    // Stronger than "not signed": creation emits NO Bunny playback URL at all,
    // signed or unsigned. It records relationships and the one-time share
    // credential, nothing about how the bytes are reached.
    assert.doesNotMatch(serialized, /iframe\.mediadelivery\.net/);
    assert.equal(result.shareLink.videos[0]?.videoId, "video-bunny");
  });

  it("REJECTS a reconciled remote-missing Bunny video, with no Bunny bypass", async () => {
    // THE REGRESSION THIS GUARDS. Someone deletes the video in the Bunny
    // dashboard; a sync reconciles it to FAILED and stamps the remote-missing
    // marker. Creating a NEW share link from it must then fail through the
    // EXISTING eligibility gate - `status !== READY` - rather than through some
    // weaker Bunny-specific path. There is deliberately no remote-missing
    // special case in the eligibility code at all.
    const harness = createHarness({
      preflightVideos: [
        bunnyCandidate({
          status: VideoStatus.FAILED,
          metadataJson: {
            bunnyStream: {
              videoId: BUNNY_GUID,
              libraryId: "987654",
              remoteMissing: {
                detectedAt: "2026-08-23T12:00:00.000Z",
                reason: "NOT_FOUND",
              },
            },
          },
        }),
      ],
    });

    await assert.rejects(
      harness.service.createShareLink(
        "website-1",
        { videoIds: ["video-bunny"] } as never,
        "admin-1",
      ),
      (error: unknown) => {
        const body = readBadRequest(error);
        assert.equal(body?.code, "VIDEO_NOT_ACTIVE_FOR_WEBSITE");
        const details = body?.details as Record<string, string[]>;
        assert.deepEqual(details.notReadyVideoIds, ["video-bunny"]);
        return true;
      },
    );
    assert.equal(harness.counts().shareLinkCreateCalls, 0);
  });

  it("REJECTS a remote-missing Bunny video even while its identifiers stay valid", async () => {
    // The provider identifiers are deliberately PRESERVED by reconciliation so
    // the record can still be purged or recovered. That must not read as
    // "still eligible": the local status is the gate, and it is FAILED.
    const harness = createHarness({
      preflightVideos: [
        candidate({ id: "video-direct" }),
        bunnyCandidate({
          status: VideoStatus.FAILED,
          metadataJson: {
            bunnyStream: {
              videoId: BUNNY_GUID,
              libraryId: "987654",
              remoteMissing: {
                detectedAt: "2026-08-23T12:00:00.000Z",
                reason: "NOT_FOUND",
              },
            },
          },
        }),
      ],
    });

    await assert.rejects(
      harness.service.createShareLink(
        "website-1",
        { videoIds: ["video-direct", "video-bunny"] } as never,
        "admin-1",
      ),
      (error: unknown) => {
        const details = readBadRequest(error)?.details as Record<
          string,
          string[]
        >;
        // Only the missing one is rejected - the healthy sibling is untouched.
        assert.deepEqual(details.invalidVideoIds, ["video-bunny"]);
        return true;
      },
    );
    assert.equal(harness.counts().shareLinkCreateCalls, 0);
  });

  it("keeps mixing Bunny with other source types in one link", async () => {
    const harness = createHarness({
      preflightVideos: [
        candidate({ id: "video-direct" }),
        bunnyCandidate(),
        candidate({
          id: "video-embed",
          sourceType: VideoSourceType.EMBED,
          playbackUrl: null,
          embedUrl: "https://www.youtube.com/embed/abc",
        }),
      ],
    });

    const result = await harness.service.createShareLink(
      "website-1",
      { videoIds: ["video-direct", "video-bunny", "video-embed"] } as never,
      "admin-1",
    );

    assert.equal(typeof result.rawToken, "string");
    assert.equal(harness.counts().shareLinkVideoCreateCalls, 3);
  });
});

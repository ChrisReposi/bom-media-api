/**
 * BUNNY STREAM — remote-missing reconciliation.
 *
 * WHY THIS EXISTS. A Bunny video can be deleted outside the CMS, typically by
 * hand in the Bunny dashboard. Before this work the local `VideoAsset` stayed
 * `READY` indefinitely: the admin showed it as fine, preview attempted to play
 * a video that no longer existed, a new share link could still be created from
 * it, and public watch resolution would keep minting freshly signed Bunny
 * playback URLs for it.
 *
 * The reconciliation is deliberately conservative. Two properties are
 * load-bearing and both are asserted here:
 *
 *   1. an AUTHORITATIVE 404 marks the asset remote-missing and makes it
 *      non-playable — but NEVER deletes the local row;
 *   2. a TRANSIENT Bunny failure (timeout, 5xx, 401/403, 429) changes nothing
 *      at all, and in particular never demotes `READY`.
 *
 * That distinction is the whole point. Conflating them would either leave dead
 * assets publicly playable, or let one bad minute of Bunny availability
 * un-publish a working catalogue.
 *
 * Nothing here performs a real network request.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InternalServerErrorException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { BUNNY_VIDEO_STATUS } from "../src/bunny/bunny-stream.constants";
import { BunnyNotFoundError } from "../src/bunny/bunny-stream.service";
import {
  applyBunnyRemoteMissingMarker,
  clearBunnyRemoteMissingMarker,
  isBunnyRemoteMissing,
  readBunnyRemoteMissing,
  readBunnyVideoAsset,
  resolveBunnyRemoteMissingStatus,
} from "../src/bunny/bunny-video-asset.util";
import {
  AuditStatus,
  EmbedProvider,
  VideoProvider,
  VideoSourceType,
  VideoStatus,
} from "../src/generated/prisma/client";
import { VideosService } from "../src/videos/videos.service";
import {
  bunnyStreamVideo,
  BUNNY_VIDEO_GUID,
  createCompatHarness,
  directUrlVideo,
  LEGACY_ALIAS,
  LEGACY_HOST,
  PUBLIC_DENIAL_RESPONSE,
  type CompatVideo,
} from "./share-link-compat-harness";

const LIBRARY_ID = "987654";
const PULL_ZONE_HOSTNAME = "vz-example.b-cdn.net";
const VIDEO_GUID = "11111111-2222-3333-4444-555555555555";
const VIDEO_ID = "video-bunny-missing";

type FakeVideoRow = {
  id: string;
  title: string;
  slug: string | null;
  description: string | null;
  status: VideoStatus;
  provider: VideoProvider;
  sourceType: VideoSourceType;
  providerAssetId: string | null;
  playbackId: string | null;
  playbackUrl: string | null;
  embedProvider: EmbedProvider | null;
  embedUrl: string | null;
  embedCloudName: string | null;
  embedPublicId: string | null;
  embedAllow: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  viewCount: bigint;
  publishedAt: Date | null;
  filterKey: string | null;
  metadataJson: unknown;
  createdAt: Date;
  updatedAt: Date;
};

function bunnyRow(overrides: Partial<FakeVideoRow> = {}): FakeVideoRow {
  return {
    id: VIDEO_ID,
    title: "Test Bunny Video",
    slug: "test-bunny-video",
    description: null,
    status: VideoStatus.READY,
    provider: VideoProvider.BUNNY,
    sourceType: VideoSourceType.EMBED,
    providerAssetId: VIDEO_GUID,
    playbackId: VIDEO_GUID,
    playbackUrl: null,
    embedProvider: EmbedProvider.GENERIC_IFRAME,
    embedUrl: `https://iframe.mediadelivery.net/embed/${LIBRARY_ID}/${VIDEO_GUID}`,
    embedCloudName: null,
    embedPublicId: null,
    embedAllow: null,
    thumbnailUrl: `https://${PULL_ZONE_HOSTNAME}/${VIDEO_GUID}/thumbnail.jpg`,
    durationSeconds: 12,
    viewCount: 0n,
    publishedAt: null,
    filterKey: null,
    metadataJson: {
      thumbnail: { source: "bunny" },
      bunnyStream: {
        videoId: VIDEO_GUID,
        libraryId: LIBRARY_ID,
        createdAt: "2026-08-23T04:25:37.606Z",
      },
    },
    createdAt: new Date("2026-08-23T00:00:00.000Z"),
    updatedAt: new Date("2026-08-23T00:00:00.000Z"),
    ...overrides,
  };
}

type AuditRecord = {
  action: string;
  status: AuditStatus;
  metadataJson: unknown;
};

type BunnyOutcome =
  | { kind: "not-found" }
  | { kind: "transient"; error: Error }
  | { kind: "ok"; status: number };

function createHarness(params: {
  row?: FakeVideoRow;
  outcome: BunnyOutcome;
}): {
  service: VideosService;
  updates: Array<Record<string, unknown>>;
  audits: AuditRecord[];
  deletes: string[];
  rows: Map<string, FakeVideoRow>;
  cacheInvalidations: string[];
} {
  const row = params.row ?? bunnyRow();
  const rows = new Map<string, FakeVideoRow>([[row.id, row]]);
  const updates: Array<Record<string, unknown>> = [];
  const audits: AuditRecord[] = [];
  const deletes: string[] = [];
  const cacheInvalidations: string[] = [];

  const prisma = {
    videoAsset: {
      findUnique: async (args: { where: { id: string } }) =>
        rows.get(args.where.id) ?? null,
      findUniqueOrThrow: async (args: { where: { id: string } }) => {
        const found = rows.get(args.where.id);
        assert.ok(found);
        return found;
      },
      update: async (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        updates.push(args.data);
        const current = rows.get(args.where.id);
        assert.ok(current);
        const next = { ...current, ...args.data } as FakeVideoRow;
        rows.set(args.where.id, next);
        return next;
      },
      // Present ONLY so a stray delete would be visible rather than throwing an
      // unrelated error. Reconciliation must never call it.
      delete: async (args: { where: { id: string } }) => {
        deletes.push(args.where.id);
        rows.delete(args.where.id);
        return {};
      },
    },
    adminAuditLog: {
      create: async (args: {
        data: {
          action: string;
          status: AuditStatus;
          metadataJson: unknown;
        };
      }) => {
        audits.push({
          action: args.data.action,
          status: args.data.status,
          metadataJson: args.data.metadataJson,
        });
        return {};
      },
    },
  };

  const bunny = {
    ensureEnabled: () => undefined,
    getVideo: async () => {
      if (params.outcome.kind === "not-found") {
        throw new BunnyNotFoundError();
      }

      if (params.outcome.kind === "transient") {
        throw params.outcome.error;
      }

      return {
        guid: VIDEO_GUID,
        libraryId: Number(LIBRARY_ID),
        title: "Test Bunny Video",
        status: params.outcome.status,
        encodeProgress: 100,
        length: 12,
        width: 1920,
        height: 1080,
        storageSize: 1234,
        thumbnailFileName: "thumbnail.jpg",
      };
    },
    mapProcessingState: (status: number | null) =>
      status === BUNNY_VIDEO_STATUS.FINISHED
        ? "READY"
        : status === BUNNY_VIDEO_STATUS.ERROR ||
            status === BUNNY_VIDEO_STATUS.UPLOAD_FAILED
          ? "FAILED"
          : "PROCESSING",
    buildThumbnailUrl: () =>
      `https://${PULL_ZONE_HOSTNAME}/${VIDEO_GUID}/thumbnail.jpg`,
  };

  const memoryCache = {
    deleteByPrefix: (prefix: string) => {
      cacheInvalidations.push(prefix);
    },
  };

  const service = new VideosService(
    prisma as never,
    {} as never,
    { get: () => undefined } as never,
    {} as never,
    {} as never,
    memoryCache as never,
    bunny as never,
  );

  return { service, updates, audits, deletes, rows, cacheInvalidations };
}

function readBunnyStreamMetadata(value: unknown): Record<string, unknown> {
  const metadata = value as Record<string, unknown>;
  return metadata.bunnyStream as Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * Authoritative 404
 * ------------------------------------------------------------------ */

describe("Bunny sync — authoritative 404 reconciles instead of failing", () => {
  it("keeps the local row, demotes READY to FAILED and records the marker", async () => {
    const harness = createHarness({ outcome: { kind: "not-found" } });

    const result = await harness.service.syncBunnyVideoStatus(
      VIDEO_ID,
      "admin-1",
    );

    // THE NON-NEGOTIABLE: a 404 never deletes the local record.
    assert.deepEqual(harness.deletes, []);
    assert.ok(harness.rows.has(VIDEO_ID));

    assert.equal(result.remoteMissing, true);
    assert.equal(result.bunnyStatus, null);
    assert.equal(result.encodeProgress, null);
    assert.equal(result.statusChanged, true);
    assert.equal(result.video.status, VideoStatus.FAILED);

    const marker = readBunnyRemoteMissing(result.video.metadataJson);
    assert.ok(marker);
    assert.equal(marker.reason, "NOT_FOUND");
    assert.equal(
      new Date(marker.detectedAt).toISOString(),
      marker.detectedAt,
      "detectedAt must be a round-trippable ISO 8601 instant",
    );
  });

  it("preserves every existing metadata key and provider identifier", async () => {
    const harness = createHarness({ outcome: { kind: "not-found" } });

    const result = await harness.service.syncBunnyVideoStatus(
      VIDEO_ID,
      "admin-1",
    );

    const metadata = result.video.metadataJson as Record<string, unknown>;
    assert.deepEqual(
      metadata.thumbnail,
      { source: "bunny" },
      "unrelated metadata must survive untouched",
    );

    const bunnyStream = readBunnyStreamMetadata(metadata);
    assert.equal(bunnyStream.videoId, VIDEO_GUID);
    assert.equal(bunnyStream.libraryId, LIBRARY_ID);
    assert.equal(bunnyStream.createdAt, "2026-08-23T04:25:37.606Z");

    // The identifiers must still satisfy the strict Bunny predicate, so the
    // record stays purgeable and recoverable.
    assert.deepEqual(readBunnyVideoAsset(result.video), {
      bunnyVideoId: VIDEO_GUID,
      libraryId: LIBRARY_ID,
    });
  });

  it("writes a VIDEO_BUNNY_REMOTE_MISSING audit row with no secret", async () => {
    const harness = createHarness({ outcome: { kind: "not-found" } });

    await harness.service.syncBunnyVideoStatus(VIDEO_ID, "admin-1");

    const audit = harness.audits.find(
      (entry) => entry.action === "VIDEO_BUNNY_REMOTE_MISSING",
    );
    assert.ok(audit);
    assert.equal(audit.status, AuditStatus.FAIL);
    assert.deepEqual(audit.metadataJson, {
      previousStatus: VideoStatus.READY,
      nextStatus: VideoStatus.FAILED,
      bunnyVideoId: VIDEO_GUID,
      remoteResult: "NOT_FOUND",
    });

    const serialized = JSON.stringify(audit.metadataJson);
    for (const forbidden of ["AccessKey", "token", "apiKey", "securityKey"]) {
      assert.doesNotMatch(serialized, new RegExp(forbidden, "i"));
    }
  });

  it("invalidates the admin and public caches so no stale READY view survives", async () => {
    const harness = createHarness({ outcome: { kind: "not-found" } });

    await harness.service.syncBunnyVideoStatus(VIDEO_ID, "admin-1");

    assert.deepEqual(harness.cacheInvalidations, [
      "admin:videos:",
      "media:metadata:",
      "public:watch:",
    ]);
  });

  it("keeps DISABLED as DISABLED — an administrator decision outranks Bunny", async () => {
    const harness = createHarness({
      row: bunnyRow({ status: VideoStatus.DISABLED }),
      outcome: { kind: "not-found" },
    });

    const result = await harness.service.syncBunnyVideoStatus(
      VIDEO_ID,
      "admin-1",
    );

    assert.equal(result.video.status, VideoStatus.DISABLED);
    assert.equal(result.statusChanged, false);
    assert.equal(result.remoteMissing, true);
    assert.equal(isBunnyRemoteMissing(result.video.metadataJson), true);
    assert.deepEqual(harness.deletes, []);
  });

  it("is idempotent: a second sync rewrites nothing and keeps the first detectedAt", async () => {
    const harness = createHarness({ outcome: { kind: "not-found" } });

    const first = await harness.service.syncBunnyVideoStatus(
      VIDEO_ID,
      "admin-1",
    );
    const firstMarker = readBunnyRemoteMissing(first.video.metadataJson);
    assert.ok(firstMarker);

    const updateCountAfterFirst = harness.updates.length;
    const auditCountAfterFirst = harness.audits.length;

    const second = await harness.service.syncBunnyVideoStatus(
      VIDEO_ID,
      "admin-1",
    );

    assert.equal(harness.updates.length, updateCountAfterFirst);
    assert.equal(harness.audits.length, auditCountAfterFirst);
    assert.equal(second.remoteMissing, true);
    assert.equal(
      readBunnyRemoteMissing(second.video.metadataJson)?.detectedAt,
      firstMarker.detectedAt,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Transient failure
 * ------------------------------------------------------------------ */

describe("Bunny sync — a transient failure never means 'deleted'", () => {
  for (const [label, error] of [
    ["5xx", new InternalServerErrorException("Bunny Stream request failed.")],
    [
      "network error / timeout",
      new ServiceUnavailableException("Bunny Stream is currently unreachable."),
    ],
  ] as const) {
    it(`propagates a ${label} truthfully and changes nothing locally`, async () => {
      const harness = createHarness({
        outcome: { kind: "transient", error },
      });

      await assert.rejects(
        harness.service.syncBunnyVideoStatus(VIDEO_ID, "admin-1"),
        (thrown: Error) => {
          assert.equal(thrown, error);
          return true;
        },
      );

      // READY is NOT demoted, no marker is written, nothing is audited.
      assert.deepEqual(harness.updates, []);
      assert.deepEqual(harness.audits, []);
      assert.deepEqual(harness.deletes, []);
      assert.equal(harness.rows.get(VIDEO_ID)?.status, VideoStatus.READY);
      assert.equal(
        isBunnyRemoteMissing(harness.rows.get(VIDEO_ID)?.metadataJson),
        false,
      );
      assert.deepEqual(harness.cacheInvalidations, []);
    });
  }
});

/* ------------------------------------------------------------------ *
 * Recovery
 * ------------------------------------------------------------------ */

describe("Bunny sync — recovery clears the marker", () => {
  function missingRow(status: VideoStatus): FakeVideoRow {
    const base = bunnyRow({ status });
    return {
      ...base,
      metadataJson: applyBunnyRemoteMissingMarker(
        base.metadataJson,
        new Date("2026-08-20T00:00:00.000Z"),
      ).metadata,
    };
  }

  it("promotes a previously remote-missing FAILED asset back to READY", async () => {
    const harness = createHarness({
      row: missingRow(VideoStatus.FAILED),
      outcome: { kind: "ok", status: BUNNY_VIDEO_STATUS.FINISHED },
    });

    const result = await harness.service.syncBunnyVideoStatus(
      VIDEO_ID,
      "admin-1",
    );

    assert.equal(result.remoteMissing, false);
    assert.equal(result.video.status, VideoStatus.READY);
    assert.equal(result.statusChanged, true);
    assert.equal(isBunnyRemoteMissing(result.video.metadataJson), false);

    // Everything else in the marker survives the clear.
    const bunnyStream = readBunnyStreamMetadata(result.video.metadataJson);
    assert.equal(bunnyStream.videoId, VIDEO_GUID);
    assert.equal(bunnyStream.libraryId, LIBRARY_ID);
    assert.equal(bunnyStream.createdAt, "2026-08-23T04:25:37.606Z");

    const audit = harness.audits.find(
      (entry) => entry.action === "VIDEO_BUNNY_REMOTE_RECOVERED",
    );
    assert.ok(audit);
    assert.equal(audit.status, AuditStatus.SUCCESS);
  });

  it("clears the marker without resurrecting a DISABLED asset", async () => {
    const harness = createHarness({
      row: missingRow(VideoStatus.DISABLED),
      outcome: { kind: "ok", status: BUNNY_VIDEO_STATUS.FINISHED },
    });

    const result = await harness.service.syncBunnyVideoStatus(
      VIDEO_ID,
      "admin-1",
    );

    assert.equal(result.video.status, VideoStatus.DISABLED);
    assert.equal(isBunnyRemoteMissing(result.video.metadataJson), false);
  });

  it("leaves an ordinary healthy sync completely unchanged", async () => {
    const harness = createHarness({
      outcome: { kind: "ok", status: BUNNY_VIDEO_STATUS.FINISHED },
    });

    const result = await harness.service.syncBunnyVideoStatus(
      VIDEO_ID,
      "admin-1",
    );

    assert.equal(result.remoteMissing, false);
    assert.equal(result.statusChanged, false);
    assert.equal(result.video.status, VideoStatus.READY);
    assert.equal(result.bunnyStatus, BUNNY_VIDEO_STATUS.FINISHED);
    assert.deepEqual(
      harness.audits,
      [],
      "a no-op sync must not write an audit row",
    );
  });
});

/* ------------------------------------------------------------------ *
 * The metadata helpers themselves
 * ------------------------------------------------------------------ */

describe("Bunny remote-missing metadata helpers", () => {
  it("refuses to invent a bunnyStream block that does not exist", () => {
    for (const metadata of [null, undefined, {}, { thumbnail: {} }, []]) {
      const applied = applyBunnyRemoteMissingMarker(metadata, new Date());
      assert.equal(applied.changed, false);
      assert.equal(isBunnyRemoteMissing(applied.metadata), false);
    }
  });

  it("round-trips apply → clear back to the original metadata", () => {
    const original = {
      thumbnail: { source: "bunny" },
      bunnyStream: {
        videoId: VIDEO_GUID,
        libraryId: LIBRARY_ID,
        createdAt: "2026-08-23T04:25:37.606Z",
      },
    };

    const applied = applyBunnyRemoteMissingMarker(original, new Date());
    assert.equal(applied.changed, true);

    const cleared = clearBunnyRemoteMissingMarker(applied.metadata);
    assert.equal(cleared.changed, true);
    assert.deepEqual(cleared.metadata, original);

    // The input object itself must not be mutated.
    assert.equal(isBunnyRemoteMissing(original), false);
  });

  it("reports no change when clearing metadata that carries no marker", () => {
    const cleared = clearBunnyRemoteMissingMarker({
      bunnyStream: { videoId: VIDEO_GUID },
    });
    assert.equal(cleared.changed, false);
  });

  it("maps every local status to a non-playable one except DISABLED", () => {
    assert.equal(
      resolveBunnyRemoteMissingStatus(VideoStatus.DISABLED),
      VideoStatus.DISABLED,
    );
    for (const status of [
      VideoStatus.READY,
      VideoStatus.PROCESSING,
      VideoStatus.DRAFT,
      VideoStatus.FAILED,
    ]) {
      assert.equal(
        resolveBunnyRemoteMissingStatus(status),
        VideoStatus.FAILED,
        `${status} must become non-playable`,
      );
    }
  });
});

/* ------------------------------------------------------------------ *
 * PUBLIC FAIL-CLOSED
 *
 * The critical property. After reconciliation has marked an asset
 * remote-missing, public watch resolution must mint ZERO new Bunny signed
 * playback URLs for it. The evidence is a signing spy's call count, not an
 * inspection of the response - a response that happened to omit the URL for
 * some other reason would not prove the token was never minted.
 *
 * PERFORMANCE. Note what these tests do NOT need: a Bunny collaborator that
 * answers `getVideo`. Public resolution performs no Bunny GET at all. Remote
 * existence is eventual-consistency state maintained by sync and by the
 * reconciliation script; it is never re-validated per view. The spy here only
 * signs, and a `getVideo` on it would throw.
 * ------------------------------------------------------------------ */

describe("Public watch fails closed for a remote-missing Bunny asset", () => {
  /** Counts every actual mint. Must stay at zero for a missing asset. */
  function createSigningSpy() {
    const spy = {
      signCount: 0,
      canSignCount: 0,
      isEnabled: (): boolean => true,
      canSignEmbedUrl: (): boolean => {
        spy.canSignCount += 1;
        return true;
      },
      createSignedEmbedUrl: (videoId: string) => {
        spy.signCount += 1;
        return {
          embedUrl: `https://iframe.mediadelivery.net/embed/${LIBRARY_ID}/${videoId}?token=deadbeef&expires=1`,
          token: "deadbeef",
          expires: 1,
        };
      },
      // Public resolution must never reach Bunny over the network.
      getVideo: () => {
        throw new Error(
          "public watch resolution must not perform a Bunny GET per view",
        );
      },
    };

    return spy;
  }

  /** The reconciled shape: FAILED plus the remote-missing marker. */
  function remoteMissingBunnyVideo(): CompatVideo {
    const healthy = bunnyStreamVideo();

    return bunnyStreamVideo({
      status: VideoStatus.FAILED,
      metadataJson: applyBunnyRemoteMissingMarker(
        healthy.metadataJson,
        new Date("2026-08-23T12:00:00.000Z"),
      ).metadata,
    });
  }

  it("mints ZERO signed URLs for a single-video share whose only video is missing", async () => {
    const bunnyStream = createSigningSpy();
    const { service } = createCompatHarness({
      videos: [remoteMissingBunnyVideo()],
      bunnyStream,
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(
      bunnyStream.signCount,
      0,
      "a remote-missing asset must never receive a playback credential",
    );
    // The reviewer receives the standard generic denial - no playable iframe.
    assert.deepEqual(response, PUBLIC_DENIAL_RESPONSE);
  });

  it("positive control: the SAME fixture is served and signed while it is healthy", async () => {
    // Without this, the denial above could pass for an unrelated reason.
    const bunnyStream = createSigningSpy();
    const { service } = createCompatHarness({
      videos: [bunnyStreamVideo()],
      bunnyStream,
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.valid, true);
    assert.equal(bunnyStream.signCount, 1);
    assert.match(
      String(response.videos[0]?.embedUrl),
      /iframe\.mediadelivery\.net/,
    );
  });

  it("never emits the stored UNSIGNED Bunny URL as a fallback", async () => {
    const bunnyStream = createSigningSpy();
    const { service } = createCompatHarness({
      videos: [remoteMissingBunnyVideo()],
      bunnyStream,
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.doesNotMatch(
      JSON.stringify(response),
      /iframe\.mediadelivery\.net/,
      "failing closed must never degrade into serving the unsigned URL",
    );
  });

  it("excludes ONLY the missing video from a multi-video share", async () => {
    // A share link is not destroyed because one of its videos went missing.
    // The existing per-video filtering already does the right thing; this pins
    // it so a future change cannot turn one bad asset into a dead share link.
    const bunnyStream = createSigningSpy();
    const { service } = createCompatHarness({
      videos: [remoteMissingBunnyVideo(), directUrlVideo()],
      bunnyStream,
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.valid, true);
    assert.equal(bunnyStream.signCount, 0);
    assert.deepEqual(
      response.videos.map((video) => video.id),
      [directUrlVideo().id],
      "the healthy sibling must still be served",
    );
  });

  it("resumes signing once a later sync clears the marker", async () => {
    // Recovery is end to end: reconciliation is not a one-way door.
    const bunnyStream = createSigningSpy();
    const recovered = bunnyStreamVideo({
      status: VideoStatus.READY,
      metadataJson: clearBunnyRemoteMissingMarker(
        remoteMissingBunnyVideo().metadataJson,
      ).metadata,
    });
    const { service } = createCompatHarness({
      videos: [recovered],
      bunnyStream,
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.valid, true);
    assert.equal(bunnyStream.signCount, 1);
  });
});

/* ------------------------------------------------------------------ *
 * BLOCKER 1 — THE AUTHORITATIVE DATABASE SIGNING GATE
 *
 * `MemoryCacheService` is PROCESS-LOCAL. `yarn reconcile:bunny --apply` runs in
 * a SEPARATE process: it commits `status = FAILED` + `remoteMissing` to the
 * database and has no way to reach a running API process's `public:watch:`
 * entries. A second API worker, or a direct database fix, has the same effect.
 *
 * So the regression these tests exist for is precisely:
 *
 *   T0  API caches the row as READY
 *   T1  another process reconciles it to FAILED + remoteMissing
 *   T2  a public request arrives and hits that stale cache entry
 *
 * Before the gate, T2 minted a fresh signed Bunny URL for a video Bunny had
 * already deleted. The fix does NOT try to invalidate another process's memory
 * - it re-reads the authoritative row immediately before signing.
 *
 * These tests build a GENUINELY stale cache: request one populates it, then the
 * fixture rows (the "database") are mutated underneath, then request two hits
 * the cached entry. The harness returns shallow copies, so the cached snapshot
 * genuinely diverges from the fixture - which is what makes this a real test of
 * the gate rather than of the mock.
 * ------------------------------------------------------------------ */

type CompatHarnessInstance = ReturnType<typeof createCompatHarness>;
type PublicWatchResult = Awaited<
  ReturnType<CompatHarnessInstance["service"]["resolvePublicWatch"]>
>;

describe("Bunny signing is gated on the authoritative database row", () => {
  const OTHER_GUID = "99999999-8888-7777-6666-555555555555";

  /** Counts mints, and proves no Bunny Management request is ever made. */
  function createGateSpy() {
    const spy = {
      signCount: 0,
      getVideoCount: 0,
      isEnabled: (): boolean => true,
      canSignEmbedUrl: (): boolean => true,
      createSignedEmbedUrl: (videoId: string) => {
        spy.signCount += 1;
        return {
          embedUrl: `https://iframe.mediadelivery.net/embed/${LIBRARY_ID}/${videoId}?token=deadbeef&expires=1`,
          token: "deadbeef",
          expires: 1,
        };
      },
      getVideo: async () => {
        spy.getVideoCount += 1;
        throw new Error(
          "public watch resolution must never call the Bunny Management API",
        );
      },
    };

    return spy;
  }

  /**
   * Populates the watch cache with a healthy READY Bunny row, mutates the
   * underlying fixture rows, then resolves a second time against the now-stale
   * cache entry.
   */
  async function primeCacheThenMutate(
    mutate: (harness: CompatHarnessInstance) => void,
  ): Promise<{
    spy: ReturnType<typeof createGateSpy>;
    signCountAfterPriming: number;
    second: PublicWatchResult;
    findManyCalls: number;
  }> {
    const spy = createGateSpy();
    const harness = createCompatHarness({
      videos: [bunnyStreamVideo()],
      bunnyStream: spy,
      memoryCache: true,
    });

    // REQUEST ONE - healthy. Populates `public:watch:` and signs normally.
    const first = await harness.service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });
    assert.equal(first.valid, true, "priming request must succeed");
    const signCountAfterPriming = spy.signCount;
    assert.equal(signCountAfterPriming, 1);

    // T1 - another process changes the database. The cached snapshot is
    // untouched and still says READY.
    mutate(harness);

    // Count the gate's queries so "ONE small local read" is measured rather
    // than assumed.
    let findManyCalls = 0;
    const realFindMany = harness.prisma.videoAsset.findMany;
    harness.prisma.videoAsset.findMany = async (args: never) => {
      findManyCalls += 1;
      return realFindMany.call(harness.prisma.videoAsset, args);
    };

    // REQUEST TWO - hits the stale cache entry.
    const second = await harness.service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    return { spy, signCountAfterPriming, second, findManyCalls };
  }

  function assertNoBunnyUrl(response: unknown): void {
    assert.doesNotMatch(
      JSON.stringify(response),
      /iframe\.mediadelivery\.net/,
      "a refused asset must not receive a signed URL, and must not fall back to the stored unsigned one",
    );
  }

  it("TEST A - stale READY cache, database says FAILED + remoteMissing: mints nothing", async () => {
    const { spy, signCountAfterPriming, second } = await primeCacheThenMutate(
      (harness) => {
        const row = harness.prisma.videos[0];
        assert.ok(row);
        row.status = VideoStatus.FAILED;
        // REPLACED, not mutated in place: the cached snapshot shares the
        // original object reference, so mutating it would destroy the very
        // staleness this test depends on.
        row.metadataJson = applyBunnyRemoteMissingMarker(
          row.metadataJson,
          new Date("2026-08-23T12:00:00.000Z"),
        ).metadata;
      },
    );

    assert.equal(
      spy.signCount - signCountAfterPriming,
      0,
      "THE BLOCKER: a stale READY cache entry must not mint a Bunny token",
    );
    assertNoBunnyUrl(second);
  });

  it("TEST B - stale READY cache, database says DISABLED: mints nothing", async () => {
    const { spy, signCountAfterPriming, second } = await primeCacheThenMutate(
      (harness) => {
        const row = harness.prisma.videos[0];
        assert.ok(row);
        row.status = VideoStatus.DISABLED;
      },
    );

    assert.equal(spy.signCount - signCountAfterPriming, 0);
    assertNoBunnyUrl(second);
  });

  it("TEST C - stale READY cache, database row deleted: mints nothing", async () => {
    const { spy, signCountAfterPriming, second } = await primeCacheThenMutate(
      (harness) => {
        harness.prisma.videos.length = 0;
      },
    );

    assert.equal(spy.signCount - signCountAfterPriming, 0);
    assertNoBunnyUrl(second);
  });

  it("TEST D - cached Bunny id A, database now holds Bunny id B: mints nothing", async () => {
    const { spy, signCountAfterPriming, second } = await primeCacheThenMutate(
      (harness) => {
        const row = harness.prisma.videos[0];
        assert.ok(row);
        // Still a perfectly valid, READY Bunny asset - just a DIFFERENT remote
        // video. Signing either id would be wrong.
        row.providerAssetId = OTHER_GUID;
        row.playbackId = OTHER_GUID;
        row.metadataJson = {
          bunnyStream: { videoId: OTHER_GUID, libraryId: LIBRARY_ID },
        };
      },
    );

    assert.equal(
      spy.signCount - signCountAfterPriming,
      0,
      "an identifier mismatch must refuse outright, not sign the other id",
    );
    assertNoBunnyUrl(second);
    assert.doesNotMatch(JSON.stringify(second), new RegExp(OTHER_GUID));
    assert.doesNotMatch(JSON.stringify(second), new RegExp(BUNNY_VIDEO_GUID));
  });

  it("TEST E - healthy: cache is used, the gate passes, and a URL IS signed", async () => {
    // The positive control. Without it every assertion above could pass for an
    // unrelated reason - a broken cache, a broken fixture, a broken harness.
    const { spy, signCountAfterPriming, second } = await primeCacheThenMutate(
      () => {
        // Nothing changes: the database still agrees with the cache.
      },
    );

    assert.equal(second.valid, true);
    assert.equal(
      spy.signCount - signCountAfterPriming,
      1,
      "a healthy asset must still be signed on a cache hit",
    );
    assert.match(
      String(second.videos[0]?.embedUrl),
      /iframe\.mediadelivery\.net/,
    );
  });

  it("TEST F - the gate reads the local database ONLY, never the Bunny API", async () => {
    const { spy, findManyCalls } = await primeCacheThenMutate(() => {
      // Healthy, so the gate runs its full path rather than short-circuiting.
    });

    assert.equal(
      spy.getVideoCount,
      0,
      "public watch resolution must add no Bunny Management API request",
    );
    assert.equal(
      findManyCalls,
      1,
      "the gate must be ONE batched local query for the whole response",
    );
  });

  it("issues NO query at all for a share containing no Bunny video", async () => {
    // The gate must not tax the shares that cannot benefit from it.
    const spy = createGateSpy();
    const harness = createCompatHarness({
      videos: [directUrlVideo()],
      bunnyStream: spy,
    });

    let findManyCalls = 0;
    const realFindMany = harness.prisma.videoAsset.findMany;
    harness.prisma.videoAsset.findMany = async (args: never) => {
      findManyCalls += 1;
      return realFindMany.call(harness.prisma.videoAsset, args);
    };

    const response = await harness.service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.valid, true);
    assert.equal(findManyCalls, 0);
    assert.equal(spy.signCount, 0);
    assert.equal(spy.getVideoCount, 0);
  });

  it("fails closed when the gate's own database read fails", async () => {
    const spy = createGateSpy();
    const harness = createCompatHarness({
      videos: [bunnyStreamVideo()],
      bunnyStream: spy,
    });
    harness.prisma.videoAsset.findMany = async () => {
      throw new Error("database unavailable");
    };

    const response = await harness.service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(
      spy.signCount,
      0,
      "an unreadable gate must refuse rather than trust the cached row",
    );
    assertNoBunnyUrl(response);
  });
});

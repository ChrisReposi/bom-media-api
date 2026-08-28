import "reflect-metadata";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import {
  CanonicalShareLinkService,
  type CanonicalEvidenceSnapshot,
} from "../src/admin-websites/canonical-share-link.service";
import { isShareLinkTokenOrAliasCollision } from "../src/admin-websites/utils/share-link-errors.util";
import {
  buildCanonicalPublicShareUrl,
  buildCanonicalReviewUrl,
} from "../src/admin-websites/utils/share-url.util";
import { computeSha256Hex } from "../src/videos/utils/video-checksum.util";
import {
  classifyExistingCanonical,
  classifyPair,
  mask,
  summarize,
  summarizeExistingCanonical,
  summarizeResolutions,
  type AuditShareLinkRow,
} from "../scripts/audit/canonical-share-link-audit-core";
import {
  assessHistoricalWinnerPinnability,
  isDenyingShareLinkStatus,
  selectCanonicalHistoricalWinner,
  type CanonicalAdoptionCandidate,
} from "../src/admin-websites/utils/canonical-adoption-policy.util";
import { Prisma } from "../src/generated/prisma/client";

// ---------------------------------------------------------------------------
// Fake persistence harness
// ---------------------------------------------------------------------------

type FakeShareLink = {
  id: string;
  websiteId: string;
  tokenHash: string;
  alias: string | null;
  label: string | null;
  expiresAt: Date | null;
  maxViews: number | null;
  currentViews: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  lastViewedAt: Date | null;
};

type FakeCanonical = {
  id: string;
  websiteId: string;
  videoId: string;
  shareLinkId: string;
  canonicalDomainId: string;
  canonicalHostSnapshot: string;
  canonicalProtocol: string;
  evidenceFingerprint: string | null;
  evidenceSnapshotJson: unknown;
  createdAt: Date;
  updatedAt: Date;
};

class FakePrisma {
  websites = new Map<string, { id: string; status: string }>();
  domains = new Map<
    string,
    {
      id: string;
      websiteId: string | null;
      domain: string;
      status: string;
      isPrimary: boolean;
      createdAt: Date;
    }
  >();
  videos = new Map<string, Record<string, unknown>>();
  shareLinks = new Map<string, FakeShareLink>();
  shareLinkVideos: {
    shareLinkId: string;
    videoId: string;
    sortOrder: number;
  }[] = [];
  canonicals = new Map<string, FakeCanonical>();
  audits: { action: string; entityId: string }[] = [];
  failNextShareLinkCreateWith: unknown = null;
  failNextCanonicalCreateWith: unknown = null;
  /**
   * Simulates losing the pair race honestly: a P2002 means a row for this pair
   * NOW EXISTS, so the hook commits the winner's mapping before throwing. A
   * bare throw would let the loser's reload find nothing, which is a state the
   * database cannot actually produce.
   */
  raceWinnerShareLinkIdOnNextCanonicalCreate: string | null = null;
  lastVideoFindUniqueArgs: Record<string, unknown> | null = null;
  private sequence = 0;

  nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  website = {
    findFirst: async (args: {
      where: { id: string; status: string };
    }): Promise<{ id: string } | null> => {
      const website = this.websites.get(args.where.id);
      return website && website.status === args.where.status
        ? { id: website.id }
        : null;
    },
  };

  websiteDomain = {
    findFirst: async (args: {
      where: { websiteId: string };
    }): Promise<{ id: string; domain: string } | null> => {
      const candidates = [...this.domains.values()]
        .filter(
          (domain) =>
            domain.websiteId === args.where.websiteId &&
            domain.status === "ACTIVE",
        )
        .sort(
          (a, b) =>
            Number(b.isPrimary) - Number(a.isPrimary) ||
            a.createdAt.getTime() - b.createdAt.getTime(),
        );
      const first = candidates[0];
      return first ? { id: first.id, domain: first.domain } : null;
    },
    findUnique: async (args: {
      where: { id: string };
    }): Promise<{
      domain: string;
      status: string;
      websiteId: string | null;
    } | null> => {
      const domain = this.domains.get(args.where.id);
      return domain
        ? {
            domain: domain.domain,
            status: domain.status,
            websiteId: domain.websiteId,
          }
        : null;
    },
  };

  videoAsset = {
    findUnique: async (args: {
      where: { id: string };
      include?: Record<string, unknown>;
    }): Promise<Record<string, unknown> | null> => {
      this.lastVideoFindUniqueArgs = args;
      return this.videos.get(args.where.id) ?? null;
    },
  };

  shareLink = {
    create: async (args: {
      data: Omit<
        FakeShareLink,
        "id" | "createdAt" | "updatedAt" | "lastViewedAt"
      >;
    }): Promise<FakeShareLink> => {
      if (this.failNextShareLinkCreateWith !== null) {
        const error = this.failNextShareLinkCreateWith;
        this.failNextShareLinkCreateWith = null;
        throw error;
      }
      const created: FakeShareLink = {
        ...args.data,
        id: this.nextId("link"),
        createdAt: new Date(),
        updatedAt: new Date(),
        lastViewedAt: null,
      };
      this.shareLinks.set(created.id, created);
      return created;
    },
    findUnique: async (args: { where: { id: string } }): Promise<unknown> => {
      const link = this.shareLinks.get(args.where.id);
      return link ? this.withVideos(link) : null;
    },
    /**
     * Models ONLY the predicates the production query actually sends, each
     * applied only when present. Dropping one from the service therefore
     * surfaces as a wrong candidate set — the failure this harness exists to
     * catch — rather than as "nothing matches".
     */
    findMany: async (args: {
      where: {
        websiteId: string;
        shareLinkVideos?: { some: { videoId: string } };
      };
      /**
       * The ORDER IS THE POLICY — `createdAt DESC`, then `id DESC` as the
       * deterministic tie-break — so the fake reproduces it rather than
       * ignoring it.
       */
      orderBy?: [{ createdAt: "desc" }, { id: "desc" }];
    }): Promise<
      {
        id: string;
        alias: string | null;
        status: string;
        expiresAt: Date | null;
        maxViews: number | null;
        createdAt: Date;
        shareLinkVideos: { videoId: string }[];
        canonicalVideoShareLink: {
          websiteId: string;
          videoId: string;
        } | null;
      }[]
    > => {
      const anchoredByShareLinkId = new Map(
        [...this.canonicals.values()].map((row) => [
          row.shareLinkId,
          { websiteId: row.websiteId, videoId: row.videoId },
        ]),
      );
      const needle = args.where.shareLinkVideos?.some.videoId;

      return [...this.shareLinks.values()]
        .filter((link) => link.websiteId === args.where.websiteId)
        .filter(
          (link) =>
            needle === undefined ||
            this.shareLinkVideos.some(
              (row) => row.shareLinkId === link.id && row.videoId === needle,
            ),
        )
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
        )
        .map((link) => ({
          id: link.id,
          alias: link.alias,
          status: link.status,
          expiresAt: link.expiresAt,
          maxViews: link.maxViews,
          createdAt: link.createdAt,
          shareLinkVideos: this.shareLinkVideos
            .filter((row) => row.shareLinkId === link.id)
            .map((row) => ({ videoId: row.videoId })),
          canonicalVideoShareLink: anchoredByShareLinkId.get(link.id) ?? null,
        }));
    },
  };

  shareLinkVideo = {
    create: async (args: {
      data: { shareLinkId: string; videoId: string; sortOrder: number };
    }): Promise<void> => {
      this.shareLinkVideos.push(args.data);
    },
  };

  canonicalVideoShareLink = {
    findUnique: async (args: {
      where: {
        websiteId_videoId?: { websiteId: string; videoId: string };
        id?: string;
      };
    }): Promise<unknown> => {
      const canonical = args.where.websiteId_videoId
        ? [...this.canonicals.values()].find(
            (row) =>
              row.websiteId === args.where.websiteId_videoId?.websiteId &&
              row.videoId === args.where.websiteId_videoId?.videoId,
          )
        : this.canonicals.get(args.where.id ?? "");
      return canonical ? this.withShareLink(canonical) : null;
    },
    findUniqueOrThrow: async (args: {
      where: { id: string };
    }): Promise<unknown> => {
      const canonical = this.canonicals.get(args.where.id);
      if (!canonical) {
        throw new Error("canonical not found");
      }
      return this.withShareLink(canonical);
    },
    create: async (args: {
      data: Omit<FakeCanonical, "id" | "createdAt" | "updatedAt">;
    }): Promise<FakeCanonical> => {
      if (this.raceWinnerShareLinkIdOnNextCanonicalCreate !== null) {
        const winnerShareLinkId =
          this.raceWinnerShareLinkIdOnNextCanonicalCreate;
        this.raceWinnerShareLinkIdOnNextCanonicalCreate = null;
        const winner: FakeCanonical = {
          ...args.data,
          shareLinkId: winnerShareLinkId,
          id: this.nextId("canonical"),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        this.canonicals.set(winner.id, winner);
        throw new Prisma.PrismaClientKnownRequestError("unique", {
          code: "P2002",
          clientVersion: "7.8.0",
          meta: { target: "CanonicalVideoShareLink_websiteId_videoId_key" },
        });
      }
      if (this.failNextCanonicalCreateWith !== null) {
        const error = this.failNextCanonicalCreateWith;
        this.failNextCanonicalCreateWith = null;
        throw error;
      }
      const duplicate = [...this.canonicals.values()].some(
        (row) =>
          row.websiteId === args.data.websiteId &&
          row.videoId === args.data.videoId,
      );
      if (duplicate) {
        throw new Prisma.PrismaClientKnownRequestError("unique", {
          code: "P2002",
          clientVersion: "7.8.0",
          meta: { target: "CanonicalVideoShareLink_websiteId_videoId_key" },
        });
      }
      const created: FakeCanonical = {
        ...args.data,
        id: this.nextId("canonical"),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.canonicals.set(created.id, created);
      return created;
    },
    count: async (args: {
      where: { canonicalDomainId?: string; videoId?: string };
    }): Promise<number> =>
      [...this.canonicals.values()].filter(
        (row) =>
          (args.where.canonicalDomainId === undefined ||
            row.canonicalDomainId === args.where.canonicalDomainId) &&
          (args.where.videoId === undefined ||
            row.videoId === args.where.videoId),
      ).length,
  };

  adminAuditLog = {
    create: async (args: {
      data: { action: string; entityId: string };
    }): Promise<void> => {
      this.audits.push({
        action: args.data.action,
        entityId: args.data.entityId,
      });
    },
  };

  async $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    return fn(this);
  }

  private withVideos(link: FakeShareLink) {
    return {
      ...link,
      shareLinkVideos: this.shareLinkVideos
        .filter((row) => row.shareLinkId === link.id)
        .map((row, index) => ({
          id: `slv-${index}`,
          videoId: row.videoId,
          sortOrder: row.sortOrder,
          video: this.videos.get(row.videoId) ?? { title: "?" },
        })),
    };
  }

  private withShareLink(canonical: FakeCanonical) {
    const link = this.shareLinks.get(canonical.shareLinkId);
    return { ...canonical, shareLink: link ? this.withVideos(link) : null };
  }
}

function createService(options?: { eligibilityError?: Error }) {
  const prisma = new FakePrisma();
  prisma.websites.set("site-a", { id: "site-a", status: "ACTIVE" });
  prisma.websites.set("site-b", { id: "site-b", status: "ACTIVE" });
  prisma.domains.set("dom-a", {
    id: "dom-a",
    websiteId: "site-a",
    domain: "plushcomedystudios.com",
    status: "ACTIVE",
    isPrimary: true,
    createdAt: new Date("2026-01-01"),
  });
  prisma.domains.set("dom-b", {
    id: "dom-b",
    websiteId: "site-b",
    domain: "other-site.com",
    status: "ACTIVE",
    isPrimary: true,
    createdAt: new Date("2026-01-01"),
  });
  for (const videoId of ["video-1", "video-2"]) {
    prisma.videos.set(videoId, {
      id: videoId,
      sourceType: "LOCAL_FILE",
      title: `Video ${videoId}`,
      durationSeconds: 60,
      publishedAt: null,
      playbackUrl: null,
      providerAssetId: null,
      embedProvider: null,
      embedUrl: null,
      embedPublicId: null,
      localFileAsset: {
        checksumSha256: `sum-${videoId}`,
        sizeBytes: 1000n,
        mimeType: "video/mp4",
      },
      binaryAsset: null,
    });
  }

  const websitesStub = {
    validateShareLinkVideoEligibility: async () => {
      if (options?.eligibilityError) {
        throw options.eligibilityError;
      }
    },
    getConfiguredPublicSiteProtocol: () => undefined,
    toShareLinkResponse: (
      link: FakeShareLink & { shareLinkVideos: { videoId: string }[] },
      publicUrl: string | null,
    ) => ({
      id: link.id,
      alias: link.alias,
      status: link.status,
      publicUrl,
      videos: link.shareLinkVideos.map((video) => ({
        videoId: video.videoId,
      })),
    }),
  };

  const config = {
    get: (key: string) =>
      key === "SHARE_TOKEN_PEPPER" ? "test-pepper" : undefined,
  };

  const service = new CanonicalShareLinkService(
    prisma as never,
    config as never,
    websitesStub as never,
  );
  return { prisma, service };
}

function expectConflictCode(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ConflictException, String(error));
    assert.equal(error.getStatus(), 409);
    assert.equal((error.getResponse() as { code?: string }).code, code);
    return true;
  };
}

function assertCanonicalResponseHasNoSecrets(response: object): void {
  assert.equal(
    Object.prototype.hasOwnProperty.call(response, "rawToken"),
    false,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(response, "tokenHash"),
    false,
  );
  assert.equal(JSON.stringify(response).includes("tokenHash"), false);
}

function configureDbBlobVideo(
  prisma: FakePrisma,
  checksumSha256: string | null,
  sizeBytes = 5n,
  mimeType = "video/mp4",
): void {
  const video = prisma.videos.get("video-1");
  assert.ok(video);
  prisma.videos.set("video-1", {
    ...video,
    sourceType: "DB_BLOB",
    playbackUrl: null,
    providerAssetId: null,
    embedProvider: null,
    embedUrl: null,
    embedPublicId: null,
    localFileAsset: null,
    binaryAsset: { checksumSha256, sizeBytes, mimeType },
  });
}

function addLegacySingleVideoLink(prisma: FakePrisma): FakeShareLink {
  const now = new Date();
  const shareLink: FakeShareLink = {
    id: "legacy-link",
    websiteId: "site-a",
    tokenHash: "private-test-hash",
    alias: "legacy1",
    label: null,
    expiresAt: null,
    maxViews: null,
    currentViews: 0,
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
    lastViewedAt: null,
  };
  prisma.shareLinks.set(shareLink.id, shareLink);
  prisma.shareLinkVideos.push({
    shareLinkId: shareLink.id,
    videoId: "video-1",
    sortOrder: 0,
  });
  return shareLink;
}

// ---------------------------------------------------------------------------
// Pure URL and fingerprint behavior
// ---------------------------------------------------------------------------

describe("canonical public share URL", () => {
  it("always produces the exact hash-router form", () => {
    const cases: Array<[string, string, string, string]> = [
      [
        "plushcomedystudios.com",
        "G3tqak0",
        "https",
        "https://plushcomedystudios.com/#/s/G3tqak0/videos",
      ],
      [
        "  PlushComedyStudios.com  ",
        "G3tqak0",
        "https",
        "https://plushcomedystudios.com/#/s/G3tqak0/videos",
      ],
      [
        "127.0.0.1:5500",
        "abc1234",
        "http",
        "http://127.0.0.1:5500/#/s/abc1234/videos",
      ],
    ];
    for (const [host, alias, protocol, expected] of cases) {
      assert.equal(
        buildCanonicalPublicShareUrl({ host, alias, protocol }),
        expected,
      );
    }
  });

  it("never emits legacy shapes", () => {
    const url = buildCanonicalPublicShareUrl({
      host: "plushcomedystudios.com",
      alias: "G3tqak0",
      protocol: "https",
    });
    assert.ok(!url.includes("?token="));
    assert.ok(!url.endsWith("/"));
    assert.ok(!/\/s\/[^#]*#\/videos$/.test(url), "path-form with hash suffix");
  });
});

describe("evidence fingerprint", () => {
  const baseSnapshot: CanonicalEvidenceSnapshot = {
    videoId: "video-1",
    sourceType: "LOCAL_FILE",
    title: "Video",
    durationSeconds: 60,
    publishedAt: null,
    playbackUrl: null,
    providerAssetId: null,
    embedProvider: null,
    embedUrl: null,
    embedPublicId: null,
    checksumSha256: "abc",
    sizeBytes: "1000",
    mimeType: "video/mp4",
    snapshotAt: "2026-07-18T00:00:00.000Z",
  };

  it("is deterministic and ignores snapshotAt", () => {
    const { service } = createService();
    const first = service.computeFingerprint(baseSnapshot);
    const second = service.computeFingerprint({
      ...baseSnapshot,
      snapshotAt: "2027-01-01T00:00:00.000Z",
    });
    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{64}$/);
  });

  it("changes when evidence-critical identity changes", () => {
    const { service } = createService();
    const original = service.computeFingerprint(baseSnapshot);
    assert.notEqual(
      service.computeFingerprint({ ...baseSnapshot, checksumSha256: "zzz" }),
      original,
    );
    assert.notEqual(
      service.computeFingerprint({ ...baseSnapshot, title: "Renamed" }),
      original,
    );
  });
});

describe("DB_BLOB canonical evidence", () => {
  const bytesA = Buffer.from("alpha");
  const bytesB = Buffer.from("bravo");
  const checksumA = computeSha256Hex(bytesA);
  const checksumB = computeSha256Hex(bytesB);

  it("selects and snapshots the persisted binary checksum with size and MIME", async () => {
    const { prisma, service } = createService();
    configureDbBlobVideo(prisma, checksumA, BigInt(bytesA.length));

    const created = await service.createOrGetCanonical(
      "site-a",
      "video-1",
      "admin-1",
    );
    const snapshot = created.evidenceSnapshot as CanonicalEvidenceSnapshot;

    assert.equal(snapshot.sourceType, "DB_BLOB");
    assert.equal(snapshot.checksumSha256, checksumA);
    assert.equal(snapshot.sizeBytes, String(bytesA.length));
    assert.equal(snapshot.mimeType, "video/mp4");
    assert.match(snapshot.checksumSha256, /^[0-9a-f]{64}$/);
    assert.equal(
      (
        prisma.lastVideoFindUniqueArgs?.include as {
          binaryAsset?: { select?: Record<string, boolean> };
        }
      )?.binaryAsset?.select?.checksumSha256,
      true,
    );
  });

  it("detects same-size and same-MIME byte replacement through checksum drift", async () => {
    assert.equal(bytesA.length, bytesB.length);
    assert.notEqual(checksumA, checksumB);
    const { prisma, service } = createService();
    configureDbBlobVideo(prisma, checksumA, BigInt(bytesA.length));
    const created = await service.createOrGetCanonical(
      "site-a",
      "video-1",
      "admin-1",
    );
    const originalSnapshot =
      created.evidenceSnapshot as CanonicalEvidenceSnapshot;

    configureDbBlobVideo(prisma, checksumB, BigInt(bytesB.length));
    const replacementVideo = prisma.videos.get("video-1")!;
    const replacementSnapshot: CanonicalEvidenceSnapshot = {
      ...originalSnapshot,
      checksumSha256: checksumB,
      snapshotAt: new Date().toISOString(),
    };
    assert.equal(replacementSnapshot.sizeBytes, originalSnapshot.sizeBytes);
    assert.equal(replacementSnapshot.mimeType, originalSnapshot.mimeType);
    assert.notEqual(
      service.computeFingerprint(replacementSnapshot),
      service.computeFingerprint(originalSnapshot),
    );
    assert.equal(
      (replacementVideo.binaryAsset as { sizeBytes: bigint }).sizeBytes,
      BigInt(bytesA.length),
    );

    await assert.rejects(
      service.createOrGetCanonical("site-a", "video-1", "admin-1"),
      expectConflictCode("CANONICAL_EVIDENCE_DRIFT"),
    );
  });

  it("reuses the canonical mapping when DB evidence is unchanged", async () => {
    const { prisma, service } = createService();
    configureDbBlobVideo(prisma, checksumA, BigInt(bytesA.length));
    const created = await service.createOrGetCanonical(
      "site-a",
      "video-1",
      "admin-1",
    );
    configureDbBlobVideo(prisma, checksumA, BigInt(bytesA.length));

    const reused = await service.createOrGetCanonical(
      "site-a",
      "video-1",
      "admin-1",
    );
    assert.equal(reused.outcome, "REUSED");
    assert.equal(reused.alias, created.alias);
    assert.equal(reused.publicUrl, created.publicUrl);
  });

  it("rejects a new legacy-null DB blob before any canonical write", async () => {
    const { prisma, service } = createService();
    configureDbBlobVideo(prisma, null);

    await assert.rejects(
      service.createOrGetCanonical("site-a", "video-1", "admin-1"),
      expectConflictCode("CANONICAL_EVIDENCE_INCOMPLETE"),
    );
    assert.equal(prisma.shareLinks.size, 0);
    assert.equal(prisma.shareLinkVideos.length, 0);
    assert.equal(prisma.canonicals.size, 0);
    assert.equal(prisma.audits.length, 0);
  });

  it("rejects reuse and GET when current or stored DB evidence is incomplete", async () => {
    const currentNull = createService();
    configureDbBlobVideo(currentNull.prisma, checksumA);
    await currentNull.service.createOrGetCanonical(
      "site-a",
      "video-1",
      "admin-1",
    );
    configureDbBlobVideo(currentNull.prisma, null);
    await assert.rejects(
      currentNull.service.createOrGetCanonical("site-a", "video-1", "admin-1"),
      expectConflictCode("CANONICAL_EVIDENCE_INCOMPLETE"),
    );
    await assert.rejects(
      currentNull.service.getCanonical("site-a", "video-1"),
      expectConflictCode("CANONICAL_EVIDENCE_INCOMPLETE"),
    );

    const storedNull = createService();
    configureDbBlobVideo(storedNull.prisma, checksumA);
    await storedNull.service.createOrGetCanonical(
      "site-a",
      "video-1",
      "admin-1",
    );
    const canonical = [...storedNull.prisma.canonicals.values()][0];
    canonical.evidenceSnapshotJson = {
      ...(canonical.evidenceSnapshotJson as object),
      checksumSha256: null,
    };
    await assert.rejects(
      storedNull.service.createOrGetCanonical("site-a", "video-1", "admin-1"),
      expectConflictCode("CANONICAL_EVIDENCE_INCOMPLETE"),
    );
  });

  it("refuses legacy-link adoption before mapping or success audit writes", async () => {
    const { prisma, service } = createService();
    configureDbBlobVideo(prisma, null);
    const legacyLink = addLegacySingleVideoLink(prisma);

    await assert.rejects(
      service.adoptExistingShareLink({
        websiteId: "site-a",
        videoId: "video-1",
        shareLinkId: legacyLink.id,
        adminId: "admin-1",
      }),
      expectConflictCode("CANONICAL_EVIDENCE_INCOMPLETE"),
    );
    assert.equal(prisma.canonicals.size, 0);
    assert.equal(prisma.audits.length, 0);
    assert.equal(prisma.shareLinks.size, 1, "legacy link is untouched");
    assert.equal(
      prisma.shareLinkVideos.length,
      1,
      "legacy relation is untouched",
    );
  });
});

describe("non-database canonical evidence regression", () => {
  it("preserves DIRECT_URL identity without inventing a byte checksum", async () => {
    const { prisma, service } = createService();
    const video = prisma.videos.get("video-1")!;
    prisma.videos.set("video-1", {
      ...video,
      sourceType: "DIRECT_URL",
      playbackUrl: "https://media.example.test/video.mp4",
      localFileAsset: null,
      binaryAsset: null,
    });

    const created = await service.createOrGetCanonical(
      "site-a",
      "video-1",
      "admin-1",
    );
    const snapshot = created.evidenceSnapshot as CanonicalEvidenceSnapshot;
    assert.equal(snapshot.sourceType, "DIRECT_URL");
    assert.equal(snapshot.playbackUrl, "https://media.example.test/video.mp4");
    assert.equal(snapshot.checksumSha256, null);
    assert.equal(snapshot.sizeBytes, null);
    assert.equal(snapshot.mimeType, null);
    assert.equal(
      (await service.createOrGetCanonical("site-a", "video-1", "admin-1"))
        .outcome,
      "REUSED",
    );
  });
});

// ---------------------------------------------------------------------------
// Create-or-get behavior
// ---------------------------------------------------------------------------

describe("canonical create-or-get", () => {
  it("creates once, then reuses byte-for-byte the same alias URL without exposing a token", async () => {
    const { service } = createService();

    const created = await service.createOrGetCanonical(
      "site-a",
      "video-1",
      "admin-1",
    );
    assert.equal(created.outcome, "CREATED");
    assert.equal(created.isCanonical, true);
    assertCanonicalResponseHasNoSecrets(created);
    assert.ok(created.alias);
    assert.equal(
      created.publicUrl,
      `https://plushcomedystudios.com/#/s/${encodeURIComponent(created.alias)}/videos`,
    );

    const reused = await service.createOrGetCanonical(
      "site-a",
      "video-1",
      "admin-1",
    );
    assert.equal(reused.outcome, "REUSED");
    assertCanonicalResponseHasNoSecrets(reused);
    assert.equal(reused.alias, created.alias);
    assert.equal(reused.publicUrl, created.publicUrl);
    assert.equal(reused.shareLink.id, created.shareLink.id);
  });

  it("gives different aliases/URLs per website and per video", async () => {
    const { service } = createService();
    const a1 = await service.createOrGetCanonical("site-a", "video-1", "x");
    const b1 = await service.createOrGetCanonical("site-b", "video-1", "x");
    const a2 = await service.createOrGetCanonical("site-a", "video-2", "x");

    assert.notEqual(a1.alias, b1.alias);
    assert.notEqual(a1.publicUrl, b1.publicUrl);
    assert.notEqual(a1.alias, a2.alias);
    assert.ok(b1.publicUrl.startsWith("https://other-site.com/"));
  });

  it("returns REUSED when losing the unique-pair race", async () => {
    const { prisma, service } = createService();
    const winner = await service.createOrGetCanonical("site-a", "video-1", "x");
    const winnerShareLinkId = winner.shareLink.id;

    // Drop the mapping so the next call gets past the early gate, exactly as a
    // racer that read before the winner committed would. The link itself stays,
    // so the request resolves it as the pair's existing single-video link and
    // races to pin it.
    prisma.canonicals.clear();
    prisma.raceWinnerShareLinkIdOnNextCanonicalCreate = winnerShareLinkId;

    const loser = await service.createOrGetCanonical("site-a", "video-1", "x");

    assert.equal(loser.outcome, "REUSED");
    assert.equal(loser.shareLink.id, winnerShareLinkId);
    assert.equal(loser.alias, winner.alias);
    assert.equal(loser.publicUrl, winner.publicUrl);
    // The whole point: losing the race must not leave a second link behind.
    assert.equal(prisma.shareLinks.size, 1);
    assert.equal(prisma.canonicals.size, 1);
  });

  it("retries alias/token collisions and still creates exactly one mapping", async () => {
    const { prisma, service } = createService();
    prisma.failNextShareLinkCreateWith =
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "7.8.0",
        meta: { target: ["alias"] },
      });

    const created = await service.createOrGetCanonical(
      "site-a",
      "video-1",
      "x",
    );
    assert.equal(created.outcome, "CREATED");
    assert.equal(prisma.canonicals.size, 1);
    assert.equal(prisma.shareLinks.size, 1);
  });

  it("rejects reuse of a revoked canonical link without replacing it", async () => {
    const { prisma, service } = createService();
    await service.createOrGetCanonical("site-a", "video-1", "x");
    for (const link of prisma.shareLinks.values()) {
      link.status = "REVOKED";
    }

    await assert.rejects(
      service.createOrGetCanonical("site-a", "video-1", "x"),
      expectConflictCode("CANONICAL_LINK_REVOKED"),
    );
    assert.equal(prisma.canonicals.size, 1, "no silent replacement");
    assert.equal(prisma.shareLinks.size, 1);
  });

  it("rejects reuse when the canonical domain drifted", async () => {
    const { prisma, service } = createService();
    await service.createOrGetCanonical("site-a", "video-1", "x");
    prisma.domains.get("dom-a")!.domain = "renamed-host.com";

    await assert.rejects(
      service.createOrGetCanonical("site-a", "video-1", "x"),
      expectConflictCode("CANONICAL_DOMAIN_UNAVAILABLE"),
    );
  });

  it("rejects reuse when evidence drifted", async () => {
    const { prisma, service } = createService();
    await service.createOrGetCanonical("site-a", "video-1", "x");
    const video = prisma.videos.get("video-1")!;
    (video as { localFileAsset: { checksumSha256: string } }).localFileAsset = {
      ...(video.localFileAsset as object),
      checksumSha256: "tampered",
    } as {
      checksumSha256: string;
    };

    await assert.rejects(
      service.createOrGetCanonical("site-a", "video-1", "x"),
      expectConflictCode("CANONICAL_EVIDENCE_DRIFT"),
    );
  });

  it("rejects reuse when the video is no longer shareable, keeping the URL", async () => {
    const harness = createService();
    await harness.service.createOrGetCanonical("site-a", "video-1", "x");

    const blocked = createService({
      eligibilityError: new Error("not eligible"),
    });
    blocked.prisma.canonicals = harness.prisma.canonicals;
    blocked.prisma.shareLinks = harness.prisma.shareLinks;
    blocked.prisma.shareLinkVideos = harness.prisma.shareLinkVideos;

    await assert.rejects(
      blocked.service.createOrGetCanonical("site-a", "video-1", "x"),
      expectConflictCode("CANONICAL_VIDEO_NOT_SHAREABLE"),
    );
    assert.equal(blocked.prisma.canonicals.size, 1);
  });

  it("get returns drift state without blocking reads", async () => {
    const { prisma, service } = createService();
    await service.createOrGetCanonical("site-a", "video-1", "x");
    const clean = await service.getCanonical("site-a", "video-1");
    assertCanonicalResponseHasNoSecrets(clean);
    assert.ok(clean.alias);
    assert.ok(clean.publicUrl);
    assert.equal(clean.evidenceDrift, false);

    const video = prisma.videos.get("video-1")!;
    (video as { title: string }).title = "Edited title";
    const drifted = await service.getCanonical("site-a", "video-1");
    assertCanonicalResponseHasNoSecrets(drifted);
    assert.equal(drifted.evidenceDrift, true);
    assert.equal(drifted.outcome, "REUSED");
  });

  it("404s the read path when no canonical mapping exists", async () => {
    const { service } = createService();
    await assert.rejects(
      service.getCanonical("site-a", "video-1"),
      NotFoundException,
    );
  });
});

// ---------------------------------------------------------------------------
// Collision util + audit core
// ---------------------------------------------------------------------------

describe("canonical delete-policy schema contract", () => {
  it("keeps every CanonicalVideoShareLink relation on onDelete: Restrict", () => {
    // Canonical provenance must never disappear via a cascade; the database
    // is the final boundary (proven live: DELETE on each parent → MySQL 1451
    // while a mapping exists). This contract pins the schema so a future
    // relation edit cannot silently reintroduce Cascade.
    const schema = readFileSync(
      new URL("../prisma/schema.prisma", import.meta.url),
      "utf8",
    );
    const modelMatch = schema.match(
      /model CanonicalVideoShareLink \{[\s\S]*?\n\}/,
    );
    assert.ok(modelMatch, "CanonicalVideoShareLink model missing");
    const relationLines = modelMatch[0]
      .split("\n")
      .filter((line) => line.includes("@relation(fields:"));
    assert.equal(relationLines.length, 4);
    for (const line of relationLines) {
      assert.ok(
        line.includes("onDelete: Restrict"),
        `relation must be Restrict: ${line.trim()}`,
      );
    }
  });
});

describe("share-link collision util", () => {
  it("matches only alias/tokenHash P2002 violations", () => {
    const build = (target: unknown) =>
      new Prisma.PrismaClientKnownRequestError("u", {
        code: "P2002",
        clientVersion: "7.8.0",
        meta: { target },
      });
    const buildAdapterShape = (index: string) =>
      new Prisma.PrismaClientKnownRequestError("u", {
        code: "P2002",
        clientVersion: "7.8.0",
        meta: {
          modelName: "ShareLink",
          driverAdapterError: { cause: { constraint: { index } } },
        },
      });
    // MariaDB driver-adapter shape: no meta.target at all (proven by probing
    // MySQL 1062 through the live adapter).
    assert.equal(
      isShareLinkTokenOrAliasCollision(
        buildAdapterShape("ShareLink.ShareLink_alias_key"),
      ),
      true,
    );
    assert.equal(
      isShareLinkTokenOrAliasCollision(
        buildAdapterShape(
          "CanonicalVideoShareLink.CanonicalVideoShareLink_websiteId_videoId_key",
        ),
      ),
      false,
    );
    assert.equal(isShareLinkTokenOrAliasCollision(build(["alias"])), true);
    assert.equal(
      isShareLinkTokenOrAliasCollision(build("ShareLink_tokenHash_key")),
      true,
    );
    assert.equal(
      isShareLinkTokenOrAliasCollision(
        build("CanonicalVideoShareLink_websiteId_videoId_key"),
      ),
      false,
    );
    assert.equal(isShareLinkTokenOrAliasCollision(new Error("x")), false);
  });
});

describe("canonical audit core", () => {
  const link = (over: Partial<AuditShareLinkRow>): AuditShareLinkRow => ({
    id: "link-1",
    websiteId: "site-a",
    alias: "abc",
    status: "ACTIVE",
    expiresAt: null,
    maxViews: null,
    createdAt: new Date(),
    lastViewedAt: null,
    currentViews: 0,
    videoIds: ["video-1"],
    ...over,
  });

  it("classifies the owner-decision categories", () => {
    assert.equal(
      classifyPair("site-a", "video-1", []).classification,
      "NO_LINKS",
    );
    assert.equal(
      classifyPair("site-a", "video-1", [link({})]).classification,
      "SINGLE_CANDIDATE",
    );
    assert.equal(
      classifyPair("site-a", "video-1", [link({}), link({ id: "link-2" })])
        .classification,
      "DUPLICATE_ACTIVE_LINKS",
    );
    assert.equal(
      classifyPair("site-a", "video-1", [
        link({}),
        link({ id: "link-2", status: "REVOKED" }),
      ]).classification,
      "ACTIVE_PLUS_REVOKED",
    );
    assert.equal(
      classifyPair("site-a", "video-1", [
        link({ videoIds: ["video-1", "video-2"] }),
      ]).classification,
      "MULTI_VIDEO_ONLY",
    );
    assert.equal(
      classifyPair("site-a", "video-1", [link({ status: "REVOKED" })])
        .classification,
      "REVOKED_ONLY",
    );
  });

  it("counts limits and missing aliases and summarizes", () => {
    const result = classifyPair("site-a", "video-1", [
      link({ expiresAt: new Date() }),
      link({ id: "link-2", alias: null, status: "REVOKED" }),
    ]);
    assert.equal(result.linksWithLimits, 1);
    assert.equal(result.linksMissingAlias, 1);
    assert.deepEqual(summarize([result]), { ACTIVE_PLUS_REVOKED: 1 });
  });

  it("masks identifiers and aliases", () => {
    assert.equal(mask("G3tqak0"), "G3tq***");
    assert.equal(mask("ab"), "a***");
    assert.equal(mask(null), "(none)");
  });

  /**
   * THE AUDIT'S PREDICTION IS BINDING. These pin that the report names the same
   * winner the request path will actually adopt, and — just as importantly —
   * that it does not soften a pin-then-deny outcome into something friendlier.
   */
  it("predicts ADOPT_HISTORICAL and names the NEWEST link", () => {
    const result = classifyPair("site-a", "video-1", [
      link({ id: "l1", createdAt: new Date("2026-01-01") }),
      link({ id: "l2", createdAt: new Date("2026-04-01") }),
      link({ id: "l3", createdAt: new Date("2026-03-01") }),
    ]);

    assert.equal(result.resolution, "ADOPT_HISTORICAL");
    assert.equal(result.deterministicWinnerId, "l2");
    assert.equal(result.deterministicWinnerStatus, "ACTIVE");
    assert.equal(result.historicalCandidateCount, 3);
    assert.equal(result.pinBlocker, null);
  });

  it("predicts ADOPT_HISTORICAL_THEN_DENY for a revoked newest link", () => {
    // The operator must see this in advance. The pair WILL be pinned to the
    // revoked link and the request WILL then deny — which is correct, because
    // the alternative is bypassing the owner's revoke.
    const result = classifyPair("site-a", "video-1", [
      link({ id: "old-active", createdAt: new Date("2026-01-01") }),
      link({
        id: "new-revoked",
        status: "REVOKED",
        createdAt: new Date("2026-06-01"),
      }),
    ]);

    assert.equal(result.resolution, "ADOPT_HISTORICAL_THEN_DENY");
    assert.equal(
      result.deterministicWinnerId,
      "new-revoked",
      "the older ACTIVE link must NOT be named as the winner",
    );
    assert.equal(result.deterministicWinnerStatus, "REVOKED");
    assert.equal(result.pinBlocker, null, "revoked is pinnable, just denying");
  });

  it("predicts BLOCKED_OWNER_REVIEW and names the structural blocker", () => {
    for (const [overrides, blocker] of [
      [{ alias: null }, "ALIAS_MISSING"],
      [{ expiresAt: new Date("2027-01-01") }, "HAS_EXPIRY"],
      [{ maxViews: 5 }, "HAS_MAX_VIEWS"],
      [
        { anchoredCanonicalPair: { websiteId: "site-a", videoId: "video-2" } },
        "ANCHORED_TO_OTHER_PAIR",
      ],
    ] as const) {
      const result = classifyPair("site-a", "video-1", [
        link({ id: "old-active", createdAt: new Date("2026-01-01") }),
        link({ id: "newest", createdAt: new Date("2026-06-01"), ...overrides }),
      ]);

      assert.equal(result.resolution, "BLOCKED_OWNER_REVIEW", blocker);
      assert.equal(result.pinBlocker, blocker);
      assert.equal(
        result.deterministicWinnerId,
        "newest",
        "the blocked winner is still named — never an older fallback",
      );
    }
  });

  it("predicts MINT_NEW only when the pair has no exact history at all", () => {
    assert.equal(classifyPair("site-a", "video-1", []).resolution, "MINT_NEW");

    // A bundle is not history FOR THIS PAIR, so this is genuinely empty.
    const bundleOnly = classifyPair("site-a", "video-1", [
      link({ id: "bundle", videoIds: ["video-1", "video-2"] }),
    ]);
    assert.equal(bundleOnly.resolution, "MINT_NEW");
    assert.equal(bundleOnly.historicalCandidateCount, 0);
    assert.equal(bundleOnly.multiVideoLinkCount, 1);

    // But ANY exact single-video history removes the mint option entirely.
    for (const overrides of [
      { status: "REVOKED" as const },
      { status: "DISABLED" as const },
      { alias: null },
      { expiresAt: new Date("2027-01-01") },
      { maxViews: 1 },
    ]) {
      const result = classifyPair("site-a", "video-1", [
        link({ id: "only", ...overrides }),
      ]);
      assert.notEqual(
        result.resolution,
        "MINT_NEW",
        `${JSON.stringify(overrides)} must never predict a mint`,
      );
    }
  });

  it("reports ALREADY_CANONICAL and counts post-canonical duplicates", () => {
    const result = classifyPair(
      "site-a",
      "video-1",
      [
        link({
          id: "pinned",
          createdAt: new Date("2026-01-01"),
          anchoredCanonicalPair: { websiteId: "site-a", videoId: "video-1" },
        }),
        link({ id: "later-1", createdAt: new Date("2026-05-01") }),
        link({ id: "later-2", createdAt: new Date("2026-06-01") }),
        link({ id: "earlier", createdAt: new Date("2025-12-01") }),
      ],
      {
        canonical: { shareLinkId: "pinned", createdAt: new Date("2026-02-01") },
      },
    );

    assert.equal(result.resolution, "ALREADY_CANONICAL");
    assert.equal(
      result.deterministicWinnerId,
      "pinned",
      "an existing mapping always wins, whatever history says",
    );
    assert.equal(result.postCanonicalDuplicateCount, 2);
  });

  it("summarizes by predicted resolution", () => {
    const adopt = classifyPair("site-a", "video-1", [link({})]);
    const mint = classifyPair("site-a", "video-2", []);

    assert.deepEqual(summarizeResolutions([adopt, mint, mint]), {
      ADOPT_HISTORICAL: 1,
      MINT_NEW: 2,
    });
  });
});

/**
 * The shared policy itself, exercised directly. It is the single copy the
 * service and the audit script both call, so its rules are pinned once here
 * rather than re-asserted through two harnesses.
 */
describe("canonical historical selection policy", () => {
  const pair = { websiteId: "site-a", videoId: "video-1" };

  const candidate = (
    over: Partial<CanonicalAdoptionCandidate> = {},
  ): CanonicalAdoptionCandidate => ({
    id: "l1",
    alias: "abc",
    status: "ACTIVE",
    expiresAt: null,
    maxViews: null,
    createdAt: new Date("2026-01-01"),
    anchoredPair: null,
    ...over,
  });

  it("selects the newest link and never consults status", () => {
    for (const status of ["ACTIVE", "REVOKED", "DISABLED", "EXPIRED"]) {
      const selection = selectCanonicalHistoricalWinner(
        [
          candidate({ id: "older", createdAt: new Date("2026-01-01") }),
          candidate({
            id: "newest",
            createdAt: new Date("2026-06-01"),
            status,
          }),
        ],
        pair,
      );

      assert.equal(
        selection.winner?.id,
        "newest",
        `a ${status} newest link must still win — filtering it out would let an owner's restriction be routed around`,
      );
      assert.equal(selection.historicalCandidateCount, 2);
    }
  });

  it("marks a revoked or disabled winner as PINNABLE, not blocked", () => {
    // The distinction the whole design rests on: identity is not usability.
    for (const status of ["REVOKED", "DISABLED", "EXPIRED"]) {
      assert.equal(
        assessHistoricalWinnerPinnability(candidate({ status }), pair),
        null,
        `${status} must pin and then deny, not block the pin`,
      );
      assert.equal(isDenyingShareLinkStatus(status), true);
    }
    assert.equal(isDenyingShareLinkStatus("ACTIVE"), false);
  });

  it("blocks a pin for exactly the structural faults, and no others", () => {
    assert.equal(assessHistoricalWinnerPinnability(candidate(), pair), null);
    assert.equal(
      assessHistoricalWinnerPinnability(candidate({ alias: null }), pair),
      "ALIAS_MISSING",
    );
    assert.equal(
      assessHistoricalWinnerPinnability(candidate({ alias: "   " }), pair),
      "ALIAS_MISSING",
    );
    assert.equal(
      assessHistoricalWinnerPinnability(
        candidate({ expiresAt: new Date("2027-01-01") }),
        pair,
      ),
      "HAS_EXPIRY",
    );
    assert.equal(
      assessHistoricalWinnerPinnability(candidate({ maxViews: 1 }), pair),
      "HAS_MAX_VIEWS",
    );
    assert.equal(
      assessHistoricalWinnerPinnability(
        candidate({
          anchoredPair: { websiteId: "site-a", videoId: "video-2" },
        }),
        pair,
      ),
      "ANCHORED_TO_OTHER_PAIR",
    );
    // Anchored to THIS pair is a lost race, not corruption: the unique
    // constraint recovers it by reloading the winner.
    assert.equal(
      assessHistoricalWinnerPinnability(
        candidate({ anchoredPair: pair }),
        pair,
      ),
      null,
    );
  });

  it("never disqualifies a link for views already served", () => {
    // `currentViews` is not even part of the candidate type. A view budget is
    // blocked by `maxViews`, not by how much of it has been spent.
    assert.equal(
      assessHistoricalWinnerPinnability(candidate({ maxViews: null }), pair),
      null,
    );
  });

  it("orders newest first and breaks an exact tie on id DESC", () => {
    const sameInstant = new Date("2026-05-05T10:00:00.000Z");
    const selection = selectCanonicalHistoricalWinner(
      [
        candidate({ id: "aaa", createdAt: sameInstant }),
        candidate({ id: "zzz", createdAt: sameInstant }),
        candidate({ id: "old", createdAt: new Date("2020-01-01") }),
      ],
      pair,
    );

    assert.equal(selection.winner?.id, "zzz");
    assert.equal(selection.historicalCandidateCount, 3);
  });

  it("is order-independent: shuffling the input never changes the winner", () => {
    const rows = [
      candidate({ id: "a", createdAt: new Date("2026-01-01") }),
      candidate({ id: "b", createdAt: new Date("2026-07-01") }),
      candidate({ id: "c", createdAt: new Date("2026-03-01") }),
      // Newest AND revoked — it must win every permutation.
      candidate({
        id: "d",
        createdAt: new Date("2026-09-01"),
        status: "REVOKED",
      }),
    ];

    for (const permutation of [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [1, 3, 0, 2],
      [2, 0, 3, 1],
    ]) {
      const selection = selectCanonicalHistoricalWinner(
        permutation.map((index) => rows[index]),
        pair,
      );
      assert.equal(selection.winner?.id, "d");
      assert.equal(selection.historicalCandidateCount, 4);
      assert.equal(selection.pinBlocker, null);
    }
  });

  it("selects nothing from an empty history — the only case that may mint", () => {
    const selection = selectCanonicalHistoricalWinner([], pair);

    assert.equal(selection.winner, null);
    assert.equal(selection.historicalCandidateCount, 0);
    assert.equal(selection.pinBlocker, null);
  });

  it("never returns a null winner when any candidate exists", () => {
    // The property that forbids a mint-on-unusable-history fallback: if there
    // is history, there is always a winner, however restricted it is.
    for (const overrides of [
      { status: "REVOKED" as const },
      { alias: null },
      { expiresAt: new Date("2027-01-01") },
      { maxViews: 1 },
      { anchoredPair: { websiteId: "site-a", videoId: "video-9" } },
    ]) {
      const selection = selectCanonicalHistoricalWinner(
        [candidate(overrides)],
        pair,
      );
      assert.notEqual(
        selection.winner,
        null,
        `${JSON.stringify(overrides)} must still produce a winner`,
      );
    }
  });
});

/**
 * EXISTING CanonicalVideoShareLink ROWS — read-only classification.
 *
 * This looks BACKWARDS at what a previous implementation already wrote, which is
 * a different question from "what will the request path do next". Nothing here
 * repoints or repairs anything; the audit only names the fault.
 */
describe("existing canonical mapping audit", () => {
  const mapping = {
    websiteId: "site-a",
    videoId: "video-1",
    shareLinkId: "link-1",
  };

  const anchoredLink = (
    over: Partial<AuditShareLinkRow> = {},
  ): AuditShareLinkRow => ({
    id: "link-1",
    websiteId: "site-a",
    alias: "abc",
    status: "ACTIVE",
    expiresAt: null,
    maxViews: null,
    createdAt: new Date("2026-01-01"),
    lastViewedAt: null,
    currentViews: 0,
    videoIds: ["video-1"],
    ...over,
  });

  it("reports a healthy mapping as having no finding", () => {
    const result = classifyExistingCanonical(mapping, [anchoredLink()]);

    assert.equal(result.finding, null);
    assert.equal(result.unresolvable, false);
  });

  it("flags an alias-less anchor as UNRESOLVABLE — the KI-022 residue", () => {
    // `buildCanonicalReviewUrl()` throws without an alias, so the pair has no
    // resolvable canonical URL and no HTTP path can give it one. These are the
    // rows an operator must remediate by hand.
    for (const alias of [null, "", "   "]) {
      const result = classifyExistingCanonical(mapping, [
        anchoredLink({ alias }),
      ]);
      assert.equal(result.finding, "ALIAS_MISSING", String(alias));
      assert.equal(result.unresolvable, true);
    }
  });

  it("flags a website mismatch as unresolvable", () => {
    const result = classifyExistingCanonical(mapping, [
      anchoredLink({ websiteId: "site-b" }),
    ]);

    assert.equal(result.finding, "WEBSITE_MISMATCH");
    assert.equal(result.unresolvable, true);
  });

  it("flags exact-membership mismatch as unresolvable", () => {
    // A `[A, B]` membership anchored for A would publish B to everyone
    // following A's canonical URL.
    for (const videoIds of [["video-1", "video-2"], ["video-2"], []]) {
      const result = classifyExistingCanonical(mapping, [
        anchoredLink({ videoIds }),
      ]);
      assert.equal(
        result.finding,
        "MEMBERSHIP_MISMATCH",
        JSON.stringify(videoIds),
      );
      assert.equal(result.unresolvable, true);
    }
  });

  it("flags a vanished anchor as unresolvable", () => {
    // All four relations are `onDelete: Restrict`, so this should be
    // impossible; meeting it means a restore or a direct SQL edit.
    const result = classifyExistingCanonical(mapping, []);

    assert.equal(result.finding, "SHARE_LINK_MISSING");
    assert.equal(result.unresolvable, true);
  });

  it("flags a legacy access control WITHOUT calling it unresolvable", () => {
    // Public resolution still enforces both, so nothing is bypassed. What is
    // wrong is that the admin side reports a "permanent" URL that will lapse.
    const expiring = classifyExistingCanonical(mapping, [
      anchoredLink({ expiresAt: new Date("2027-01-01") }),
    ]);
    assert.equal(expiring.finding, "HAS_EXPIRY");
    assert.equal(expiring.unresolvable, false);

    const limited = classifyExistingCanonical(mapping, [
      anchoredLink({ maxViews: 5 }),
    ]);
    assert.equal(limited.finding, "HAS_MAX_VIEWS");
    assert.equal(limited.unresolvable, false);
  });

  it("reports a non-ACTIVE anchor LAST, and never as a fault", () => {
    // Pinning a revoked or disabled link is the INTENDED separation of identity
    // from usability. It is surfaced only so a 409 is diagnosable without
    // opening the database — never as something to repair.
    for (const status of ["REVOKED", "DISABLED", "EXPIRED"]) {
      const result = classifyExistingCanonical(mapping, [
        anchoredLink({ status }),
      ]);
      assert.equal(result.finding, "STATUS_NOT_ACTIVE", status);
      assert.equal(
        result.unresolvable,
        false,
        "a revoked canonical identity is correct, not broken",
      );
    }
  });

  it("prefers the more severe finding when several apply", () => {
    // A revoked, alias-less anchor is reported as ALIAS_MISSING: that is the
    // one an operator can and must act on.
    const result = classifyExistingCanonical(mapping, [
      anchoredLink({ alias: null, status: "REVOKED", maxViews: 3 }),
    ]);

    assert.equal(result.finding, "ALIAS_MISSING");
    assert.equal(result.unresolvable, true);
  });

  it("summarizes findings, counting a healthy mapping as HEALTHY", () => {
    const results = [
      classifyExistingCanonical(mapping, [anchoredLink()]),
      classifyExistingCanonical(mapping, [anchoredLink({ alias: null })]),
      classifyExistingCanonical(mapping, [anchoredLink({ status: "REVOKED" })]),
    ];

    assert.deepEqual(summarizeExistingCanonical(results), {
      HEALTHY: 1,
      ALIAS_MISSING: 1,
      STATUS_NOT_ACTIVE: 1,
    });
  });
});

/**
 * ALREADY-EXISTING MAPPINGS, THROUGH THE NORMAL RUNTIME.
 *
 * The block above classifies existing mappings on paper. This one drives the
 * real path — `createOrGetCanonical()` → `loadCanonical()` → `assertReusable()`
 * → `toResponse()` / `buildCanonicalReviewUrl()` — and proves it fails closed on
 * the same faults, with the mapping left exactly as it was.
 *
 * THE INVARIANT UNDER TEST, stated once for every case below:
 *
 *   An existing `CanonicalVideoShareLink` is authoritative FOREVER. Unusable is
 *   not wrong. Nothing here may repoint it, delete it, repair the link it
 *   anchors, mint a replacement, or fall back to a historical link — even
 *   though every one of these pairs has a NEWER, perfectly pinnable ACTIVE
 *   single-video link sitting in history, planted precisely so that a fallback
 *   would be visible if it ever happened.
 */
describe("existing canonical mapping runtime contract", () => {
  type Baseline = {
    canonicals: string;
    shareLinks: string;
    shareLinkVideos: string;
    canonicalCount: number;
    shareLinkCount: number;
    auditCount: number;
  };

  /**
   * A byte-comparable image of everything the runtime could have written.
   *
   * JSON rather than a field-by-field check on purpose: `Date` serializes to a
   * fixed ISO string and `BigInt` to decimal, so an unchanged row reproduces a
   * character-identical string and ANY mutation shows up — including one to a
   * column a hand-written assertion would not have thought to look at.
   */
  function captureBaseline(prisma: FakePrisma): Baseline {
    const stable = (value: unknown): string =>
      JSON.stringify(value, (_key, inner: unknown) =>
        typeof inner === "bigint" ? inner.toString() : inner,
      );

    return {
      canonicals: stable([...prisma.canonicals.entries()]),
      shareLinks: stable([...prisma.shareLinks.entries()]),
      shareLinkVideos: stable(prisma.shareLinkVideos),
      canonicalCount: prisma.canonicals.size,
      shareLinkCount: prisma.shareLinks.size,
      auditCount: prisma.audits.length,
    };
  }

  type SeededPair = {
    prisma: FakePrisma;
    service: CanonicalShareLinkService;
    anchoredLink: FakeShareLink;
    decoyLink: FakeShareLink;
  };

  /**
   * A committed, healthy mapping — plus a NEWER, ACTIVE, alias-bearing, exact
   * single-video decoy for the same pair.
   *
   * The decoy is the load-bearing part. It is strictly newer than the anchored
   * link and passes `assessHistoricalWinnerPinnability()` outright, so it is
   * exactly what a fallback would reach for. Every later assertion that the
   * mapping still points at the anchored link is therefore a live proof that no
   * fallback occurred, not a restatement of "nothing happened".
   */
  async function seedExistingMapping(): Promise<SeededPair> {
    const { prisma, service } = createService();
    await service.createOrGetCanonical("site-a", "video-1", "admin-1");
    prisma.audits.length = 0;

    const anchoredLink = [...prisma.shareLinks.values()][0];
    assert.ok(anchoredLink, "seed did not create the anchored link");

    const newer = new Date(anchoredLink.createdAt.getTime() + 86_400_000);
    const decoyLink: FakeShareLink = {
      id: "decoy-newer-link",
      websiteId: "site-a",
      tokenHash: "decoy-token-hash-must-never-be-returned",
      alias: "decoyAlias1234",
      label: null,
      expiresAt: null,
      maxViews: null,
      currentViews: 0,
      status: "ACTIVE",
      createdAt: newer,
      updatedAt: newer,
      lastViewedAt: null,
    };
    prisma.shareLinks.set(decoyLink.id, decoyLink);
    prisma.shareLinkVideos.push({
      shareLinkId: decoyLink.id,
      videoId: "video-1",
      sortOrder: 0,
    });

    return { prisma, service, anchoredLink, decoyLink };
  }

  /** Every secret the canonical subsystem holds, none of which may escape. */
  function assertNoSecretExposure(
    error: ConflictException,
    prisma: FakePrisma,
  ) {
    const serialized = JSON.stringify(error.getResponse());

    for (const forbidden of [
      "rawtoken",
      "tokenhash",
      "token",
      "pepper",
      "secret",
    ]) {
      assert.equal(
        serialized.toLowerCase().includes(forbidden),
        false,
        `error body mentions ${forbidden}: ${serialized}`,
      );
    }
    for (const link of prisma.shareLinks.values()) {
      assert.equal(
        serialized.includes(link.tokenHash),
        false,
        "error body leaked a tokenHash",
      );
      // The alias authorizes a public watch on the bound host all by itself, so
      // it is a bearer credential and must not travel in an error either.
      if (link.alias !== null && link.alias.trim() !== "") {
        assert.equal(
          serialized.includes(link.alias),
          false,
          "error body leaked an alias",
        );
      }
    }
  }

  /**
   * The seven required properties, asserted together so that no case in this
   * block can quietly prove less than another.
   */
  async function assertPairUntouched(params: {
    seeded: SeededPair;
    baseline: Baseline;
    expectedCode: string;
    expectedFault?: string;
  }): Promise<void> {
    const { seeded, baseline, expectedCode, expectedFault } = params;
    const { prisma, service, anchoredLink, decoyLink } = seeded;

    let thrown: unknown;
    await assert.rejects(
      service.createOrGetCanonical("site-a", "video-1", "admin-1"),
      (error: unknown) => {
        thrown = error;
        return true;
      },
    );

    // (7) the expected stable error code, plus the audit's own fault label.
    assert.ok(thrown instanceof ConflictException, String(thrown));
    assert.equal(thrown.getStatus(), 409);
    const body = thrown.getResponse() as { code?: string; fault?: string };
    assert.equal(body.code, expectedCode);
    assert.equal(body.fault, expectedFault);

    // (1) no new ShareLink. (2) no new CanonicalVideoShareLink.
    assert.equal(
      prisma.shareLinks.size,
      baseline.shareLinkCount,
      "minted a replacement link",
    );
    assert.equal(
      prisma.canonicals.size,
      baseline.canonicalCount,
      "wrote a second mapping",
    );

    // (3) the mapping is byte-for-byte what it was, and so are the ShareLink
    // rows: silently "repairing" the anchored link would change the mapping's
    // meaning without an owner, which is as wrong as repointing it.
    const after = captureBaseline(prisma);
    assert.equal(after.canonicals, baseline.canonicals, "mapping mutated");
    assert.equal(after.shareLinks, baseline.shareLinks, "share link mutated");
    assert.equal(
      after.shareLinkVideos,
      baseline.shareLinkVideos,
      "membership mutated",
    );

    // (4) no canonical success audit of any kind.
    assert.equal(
      prisma.audits.length,
      baseline.auditCount,
      "wrote an audit row",
    );
    assert.equal(
      prisma.audits.some((row) => row.action.startsWith("CANONICAL_")),
      false,
      "wrote a canonical audit row",
    );

    // (5) no fallback to the newer, pinnable, ACTIVE historical link.
    const mapping = [...prisma.canonicals.values()][0];
    assert.equal(mapping.shareLinkId, anchoredLink.id, "mapping was repointed");
    assert.notEqual(mapping.shareLinkId, decoyLink.id, "fell back to history");

    // (6) no credential of any kind in the error body.
    assertNoSecretExposure(thrown, prisma);

    // The refusal must be REPEATABLE. A guard that fails closed once and then
    // lets the next call through would be worse than none, because the
    // operator's retry is the request that would get served.
    await assert.rejects(
      service.createOrGetCanonical("site-a", "video-1", "admin-1"),
      expectConflictCode(expectedCode),
    );
    assert.equal(captureBaseline(prisma).canonicals, baseline.canonicals);
  }

  // -- 1. alias = null -------------------------------------------------------

  it("refuses an alias-less anchor BEFORE URL construction, with a stable code", async () => {
    // The KI-022 residue. Before this guard the mapping passed `assertReusable()`
    // and `buildCanonicalReviewUrl()` threw a bare 400 while SERIALIZING the
    // response: fail-closed, but with no code the Admin console could key a
    // remediation message off, and nothing saying the pair needs an owner.
    for (const alias of [null, "", "   "]) {
      const seeded = await seedExistingMapping();
      seeded.prisma.shareLinks.get(seeded.anchoredLink.id)!.alias = alias;

      await assertPairUntouched({
        seeded,
        baseline: captureBaseline(seeded.prisma),
        expectedCode: "CANONICAL_LINK_ALIAS_MISSING",
        expectedFault: "ALIAS_MISSING",
      });
    }
  });

  it("never reaches the URL builder for an alias-less anchor", async () => {
    // Proves the refusal is genuinely BEFORE construction rather than a
    // relabelled builder failure: a 409 rather than the builder's 400, and the
    // builder's own message must be absent.
    const seeded = await seedExistingMapping();
    seeded.prisma.shareLinks.get(seeded.anchoredLink.id)!.alias = null;

    await assert.rejects(
      seeded.service.createOrGetCanonical("site-a", "video-1", "admin-1"),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException, String(error));
        assert.equal(error.getStatus(), 409, "a 400 means the builder threw");
        const body = error.getResponse() as { message?: string };
        assert.equal(
          body.message?.includes("Canonical share alias is required"),
          false,
        );
        return true;
      },
    );

    // The builder still refuses on its own, so the fail-closed floor survives
    // even if the guard above were ever removed.
    assert.throws(
      () =>
        buildCanonicalReviewUrl({
          host: "plushcomedystudios.com",
          alias: "",
          protocol: "https",
        }),
      BadRequestException,
    );
  });

  // -- 2. expiresAt != null --------------------------------------------------

  it("refuses an anchor carrying an expiry, and never clears it", async () => {
    const seeded = await seedExistingMapping();
    const expiresAt = new Date("2030-01-01T00:00:00.000Z");
    seeded.prisma.shareLinks.get(seeded.anchoredLink.id)!.expiresAt = expiresAt;

    await assertPairUntouched({
      seeded,
      baseline: captureBaseline(seeded.prisma),
      expectedCode: "CANONICAL_LINK_OPTIONS_PRESENT",
      expectedFault: "HAS_EXPIRY",
    });

    // Clearing the owner's expiry to make the canonical URL "work" would be
    // exactly the bypass this refusal exists to prevent.
    assert.deepEqual(
      seeded.prisma.shareLinks.get(seeded.anchoredLink.id)!.expiresAt,
      expiresAt,
    );
  });

  it("refuses an expiry that has not yet elapsed", async () => {
    // The test is `expiresAt !== null`, not `expiresAt <= now`. A canonical URL
    // is reported as PERMANENT, and one that merely has not lapsed yet is not.
    const seeded = await seedExistingMapping();
    seeded.prisma.shareLinks.get(seeded.anchoredLink.id)!.expiresAt = new Date(
      Date.now() + 10 * 365 * 24 * 60 * 60 * 1000,
    );

    await assert.rejects(
      seeded.service.createOrGetCanonical("site-a", "video-1", "admin-1"),
      expectConflictCode("CANONICAL_LINK_OPTIONS_PRESENT"),
    );
  });

  // -- 3. maxViews != null ---------------------------------------------------

  it("refuses an anchor carrying a view limit, and never clears it", async () => {
    const seeded = await seedExistingMapping();
    seeded.prisma.shareLinks.get(seeded.anchoredLink.id)!.maxViews = 5;

    await assertPairUntouched({
      seeded,
      baseline: captureBaseline(seeded.prisma),
      expectedCode: "CANONICAL_LINK_OPTIONS_PRESENT",
      expectedFault: "HAS_MAX_VIEWS",
    });

    assert.equal(
      seeded.prisma.shareLinks.get(seeded.anchoredLink.id)!.maxViews,
      5,
    );
  });

  it("refuses a view limit with budget remaining, never consulting currentViews", async () => {
    const seeded = await seedExistingMapping();
    const link = seeded.prisma.shareLinks.get(seeded.anchoredLink.id)!;
    link.maxViews = 1000;
    link.currentViews = 0;

    await assert.rejects(
      seeded.service.createOrGetCanonical("site-a", "video-1", "admin-1"),
      expectConflictCode("CANONICAL_LINK_OPTIONS_PRESENT"),
    );
  });

  // -- 4. shareLink.websiteId !== canonical.websiteId ------------------------

  it("refuses an anchor bound to a different website", async () => {
    const seeded = await seedExistingMapping();
    seeded.prisma.shareLinks.get(seeded.anchoredLink.id)!.websiteId = "site-b";

    await assertPairUntouched({
      seeded,
      baseline: captureBaseline(seeded.prisma),
      expectedCode: "CANONICAL_LINK_INTEGRITY_CONFLICT",
      expectedFault: "WEBSITE_MISMATCH",
    });

    // The mapping still claims site-a and the link still claims site-b. Neither
    // was "corrected": this code cannot know which of the two is the truth, and
    // guessing would rewrite provenance.
    assert.equal([...seeded.prisma.canonicals.values()][0].websiteId, "site-a");
    assert.equal(
      seeded.prisma.shareLinks.get(seeded.anchoredLink.id)!.websiteId,
      "site-b",
    );
  });

  // -- 5. membership is not exactly one row matching canonical.videoId -------

  it("refuses every membership that is not exactly the mapped video", async () => {
    // `[A, B]` is the dangerous one: anchored for A, its URL would publish B to
    // every reviewer who follows A's canonical link.
    const memberships: string[][] = [
      ["video-1", "video-2"],
      ["video-2"],
      [],
      ["video-1", "video-1"],
    ];

    for (const videoIds of memberships) {
      const seeded = await seedExistingMapping();
      seeded.prisma.shareLinkVideos = seeded.prisma.shareLinkVideos.filter(
        (row) => row.shareLinkId !== seeded.anchoredLink.id,
      );
      videoIds.forEach((videoId, index) => {
        seeded.prisma.shareLinkVideos.push({
          shareLinkId: seeded.anchoredLink.id,
          videoId,
          sortOrder: index,
        });
      });

      await assertPairUntouched({
        seeded,
        baseline: captureBaseline(seeded.prisma),
        expectedCode: "CANONICAL_LINK_INTEGRITY_CONFLICT",
        expectedFault: "MEMBERSHIP_MISMATCH",
      });
    }
  });

  // -- 6. status = REVOKED ---------------------------------------------------

  it("refuses a REVOKED anchor with CANONICAL_LINK_REVOKED and keeps the mapping", async () => {
    // Already-correct behaviour, proven here against the full seven-property
    // checklist and against a newer ACTIVE link that a status filter would have
    // silently promoted — which is the bypass the whole design forbids.
    const seeded = await seedExistingMapping();
    seeded.prisma.shareLinks.get(seeded.anchoredLink.id)!.status = "REVOKED";

    await assertPairUntouched({
      seeded,
      baseline: captureBaseline(seeded.prisma),
      expectedCode: "CANONICAL_LINK_REVOKED",
    });
  });

  // -- 7. status = DISABLED --------------------------------------------------

  it("refuses a DISABLED anchor with CANONICAL_LINK_INACTIVE and keeps the mapping", async () => {
    const seeded = await seedExistingMapping();
    seeded.prisma.shareLinks.get(seeded.anchoredLink.id)!.status = "DISABLED";

    await assertPairUntouched({
      seeded,
      baseline: captureBaseline(seeded.prisma),
      expectedCode: "CANONICAL_LINK_INACTIVE",
    });
  });

  it("keeps EXPIRED status on the inactive code, distinct from an expiresAt column", async () => {
    // The two are independent (see `canonical-adoption-policy.util.ts`): the
    // status enum answers through `CANONICAL_LINK_INACTIVE`, the column through
    // `CANONICAL_LINK_OPTIONS_PRESENT`.
    const seeded = await seedExistingMapping();
    seeded.prisma.shareLinks.get(seeded.anchoredLink.id)!.status = "EXPIRED";

    await assert.rejects(
      seeded.service.createOrGetCanonical("site-a", "video-1", "admin-1"),
      expectConflictCode("CANONICAL_LINK_INACTIVE"),
    );
  });

  // -- ordering, and the healthy case ----------------------------------------

  it("answers an owner's revoke first, whatever else is also wrong", async () => {
    // A non-ACTIVE status is the one fault whose remedy is a DECISION rather
    // than a repair, so it is reported before any of the structural ones.
    // Pointing an operator at "restore the alias" for a link the owner
    // deliberately revoked would send them to fix the wrong thing, and could
    // end with them restoring access that was removed on purpose. `CANON-13` /
    // `CANON-14` pin the same precedence for a terminal status plus a budget.
    const seeded = await seedExistingMapping();
    const link = seeded.prisma.shareLinks.get(seeded.anchoredLink.id)!;
    link.alias = null;
    link.status = "REVOKED";
    link.maxViews = 3;

    await assert.rejects(
      seeded.service.createOrGetCanonical("site-a", "video-1", "admin-1"),
      expectConflictCode("CANONICAL_LINK_REVOKED"),
    );

    // Nothing was handed out under either precedence — the choice is only about
    // which remediation the operator is pointed at first.
    assert.equal(seeded.prisma.shareLinks.size, 2);
    assert.equal(seeded.prisma.canonicals.size, 1);
  });

  it("names the same fault the read-only audit names, for an ACTIVE anchor", async () => {
    // An audit that reports a different fault than the runtime refuses with is
    // the same defect as an audit that predicts a different winner: the
    // operator plans against one and meets the other. Wherever the audit's own
    // answer is not `STATUS_NOT_ACTIVE`, the two must agree.
    const cases: Array<{
      over: Partial<AuditShareLinkRow>;
      finding: string;
      code: string;
    }> = [
      {
        over: { alias: null, expiresAt: new Date("2030-01-01"), maxViews: 9 },
        finding: "ALIAS_MISSING",
        code: "CANONICAL_LINK_ALIAS_MISSING",
      },
      {
        over: { websiteId: "site-b", maxViews: 9 },
        finding: "WEBSITE_MISMATCH",
        code: "CANONICAL_LINK_INTEGRITY_CONFLICT",
      },
      {
        over: { videoIds: ["video-1", "video-2"], maxViews: 9 },
        finding: "MEMBERSHIP_MISMATCH",
        code: "CANONICAL_LINK_INTEGRITY_CONFLICT",
      },
      {
        over: { expiresAt: new Date("2030-01-01"), maxViews: 9 },
        finding: "HAS_EXPIRY",
        code: "CANONICAL_LINK_OPTIONS_PRESENT",
      },
      {
        over: { maxViews: 9 },
        finding: "HAS_MAX_VIEWS",
        code: "CANONICAL_LINK_OPTIONS_PRESENT",
      },
    ];

    for (const { over, finding, code } of cases) {
      const seeded = await seedExistingMapping();
      const link = seeded.prisma.shareLinks.get(seeded.anchoredLink.id)!;
      const { videoIds, ...columns } = over;
      Object.assign(link, columns);
      if (videoIds !== undefined) {
        seeded.prisma.shareLinkVideos = seeded.prisma.shareLinkVideos.filter(
          (row) => row.shareLinkId !== link.id,
        );
        videoIds.forEach((videoId, index) => {
          seeded.prisma.shareLinkVideos.push({
            shareLinkId: link.id,
            videoId,
            sortOrder: index,
          });
        });
      }

      await assert.rejects(
        seeded.service.createOrGetCanonical("site-a", "video-1", "admin-1"),
        expectConflictCode(code),
      );

      assert.equal(
        classifyExistingCanonical(
          {
            websiteId: "site-a",
            videoId: "video-1",
            shareLinkId: link.id,
          },
          [
            {
              id: link.id,
              websiteId: link.websiteId,
              alias: link.alias,
              status: link.status,
              expiresAt: link.expiresAt,
              maxViews: link.maxViews,
              createdAt: link.createdAt,
              lastViewedAt: null,
              currentViews: link.currentViews,
              videoIds: videoIds ?? ["video-1"],
            },
          ],
        ).finding,
        finding,
      );
    }
  });

  it("still reuses a healthy mapping, decoy history notwithstanding", async () => {
    // The guard must not turn a good mapping into a refusal, and the newer
    // pinnable decoy must not displace it either.
    const seeded = await seedExistingMapping();
    const baseline = captureBaseline(seeded.prisma);

    const reused = await seeded.service.createOrGetCanonical(
      "site-a",
      "video-1",
      "admin-1",
    );

    assert.equal(reused.outcome, "REUSED");
    assert.equal(reused.alias, seeded.anchoredLink.alias);
    assert.notEqual(reused.alias, seeded.decoyLink.alias);
    assert.ok(reused.reviewUrl.includes(reused.alias));
    assertCanonicalResponseHasNoSecrets(reused);
    assert.equal(
      captureBaseline(seeded.prisma).canonicals,
      baseline.canonicals,
    );
    assert.equal(seeded.prisma.audits.length, 0);
  });
});

/**
 * PUBLIC RESOLUTION IS INDEPENDENT — proven, not assumed, and NOT CHANGED.
 *
 * The admin-side refusals above would be worth little as a safety story if a
 * canonical mapping could confer any bypass on the public side, so the
 * independence is pinned here structurally rather than left as a claim in a
 * comment. These tests assert the CURRENT behaviour; nothing in this change
 * touches `public.service.ts`.
 */
describe("public resolution independence from canonical mappings", () => {
  const publicServiceSource = readFileSync(
    new URL("../src/public/public.service.ts", import.meta.url),
    "utf8",
  );

  it("never reads the canonical subsystem at all", () => {
    // The strongest statement available: a mapping cannot grant a bypass it is
    // never consulted for.
    assert.equal(
      /canonical/i.test(publicServiceSource),
      false,
      "public resolution referenced the canonical subsystem",
    );
  });

  it("keeps enforcing status, expiresAt and maxViews on the watch path", () => {
    const denied = publicServiceSource.match(
      /private getDeniedReason\([\s\S]*?\n {2}\}/,
    );
    assert.ok(denied, "getDeniedReason() missing");
    assert.match(denied[0], /status !== ShareLinkStatus\.ACTIVE/);
    assert.match(
      denied[0],
      /expiresAt !== null && shareLink\.expiresAt <= now/,
    );
    assert.match(denied[0], /maxViews !== null/);
    assert.match(denied[0], /currentViews >= shareLink\.maxViews/);
  });

  it("re-checks all three atomically when consuming a view", () => {
    // The authoritative gate: a conditional UPDATE, so two concurrent reviewers
    // cannot both consume the last view of a budgeted link.
    const increment = publicServiceSource.match(
      /private async incrementShareLinkView\([\s\S]*?\n {2}\}/,
    );
    assert.ok(increment, "incrementShareLinkView() missing");
    assert.match(increment[0], /status: ShareLinkStatus\.ACTIVE/);
    assert.match(increment[0], /expiresAt: null.*expiresAt: \{ gt: now \}/s);
    assert.match(increment[0], /currentViews: \{ lt: shareLink\.maxViews \}/);
    assert.match(increment[0], /result\.count === 1/);
  });

  it("re-checks status and expiry on every media playback route", () => {
    const media = publicServiceSource.match(
      /private getDeniedReasonForMediaPlayback\([\s\S]*?\n {2}\}/,
    );
    assert.ok(media, "getDeniedReasonForMediaPlayback() missing");
    assert.match(media[0], /status !== ShareLinkStatus\.ACTIVE/);
    assert.match(media[0], /expiresAt !== null && shareLink\.expiresAt <= now/);
  });
});

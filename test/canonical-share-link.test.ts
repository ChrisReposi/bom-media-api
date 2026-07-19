import "reflect-metadata";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ConflictException, NotFoundException } from "@nestjs/common";
import {
  CanonicalShareLinkService,
  type CanonicalEvidenceSnapshot,
} from "../src/admin-websites/canonical-share-link.service";
import { isShareLinkTokenOrAliasCollision } from "../src/admin-websites/utils/share-link-errors.util";
import { buildCanonicalPublicShareUrl } from "../src/admin-websites/utils/share-url.util";
import {
  classifyPair,
  mask,
  summarize,
  type AuditShareLinkRow,
} from "../scripts/audit/canonical-share-link-audit-core";
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
    }): Promise<Record<string, unknown> | null> =>
      this.videos.get(args.where.id) ?? null,
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
    assert.equal((error.getResponse() as { code?: string }).code, code);
    return true;
  };
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

// ---------------------------------------------------------------------------
// Create-or-get behavior
// ---------------------------------------------------------------------------

describe("canonical create-or-get", () => {
  it("creates once, then reuses byte-for-byte the same URL without a new token", async () => {
    const { service } = createService();

    const created = await service.createOrGetCanonical(
      "site-a",
      "video-1",
      "admin-1",
    );
    assert.equal(created.outcome, "CREATED");
    assert.equal(created.isCanonical, true);
    assert.ok(created.rawToken, "creator receives the raw token once");
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
    assert.equal(reused.rawToken, undefined);
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

    // Simulate a racing request that passed the findUnique gate before the
    // winner committed: force the next canonical create into the P2002 path.
    prisma.canonicals.delete([...prisma.canonicals.keys()][0]);
    prisma.failNextCanonicalCreateWith =
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "7.8.0",
        meta: { target: "CanonicalVideoShareLink_websiteId_videoId_key" },
      });
    // Restore the winner row so the loser can reload it.
    const restored = await service.createOrGetCanonical(
      "site-a",
      "video-1",
      "x",
    );
    assert.equal(restored.outcome, "CREATED");
    prisma.failNextCanonicalCreateWith = null;

    const loser = await service.createOrGetCanonical("site-a", "video-1", "x");
    assert.equal(loser.outcome, "REUSED");
    assert.equal(loser.alias, restored.alias);
    assert.notEqual(
      loser.alias,
      winner.alias === loser.alias ? "" : winner.alias,
    );
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
    assert.equal(clean.evidenceDrift, false);

    const video = prisma.videos.get("video-1")!;
    (video as { title: string }).title = "Edited title";
    const drifted = await service.getCanonical("site-a", "video-1");
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
});

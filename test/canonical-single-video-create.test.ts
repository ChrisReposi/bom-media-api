import "reflect-metadata";
import { AsyncLocalStorage } from "node:async_hooks";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { CanonicalShareLinkService } from "../src/admin-websites/canonical-share-link.service";
import type { CreateShareLinkDto } from "../src/admin-websites/dto/create-share-link.dto";
import { Prisma } from "../src/generated/prisma/client";

/**
 * CANONICAL SINGLE-VIDEO CREATE ROUTING.
 *
 * `POST /admin/websites/:id/share-links` used to mint a brand new ShareLink,
 * with a brand new alias and a brand new token, every single time it was
 * called. Pressing "Tạo share link" twice for the same website and the same one
 * video produced two links, ten times produced ten, and each one had a
 * different reviewer URL. The `CanonicalVideoShareLink` mapping that exists to
 * prevent exactly that was only reachable through a separate endpoint that no
 * client called.
 *
 * These tests pin the routing: an EXACT single-video request resolves the
 * canonical link for the pair, a multi-video request is untouched, and the two
 * coexist for the same video without colliding.
 *
 * The security half matters as much as the reuse half. A canonical link that is
 * revoked, disabled, expired, exhausted or whose video is no longer shareable
 * must REFUSE — never quietly mint a fresh credential, which would hand back
 * working access to a link an owner had deliberately taken away.
 */

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

/**
 * What one open transaction has inserted so far, so a rollback can undo
 * exactly its own writes and nothing else. A whole-collection snapshot would
 * be wrong here: transactions interleave at every await, so restoring the
 * collections would also erase rows a CONCURRENT transaction had already
 * committed — the opposite of isolation.
 */
type TransactionJournal = {
  shareLinkIds: string[];
  canonicalIds: string[];
  shareLinkVideoRows: unknown[];
  auditRows: unknown[];
};

const openTransaction = new AsyncLocalStorage<TransactionJournal>();

class FakePrisma {
  websites = new Map<string, { id: string; status: string }>();
  domains = new Map<
    string,
    {
      id: string;
      websiteId: string;
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
  audits: { action: string; entityId: string; metadata: unknown }[] = [];
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
      const first = [...this.domains.values()]
        .filter(
          (domain) =>
            domain.websiteId === args.where.websiteId &&
            domain.status === "ACTIVE",
        )
        .sort(
          (a, b) =>
            Number(b.isPrimary) - Number(a.isPrimary) ||
            a.createdAt.getTime() - b.createdAt.getTime(),
        )[0];
      return first ? { id: first.id, domain: first.domain } : null;
    },
    findUnique: async (args: {
      where: { id: string };
    }): Promise<{
      domain: string;
      status: string;
      websiteId: string;
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
      const created: FakeShareLink = {
        ...args.data,
        id: this.nextId("link"),
        createdAt: new Date(),
        updatedAt: new Date(),
        lastViewedAt: null,
      };
      this.shareLinks.set(created.id, created);
      openTransaction.getStore()?.shareLinkIds.push(created.id);
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
        canonicalVideoShareLink?: { is: null };
        shareLinkVideos?: { some: { videoId: string } };
      };
      orderBy?: { createdAt: "asc" };
    }): Promise<
      {
        id: string;
        alias: string | null;
        shareLinkVideos: { videoId: string }[];
      }[]
    > => {
      const anchored = new Set(
        [...this.canonicals.values()].map((row) => row.shareLinkId),
      );
      const needle = args.where.shareLinkVideos?.some.videoId;

      return [...this.shareLinks.values()]
        .filter((link) => link.websiteId === args.where.websiteId)
        .filter(
          (link) =>
            args.where.canonicalVideoShareLink === undefined ||
            !anchored.has(link.id),
        )
        .filter(
          (link) =>
            needle === undefined ||
            this.shareLinkVideos.some(
              (row) => row.shareLinkId === link.id && row.videoId === needle,
            ),
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((link) => ({
          id: link.id,
          alias: link.alias,
          shareLinkVideos: this.shareLinkVideos
            .filter((row) => row.shareLinkId === link.id)
            .map((row) => ({ videoId: row.videoId })),
        }));
    },
  };

  shareLinkVideo = {
    create: async (args: {
      data: { shareLinkId: string; videoId: string; sortOrder: number };
    }): Promise<void> => {
      this.shareLinkVideos.push(args.data);
      openTransaction.getStore()?.shareLinkVideoRows.push(args.data);
    },
  };

  canonicalVideoShareLink = {
    findUnique: async (args: {
      where: {
        websiteId_videoId?: { websiteId: string; videoId: string };
        id?: string;
      };
    }): Promise<unknown> => {
      const pair = args.where.websiteId_videoId;
      const canonical = pair
        ? [...this.canonicals.values()].find(
            (row) =>
              row.websiteId === pair.websiteId && row.videoId === pair.videoId,
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
      // The database unique constraint is the arbiter of the pair race. This
      // reproduces it, so a loser takes the same P2002 recovery path it takes
      // against MySQL.
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
      openTransaction.getStore()?.canonicalIds.push(created.id);
      return created;
    },
    count: async (): Promise<number> => this.canonicals.size,
  };

  adminAuditLog = {
    create: async (args: {
      data: { action: string; entityId: string; metadataJson?: unknown };
    }): Promise<void> => {
      const row = {
        action: args.data.action,
        entityId: args.data.entityId,
        metadata: args.data.metadataJson,
      };
      this.audits.push(row);
      openTransaction.getStore()?.auditRows.push(row);
    },
  };

  /**
   * ATOMIC, because the properties under test depend on it.
   *
   * The canonical create path writes a ShareLink and then its mapping in ONE
   * transaction, so a unique violation on the mapping must discard the
   * ShareLink too. Without that, a lost race would leave an orphan duplicate
   * behind that the database never actually produces — which would both fail a
   * correct implementation and hide a real orphan if the ordering changed.
   *
   * Rollback undoes only this transaction's own inserts, tracked through an
   * AsyncLocalStorage journal, so a concurrent transaction that committed in
   * the meantime is untouched.
   */
  async $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    const journal: TransactionJournal = {
      shareLinkIds: [],
      canonicalIds: [],
      shareLinkVideoRows: [],
      auditRows: [],
    };

    return openTransaction.run(journal, async () => {
      try {
        return await fn(this);
      } catch (error) {
        for (const id of journal.shareLinkIds) {
          this.shareLinks.delete(id);
        }
        for (const id of journal.canonicalIds) {
          this.canonicals.delete(id);
        }
        this.shareLinkVideos = this.shareLinkVideos.filter(
          (row) => !journal.shareLinkVideoRows.includes(row),
        );
        this.audits = this.audits.filter(
          (row) => !journal.auditRows.includes(row),
        );
        throw error;
      }
    });
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

type Harness = {
  prisma: FakePrisma;
  service: CanonicalShareLinkService;
  /** Every call the MULTI-VIDEO path received, in order. */
  multiVideoCalls: { websiteId: string; videoIds: string[] }[];
};

function createHarness(options?: {
  eligibilityError?: Error;
  /** Videos ACTIVE-assigned to a website, used when `videoIds` is omitted. */
  assignments?: Record<string, string[]>;
}): Harness {
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
  for (const videoId of ["video-1", "video-2", "video-3"]) {
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

  const multiVideoCalls: { websiteId: string; videoIds: string[] }[] = [];

  const websitesStub = {
    validateShareLinkVideoEligibility: async () => {
      if (options?.eligibilityError) {
        throw options.eligibilityError;
      }
    },
    getConfiguredPublicSiteProtocol: () => undefined,
    resolveShareLinkVideoIds: async (
      websiteId: string,
      dto: CreateShareLinkDto,
    ): Promise<string[]> => {
      const provided = dto.videoIds ?? [];
      if (provided.length > 0) {
        return [...provided];
      }
      return [...(options?.assignments?.[websiteId] ?? [])];
    },
    createShareLink: async (
      websiteId: string,
      _dto: CreateShareLinkDto,
      _adminId: string,
      resolvedVideoIds?: string[],
    ) => {
      const videoIds = resolvedVideoIds ?? [];
      multiVideoCalls.push({ websiteId, videoIds });
      const link = await prisma.shareLink.create({
        data: {
          websiteId,
          tokenHash: `hash-${prisma.nextId("t")}`,
          alias: prisma.nextId("bundle"),
          label: null,
          expiresAt: null,
          maxViews: null,
          currentViews: 0,
          status: "ACTIVE",
        },
      });
      for (const [index, videoId] of videoIds.entries()) {
        await prisma.shareLinkVideo.create({
          data: { shareLinkId: link.id, videoId, sortOrder: index },
        });
      }
      return {
        message: "Share link created successfully.",
        shareLink: { id: link.id, alias: link.alias, videos: videoIds },
        rawToken: "s_raw",
        publicUrl: `https://plushcomedystudios.com/watch#k=${link.alias}`,
        outcome: "CREATED",
        isCanonical: false,
      };
    },
    toShareLinkResponse: (
      link: FakeShareLink & { shareLinkVideos: { videoId: string }[] },
      publicUrl: string | null,
    ) => ({
      id: link.id,
      alias: link.alias,
      status: link.status,
      expiresAt: link.expiresAt,
      maxViews: link.maxViews,
      currentViews: link.currentViews,
      publicUrl,
      videos: link.shareLinkVideos.map((video) => ({ videoId: video.videoId })),
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

  return { prisma, service, multiVideoCalls };
}

function singleVideoRequest(videoId: string): CreateShareLinkDto {
  return { videoIds: [videoId] } as CreateShareLinkDto;
}

/** The one canonical row for a pair, or `undefined`. */
function canonicalFor(
  prisma: FakePrisma,
  websiteId: string,
  videoId: string,
): FakeCanonical | undefined {
  return [...prisma.canonicals.values()].find(
    (row) => row.websiteId === websiteId && row.videoId === videoId,
  );
}

function expectConflictCode(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ConflictException, String(error));
    assert.equal(error.getStatus(), 409);
    assert.equal((error.getResponse() as { code?: string }).code, code);
    return true;
  };
}

// ---------------------------------------------------------------------------
// CANON-01 .. CANON-08 — identity and coexistence
// ---------------------------------------------------------------------------

describe("canonical single-video create routing", () => {
  it("CANON-01 creates exactly one share link and one canonical mapping", async () => {
    const { prisma, service, multiVideoCalls } = createHarness();

    const first = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    assert.equal(first.outcome, "CREATED");
    assert.equal(first.isCanonical, true);
    assert.equal(prisma.shareLinks.size, 1);
    assert.equal(prisma.canonicals.size, 1);
    // The multi-video path must not have been consulted at all.
    assert.deepEqual(multiVideoCalls, []);
  });

  it("CANON-02 returns the same id, alias and URL on the second request, writing no row", async () => {
    const { prisma, service } = createHarness();

    const first = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    const shareLinkCountAfterFirst = prisma.shareLinks.size;

    const second = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-2",
    );

    assert.equal(second.outcome, "REUSED");
    assert.equal(second.shareLink.id, first.shareLink.id);
    assert.equal(second.shareLink.alias, first.shareLink.alias);
    assert.equal(second.publicUrl, first.publicUrl);
    assert.equal(prisma.shareLinks.size, shareLinkCountAfterFirst);
    assert.equal(prisma.canonicals.size, 1);
  });

  it("CANON-02 returns the V2 reviewer URL, never the legacy hash form", async () => {
    const { service } = createHarness();

    const created = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    assert.equal(
      created.publicUrl,
      `https://plushcomedystudios.com/watch#k=${encodeURIComponent(
        created.shareLink.alias ?? "",
      )}`,
    );
    // The credential must never reach a path segment or a query string, where
    // the static host and every proxy in front of it would log it.
    const url = new URL(created.publicUrl ?? "");
    assert.equal(url.pathname, "/watch");
    assert.equal(url.search, "");
    assert.equal(created.publicUrl?.includes("/#/s/"), false);
  });

  it("CANON-03 still holds one canonical identity after a hundred requests", async () => {
    const { prisma, service } = createHarness();

    const results = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      results.push(
        await service.createShareLinkForRequest(
          "site-a",
          singleVideoRequest("video-1"),
          "admin-1",
        ),
      );
    }

    assert.equal(prisma.canonicals.size, 1);
    assert.equal(prisma.shareLinks.size, 1);
    assert.equal(new Set(results.map((row) => row.shareLink.id)).size, 1);
    assert.equal(new Set(results.map((row) => row.publicUrl)).size, 1);
    assert.equal(results.filter((row) => row.outcome === "CREATED").length, 1);
  });

  it("CANON-04 resolves concurrent same-pair requests to one canonical share link", async () => {
    const { prisma, service } = createHarness();

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.createShareLinkForRequest(
          "site-a",
          singleVideoRequest("video-1"),
          "admin-1",
        ),
      ),
    );

    assert.equal(prisma.canonicals.size, 1);
    assert.equal(new Set(results.map((row) => row.shareLink.id)).size, 1);
    assert.equal(new Set(results.map((row) => row.publicUrl)).size, 1);
    // Exactly one racer won; every other one reused rather than minting.
    assert.equal(results.filter((row) => row.outcome === "CREATED").length, 1);
    assert.equal(results.filter((row) => row.outcome === "REUSED").length, 7);
  });

  it("CANON-05 gives the same video a different canonical link per website", async () => {
    const { prisma, service } = createHarness();

    const onA = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    const onB = await service.createShareLinkForRequest(
      "site-b",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    assert.notEqual(onA.shareLink.id, onB.shareLink.id);
    assert.notEqual(onA.shareLink.alias, onB.shareLink.alias);
    assert.equal(prisma.canonicals.size, 2);
    assert.ok(onB.publicUrl?.startsWith("https://other-site.com/watch#k="));
  });

  it("CANON-06 gives different videos on one website different canonical links", async () => {
    const { prisma, service } = createHarness();

    const videoOne = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    const videoTwo = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-2"),
      "admin-1",
    );

    assert.notEqual(videoOne.shareLink.id, videoTwo.shareLink.id);
    assert.equal(prisma.canonicals.size, 2);
  });

  it("CANON-07 routes a multi-video request to the bundle path, untouched", async () => {
    const { prisma, service, multiVideoCalls } = createHarness();

    const bundle = await service.createShareLinkForRequest(
      "site-a",
      { videoIds: ["video-1", "video-2"] } as CreateShareLinkDto,
      "admin-1",
    );

    assert.equal(bundle.isCanonical, false);
    assert.equal(bundle.outcome, "CREATED");
    assert.equal(prisma.canonicals.size, 0);
    assert.deepEqual(multiVideoCalls, [
      { websiteId: "site-a", videoIds: ["video-1", "video-2"] },
    ]);
  });

  it("CANON-07 creating a bundle twice does not deduplicate it", async () => {
    const { prisma, service } = createHarness();
    const dto = { videoIds: ["video-1", "video-2"] } as CreateShareLinkDto;

    const first = await service.createShareLinkForRequest(
      "site-a",
      dto,
      "admin-1",
    );
    const second = await service.createShareLinkForRequest(
      "site-a",
      dto,
      "admin-1",
    );

    assert.notEqual(first.shareLink.id, second.shareLink.id);
    assert.equal(prisma.shareLinks.size, 2);
  });

  it("CANON-08 lets one video belong to its canonical link AND a bundle", async () => {
    const { prisma, service } = createHarness();

    const canonical = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    const bundle = await service.createShareLinkForRequest(
      "site-a",
      { videoIds: ["video-1", "video-2"] } as CreateShareLinkDto,
      "admin-1",
    );

    assert.notEqual(canonical.shareLink.id, bundle.shareLink.id);
    // Membership carries no uniqueness: video-1 legitimately appears twice.
    const membershipsForVideoOne = prisma.shareLinkVideos.filter(
      (row) => row.videoId === "video-1",
    );
    assert.equal(membershipsForVideoOne.length, 2);
    // Canonical identity is carried by the mapping, not by membership.
    assert.equal(prisma.canonicals.size, 1);
    assert.equal(
      canonicalFor(prisma, "site-a", "video-1")?.shareLinkId,
      canonical.shareLink.id,
    );

    // ...and the pair still resolves to the canonical link, not the bundle.
    const again = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    assert.equal(again.shareLink.id, canonical.shareLink.id);
    assert.equal(again.outcome, "REUSED");
  });

  it("routes a website whose whole assignment set is one video to the canonical path", async () => {
    // `videoIds` omitted resolves to the website's active assignments. One
    // assigned video is a genuine single-video link and must not escape
    // canonical routing just because the caller left the field out.
    const { prisma, service, multiVideoCalls } = createHarness({
      assignments: { "site-a": ["video-1"] },
    });

    const created = await service.createShareLinkForRequest(
      "site-a",
      {} as CreateShareLinkDto,
      "admin-1",
    );

    assert.equal(created.isCanonical, true);
    assert.equal(prisma.canonicals.size, 1);
    assert.deepEqual(multiVideoCalls, []);
  });
});

// ---------------------------------------------------------------------------
// CANON-09 .. CANON-15 — security state is never bypassed
// ---------------------------------------------------------------------------

describe("canonical reuse never rotates credentials or resets budgets", () => {
  it("CANON-09 leaves currentViews untouched on reuse", async () => {
    const { prisma, service } = createHarness();

    const first = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    const link = prisma.shareLinks.get(first.shareLink.id);
    assert.ok(link);
    link.currentViews = 37;

    const reused = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    assert.equal(reused.outcome, "REUSED");
    assert.equal(prisma.shareLinks.get(first.shareLink.id)?.currentViews, 37);
  });

  it("CANON-10 leaves expiresAt and maxViews untouched on reuse", async () => {
    const { prisma, service } = createHarness();

    const first = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    const link = prisma.shareLinks.get(first.shareLink.id);
    assert.ok(link);
    const pinnedExpiry = new Date("2027-01-01T00:00:00.000Z");
    link.expiresAt = pinnedExpiry;
    link.maxViews = 5;

    await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    const after = prisma.shareLinks.get(first.shareLink.id);
    assert.equal(after?.expiresAt?.toISOString(), pinnedExpiry.toISOString());
    assert.equal(after?.maxViews, 5);
  });

  it("CANON-16 keeps the token hash and alias byte-identical across reuse", async () => {
    const { prisma, service } = createHarness();

    const first = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    const before = { ...prisma.shareLinks.get(first.shareLink.id)! };

    await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    const after = prisma.shareLinks.get(first.shareLink.id);
    assert.equal(after?.tokenHash, before.tokenHash);
    assert.equal(after?.alias, before.alias);
    assert.equal(after?.websiteId, before.websiteId);
    assert.equal(after?.createdAt.getTime(), before.createdAt.getTime());
  });

  for (const [label, status, code] of [
    ["CANON-11 revoked", "REVOKED", "CANONICAL_LINK_REVOKED"],
    ["CANON-12 disabled", "DISABLED", "CANONICAL_LINK_INACTIVE"],
    ["CANON-13 expired", "EXPIRED", "CANONICAL_LINK_INACTIVE"],
  ] as const) {
    it(`${label} refuses instead of minting a replacement credential`, async () => {
      const { prisma, service } = createHarness();

      const first = await service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-1",
      );
      const link = prisma.shareLinks.get(first.shareLink.id);
      assert.ok(link);
      link.status = status;

      const shareLinkCountBefore = prisma.shareLinks.size;
      const canonicalCountBefore = prisma.canonicals.size;

      await assert.rejects(
        service.createShareLinkForRequest(
          "site-a",
          singleVideoRequest("video-1"),
          "admin-1",
        ),
        expectConflictCode(code),
      );

      // Nothing new was minted, and the existing link was NOT revived.
      assert.equal(prisma.shareLinks.size, shareLinkCountBefore);
      assert.equal(prisma.canonicals.size, canonicalCountBefore);
      assert.equal(prisma.shareLinks.get(first.shareLink.id)?.status, status);
      assert.equal(
        canonicalFor(prisma, "site-a", "video-1")?.shareLinkId,
        first.shareLink.id,
      );
    });
  }

  it("CANON-14 an exhausted canonical link is refused, not reset", async () => {
    const { prisma, service } = createHarness();

    const first = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    const link = prisma.shareLinks.get(first.shareLink.id);
    assert.ok(link);
    // A historical link that carried a budget and burned through it. Status is
    // the terminal fact the sweep records.
    link.maxViews = 3;
    link.currentViews = 3;
    link.status = "EXPIRED";

    await assert.rejects(
      service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-1",
      ),
      expectConflictCode("CANONICAL_LINK_INACTIVE"),
    );

    const after = prisma.shareLinks.get(first.shareLink.id);
    assert.equal(after?.currentViews, 3, "views must not be reset");
    assert.equal(after?.maxViews, 3, "budget must not be replaced");
    assert.equal(prisma.shareLinks.size, 1, "no replacement link");
  });

  it("CANON-15 an unshareable video keeps its canonical URL and mints nothing", async () => {
    const { prisma, service } = createHarness();

    const first = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    // Now the video stops being shareable — unassigned, remoteMissing, no
    // longer READY. Eligibility is what reports every one of those.
    const blocked = createHarness({
      eligibilityError: new Error("VIDEO_NOT_ACTIVE_FOR_WEBSITE"),
    });
    blocked.prisma.shareLinks = prisma.shareLinks;
    blocked.prisma.canonicals = prisma.canonicals;
    blocked.prisma.shareLinkVideos = prisma.shareLinkVideos;

    await assert.rejects(
      blocked.service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-1",
      ),
      expectConflictCode("CANONICAL_VIDEO_NOT_SHAREABLE"),
    );

    assert.equal(blocked.prisma.shareLinks.size, 1);
    assert.equal(
      canonicalFor(blocked.prisma, "site-a", "video-1")?.shareLinkId,
      first.shareLink.id,
    );
  });

  it("CANON-16 the same canonical identity resumes after disable then restore", async () => {
    const { prisma, service } = createHarness();

    const original = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    const link = prisma.shareLinks.get(original.shareLink.id);
    assert.ok(link);

    // Disabling the video sweeps the link to DISABLED.
    link.status = "DISABLED";
    await assert.rejects(
      service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-1",
      ),
      expectConflictCode("CANONICAL_LINK_INACTIVE"),
    );

    // Restoring the video to READY sweeps the SAME link back to ACTIVE — the
    // lifecycle never rewrites alias, tokenHash or websiteId.
    link.status = "ACTIVE";

    const afterRestore = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    assert.equal(afterRestore.outcome, "REUSED");
    assert.equal(afterRestore.shareLink.id, original.shareLink.id);
    assert.equal(afterRestore.shareLink.alias, original.shareLink.alias);
    assert.equal(afterRestore.publicUrl, original.publicUrl);
    assert.equal(prisma.shareLinks.size, 1, "no L2 was ever minted");
  });
});

// ---------------------------------------------------------------------------
// Option contract, auditing and idempotent retry
// ---------------------------------------------------------------------------

describe("canonical single-video option contract", () => {
  for (const [field, dto] of [
    ["expiresAt", { videoIds: ["video-1"], expiresAt: "2027-01-01T00:00:00Z" }],
    ["maxViews", { videoIds: ["video-1"], maxViews: 5 }],
    ["label", { videoIds: ["video-1"], label: "Gửi cho khách hàng A" }],
  ] as const) {
    it(`rejects a single-video request carrying ${field}, before writing anything`, async () => {
      const { prisma, service } = createHarness();

      await assert.rejects(
        service.createShareLinkForRequest(
          "site-a",
          dto as CreateShareLinkDto,
          "admin-1",
        ),
        (error: unknown) => {
          assert.ok(error instanceof BadRequestException, String(error));
          const body = error.getResponse() as {
            code?: string;
            message?: string;
          };
          assert.equal(body.code, "CANONICAL_LINK_OPTIONS_NOT_ALLOWED");
          assert.ok(body.message?.includes(field));
          return true;
        },
      );

      assert.equal(prisma.shareLinks.size, 0);
      assert.equal(prisma.canonicals.size, 0);
    });
  }

  it("accepts an empty label, which carries no intent to limit the link", async () => {
    const { service } = createHarness();

    const created = await service.createShareLinkForRequest(
      "site-a",
      { videoIds: ["video-1"], label: "   " } as CreateShareLinkDto,
      "admin-1",
    );

    assert.equal(created.isCanonical, true);
  });

  it("still allows those options on a multi-video bundle", async () => {
    const { service, multiVideoCalls } = createHarness();

    const bundle = await service.createShareLinkForRequest(
      "site-a",
      {
        videoIds: ["video-1", "video-2"],
        maxViews: 5,
        expiresAt: "2027-01-01T00:00:00Z",
        label: "Khách hàng A",
      } as CreateShareLinkDto,
      "admin-1",
    );

    assert.equal(bundle.isCanonical, false);
    assert.equal(multiVideoCalls.length, 1);
  });
});

describe("canonical single-video audit and retry", () => {
  it("CANON-19 writes no raw token, alias or hash into the audit log", async () => {
    const { prisma, service } = createHarness();

    await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    assert.equal(prisma.audits.length, 1);
    assert.equal(prisma.audits[0].action, "CANONICAL_SHARE_LINK_CREATE");

    const serialized = JSON.stringify(prisma.audits);
    const link = [...prisma.shareLinks.values()][0];
    assert.equal(serialized.includes("tokenHash"), false);
    assert.equal(serialized.includes("rawToken"), false);
    assert.equal(serialized.includes(link.tokenHash), false);
    assert.ok(link.alias);
    assert.equal(
      serialized.includes(link.alias),
      false,
      "the credential must not be audited",
    );
  });

  it("CANON-19 never returns a raw token on the canonical path", async () => {
    const { service } = createHarness();

    const created = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    const reused = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    for (const response of [created, reused]) {
      assert.equal(response.rawToken, undefined);
      assert.equal(JSON.stringify(response).includes("tokenHash"), false);
    }
  });

  it("CANON-20 is idempotent across a retry after an ambiguous response", async () => {
    const { prisma, service } = createHarness();

    // The client never saw the first response — a timeout, a dropped socket —
    // and retried the identical request.
    const first = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    const retry = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    assert.equal(retry.shareLink.id, first.shareLink.id);
    assert.equal(retry.publicUrl, first.publicUrl);
    assert.equal(prisma.shareLinks.size, 1);
    assert.equal(prisma.canonicals.size, 1);
  });
});

// ---------------------------------------------------------------------------
// CANON-HIST-01 .. 12 — historical links that predate any canonical mapping
// ---------------------------------------------------------------------------

/**
 * Seeds a share link exactly as historical production data holds one: the rows
 * exist and no `CanonicalVideoShareLink` mapping was ever written, because the
 * mapping only ever came from an endpoint no client called.
 */
function seedHistoricalLink(
  prisma: FakePrisma,
  params: {
    websiteId: string;
    videoIds: string[];
    alias: string;
    status?: string;
    createdAt?: Date;
    expiresAt?: Date | null;
    maxViews?: number | null;
    currentViews?: number;
  },
): string {
  const id = prisma.nextId("historical");
  prisma.shareLinks.set(id, {
    id,
    websiteId: params.websiteId,
    tokenHash: `hash-${params.alias}`,
    alias: params.alias,
    label: "Gửi cho khách hàng A",
    expiresAt: params.expiresAt ?? null,
    maxViews: params.maxViews ?? null,
    currentViews: params.currentViews ?? 0,
    status: params.status ?? "ACTIVE",
    createdAt: params.createdAt ?? new Date("2026-01-01"),
    updatedAt: params.createdAt ?? new Date("2026-01-01"),
    lastViewedAt: null,
  });
  for (const [index, videoId] of params.videoIds.entries()) {
    prisma.shareLinkVideos.push({ shareLinkId: id, videoId, sortOrder: index });
  }
  return id;
}

describe("canonical adoption of historical single-video links", () => {
  it("CANON-HIST-01 creates a canonical link when no historical candidate exists", async () => {
    const { prisma, service } = createHarness();

    const created = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    assert.equal(created.outcome, "CREATED");
    assert.equal(prisma.shareLinks.size, 1);
    assert.equal(prisma.canonicals.size, 1);
  });

  it("CANON-HIST-02 adopts the one historical link instead of minting a second", async () => {
    const { prisma, service } = createHarness();
    const historicalId = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-alias-1",
    });
    const before = { ...prisma.shareLinks.get(historicalId) };

    const resolved = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    assert.equal(resolved.outcome, "REUSED");
    assert.equal(resolved.shareLink.id, historicalId);
    assert.equal(resolved.shareLink.alias, "hist-alias-1");
    assert.equal(
      prisma.shareLinks.size,
      1,
      "no second share link may be created",
    );
    assert.equal(
      canonicalFor(prisma, "site-a", "video-1")?.shareLinkId,
      historicalId,
    );

    // Every identity-bearing column is byte-identical afterwards.
    const after = prisma.shareLinks.get(historicalId);
    assert.equal(after?.alias, before.alias);
    assert.equal(after?.tokenHash, before.tokenHash);
    assert.equal(after?.createdAt.getTime(), before.createdAt?.getTime());
    assert.equal(after?.currentViews, before.currentViews);
    assert.equal(after?.maxViews, before.maxViews);
    assert.equal(after?.expiresAt, before.expiresAt);
    assert.equal(after?.status, before.status);
    assert.equal(after?.label, before.label, "adoption must not rename");
  });

  it("CANON-HIST-02 the adopted link is what every later request returns", async () => {
    const { prisma, service } = createHarness();
    const historicalId = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-alias-1",
    });

    const first = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    const second = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    assert.equal(first.shareLink.id, historicalId);
    assert.equal(second.shareLink.id, historicalId);
    assert.equal(second.publicUrl, first.publicUrl);
    assert.equal(prisma.shareLinks.size, 1);
  });

  it("CANON-HIST-02 audits adoption distinctly from creation, with no credential", async () => {
    const { prisma, service } = createHarness();
    seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-alias-1",
    });

    await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    assert.equal(prisma.audits.length, 1);
    assert.equal(prisma.audits[0].action, "CANONICAL_SHARE_LINK_ADOPT");
    assert.equal(JSON.stringify(prisma.audits).includes("hist-alias-1"), false);
  });

  for (const [label, status, code] of [
    ["CANON-HIST-03 revoked", "REVOKED", "CANONICAL_LINK_REVOKED"],
    ["CANON-HIST-04 disabled", "DISABLED", "CANONICAL_LINK_INACTIVE"],
    ["CANON-HIST-05 expired", "EXPIRED", "CANONICAL_LINK_INACTIVE"],
  ] as const) {
    it(`${label} historical link is pinned, never replaced`, async () => {
      const { prisma, service } = createHarness();
      const historicalId = seedHistoricalLink(prisma, {
        websiteId: "site-a",
        videoIds: ["video-1"],
        alias: "hist-alias-1",
        status,
      });

      await assert.rejects(
        service.createShareLinkForRequest(
          "site-a",
          singleVideoRequest("video-1"),
          "admin-1",
        ),
        expectConflictCode(code),
      );

      // The identity IS pinned — the pair now has one permanent answer — but
      // no replacement credential was minted and the link was not revived.
      assert.equal(
        canonicalFor(prisma, "site-a", "video-1")?.shareLinkId,
        historicalId,
      );
      assert.equal(prisma.shareLinks.size, 1, "no replacement link");
      assert.equal(prisma.shareLinks.get(historicalId)?.status, status);

      // The pinning is durable: the next attempt takes the mapping path and
      // still refuses rather than creating anything.
      await assert.rejects(
        service.createShareLinkForRequest(
          "site-a",
          singleVideoRequest("video-1"),
          "admin-1",
        ),
        expectConflictCode(code),
      );
      assert.equal(prisma.shareLinks.size, 1);
      assert.equal(prisma.canonicals.size, 1);
    });
  }

  it("CANON-HIST-06 an exhausted historical link keeps its spent budget", async () => {
    const { prisma, service } = createHarness();
    const historicalId = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-alias-1",
      status: "EXPIRED",
      maxViews: 3,
      currentViews: 3,
    });

    await assert.rejects(
      service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-1",
      ),
      expectConflictCode("CANONICAL_LINK_INACTIVE"),
    );

    const after = prisma.shareLinks.get(historicalId);
    assert.equal(after?.currentViews, 3, "views must not be reset");
    assert.equal(after?.maxViews, 3, "budget must not be replaced");
    assert.equal(prisma.shareLinks.size, 1);
  });

  it("CANON-HIST-07 refuses when two historical candidates exist, creating nothing", async () => {
    const { prisma, service } = createHarness();
    seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-alias-1",
      createdAt: new Date("2026-01-01"),
    });
    seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-alias-2",
      createdAt: new Date("2026-02-01"),
    });

    await assert.rejects(
      service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-1",
      ),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException, String(error));
        assert.equal(error.getStatus(), 409);
        const body = error.getResponse() as {
          code?: string;
          candidateCount?: number;
        };
        assert.equal(body.code, "CANONICAL_LINK_AMBIGUOUS");
        assert.equal(body.candidateCount, 2);
        return true;
      },
    );

    // No L3, no mapping, and no winner silently picked by createdAt or status.
    assert.equal(prisma.shareLinks.size, 2);
    assert.equal(prisma.canonicals.size, 0);
    assert.equal(prisma.audits.length, 0);
  });

  it("CANON-HIST-07 stays refused on retry until an owner adopts one", async () => {
    const { prisma, service } = createHarness();
    const firstId = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-alias-1",
    });
    seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-alias-2",
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(
        service.createShareLinkForRequest(
          "site-a",
          singleVideoRequest("video-1"),
          "admin-1",
        ),
        expectConflictCode("CANONICAL_LINK_AMBIGUOUS"),
      );
    }
    assert.equal(prisma.shareLinks.size, 2);

    // The operator resolves it through the existing deliberate adoption path.
    await service.adoptExistingShareLink({
      websiteId: "site-a",
      videoId: "video-1",
      shareLinkId: firstId,
      adminId: "owner-1",
    });

    const resolved = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    assert.equal(resolved.outcome, "REUSED");
    assert.equal(resolved.shareLink.id, firstId);
    assert.equal(prisma.shareLinks.size, 2, "the other link is left alone");
  });

  it("CANON-HIST-08 adopts the exact [A] link and ignores the [A,B] bundle", async () => {
    const { prisma, service } = createHarness();
    const exactId = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-exact",
    });
    const bundleId = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1", "video-2"],
      alias: "hist-bundle",
    });

    const resolved = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    assert.equal(resolved.shareLink.id, exactId);
    assert.notEqual(resolved.shareLink.id, bundleId);
    assert.equal(prisma.shareLinks.size, 2, "nothing new was minted");
    assert.equal(
      prisma.shareLinkVideos.filter((row) => row.shareLinkId === bundleId)
        .length,
      2,
      "the bundle keeps both members",
    );
  });

  it("CANON-HIST-09 a bundle alone is NOT a candidate — adopting it would leak B", async () => {
    const { prisma, service } = createHarness();
    const bundleId = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1", "video-2"],
      alias: "hist-bundle",
    });

    const created = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    assert.equal(created.outcome, "CREATED");
    assert.notEqual(created.shareLink.id, bundleId);
    assert.equal(prisma.shareLinks.size, 2);
    // The canonical link contains video-1 ONLY.
    assert.deepEqual(created.shareLink.videos, [{ videoId: "video-1" }]);
    assert.equal(
      canonicalFor(prisma, "site-a", "video-1")?.shareLinkId,
      created.shareLink.id,
    );
  });

  it("CANON-HIST-09 a same-video link on ANOTHER website is not a candidate", async () => {
    const { prisma, service } = createHarness();
    const otherSiteId = seedHistoricalLink(prisma, {
      websiteId: "site-b",
      videoIds: ["video-1"],
      alias: "hist-other-site",
    });

    const created = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    assert.equal(created.outcome, "CREATED");
    assert.notEqual(created.shareLink.id, otherSiteId);
  });

  it("CANON-HIST-10 eight concurrent requests all adopt the one historical link", async () => {
    const { prisma, service } = createHarness();
    const historicalId = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-alias-1",
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.createShareLinkForRequest(
          "site-a",
          singleVideoRequest("video-1"),
          "admin-1",
        ),
      ),
    );

    assert.equal(prisma.canonicals.size, 1);
    assert.equal(prisma.shareLinks.size, 1, "zero new share links");
    for (const result of results) {
      assert.equal(result.shareLink.id, historicalId);
      assert.equal(result.outcome, "REUSED");
    }
    assert.equal(new Set(results.map((row) => row.publicUrl)).size, 1);
  });

  it("CANON-HIST-11 an adopt racing a create leaves one canonical each and no orphan", async () => {
    const { prisma, service } = createHarness();
    const historicalId = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-alias-1",
    });

    // video-1 has a historical link (adopt path); video-2 has none (create
    // path). Running them together drives both paths at the same constraint.
    const results = await Promise.all([
      service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-1",
      ),
      service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-2",
      ),
      service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-2"),
        "admin-3",
      ),
      service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-2"),
        "admin-4",
      ),
    ]);

    assert.equal(
      canonicalFor(prisma, "site-a", "video-1")?.shareLinkId,
      historicalId,
    );
    assert.equal(prisma.canonicals.size, 2, "one mapping per pair");
    // The historical link plus exactly one newly minted link for video-2.
    assert.equal(prisma.shareLinks.size, 2, "no orphan duplicate");
    assert.equal(results[0].shareLink.id, historicalId);
    assert.equal(results[1].shareLink.id, historicalId);
    assert.equal(results[2].shareLink.id, results[3].shareLink.id);
  });

  it("CANON-HIST-12 an existing mapping wins over any historical duplicate", async () => {
    const { prisma, service } = createHarness();
    // A mapping already pins one link...
    const pinned = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    // ...and duplicates appear afterwards, which WOULD be ambiguous if the
    // scan ran. Authoritative provenance must short-circuit it entirely.
    seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-alias-1",
    });
    seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-alias-2",
    });

    const resolved = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    assert.equal(resolved.outcome, "REUSED");
    assert.equal(resolved.shareLink.id, pinned.shareLink.id);
    assert.equal(resolved.publicUrl, pinned.publicUrl);
    assert.equal(prisma.canonicals.size, 1);
  });
});

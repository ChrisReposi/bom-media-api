import "reflect-metadata";
import { AsyncLocalStorage } from "node:async_hooks";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BadRequestException, ConflictException, Logger } from "@nestjs/common";
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
  /** Optional: rows seeded as "historical" predate the column. */
  transportAlias?: string | null;
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
  /** How many further transport-alias writes must fail with P2002. */
  transportAliasCollisionsRemaining = 0;
  /**
   * Callbacks fired at the START of a transport-alias updateMany, before its
   * check-and-set runs.
   *
   * This is how the LOSER path is made deterministic rather than
   * scheduler-dependent: a hook stands in for the winner committing in the
   * window between this request's read (which saw null) and its own write.
   * Without it a test can only set the value up front, which the service
   * answers from its early return — passing without ever reaching the branch
   * under test.
   */
  beforeTransportAliasUpdate: Array<() => void> = [];
  /** Every transport alias this fake actually persisted, in order. */
  persistedTransportAliases: string[] = [];
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
     * The transport-alias BACKFILL: one row by id, and ONLY while it still has
     * no transport alias and is ACTIVE. Every predicate is applied, so a
     * service that dropped the `status` guard would surface here as "a
     * revoked link was given an email-safe alias".
     */
    updateMany: async (args: {
      where: { id: string; transportAlias?: null; status?: string };
      data: { transportAlias?: string };
    }): Promise<{ count: number }> => {
      /* An EXTREMELY unlikely unique collision, on demand. The database
         raises P2002 when the generated value is already taken; this models
         exactly that, N times, so the bounded retry is exercised rather than
         assumed. */
      for (const hook of this.beforeTransportAliasUpdate.splice(0)) {
        hook();
      }
      if (this.transportAliasCollisionsRemaining > 0) {
        this.transportAliasCollisionsRemaining -= 1;
        throw new Prisma.PrismaClientKnownRequestError("unique", {
          code: "P2002",
          clientVersion: "7.8.0",
          meta: { target: "ShareLink_transportAlias_key" },
        });
      }
      const link = this.shareLinks.get(args.where.id);
      if (!link) {
        return { count: 0 };
      }
      if (
        "transportAlias" in args.where &&
        (link.transportAlias ?? null) !== null
      ) {
        return { count: 0 };
      }
      if (
        args.where.status !== undefined &&
        link.status !== args.where.status
      ) {
        return { count: 0 };
      }
      if (args.data.transportAlias !== undefined) {
        link.transportAlias = args.data.transportAlias;
        this.persistedTransportAliases.push(args.data.transportAlias);
      }
      return { count: 1 };
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
       * The ORDER IS THE POLICY, so the fake reproduces it rather than
       * ignoring it: `createdAt DESC` then `id DESC`. A harness that sorted
       * ascending would let a service bug that picks the oldest link pass.
       *
       * NOTE THE ABSENT FILTERS. The production query no longer removes rows by
       * status, nor rows that already anchor a mapping — removing either would
       * make an OLDER link silently become the winner. The fake models exactly
       * that, and SELECTS the anchor relation so the service can refuse on it.
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
  /**
   * Callbacks fired the moment a transaction OPENS, before its body runs.
   *
   * This is how a TOCTOU window is made deterministic: a hook stands in for a
   * concurrent writer that committed between the request's pre-flight reads and
   * the canonical write. Any precondition still read outside the transaction
   * cannot see the hook's mutation, so a test that asserts the mutation was
   * honoured fails exactly when the read moved back out.
   */
  transactionOpenHooks: Array<() => void> = [];

  async $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    for (const hook of this.transactionOpenHooks.splice(0)) {
      hook();
    }
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
  /** Live switches a transaction-open hook can flip. */
  control: { eligibilityError: Error | null };
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

  /**
   * Mutable so a transaction-open hook can revoke eligibility mid-flight. A
   * static option could only model "was never eligible", which is a different
   * and much weaker property than "stopped being eligible after the pre-flight
   * read".
   */
  const control: { eligibilityError: Error | null } = {
    eligibilityError: options?.eligibilityError ?? null,
  };

  const websitesStub = {
    validateShareLinkVideoEligibility: async () => {
      if (control.eligibilityError) {
        throw control.eligibilityError;
      }
    },
    getConfiguredPublicSiteProtocol: () => undefined,
    /* The reviewer-frontend capability gate. `site-a` is the supported host
       in these fixtures; `other-site.com` (site-b) deliberately is not. */
    supportsCompatibilityUrl: (domain: string | null) =>
      domain === "plushcomedystudios.com",
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
          /* NO transportAlias. The real bundle path mints none — the
             email-safe URL is canonical-single-video only — so a stub that
             fabricated one would let a test assert behaviour production does
             not have. `share-link-scope.test.ts` drives the REAL bundle path. */
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
        compatibilityUrl: null,
        outcome: "CREATED",
        isCanonical: false,
      };
    },
    toShareLinkResponse: (
      link: FakeShareLink & { shareLinkVideos: { videoId: string }[] },
      publicUrl: string | null,
      compatibilityUrl: string | null = null,
    ) => ({
      id: link.id,
      alias: link.alias,
      status: link.status,
      expiresAt: link.expiresAt,
      maxViews: link.maxViews,
      currentViews: link.currentViews,
      publicUrl,
      compatibilityUrl,
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

  return { prisma, service, multiVideoCalls, control };
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

  it("CANON-10 leaves expiresAt and maxViews untouched, and now refuses rather than reporting a permanent URL", async () => {
    // THE INVARIANT IS UNCHANGED AND STRENGTHENED. The columns must never be
    // rewritten by a reuse — that is what this case has always pinned, and it
    // still holds below.
    //
    // What changed is the verdict around it. This used to SUCCEED: the pair's
    // canonical URL was handed back for a link that will lapse or run out,
    // described to the operator as permanent, with no replacement possible once
    // it does. `assertReusable()` read neither column. It now refuses with
    // `CANONICAL_LINK_OPTIONS_PRESENT` and still writes nothing.
    //
    // No production share link is broken by this: the link itself is untouched
    // and public resolution — which enforces both columns independently and
    // never reads the canonical mapping — is unchanged. Only the admin-side
    // claim that the URL is permanent is withdrawn.
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

    await assert.rejects(
      service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-1",
      ),
      expectConflictCode("CANONICAL_LINK_OPTIONS_PRESENT"),
    );

    const after = prisma.shareLinks.get(first.shareLink.id);
    assert.equal(after?.expiresAt?.toISOString(), pinnedExpiry.toISOString());
    assert.equal(after?.maxViews, 5);

    // Refusing must not become a licence to mint or repoint.
    assert.equal(prisma.shareLinks.size, 1, "no replacement link");
    assert.equal(prisma.canonicals.size, 1, "no second mapping");
    assert.equal(
      canonicalFor(prisma, "site-a", "video-1")?.shareLinkId,
      first.shareLink.id,
    );
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
    /** Explicit id, for pinning the `id DESC` tie-break deterministically. */
    id?: string;
  },
): string {
  const id = params.id ?? prisma.nextId("historical");
  prisma.shareLinks.set(id, {
    id,
    websiteId: params.websiteId,
    tokenHash: `hash-${params.alias}`,
    alias: params.alias,
    transportAlias: null,
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

/**
 * HISTORICAL RECOVERY POLICY — IDENTITY IS NOT USABILITY.
 *
 * Production created single-video ShareLinks long before any canonical mapping
 * existed, so almost every pair arrives here with history and no mapping.
 *
 *   1. an existing mapping ALWAYS wins, and is never repointed;
 *   2. otherwise the NEWEST exact single-video link is the identity —
 *      `createdAt DESC`, `id DESC` — whatever its status;
 *   3. only a pair with NO history at all mints a fresh canonical link.
 *
 * THE STATUS OF THE WINNER IS NOT A SELECTION INPUT, and these tests exist
 * mostly to keep it that way. Filtering to "usable" candidates first reads as
 * the safer choice and is the opposite: it lets a deliberate revoke be routed
 * around, either by promoting an older ACTIVE link or by minting a fresh one.
 * A revoked winner is pinned and then DENIES.
 *
 * Legacy rows are never deleted, revoked, renamed or re-scoped by any of it.
 */
describe("canonical adoption of historical single-video links", () => {
  it("C1 mints a canonical link when the pair has NO history at all", async () => {
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

  it("C2 adopts the one historical link instead of minting a second", async () => {
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

  it("C14 the adopted link is what every later request returns", async () => {
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

  it("C3 newest ACTIVE beats older ACTIVE", async () => {
    const { prisma, service } = createHarness();
    const older = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-jan",
      createdAt: new Date("2026-01-01"),
    });
    const newer = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-mar",
      createdAt: new Date("2026-03-01"),
    });

    const resolved = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    assert.equal(resolved.outcome, "REUSED");
    assert.equal(resolved.shareLink.id, newer);
    assert.notEqual(resolved.shareLink.id, older);
    assert.equal(prisma.shareLinks.size, 2, "nothing new was minted");
    assert.equal(prisma.shareLinks.get(older)?.status, "ACTIVE");
    assert.equal(prisma.shareLinks.get(older)?.alias, "hist-jan");
  });

  it("C4 breaks an exact createdAt tie deterministically on id DESC", async () => {
    const sameInstant = new Date("2026-05-05T10:00:00.000Z");
    const winners = new Set<string>();

    // Repeated because a non-deterministic tie-break would only show up
    // sometimes: the point is that the SAME row wins every single time.
    for (let run = 0; run < 5; run += 1) {
      const { prisma, service } = createHarness();
      seedHistoricalLink(prisma, {
        id: "hist-aaa",
        websiteId: "site-a",
        videoIds: ["video-1"],
        alias: "hist-alias-aaa",
        createdAt: sameInstant,
      });
      seedHistoricalLink(prisma, {
        id: "hist-zzz",
        websiteId: "site-a",
        videoIds: ["video-1"],
        alias: "hist-alias-zzz",
        createdAt: sameInstant,
      });

      const resolved = await service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-1",
      );
      winners.add(resolved.shareLink.id);
      assert.equal(prisma.shareLinks.size, 2);
    }

    assert.deepEqual([...winners], ["hist-zzz"]);
  });

  // -------------------------------------------------------------------------
  // THE SECURITY HALF. A restricted newest link must never be routed around.
  // -------------------------------------------------------------------------

  /**
   * FOUR DISTINCT CONDITIONS, NEVER CONFLATED.
   *
   * "Expired" is ambiguous here and is deliberately never used unqualified:
   *
   *   status === REVOKED        status enum -> PIN, then CANONICAL_LINK_REVOKED
   *   status === DISABLED       status enum -> PIN, then CANONICAL_LINK_INACTIVE
   *   status === EXPIRED        status enum -> PIN, then CANONICAL_LINK_INACTIVE
   *   expiresAt !== null        time COLUMN -> REFUSE pre-write, HAS_EXPIRY
   *   maxViews  !== null        budget COL. -> REFUSE pre-write, HAS_MAX_VIEWS
   *
   * The two groups behave differently on purpose: a status says "this link is
   * over", which a permanent identity can honestly represent; a column says
   * "this link is limited", which the canonical contract cannot represent at
   * all. The loop below covers the three STATUS values only.
   */
  for (const [label, status, code] of [
    ["C5 status=REVOKED", "REVOKED", "CANONICAL_LINK_REVOKED"],
    ["C5 status=DISABLED", "DISABLED", "CANONICAL_LINK_INACTIVE"],
    [
      "C5 status=EXPIRED (the enum, NOT expiresAt)",
      "EXPIRED",
      "CANONICAL_LINK_INACTIVE",
    ],
  ] as const) {
    it(`${label} newest is pinned and DENIES — the older ACTIVE link is NOT promoted`, async () => {
      const { prisma, service } = createHarness();
      const olderActive = seedHistoricalLink(prisma, {
        websiteId: "site-a",
        videoIds: ["video-1"],
        alias: "hist-older-active",
        createdAt: new Date("2026-01-01"),
      });
      const newestRestricted = seedHistoricalLink(prisma, {
        websiteId: "site-a",
        videoIds: ["video-1"],
        alias: "hist-newest-restricted",
        status,
        createdAt: new Date("2026-06-01"),
      });

      await assert.rejects(
        service.createShareLinkForRequest(
          "site-a",
          singleVideoRequest("video-1"),
          "admin-1",
        ),
        expectConflictCode(code),
      );

      // IDENTITY IS PINNED to the restricted link...
      assert.equal(
        canonicalFor(prisma, "site-a", "video-1")?.shareLinkId,
        newestRestricted,
        "the newest link is the identity, whatever its status",
      );
      // ...and the older ACTIVE link was NOT blessed in its place, which is the
      // bypass this whole test exists to forbid.
      assert.notEqual(
        canonicalFor(prisma, "site-a", "video-1")?.shareLinkId,
        olderActive,
      );
      assert.equal(prisma.shareLinks.size, 2, "no replacement was minted");
      assert.equal(prisma.shareLinks.get(newestRestricted)?.status, status);
      assert.equal(prisma.shareLinks.get(olderActive)?.status, "ACTIVE");

      // The refusal is DURABLE: the next attempt takes the existing-mapping
      // path and still denies, rather than reconsidering the older link.
      await assert.rejects(
        service.createShareLinkForRequest(
          "site-a",
          singleVideoRequest("video-1"),
          "admin-1",
        ),
        expectConflictCode(code),
      );
      assert.equal(prisma.shareLinks.size, 2);
      assert.equal(prisma.canonicals.size, 1);
    });
  }

  /**
   * THE FOUR-WAY DISTINCTION, ASSERTED AS A SINGLE MATRIX.
   *
   * Each row states the condition by its EXACT name — a `status` enum value or a
   * nullable column — and the exact outcome. Nothing here says "expired" on its
   * own, because that word maps to two unrelated conditions with two different
   * behaviours, and conflating them is how a status check and a column check get
   * swapped for one another during a later edit.
   */
  for (const row of [
    {
      label: "status === REVOKED",
      overrides: { status: "REVOKED" as const },
      pinned: true,
      code: "CANONICAL_LINK_REVOKED",
    },
    {
      label: "status === DISABLED",
      overrides: { status: "DISABLED" as const },
      pinned: true,
      code: "CANONICAL_LINK_INACTIVE",
    },
    {
      label: "status === EXPIRED (enum, not a time)",
      overrides: { status: "EXPIRED" as const },
      pinned: true,
      code: "CANONICAL_LINK_INACTIVE",
    },
    {
      label: "expiresAt !== null, in the FUTURE, status ACTIVE",
      overrides: { expiresAt: new Date("2099-01-01") },
      pinned: false,
      code: "CANONICAL_HISTORICAL_OPTIONS_PRESENT",
    },
    {
      label: "expiresAt !== null, already in the PAST, status ACTIVE",
      overrides: { expiresAt: new Date("2020-01-01") },
      pinned: false,
      code: "CANONICAL_HISTORICAL_OPTIONS_PRESENT",
    },
    {
      label: "maxViews !== null, budget UNSPENT",
      overrides: { maxViews: 10, currentViews: 0 },
      pinned: false,
      code: "CANONICAL_HISTORICAL_OPTIONS_PRESENT",
    },
    {
      label: "maxViews !== null, budget EXHAUSTED by views",
      overrides: { maxViews: 3, currentViews: 3 },
      pinned: false,
      code: "CANONICAL_HISTORICAL_OPTIONS_PRESENT",
    },
  ]) {
    it(`C-MATRIX ${row.label} -> ${row.pinned ? "PIN then" : "refuse pre-write with"} ${row.code}`, async () => {
      const { prisma, service } = createHarness();
      const olderActive = seedHistoricalLink(prisma, {
        websiteId: "site-a",
        videoIds: ["video-1"],
        alias: "hist-older-active",
        createdAt: new Date("2026-01-01"),
      });
      const newest = seedHistoricalLink(prisma, {
        websiteId: "site-a",
        videoIds: ["video-1"],
        alias: "hist-newest",
        createdAt: new Date("2026-06-01"),
        ...row.overrides,
      });

      await assert.rejects(
        service.createShareLinkForRequest(
          "site-a",
          singleVideoRequest("video-1"),
          "admin-1",
        ),
        expectConflictCode(row.code),
      );

      // COMMON TO EVERY ROW: no fallback, no mint, nothing rewritten.
      assert.equal(prisma.shareLinks.size, 2, "no replacement was minted");
      assert.notEqual(
        canonicalFor(prisma, "site-a", "video-1")?.shareLinkId,
        olderActive,
        "the older ACTIVE link must NEVER be promoted",
      );
      assert.equal(prisma.shareLinks.get(olderActive)?.status, "ACTIVE");
      assert.equal(
        prisma.shareLinks.get(newest)?.status,
        row.overrides.status ?? "ACTIVE",
      );
      assert.equal(
        prisma.shareLinks.get(newest)?.expiresAt ?? null,
        row.overrides.expiresAt ?? null,
      );
      assert.equal(
        prisma.shareLinks.get(newest)?.maxViews ?? null,
        row.overrides.maxViews ?? null,
      );
      assert.equal(
        prisma.shareLinks.get(newest)?.currentViews,
        row.overrides.currentViews ?? 0,
        "an exhausted budget is never reset",
      );

      // DIFFERS BY GROUP: a status pins the identity; a column refuses the pin.
      if (row.pinned) {
        assert.equal(
          canonicalFor(prisma, "site-a", "video-1")?.shareLinkId,
          newest,
          "a status value still yields a permanent identity",
        );
        assert.equal(prisma.audits.length, 1, "the pin is audited");
      } else {
        assert.equal(
          canonicalFor(prisma, "site-a", "video-1"),
          undefined,
          "a limit COLUMN must leave no mapping at all",
        );
        assert.equal(prisma.audits.length, 0, "and no audit row");
      }

      // And the verdict is DURABLE — a retry never reconsiders the older link.
      await assert.rejects(
        service.createShareLinkForRequest(
          "site-a",
          singleVideoRequest("video-1"),
          "admin-1",
        ),
        expectConflictCode(row.code),
      );
      assert.equal(prisma.shareLinks.size, 2);
    });
  }

  it("C-MATRIX status=ACTIVE with a null expiresAt and null maxViews is the ONLY pin-and-work case", async () => {
    const { prisma, service } = createHarness();
    seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-older",
      createdAt: new Date("2026-01-01"),
    });
    const newest = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-newest",
      createdAt: new Date("2026-06-01"),
    });

    const resolved = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    assert.equal(resolved.outcome, "REUSED");
    assert.equal(resolved.shareLink.id, newest);
    assert.equal(prisma.shareLinks.size, 2);
  });
  it("C-ALL-REVOKED every historical link is REVOKED — nothing is minted", async () => {
    const { prisma, service } = createHarness();
    const ids = [
      seedHistoricalLink(prisma, {
        websiteId: "site-a",
        videoIds: ["video-1"],
        alias: "hist-rev-1",
        status: "REVOKED",
        createdAt: new Date("2026-01-01"),
      }),
      seedHistoricalLink(prisma, {
        websiteId: "site-a",
        videoIds: ["video-1"],
        alias: "hist-rev-2",
        status: "REVOKED",
        createdAt: new Date("2026-05-01"),
      }),
    ];

    await assert.rejects(
      service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-1",
      ),
      expectConflictCode("CANONICAL_LINK_REVOKED"),
    );

    // Minting here would manufacture a working credential for a pair whose
    // every link an owner had deliberately revoked. It must not happen.
    assert.equal(prisma.shareLinks.size, 2, "NO new share link");
    assert.equal(
      canonicalFor(prisma, "site-a", "video-1")?.shareLinkId,
      ids[1],
    );
    for (const id of ids) {
      assert.equal(prisma.shareLinks.get(id)?.status, "REVOKED");
    }
  });

  it("C-EXPIRY newest carries expiresAt — refused, no fallback and no mint", async () => {
    const { prisma, service } = createHarness();
    const olderActive = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-older-active",
      createdAt: new Date("2026-01-01"),
    });
    seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-expiring",
      expiresAt: new Date("2027-01-01"),
      createdAt: new Date("2026-06-01"),
    });

    await assert.rejects(
      service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-1",
      ),
      expectConflictCode("CANONICAL_HISTORICAL_OPTIONS_PRESENT"),
    );

    // Adopting it would ignore the expiry (`assertReusable()` does not read
    // it); minting would bypass it outright; promoting the older link would
    // bypass it too. All three are refused, and NOTHING is written.
    assert.equal(prisma.canonicals.size, 0, "no mapping written");
    assert.equal(prisma.shareLinks.size, 2, "no replacement minted");
    assert.equal(prisma.audits.length, 0, "no success audit row");
    assert.equal(prisma.shareLinks.get(olderActive)?.status, "ACTIVE");
  });

  it("C-MAXVIEWS newest carries maxViews — refused, no fallback and no mint", async () => {
    const { prisma, service } = createHarness();
    seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-older-active",
      createdAt: new Date("2026-01-01"),
    });
    const limited = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-limited",
      maxViews: 5,
      currentViews: 5,
      createdAt: new Date("2026-06-01"),
    });

    await assert.rejects(
      service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-1",
      ),
      expectConflictCode("CANONICAL_HISTORICAL_OPTIONS_PRESENT"),
    );

    assert.equal(prisma.canonicals.size, 0);
    assert.equal(prisma.shareLinks.size, 2, "an exhausted budget is not reset");
    assert.equal(prisma.shareLinks.get(limited)?.maxViews, 5);
    assert.equal(prisma.shareLinks.get(limited)?.currentViews, 5);
    assert.equal(prisma.audits.length, 0);
  });

  it("C8 newest has a null alias — refused, no fallback and no mint", async () => {
    const { prisma, service } = createHarness();
    const olderActive = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-older-active",
      createdAt: new Date("2026-01-01"),
    });
    const aliasLess = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: null,
      createdAt: new Date("2026-06-01"),
    });

    await assert.rejects(
      service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-1",
      ),
      expectConflictCode("CANONICAL_HISTORICAL_ALIAS_MISSING"),
    );

    // THE ONE CASE THAT MUST NOT PIN. The alias IS the canonical URL's
    // credential, so a pinned alias-less row would commit a mapping whose
    // response construction throws forever, with no HTTP path to undo it.
    // Refusing keeps the pair REMEDIABLE: restore the alias and retry.
    assert.equal(prisma.canonicals.size, 0, "no unremediable mapping");
    assert.equal(prisma.shareLinks.size, 2, "no replacement minted");
    assert.equal(prisma.audits.length, 0);
    assert.equal(
      prisma.shareLinks.get(aliasLess)?.alias,
      null,
      "left as it was",
    );
    assert.equal(prisma.shareLinks.get(olderActive)?.status, "ACTIVE");

    // Remediation works, and only then does the pair resolve — to the NEWEST
    // link, not the older one that was available all along.
    prisma.shareLinks.get(aliasLess)!.alias = "restored-alias";
    const resolved = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    assert.equal(resolved.shareLink.id, aliasLess);
    assert.equal(prisma.shareLinks.size, 2);
  });

  it("C9 newest already anchors ANOTHER pair — integrity conflict, no fallback", async () => {
    const { prisma, service } = createHarness();
    const olderActive = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-older-active",
      createdAt: new Date("2026-01-01"),
    });
    const anchored = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-anchored",
      createdAt: new Date("2026-06-01"),
    });
    // `CanonicalVideoShareLink.shareLinkId` is UNIQUE, so this state cannot
    // arise by design. Meeting it means the data is corrupt, and silently
    // skipping to the older candidate would hide that and hand out an identity
    // nobody chose.
    prisma.canonicals.set("canonical-foreign", {
      id: "canonical-foreign",
      websiteId: "site-a",
      videoId: "video-2",
      shareLinkId: anchored,
      canonicalDomainId: "dom-a",
      canonicalHostSnapshot: "plushcomedystudios.com",
      canonicalProtocol: "https",
      evidenceFingerprint: null,
      evidenceSnapshotJson: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    });

    await assert.rejects(
      service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-1",
      ),
      expectConflictCode("CANONICAL_HISTORICAL_INTEGRITY_CONFLICT"),
    );

    assert.equal(
      canonicalFor(prisma, "site-a", "video-1"),
      undefined,
      "no mapping for the requested pair",
    );
    assert.equal(prisma.shareLinks.size, 2, "no replacement minted");
    assert.equal(prisma.shareLinks.get(olderActive)?.status, "ACTIVE");
  });

  it("C-MINT-ONLY zero historical links is the ONLY path that mints", async () => {
    // Exhaustive over the shapes that previously (wrongly) minted. Each must
    // now either pin or refuse; none may create a ShareLink.
    const restricted = [
      { alias: "s-revoked", status: "REVOKED" as const },
      { alias: "s-disabled", status: "DISABLED" as const },
      { alias: "s-expired", status: "EXPIRED" as const },
      { alias: "s-expiring", expiresAt: new Date("2027-01-01") },
      { alias: "s-limited", maxViews: 3 },
      { alias: null },
    ];

    for (const overrides of restricted) {
      const { prisma, service } = createHarness();
      seedHistoricalLink(prisma, {
        websiteId: "site-a",
        videoIds: ["video-1"],
        alias: "unused",
        ...overrides,
      });

      await assert.rejects(
        service.createShareLinkForRequest(
          "site-a",
          singleVideoRequest("video-1"),
          "admin-1",
        ),
        (error: unknown) => error instanceof ConflictException,
        `${JSON.stringify(overrides)} must refuse, never mint`,
      );
      assert.equal(
        prisma.shareLinks.size,
        1,
        `${JSON.stringify(overrides)} must not create a ShareLink`,
      );
    }

    // ...and the empty-history control still mints, so the assertions above
    // cannot be passing for the wrong reason.
    const { prisma, service } = createHarness();
    const created = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    assert.equal(created.outcome, "CREATED");
    assert.equal(prisma.shareLinks.size, 1);
  });

  it("C16 audits AUTO_ADOPT with the pinned status and no credential", async () => {
    const { prisma, service } = createHarness();
    seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-alias-1",
      createdAt: new Date("2026-03-01"),
    });
    seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-alias-2",
      createdAt: new Date("2026-04-01"),
    });

    await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    // Exactly one ADOPTION row. The adopted link is ACTIVE and usable, so the
    // email-safe transport alias is backfilled onto it in the same request
    // and audited separately (SHARE_LINK_TRANSPORT_ALIAS_BACKFILL); that row
    // is a different fact and must not be counted as a second adoption.
    const adoptions = prisma.audits.filter(
      (row) => row.action === "CANONICAL_SHARE_LINK_AUTO_ADOPT",
    );
    assert.equal(adoptions.length, 1);
    assert.equal(prisma.audits[0].action, "CANONICAL_SHARE_LINK_AUTO_ADOPT");
    assert.deepEqual(
      prisma.audits.map((row) => row.action),
      [
        "CANONICAL_SHARE_LINK_AUTO_ADOPT",
        "SHARE_LINK_TRANSPORT_ALIAS_BACKFILL",
      ],
    );
    const metadata = prisma.audits[0].metadata as Record<string, unknown>;
    assert.equal(metadata.historicalCandidateCount, 2);
    assert.equal(metadata.selectionPolicy, "LATEST_CREATED_AT");
    assert.equal(metadata.adoptedHistoricalLink, true);
    assert.equal(metadata.adoptedStatus, "ACTIVE");

    // The alias is a BEARER CREDENTIAL — on the bound host it authorizes a
    // watch by itself — so it must never reach an audit row, nor may the token
    // or its peppered hash.
    const serialized = JSON.stringify(prisma.audits);
    assert.equal(serialized.includes("hist-alias-1"), false);
    assert.equal(serialized.includes("hist-alias-2"), false);
    assert.equal(serialized.includes("hash-"), false);
    assert.equal(serialized.includes("test-pepper"), false);
  });

  it("C16 records the pinned status when the identity is a REVOKED link", async () => {
    const { prisma, service } = createHarness();
    seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-revoked",
      status: "REVOKED",
    });

    await assert.rejects(
      service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-1",
      ),
      expectConflictCode("CANONICAL_LINK_REVOKED"),
    );

    // The pin is a real, audited fact even though the request failed: it is
    // what stops the next call minting a replacement.
    assert.equal(prisma.audits.length, 1);
    assert.equal(prisma.audits[0].action, "CANONICAL_SHARE_LINK_AUTO_ADOPT");
    assert.equal(
      (prisma.audits[0].metadata as Record<string, unknown>).adoptedStatus,
      "REVOKED",
    );
  });

  it("C10 adopts the exact [A] link and ignores the [A,B] bundle", async () => {
    const { prisma, service } = createHarness();
    const exactId = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-exact",
      createdAt: new Date("2026-01-01"),
    });
    const bundleId = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1", "video-2"],
      alias: "hist-bundle",
      // NEWER than the exact link: if cardinality were not proven, the
      // newest-first ordering would hand the bundle the win and publish
      // video-2 to everyone who follows video-1's canonical URL.
      createdAt: new Date("2026-06-01"),
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

  it("C10 a bundle alone is NOT a candidate — adopting it would leak B", async () => {
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

    // A bundle is not history FOR THIS PAIR at all, so this is genuinely the
    // zero-history case and minting is correct.
    assert.equal(created.outcome, "CREATED");
    assert.notEqual(created.shareLink.id, bundleId);
    assert.equal(prisma.shareLinks.size, 2);
    assert.deepEqual(created.shareLink.videos, [{ videoId: "video-1" }]);
    assert.equal(
      canonicalFor(prisma, "site-a", "video-1")?.shareLinkId,
      created.shareLink.id,
    );
  });

  it("C11 a same-video link on ANOTHER website is not a candidate", async () => {
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

  it("C15 twenty concurrent requests converge on the newest historical link", async () => {
    const { prisma, service } = createHarness();
    // Four historical duplicates, exactly the shape production holds.
    seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-1",
      createdAt: new Date("2026-01-01"),
    });
    seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-2",
      createdAt: new Date("2026-02-01"),
    });
    seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-3",
      createdAt: new Date("2026-03-01"),
    });
    const expectedWinner = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-4",
      createdAt: new Date("2026-04-01"),
    });

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.createShareLinkForRequest(
          "site-a",
          singleVideoRequest("video-1"),
          "admin-1",
        ),
      ),
    );

    assert.equal(prisma.canonicals.size, 1, "one mapping");
    assert.equal(prisma.shareLinks.size, 4, "zero newly minted share links");
    for (const result of results) {
      assert.equal(result.shareLink.id, expectedWinner);
      assert.equal(result.outcome, "REUSED");
    }
    assert.equal(new Set(results.map((row) => row.publicUrl)).size, 1);
    // Exactly one adoption was audited, however many requests raced — and
    // exactly one transport-alias backfill: the conditional update admits a
    // single writer, and every other racer reloads that writer's value.
    assert.equal(prisma.audits[0].action, "CANONICAL_SHARE_LINK_AUTO_ADOPT");
    assert.equal(
      prisma.audits.filter(
        (row) => row.action === "CANONICAL_SHARE_LINK_AUTO_ADOPT",
      ).length,
      1,
    );
    assert.equal(
      prisma.audits.filter(
        (row) => row.action === "SHARE_LINK_TRANSPORT_ALIAS_BACKFILL",
      ).length,
      1,
    );
    assert.equal(prisma.audits.length, 2);
    assert.equal(
      new Set(results.map((row) => row.compatibilityUrl)).size,
      1,
      "every racer reports the one transport alias",
    );
  });

  it("C15 concurrent requests on a REVOKED newest all deny, and mint nothing", async () => {
    const { prisma, service } = createHarness();
    seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-older-active",
      createdAt: new Date("2026-01-01"),
    });
    const revoked = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-revoked",
      status: "REVOKED",
      createdAt: new Date("2026-06-01"),
    });

    const outcomes = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        service.createShareLinkForRequest(
          "site-a",
          singleVideoRequest("video-1"),
          "admin-1",
        ),
      ),
    );

    assert.equal(
      outcomes.every((result) => result.status === "rejected"),
      true,
      "a race must not let one request through",
    );
    assert.equal(prisma.canonicals.size, 1);
    assert.equal(
      canonicalFor(prisma, "site-a", "video-1")?.shareLinkId,
      revoked,
    );
    assert.equal(prisma.shareLinks.size, 2, "no replacement minted under load");
  });

  it("C-ADOPT-RACE an adopt racing a create leaves one canonical each and no orphan", async () => {
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

  it("C13 an existing mapping wins over any newer duplicate", async () => {
    const { prisma, service } = createHarness();
    // A mapping already pins one link...
    const pinned = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    // ...and NEWER duplicates appear afterwards. Under the selection policy
    // alone they would win. Authoritative provenance must short-circuit the
    // scan entirely: canonical identity, once established, does not move.
    const newerA = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-newer-a",
      createdAt: new Date("2030-01-01"),
    });
    const newerB = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-newer-b",
      createdAt: new Date("2031-01-01"),
    });

    const resolved = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    assert.equal(resolved.outcome, "REUSED");
    assert.equal(resolved.shareLink.id, pinned.shareLink.id);
    assert.notEqual(resolved.shareLink.id, newerA);
    assert.notEqual(resolved.shareLink.id, newerB);
    assert.equal(resolved.publicUrl, pinned.publicUrl);
    assert.equal(prisma.canonicals.size, 1);
    // And it stays that way on every later call.
    const again = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    assert.equal(again.shareLink.id, pinned.shareLink.id);
  });

  it("C17 a revoked EXISTING canonical mapping still fails closed, replacing nothing", async () => {
    const { prisma, service } = createHarness();
    const pinned = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    prisma.shareLinks.get(pinned.shareLink.id)!.status = "REVOKED";
    // A perfectly usable newer duplicate exists. It must NOT be promoted:
    // that would hand back working access an owner deliberately removed.
    const tempting = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-tempting",
      createdAt: new Date("2030-01-01"),
    });

    await assert.rejects(
      service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-1",
      ),
      expectConflictCode("CANONICAL_LINK_REVOKED"),
    );

    assert.equal(
      canonicalFor(prisma, "site-a", "video-1")?.shareLinkId,
      pinned.shareLink.id,
      "the mapping is not repointed",
    );
    assert.equal(prisma.shareLinks.get(tempting)?.status, "ACTIVE");
    assert.equal(prisma.canonicals.size, 1);
  });

  it("C16 never returns a raw token or hash on the adoption path", async () => {
    const { prisma, service } = createHarness();
    seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-only",
    });

    const resolved = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    assert.equal("rawToken" in resolved, false);
    const serialized = JSON.stringify(resolved);
    assert.equal(serialized.includes("tokenHash"), false);
    assert.equal(serialized.includes("test-pepper"), false);
    assert.equal(serialized.includes("s_"), false);
    assert.equal(prisma.shareLinks.size, 1);
  });
});

// ---------------------------------------------------------------------------
// C19 — TOCTOU. Every precondition must be read INSIDE the transaction.
//
// `transactionOpenHooks` stands in for a concurrent writer that committed after
// this request's pre-flight reads and before its canonical write. A precondition
// still evaluated outside the transaction cannot see the mutation, so each of
// these fails the moment a read moves back out.
// ---------------------------------------------------------------------------

describe("canonical create closes its time-of-check/time-of-use windows", () => {
  it("C19 a website disabled after the pre-flight check writes nothing", async () => {
    const { prisma, service } = createHarness();
    prisma.transactionOpenHooks.push(() => {
      prisma.websites.set("site-a", { id: "site-a", status: "DISABLED" });
    });

    await assert.rejects(
      service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-1",
      ),
      (error: unknown) => error instanceof Error,
    );

    assert.equal(prisma.canonicals.size, 0, "no mapping was committed");
    assert.equal(prisma.shareLinks.size, 0, "no orphan share link");
    assert.equal(prisma.audits.length, 0, "no success audit row");
  });

  it("C19 a video that stops being eligible after the pre-flight writes nothing", async () => {
    const { prisma, service, control } = createHarness();
    prisma.transactionOpenHooks.push(() => {
      control.eligibilityError = new BadRequestException({
        code: "VIDEO_NOT_ACTIVE_FOR_WEBSITE",
      });
    });

    await assert.rejects(
      service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-1",
      ),
      (error: unknown) => error instanceof BadRequestException,
    );

    assert.equal(prisma.canonicals.size, 0);
    assert.equal(prisma.shareLinks.size, 0);
    assert.equal(prisma.audits.length, 0);
  });

  it("C19 a domain disabled after the pre-flight is never anchored", async () => {
    const { prisma, service } = createHarness();
    prisma.transactionOpenHooks.push(() => {
      prisma.domains.get("dom-a")!.status = "DISABLED";
    });

    await assert.rejects(
      service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-1",
      ),
      (error: unknown) => error instanceof BadRequestException,
    );

    // The relation is `onDelete: Restrict`, so a mapping anchored to a disabled
    // domain would fail `assertReusable()` forever with no HTTP way back.
    assert.equal(prisma.canonicals.size, 0);
    assert.equal(prisma.shareLinks.size, 0);
    assert.equal(prisma.audits.length, 0);
  });

  it("C19 the evidence fingerprint describes the video AT COMMIT, not before", async () => {
    const { prisma, service } = createHarness();
    prisma.transactionOpenHooks.push(() => {
      const video = prisma.videos.get("video-1")!;
      video.title = "Retitled between the pre-flight and the write";
    });

    const created = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    assert.equal(created.outcome, "CREATED");

    // Reading it back recomputes the fingerprint over the CURRENT row. If the
    // snapshot had been taken before the transaction opened, the stored
    // fingerprint would already disagree and this brand-new mapping would
    // report drift on its very first read.
    const readBack = await service.getCanonical("site-a", "video-1");
    assert.equal(readBack.evidenceDrift, false);
    assert.equal(
      (readBack.evidenceSnapshot as { title?: string } | null)?.title,
      "Retitled between the pre-flight and the write",
    );
  });

  it("C19 a link revoked after the pin still denies, and mints no replacement", async () => {
    const { prisma, service } = createHarness();
    const historicalId = seedHistoricalLink(prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-alias-1",
    });
    // The winner is ACTIVE when the transaction commits and REVOKED by the time
    // the post-commit usability verdict runs — the narrow window the
    // identity/usability split is designed to answer truthfully.
    prisma.transactionOpenHooks.push(() => {
      queueMicrotask(() => {
        const link = prisma.shareLinks.get(historicalId);
        if (link) {
          link.status = "REVOKED";
        }
      });
    });

    await assert.rejects(
      service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-1",
      ),
      expectConflictCode("CANONICAL_LINK_REVOKED"),
    );

    assert.equal(
      canonicalFor(prisma, "site-a", "video-1")?.shareLinkId,
      historicalId,
      "identity is pinned; only usability failed",
    );
    assert.equal(prisma.shareLinks.size, 1, "no replacement minted");
  });
});

// ---------------------------------------------------------------------------
// CANON-TA — the email-safe transport alias rides on the canonical identity
//
// `/watch?r=<transportAlias>` is a SEPARATE 128-bit identifier from `alias`.
// It is minted with a fresh canonical link, backfilled exactly once onto an
// existing canonical link the first time that link is re-issued WHILE USABLE,
// and never minted for a link `assertReusable()` refuses. Design:
// docs/superpowers/specs/2026-09-02-email-safe-reviewer-url-design.md
// ---------------------------------------------------------------------------

describe("canonical transport alias (email-safe reviewer URL)", () => {
  const TRANSPORT_ALIAS_RE = /^[A-Za-z0-9_-]{22}$/;
  const HOST = "https://plushcomedystudios.com";

  it("CANON-TA-01 a fresh canonical mint carries a 22-character transport alias and a query-form URL", async () => {
    const { prisma, service } = createHarness();

    const created = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    const link = prisma.shareLinks.get(created.shareLink.id);

    assert.equal(created.outcome, "CREATED");
    assert.match(link?.transportAlias ?? "", TRANSPORT_ALIAS_RE);
    assert.equal(
      created.compatibilityUrl,
      `${HOST}/watch?r=${link?.transportAlias}`,
    );
    assert.equal(created.shareLink.compatibilityUrl, created.compatibilityUrl);
    // The #k URL is exactly what it was, and the two URLs share no
    // credential text in either direction.
    assert.equal(
      created.publicUrl,
      `${HOST}/watch#k=${created.shareLink.alias}`,
    );
    assert.equal(
      created.compatibilityUrl?.includes(created.shareLink.alias ?? "!"),
      false,
    );
    assert.equal(
      created.publicUrl?.includes(link?.transportAlias ?? "!"),
      false,
    );
    assert.notEqual(link?.transportAlias, link?.alias);
  });

  it("CANON-TA-02 REUSED returns the same compatibility URL and mints nothing", async () => {
    const { prisma, service } = createHarness();
    const first = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    const minted = prisma.shareLinks.get(first.shareLink.id)?.transportAlias;

    const second = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-2",
    );

    assert.equal(second.outcome, "REUSED");
    assert.equal(second.compatibilityUrl, first.compatibilityUrl);
    assert.equal(
      prisma.shareLinks.get(first.shareLink.id)?.transportAlias,
      minted,
    );
    assert.equal(prisma.shareLinks.size, 1);
    assert.equal(
      prisma.audits.filter(
        (row) => row.action === "SHARE_LINK_TRANSPORT_ALIAS_BACKFILL",
      ).length,
      0,
    );
  });

  it("CANON-TA-03 a canonical link written before the column existed is backfilled exactly once", async () => {
    const { prisma, service } = createHarness();
    const first = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    const link = prisma.shareLinks.get(first.shareLink.id);
    assert.ok(link);
    // A mapping committed by the previous build: no transport alias.
    link.transportAlias = null;

    const second = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-2",
    );

    assert.equal(second.outcome, "REUSED");
    assert.match(link.transportAlias ?? "", TRANSPORT_ALIAS_RE);
    assert.equal(
      second.compatibilityUrl,
      `${HOST}/watch?r=${link.transportAlias}`,
    );
    assert.equal(second.shareLink.compatibilityUrl, second.compatibilityUrl);
    // Identity untouched: same id, same alias, same #k URL.
    assert.equal(second.shareLink.id, first.shareLink.id);
    assert.equal(second.shareLink.alias, first.shareLink.alias);
    assert.equal(second.publicUrl, first.publicUrl);

    const third = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-3",
    );
    assert.equal(third.compatibilityUrl, second.compatibilityUrl);
    assert.equal(prisma.shareLinks.size, 1);

    // Audited once, with ids only — never the alias, the transport alias or
    // a token.
    const backfills = prisma.audits.filter(
      (row) => row.action === "SHARE_LINK_TRANSPORT_ALIAS_BACKFILL",
    );
    assert.equal(backfills.length, 1);
    assert.equal(backfills[0].entityId, link.id);
    const serialized = JSON.stringify(backfills[0].metadata);
    assert.equal(serialized.includes(link.transportAlias ?? "!"), false);
    assert.equal(serialized.includes(link.alias ?? "!"), false);
    assert.equal(serialized.includes(link.tokenHash), false);
  });

  it("CANON-TA-04 a REVOKED canonical link is never given a transport alias", async () => {
    const { prisma, service } = createHarness();
    const first = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    const link = prisma.shareLinks.get(first.shareLink.id);
    assert.ok(link);
    link.transportAlias = null;
    link.status = "REVOKED";

    await assert.rejects(
      service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-2",
      ),
      expectConflictCode("CANONICAL_LINK_REVOKED"),
    );

    assert.equal(link.transportAlias, null);
    assert.equal(
      prisma.audits.some(
        (row) => row.action === "SHARE_LINK_TRANSPORT_ALIAS_BACKFILL",
      ),
      false,
    );
  });

  it("CANON-TA-04 a DISABLED, expiring or view-limited canonical link is never given one either", async () => {
    for (const overrides of [
      { status: "DISABLED" },
      { expiresAt: new Date("2099-01-01") },
      { maxViews: 3 },
    ] as const) {
      const { prisma, service } = createHarness();
      const first = await service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-1",
      );
      const link = prisma.shareLinks.get(first.shareLink.id);
      assert.ok(link);
      link.transportAlias = null;
      Object.assign(link, overrides);

      await assert.rejects(
        service.createShareLinkForRequest(
          "site-a",
          singleVideoRequest("video-1"),
          "admin-2",
        ),
        ConflictException,
        JSON.stringify(overrides),
      );
      assert.equal(link.transportAlias, null, JSON.stringify(overrides));
    }
  });

  it("CANON-TA-05 an ACTIVE historical link adopted as canonical is backfilled; a REVOKED one is pinned and left alone", async () => {
    const active = createHarness();
    const activeId = seedHistoricalLink(active.prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-active",
    });

    const adopted = await active.service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    const adoptedLink = active.prisma.shareLinks.get(activeId);

    assert.equal(adopted.outcome, "REUSED");
    assert.equal(adopted.shareLink.id, activeId);
    assert.match(adoptedLink?.transportAlias ?? "", TRANSPORT_ALIAS_RE);
    assert.equal(
      adopted.compatibilityUrl,
      `${HOST}/watch?r=${adoptedLink?.transportAlias}`,
    );
    assert.equal(adopted.publicUrl, `${HOST}/watch#k=hist-active`);

    const revoked = createHarness();
    const revokedId = seedHistoricalLink(revoked.prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-revoked",
      status: "REVOKED",
    });

    await assert.rejects(
      revoked.service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-1",
      ),
      expectConflictCode("CANONICAL_LINK_REVOKED"),
    );
    assert.equal(
      revoked.prisma.shareLinks.get(revokedId)?.transportAlias,
      null,
    );
    assert.equal(revoked.prisma.shareLinks.size, 1, "nothing minted");
  });

  it("CANON-TA-06 a multi-video bundle is routed away and receives NO email-safe URL", async () => {
    /* SCOPE. The email-safe URL is canonical-single-video only in this
       release. A two-video request is routed to the bundle path, which mints
       no transport alias and emits no compatibility URL — proven against the
       REAL service in `share-link-scope.test.ts`; this asserts the routing
       decision and the shape the router returns. */
    const { prisma, service } = createHarness();

    const bundle = await service.createShareLinkForRequest(
      "site-a",
      { videoIds: ["video-1", "video-2"] } as CreateShareLinkDto,
      "admin-1",
    );

    assert.equal(bundle.isCanonical, false);
    assert.equal(bundle.compatibilityUrl, null);
    // The `#k` URL is untouched, and no alternate credential was written.
    assert.match(
      bundle.publicUrl ?? "",
      /^https:\/\/plushcomedystudios\.com\/watch#k=/,
    );
    assert.equal(
      prisma.canonicals.size,
      0,
      "no canonical mapping for a bundle",
    );
    for (const link of prisma.shareLinks.values()) {
      assert.equal(link.transportAlias ?? null, null);
    }
  });

  it("CANON-TA-07 a canonical mapping anchored to a MULTI-VIDEO link emits no email-safe URL", async () => {
    /* THE READ PATH, AND THE REASON THE PREDICATE LIVES AT THE EMISSION SITE.
     *
     * `getCanonical()` reaches `toResponse()` WITHOUT `assertReusable()`, so a
     * guard placed in the caller would not run here. A mapping whose anchored
     * link has grown a second member is a data-integrity fault — but it is
     * exactly the shape that must never receive a bundle-capable credential,
     * so the emission site itself refuses it. */
    const { prisma, service } = createHarness();
    const created = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    const link = prisma.shareLinks.get(created.shareLink.id);
    assert.ok(link);
    assert.match(link.transportAlias ?? "", /^[A-Za-z0-9_-]{22}$/);
    // Positive control: while it is genuinely single-video, the READ path emits.
    const before = await service.getCanonical("site-a", "video-1");
    assert.equal(before.compatibilityUrl, created.compatibilityUrl);
    assert.ok(before.compatibilityUrl);

    // A second member appears on the anchored link.
    prisma.shareLinkVideos.push({
      shareLinkId: link.id,
      videoId: "video-2",
      sortOrder: 1,
    });

    const after = await service.getCanonical("site-a", "video-1");
    assert.equal(after.compatibilityUrl, null, "a bundle must not be emitted");
    assert.equal(after.shareLink.compatibilityUrl, null);
    // The `#k` URLs are unchanged — this release withholds the NEW field only.
    assert.equal(after.publicUrl, before.publicUrl);
    assert.equal(after.reviewUrl, before.reviewUrl);
  });

  it("CANON-TA-08 a canonical mapping whose link grew a budget or expiry emits no email-safe URL", async () => {
    for (const mutation of [
      { maxViews: 5 },
      { expiresAt: new Date("2099-01-01") },
      { status: "REVOKED" },
    ] as const) {
      const { prisma, service } = createHarness();
      const created = await service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-1",
      );
      assert.ok(created.compatibilityUrl, "positive control");

      const link = prisma.shareLinks.get(created.shareLink.id);
      assert.ok(link);
      Object.assign(link, mutation);

      const read = await service.getCanonical("site-a", "video-1");
      assert.equal(
        read.compatibilityUrl,
        null,
        `emitted despite ${JSON.stringify(mutation)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// CANON-TA-CAP — the reviewer-frontend capability gate
//
// This backend serves several reviewer frontends and only some redeem
// `/watch?r=`. A compatibility URL emitted for one that cannot is a silent
// broken link, so emission is gated on an explicit per-host declaration.
// ---------------------------------------------------------------------------

describe("canonical transport alias capability gate", () => {
  it("CANON-TA-CAP-01 emits no compatibility URL for an unsupported host, while #k is unaffected", async () => {
    const { prisma, service } = createHarness();

    // site-b resolves to other-site.com, which the stub does not declare.
    const created = await service.createShareLinkForRequest(
      "site-b",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    assert.equal(created.outcome, "CREATED");
    assert.equal(created.compatibilityUrl, null);
    assert.equal(created.shareLink.compatibilityUrl, null);
    // The fragment URL is untouched and still the operator's link.
    assert.equal(
      created.publicUrl,
      `https://other-site.com/watch#k=${created.shareLink.alias}`,
    );
    // The alias IS minted and persisted, so declaring the host later is a
    // configuration change with no data to backfill.
    const link = prisma.shareLinks.get(created.shareLink.id);
    assert.match(link?.transportAlias ?? "", /^[A-Za-z0-9_-]{22}$/);
  });

  it("CANON-TA-CAP-02 the same pair emits a URL once its host is declared", async () => {
    const supported = createHarness();
    const created = await supported.service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    assert.match(
      created.compatibilityUrl ?? "",
      /^https:\/\/plushcomedystudios\.com\/watch\?r=[A-Za-z0-9_-]{22}$/,
    );
  });

  it("CANON-TA-CAP-03 a reused link on an unsupported host still reports null", async () => {
    const { service } = createHarness();
    await service.createShareLinkForRequest(
      "site-b",
      singleVideoRequest("video-1"),
      "admin-1",
    );

    const reused = await service.createShareLinkForRequest(
      "site-b",
      singleVideoRequest("video-1"),
      "admin-2",
    );

    assert.equal(reused.outcome, "REUSED");
    assert.equal(reused.compatibilityUrl, null);
  });
});

// ---------------------------------------------------------------------------
// CANON-TA-RACE — concurrent backfill convergence
//
// Two operators press "Get link" at the same moment on a canonical pair whose
// transport alias predates the column. Exactly one write may land, and BOTH
// responses must carry the value that actually landed. A response built from
// the caller's own generated value would hand a loser a string no reviewer
// could redeem.
// ---------------------------------------------------------------------------

describe("canonical transport alias backfill under concurrency", () => {
  const TRANSPORT_ALIAS_RE = /^[A-Za-z0-9_-]{22}$/;

  /** A canonical pair that exists, is reusable, and has no transport alias. */
  async function seedBackfillablePair(): Promise<{
    prisma: FakePrisma;
    service: CanonicalShareLinkService;
    shareLinkId: string;
  }> {
    const { prisma, service } = createHarness();
    const first = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    const link = prisma.shareLinks.get(first.shareLink.id);
    assert.ok(link);
    link.transportAlias = null;
    prisma.persistedTransportAliases.length = 0;
    prisma.audits.length = 0;

    return { prisma, service, shareLinkId: first.shareLink.id };
  }

  it("CANON-TA-RACE-01 two concurrent reuses converge on ONE persisted alias", async () => {
    const { prisma, service, shareLinkId } = await seedBackfillablePair();

    const [a, b] = await Promise.all([
      service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-2",
      ),
      service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-3",
      ),
    ]);

    const persisted = prisma.shareLinks.get(shareLinkId)?.transportAlias;

    // Exactly one write landed.
    assert.equal(prisma.persistedTransportAliases.length, 1);
    assert.match(persisted ?? "", TRANSPORT_ALIAS_RE);
    assert.equal(prisma.persistedTransportAliases[0], persisted);

    // BOTH responses carry that same persisted value. Neither is null, and
    // neither carries a value that was generated but never stored.
    const expected = `https://plushcomedystudios.com/watch?r=${persisted}`;
    assert.equal(a.compatibilityUrl, expected);
    assert.equal(b.compatibilityUrl, expected);
    assert.equal(a.shareLink.compatibilityUrl, expected);
    assert.equal(b.shareLink.compatibilityUrl, expected);

    // One mapping, one share link, no mint, no fallback.
    assert.equal(prisma.canonicals.size, 1);
    assert.equal(prisma.shareLinks.size, 1);
    assert.equal(a.shareLink.id, shareLinkId);
    assert.equal(b.shareLink.id, shareLinkId);
    assert.equal(a.outcome, "REUSED");
    assert.equal(b.outcome, "REUSED");
    assert.equal(a.publicUrl, b.publicUrl);

    // Deterministic audit: the writer audits, the loser does not.
    assert.equal(
      prisma.audits.filter(
        (row) => row.action === "SHARE_LINK_TRANSPORT_ALIAS_BACKFILL",
      ).length,
      1,
    );
  });

  it("CANON-TA-RACE-02 the property holds at higher concurrency", async () => {
    const { prisma, service, shareLinkId } = await seedBackfillablePair();

    const results = await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        service.createShareLinkForRequest(
          "site-a",
          singleVideoRequest("video-1"),
          `admin-${index}`,
        ),
      ),
    );

    const persisted = prisma.shareLinks.get(shareLinkId)?.transportAlias;
    assert.match(persisted ?? "", TRANSPORT_ALIAS_RE);
    assert.equal(prisma.persistedTransportAliases.length, 1);
    assert.equal(
      new Set(results.map((row) => row.compatibilityUrl)).size,
      1,
      "every racer reports the same URL",
    );
    assert.equal(
      results[0]?.compatibilityUrl,
      `https://plushcomedystudios.com/watch?r=${persisted}`,
    );
    assert.equal(
      prisma.audits.filter(
        (row) => row.action === "SHARE_LINK_TRANSPORT_ALIAS_BACKFILL",
      ).length,
      1,
    );
    assert.equal(prisma.shareLinks.size, 1);
    assert.equal(prisma.canonicals.size, 1);
  });

  it("CANON-TA-RACE-03 the LOSER re-reads authoritative state rather than its own generated value", async () => {
    /* DETERMINISTIC, and it must genuinely reach the loser BRANCH.
     *
     * Setting the winner's value before the request starts does not do that:
     * the service answers such a row from its early return and never runs the
     * conditional update at all — a test that passes without exercising the
     * code it names. The hook instead fires INSIDE `updateMany`, after this
     * request has already read the row as null, which is exactly the window a
     * concurrent winner commits in. `count` is then 0 and the loser branch is
     * forced.
     */
    const { prisma, service, shareLinkId } = await seedBackfillablePair();
    const winnerAlias = "wInNeRtRaNsPoRt_01234x";

    prisma.beforeTransportAliasUpdate.push(() => {
      const row = prisma.shareLinks.get(shareLinkId);
      assert.ok(row);
      assert.equal(row.transportAlias, null, "the read really did see null");
      row.transportAlias = winnerAlias;
      prisma.persistedTransportAliases.push(winnerAlias);
    });

    const loser = await service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-loser",
    );

    // The hook fired, so the loser really did take the count === 0 branch.
    assert.equal(prisma.beforeTransportAliasUpdate.length, 0);
    // The loser reports the WINNER's persisted alias, byte for byte — never
    // the value its own attempt generated.
    assert.equal(
      loser.compatibilityUrl,
      `https://plushcomedystudios.com/watch?r=${winnerAlias}`,
    );
    // It wrote nothing of its own and audited nothing.
    assert.equal(prisma.persistedTransportAliases.length, 1);
    assert.equal(
      prisma.shareLinks.get(shareLinkId)?.transportAlias,
      winnerAlias,
    );
    assert.equal(
      prisma.audits.some(
        (row) => row.action === "SHARE_LINK_TRANSPORT_ALIAS_BACKFILL",
      ),
      false,
    );
  });

  it("CANON-TA-RACE-04 a bounded run of unique collisions retries, then reports the truth", async () => {
    // Four collisions, then success: the bounded retry absorbs them.
    const recovering = await seedBackfillablePair();
    recovering.prisma.transportAliasCollisionsRemaining = 4;

    const recovered = await recovering.service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-2",
    );

    const persisted = recovering.prisma.shareLinks.get(
      recovering.shareLinkId,
    )?.transportAlias;
    assert.match(persisted ?? "", TRANSPORT_ALIAS_RE);
    assert.equal(
      recovered.compatibilityUrl,
      `https://plushcomedystudios.com/watch?r=${persisted}`,
    );

    // Exhausted: the canonical URL is still returned, and the enhancement
    // field truthfully reports that nothing was persisted. The request must
    // NOT fail over it.
    const exhausted = await seedBackfillablePair();
    exhausted.prisma.transportAliasCollisionsRemaining = 99;

    const response = await exhausted.service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-2",
    );

    assert.equal(response.outcome, "REUSED");
    assert.equal(
      response.publicUrl,
      `https://plushcomedystudios.com/watch#k=${response.shareLink.alias}`,
    );
    assert.equal(response.compatibilityUrl, null);
    assert.equal(
      exhausted.prisma.shareLinks.get(exhausted.shareLinkId)?.transportAlias,
      null,
    );
    assert.equal(exhausted.prisma.persistedTransportAliases.length, 0);
    assert.equal(
      exhausted.prisma.audits.some(
        (row) => row.action === "SHARE_LINK_TRANSPORT_ALIAS_BACKFILL",
      ),
      false,
    );
  });

  it("CANON-TA-RACE-06 NO audit row from ANY canonical path carries the credential", async () => {
    /* The mint happens inside the same transaction that writes the CREATE
       audit row, and the backfill writes its own row. Both are asserted here
       against the persisted value, not against a list of field names — a leak
       through a field nobody thought of still fails. */
    const minted = createHarness();
    const created = await minted.service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    const mintedAlias = minted.prisma.shareLinks.get(
      created.shareLink.id,
    )?.transportAlias;
    assert.match(mintedAlias ?? "", /^[A-Za-z0-9_-]{22}$/);
    assert.ok(minted.prisma.audits.length > 0);
    assert.equal(
      JSON.stringify(minted.prisma.audits).includes(mintedAlias ?? "!"),
      false,
      "CANONICAL_SHARE_LINK_CREATE metadata carries the transport alias",
    );

    // The ADOPT path, which audits AUTO_ADOPT and then backfills.
    const adopted = createHarness();
    seedHistoricalLink(adopted.prisma, {
      websiteId: "site-a",
      videoIds: ["video-1"],
      alias: "hist-active",
    });
    const reused = await adopted.service.createShareLinkForRequest(
      "site-a",
      singleVideoRequest("video-1"),
      "admin-1",
    );
    const backfilled = adopted.prisma.shareLinks.get(
      reused.shareLink.id,
    )?.transportAlias;
    assert.match(backfilled ?? "", /^[A-Za-z0-9_-]{22}$/);
    const serialized = JSON.stringify(adopted.prisma.audits);
    assert.deepEqual(
      adopted.prisma.audits.map((row) => row.action),
      [
        "CANONICAL_SHARE_LINK_AUTO_ADOPT",
        "SHARE_LINK_TRANSPORT_ALIAS_BACKFILL",
      ],
    );
    assert.equal(serialized.includes(backfilled ?? "!"), false);
    assert.equal(serialized.includes("hist-active"), false);
  });

  it("CANON-TA-RACE-07 the exhausted-collision WARNING never names the link's credential", async () => {
    /* `ensureTransportAlias()` logs a warning when it gives up. That is the
       one log site in the codebase that runs while a transport alias is in
       scope, so it is captured and searched rather than assumed safe. */
    const { prisma, service, shareLinkId } = await seedBackfillablePair();
    prisma.transportAliasCollisionsRemaining = 99;

    const captured: unknown[] = [];
    const methods = ["log", "error", "warn", "debug", "verbose"] as const;
    const prototype = Logger.prototype as unknown as Record<string, unknown>;
    const originals = new Map(methods.map((m) => [m, prototype[m]]));
    for (const method of methods) {
      prototype[method] = (...args: unknown[]): void => {
        captured.push(...args);
      };
    }

    try {
      await service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-2",
      );
    } finally {
      for (const method of methods) {
        prototype[method] = originals.get(method);
      }
    }

    const text = captured
      .map((entry) =>
        typeof entry === "string" ? entry : JSON.stringify(entry),
      )
      .join("\n");

    assert.ok(text.length > 0, "the exhausted path did warn");
    assert.match(text, /Transport alias backfill exhausted/);
    // It names the ShareLink id, which is a database key and not a credential.
    assert.ok(text.includes(shareLinkId));
    // And nothing CREDENTIAL-SHAPED anywhere in it. Every one of the 99
    // rejected candidates was a well-formed transport alias, so a logger that
    // echoed the value it tried would be caught here whatever field it used.
    assert.equal(
      /[A-Za-z0-9_-]{22}/.test(text.replace(shareLinkId, "")),
      false,
      `credential-shaped token in log output: ${text}`,
    );
    for (const link of prisma.shareLinks.values()) {
      if (link.alias) {
        assert.equal(text.includes(link.alias), false, "share alias logged");
      }
    }
  });

  it("CANON-TA-RACE-05 a non-collision database error is never swallowed", async () => {
    const { prisma, service, shareLinkId } = await seedBackfillablePair();
    const originalUpdateMany = prisma.shareLink.updateMany;
    prisma.shareLink.updateMany = async () => {
      throw new Prisma.PrismaClientKnownRequestError("write conflict", {
        code: "P2034",
        clientVersion: "7.8.0",
      });
    };

    await assert.rejects(
      service.createShareLinkForRequest(
        "site-a",
        singleVideoRequest("video-1"),
        "admin-2",
      ),
      (error: unknown) =>
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034",
    );

    prisma.shareLink.updateMany = originalUpdateMany;
    assert.equal(prisma.shareLinks.get(shareLinkId)?.transportAlias, null);
  });
});

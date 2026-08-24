/**
 * HISTORICAL SHARE-LINK STATUS RECONCILIATION — `yarn reconcile:share-links`.
 *
 * WHAT IS BEING DEFENDED. The sweep exists to heal `ShareLink` rows stranded
 * `DISABLED` by the OLD one-way video-disable behaviour, and its whole value
 * depends on it being unable to do anything else. So these tests are weighted
 * towards what it must NEVER do:
 *
 *   - a dry run issues ZERO writes of any kind (asserted on a fake that records
 *     every write call, not merely on the reported counters);
 *   - the ONLY column ever present in an update payload is `status`, and the
 *     only transition is `DISABLED -> ACTIVE`;
 *   - `REVOKED` and `ACTIVE` links are never even read, let alone written;
 *   - a zero-member link, a link with a vanished member, a link bearing a purge
 *     footprint, and a link with any non-`READY`, non-playable, remote-missing
 *     or unassigned member are all left alone;
 *   - `alias`, `tokenHash`, `websiteId`, `expiresAt`, `maxViews` and
 *     `currentViews` are byte-identical afterwards, and no `WebsiteVideo` or
 *     `ShareLinkVideo` row is touched;
 *   - a second `--apply` changes zero rows.
 *
 * The fake client exposes ONLY `shareLink` and `adminAuditLog`, which is the
 * `ReconcileShareLinkPrisma` surface. Reaching for `videoAsset`, `websiteVideo`
 * or `shareLinkVideo` would be a TypeError here rather than a silent write, so
 * the narrow surface is itself part of the proof.
 *
 * No database connection and no network request is made.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AssignmentStatus,
  ShareLinkStatus,
  VideoProvider,
  VideoSourceType,
  VideoStatus,
} from "../src/generated/prisma/client";
import {
  classifyShareLink,
  hasPlayableAssetForSourceType,
  parseReconcileShareLinkOptions,
  readRecordedVideoCount,
  reconcileShareLinks,
  resolveShareLinkProvenance,
  SHARE_LINK_RECONCILE_ACTION,
  type ReconcileMemberVideo,
  type ReconcileShareLinkCandidate,
} from "../scripts/operations/reconcile-share-links";

const WEBSITE_ID = "website-reconcile-a";
const OTHER_WEBSITE_ID = "website-reconcile-b";
const NOW = new Date("2026-08-24T12:00:00.000Z");
const BUNNY_GUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function directUrlMember(
  overrides: Partial<ReconcileMemberVideo> = {},
): ReconcileMemberVideo {
  return {
    id: "video-direct",
    status: VideoStatus.READY,
    provider: VideoProvider.MANUAL,
    sourceType: VideoSourceType.DIRECT_URL,
    providerAssetId: null,
    playbackId: null,
    playbackUrl: "https://media.example.com/a.mp4",
    embedUrl: null,
    metadataJson: null,
    binaryAsset: null,
    localFileAsset: null,
    websiteVideos: [{ websiteId: WEBSITE_ID, status: AssignmentStatus.ACTIVE }],
    ...overrides,
  };
}

function localFileMember(
  overrides: Partial<ReconcileMemberVideo> = {},
): ReconcileMemberVideo {
  return directUrlMember({
    id: "video-local",
    sourceType: VideoSourceType.LOCAL_FILE,
    playbackUrl: null,
    localFileAsset: { mimeType: "video/mp4", sizeBytes: 2048n },
    ...overrides,
  });
}

function dbBlobMember(
  overrides: Partial<ReconcileMemberVideo> = {},
): ReconcileMemberVideo {
  return directUrlMember({
    id: "video-blob",
    sourceType: VideoSourceType.DB_BLOB,
    playbackUrl: null,
    binaryAsset: { mimeType: "video/mp4", sizeBytes: 4096n },
    ...overrides,
  });
}

function bunnyMember(
  overrides: Partial<ReconcileMemberVideo> = {},
): ReconcileMemberVideo {
  return directUrlMember({
    id: "video-bunny",
    provider: VideoProvider.BUNNY,
    sourceType: VideoSourceType.EMBED,
    providerAssetId: BUNNY_GUID,
    playbackId: BUNNY_GUID,
    playbackUrl: null,
    embedUrl: `https://iframe.mediadelivery.net/embed/987654/${BUNNY_GUID}`,
    metadataJson: {
      bunnyStream: {
        videoId: BUNNY_GUID,
        libraryId: "987654",
        createdAt: "2026-08-01T00:00:00.000Z",
      },
    },
    ...overrides,
  });
}

/** A `DISABLED` link that is restorable and currently usable by default. */
function candidate(
  overrides: Partial<ReconcileShareLinkCandidate> = {},
  members: Array<ReconcileMemberVideo | null> = [directUrlMember()],
): ReconcileShareLinkCandidate {
  return {
    id: "share-link-reconcile-1",
    websiteId: WEBSITE_ID,
    status: ShareLinkStatus.DISABLED,
    expiresAt: null,
    maxViews: null,
    currentViews: 0,
    shareLinkVideos: members.map((video, index) => ({
      sortOrder: index,
      video,
    })),
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * Write-recording fake
 *
 * Every mutation the sweep is even capable of issuing lands in `writes`, so
 * "dry run performs zero writes" is asserted against observed calls rather
 * than against the summary the code under test produced itself.
 * ------------------------------------------------------------------ */

type RecordedWrite =
  | {
      kind: "shareLink.updateMany";
      where: { id?: string; status?: ShareLinkStatus };
      data: Record<string, unknown>;
    }
  | { kind: "adminAuditLog.create"; data: Record<string, unknown> };

/** A historical `SHARE_LINK_CREATE` audit row, as production already holds. */
type FakeCreationAudit = {
  entityId: string;
  metadataJson: unknown;
};

class FakeReconcilePrisma {
  readonly writes: RecordedWrite[] = [];
  /** Every `where` the sweep read with, so status scoping is observable. */
  readonly readWheres: Array<Record<string, unknown>> = [];

  constructor(
    private readonly rows: ReconcileShareLinkCandidate[],
    private readonly creationAudits: FakeCreationAudit[] = [],
    private readonly canonicalShareLinkIds: string[] = [],
  ) {}

  adminAuditLog = {
    findMany: async (args: {
      where: {
        action?: string;
        entityType?: string;
        entityId?: { in?: string[] };
      };
      select?: unknown;
    }) => {
      const ids = args.where.entityId?.in;

      // Every predicate is honoured only when supplied, matching the other
      // fakes: dropping `action` or `entityType` in production would surface as
      // "an unrelated audit row was accepted as creation provenance".
      return this.creationAudits
        .filter(
          (row) =>
            (args.where.action === undefined ||
              args.where.action === "SHARE_LINK_CREATE") &&
            (args.where.entityType === undefined ||
              args.where.entityType === "ShareLink") &&
            (ids === undefined || ids.includes(row.entityId)),
        )
        .map((row) => ({ ...row }));
    },

    create: async (args: { data: Record<string, unknown> }) => {
      this.writes.push({
        kind: "adminAuditLog.create",
        data: { ...args.data },
      });

      return { id: `audit-${this.writes.length}` };
    },
  };

  canonicalVideoShareLink = {
    findMany: async (args: { where: { shareLinkId?: { in?: string[] } } }) => {
      const ids = args.where.shareLinkId?.in;

      return this.canonicalShareLinkIds
        .filter((id) => ids === undefined || ids.includes(id))
        .map((shareLinkId) => ({ shareLinkId }));
    },
  };

  shareLink = {
    findMany: async (args: {
      where?: { status?: ShareLinkStatus; id?: { gt?: string } };
      take?: number;
    }) => {
      this.readWheres.push({ ...(args.where ?? {}) });
      const wantedStatus = args.where?.status;
      const after = args.where?.id?.gt;

      const matched = this.rows
        .filter(
          (row) => wantedStatus === undefined || row.status === wantedStatus,
        )
        .filter((row) => after === undefined || row.id > after)
        .sort((left, right) => (left.id < right.id ? -1 : 1));

      return matched.slice(0, args.take ?? matched.length);
    },

    updateMany: async (args: {
      where: { id?: string; status?: ShareLinkStatus };
      data: Record<string, unknown>;
    }): Promise<{ count: number }> => {
      this.writes.push({
        kind: "shareLink.updateMany",
        where: { ...args.where },
        data: { ...args.data },
      });

      const row = this.rows.find((entry) => entry.id === args.where.id);
      // The conditional WHERE is honoured, which is what makes the TOCTOU and
      // idempotency assertions meaningful rather than decorative.
      if (row === undefined) return { count: 0 };
      if (args.where.status !== undefined && row.status !== args.where.status) {
        return { count: 0 };
      }

      if (typeof args.data.status === "string") {
        row.status = args.data.status as ShareLinkStatus;
      }

      return { count: 1 };
    },
  };
}

/**
 * By default every link is given the creation provenance production already
 * holds: a `SHARE_LINK_CREATE` row whose `videoCount` equals the membership it
 * still has, i.e. INTACT membership. Tests that need damaged or absent
 * provenance say so explicitly.
 */
function harness(
  rows: ReconcileShareLinkCandidate[],
  options: {
    creationAudits?: FakeCreationAudit[];
    canonicalShareLinkIds?: string[];
  } = {},
) {
  const creationAudits =
    options.creationAudits ??
    rows.map((row) => ({
      entityId: row.id,
      metadataJson: {
        websiteId: row.websiteId,
        videoCount: row.shareLinkVideos.length,
      },
    }));

  return new FakeReconcilePrisma(
    rows,
    creationAudits,
    options.canonicalShareLinkIds ?? [],
  );
}

const DRY_RUN = { apply: false, batchSize: 100, maxBatches: 50 };
const APPLY = { apply: true, batchSize: 100, maxBatches: 50 };

/* ------------------------------------------------------------------ *
 * REC-01 .. REC-03 — the happy path, and idempotency
 * ------------------------------------------------------------------ */

describe("REC-01/02/03 the reconciliation happy path", () => {
  it("REC-01 reports the candidate and performs ZERO writes in dry run", async () => {
    const link = candidate();
    const prisma = harness([link]);

    const summary = await reconcileShareLinks(prisma as never, DRY_RUN, NOW);

    assert.equal(summary.mode, "dry-run");
    assert.equal(summary.examined, 1);
    assert.equal(summary.restorableAndCurrentlyUsable, 1);
    assert.deepEqual(summary.reactivatedShareLinkIds, [link.id]);
    // The load-bearing assertion: not one write call was issued.
    assert.deepEqual(prisma.writes, []);
    assert.equal(summary.reactivated, 0);
    assert.equal(link.status, ShareLinkStatus.DISABLED);
  });

  it("REC-02 --apply flips DISABLED to ACTIVE and nothing else", async () => {
    const link = candidate();
    const prisma = harness([link]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.mode, "apply");
    assert.equal(summary.reactivated, 1);
    assert.equal(link.status, ShareLinkStatus.ACTIVE);

    const updates = prisma.writes.filter(
      (write) => write.kind === "shareLink.updateMany",
    );
    assert.equal(updates.length, 1);
    const update = updates[0];
    assert.ok(update?.kind === "shareLink.updateMany");
    // ONLY `status`, and only the one permitted transition.
    assert.deepEqual(Object.keys(update.data), ["status"]);
    assert.equal(update.data.status, ShareLinkStatus.ACTIVE);
    // TOCTOU: the mutation still required DISABLED at write time.
    assert.equal(update.where.status, ShareLinkStatus.DISABLED);
    assert.equal(update.where.id, link.id);
  });

  it("REC-03 a second --apply changes zero rows", async () => {
    const link = candidate();
    const prisma = harness([link]);

    await reconcileShareLinks(prisma as never, APPLY, NOW);
    const second = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(second.examined, 0, "the ACTIVE row is no longer a candidate");
    assert.equal(second.reactivated, 0);
    assert.equal(link.status, ShareLinkStatus.ACTIVE);
  });

  it("REC-03 a row that stops being DISABLED between read and write is not counted", async () => {
    // Simulates the TOCTOU race directly: the conditional WHERE must refuse.
    const link = candidate();
    const prisma = harness([link]);
    const originalUpdateMany = prisma.shareLink.updateMany;
    prisma.shareLink.updateMany = async (args) => {
      link.status = ShareLinkStatus.REVOKED; // a concurrent revoke lands first
      return originalUpdateMany.call(prisma.shareLink, args);
    };

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.reactivated, 0);
    assert.equal(link.status, ShareLinkStatus.REVOKED, "revoke must survive");
    assert.deepEqual(summary.reactivatedShareLinkIds, []);
  });
});

/* ------------------------------------------------------------------ *
 * REC-04 / REC-05 — statuses that are never eligible
 * ------------------------------------------------------------------ */

describe("REC-04/05 non-DISABLED statuses are never touched", () => {
  for (const status of [
    ShareLinkStatus.REVOKED,
    ShareLinkStatus.ACTIVE,
    ShareLinkStatus.EXPIRED,
  ]) {
    it(`leaves a ${status} link completely alone, even with --apply`, async () => {
      const link = candidate({ id: `share-link-${status}`, status });
      const prisma = harness([link]);

      const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

      assert.equal(summary.examined, 0, "it is not even read");
      assert.equal(summary.reactivated, 0);
      assert.deepEqual(prisma.writes, []);
      assert.equal(link.status, status);
    });
  }

  it("scopes every candidate read to status DISABLED", async () => {
    const prisma = harness([candidate()]);

    await reconcileShareLinks(prisma as never, DRY_RUN, NOW);

    assert.ok(prisma.readWheres.length > 0);
    for (const where of prisma.readWheres) {
      assert.equal(where.status, ShareLinkStatus.DISABLED);
    }
  });

  it("a REVOKED link sitting beside a restorable one does not block it", async () => {
    // Positive control: proves the REVOKED assertions above are not passing
    // because the sweep simply does nothing at all.
    const revoked = candidate({
      id: "share-link-a-revoked",
      status: ShareLinkStatus.REVOKED,
    });
    const restorable = candidate({ id: "share-link-b-restorable" });
    const prisma = harness([revoked, restorable]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.reactivated, 1);
    assert.equal(revoked.status, ShareLinkStatus.REVOKED);
    assert.equal(restorable.status, ShareLinkStatus.ACTIVE);
  });
});

/* ------------------------------------------------------------------ *
 * REC-06 .. REC-11 — membership and member-health protections
 * ------------------------------------------------------------------ */

describe("REC-06/07/08 membership protections", () => {
  it("REC-06 a zero-member link is skipped as NO_MEMBERS", async () => {
    const link = candidate({}, []);
    const prisma = harness([link]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.skipped.NO_MEMBERS, 1);
    assert.equal(summary.reactivated, 0);
    assert.deepEqual(prisma.writes, []);
    assert.equal(link.status, ShareLinkStatus.DISABLED);
  });

  it("REC-07 a membership row whose video no longer resolves is skipped", async () => {
    const link = candidate({}, [directUrlMember(), null]);
    const prisma = harness([link]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.skipped.MEMBER_MISSING, 1);
    assert.deepEqual(prisma.writes, []);
    assert.equal(link.status, ShareLinkStatus.DISABLED);
  });

  it("REC-08 one READY plus one DISABLED member is skipped", async () => {
    const link = candidate({}, [
      directUrlMember(),
      directUrlMember({ id: "video-b", status: VideoStatus.DISABLED }),
    ]);
    const prisma = harness([link]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.skipped.MEMBER_NOT_READY, 1);
    assert.deepEqual(prisma.writes, []);
    assert.equal(link.status, ShareLinkStatus.DISABLED);
  });

  it("a purge footprint - a sortOrder gap - is skipped as MEMBERSHIP_GAP", async () => {
    // Creation assigns 0..n-1 and nothing ever updates sortOrder, so {0, 2}
    // proves a membership row was deleted, which only a purge does.
    const link = candidate();
    link.shareLinkVideos = [
      { sortOrder: 0, video: directUrlMember() },
      { sortOrder: 2, video: directUrlMember({ id: "video-c" }) },
    ];
    const prisma = harness([link]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.skipped.MEMBERSHIP_GAP, 1);
    assert.deepEqual(prisma.writes, []);
    assert.equal(link.status, ShareLinkStatus.DISABLED);
  });

  it("a single surviving member at sortOrder 1 is skipped as MEMBERSHIP_GAP", async () => {
    const link = candidate();
    link.shareLinkVideos = [{ sortOrder: 1, video: directUrlMember() }];
    const prisma = harness([link]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.skipped.MEMBERSHIP_GAP, 1);
    assert.deepEqual(prisma.writes, []);
  });

  it("a contiguous two-member link is NOT flagged as a gap", async () => {
    // Positive control for the contiguity rule: zero false positives against a
    // legitimately created multi-video link.
    const link = candidate({}, [
      directUrlMember(),
      directUrlMember({ id: "video-b" }),
    ]);
    const prisma = harness([link]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.skipped.MEMBERSHIP_GAP, 0);
    assert.equal(summary.reactivated, 1);
  });
});

describe("REC-09/10/11 every non-READY member status blocks reactivation", () => {
  for (const status of [
    VideoStatus.DRAFT,
    VideoStatus.PROCESSING,
    VideoStatus.FAILED,
    VideoStatus.DISABLED,
  ]) {
    it(`a ${status} member is skipped as MEMBER_NOT_READY`, async () => {
      const link = candidate({}, [directUrlMember({ status })]);
      const prisma = harness([link]);

      const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

      assert.equal(summary.skipped.MEMBER_NOT_READY, 1);
      assert.equal(summary.reactivated, 0);
      assert.deepEqual(prisma.writes, []);
      assert.equal(link.status, ShareLinkStatus.DISABLED);
    });
  }

  it("a READY member with no usable asset is skipped as MEMBER_NOT_PLAYABLE", async () => {
    const link = candidate({}, [directUrlMember({ playbackUrl: "   " })]);
    const prisma = harness([link]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.skipped.MEMBER_NOT_PLAYABLE, 1);
    assert.deepEqual(prisma.writes, []);
  });

  it("a member with no ACTIVE assignment to THIS link's website is skipped", async () => {
    const link = candidate({}, [
      directUrlMember({
        websiteVideos: [
          // Assigned elsewhere, and DISABLED here: neither counts.
          { websiteId: OTHER_WEBSITE_ID, status: AssignmentStatus.ACTIVE },
          { websiteId: WEBSITE_ID, status: AssignmentStatus.DISABLED },
        ],
      }),
    ]);
    const prisma = harness([link]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.skipped.MEMBER_NOT_ASSIGNED, 1);
    assert.deepEqual(prisma.writes, []);
  });
});

/* ------------------------------------------------------------------ *
 * REC-12 .. REC-14 — per-provider eligibility
 * ------------------------------------------------------------------ */

describe("REC-12/13/14 provider-specific member eligibility", () => {
  it("REC-12 a healthy READY LOCAL_FILE member is eligible", async () => {
    const prisma = harness([candidate({}, [localFileMember()])]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.reactivated, 1);
  });

  it("REC-12 a LOCAL_FILE member with a zero-byte asset is not eligible", async () => {
    const prisma = harness([
      candidate({}, [
        localFileMember({
          localFileAsset: { mimeType: "video/mp4", sizeBytes: 0n },
        }),
      ]),
    ]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.skipped.MEMBER_NOT_PLAYABLE, 1);
    assert.deepEqual(prisma.writes, []);
  });

  it("REC-13 a healthy READY Bunny member is eligible", async () => {
    const prisma = harness([candidate({}, [bunnyMember()])]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.reactivated, 1);
  });

  it("REC-14 a READY Bunny member carrying remoteMissing is NOT eligible", async () => {
    // `status === READY` must not be taken as proof of health: the public
    // signing gate refuses a remote-missing row regardless of status, so this
    // sweep must refuse it too.
    const member = bunnyMember();
    (
      member.metadataJson as { bunnyStream: Record<string, unknown> }
    ).bunnyStream.remoteMissing = {
      detectedAt: "2026-08-20T00:00:00.000Z",
      reason: "NOT_FOUND",
    };
    const link = candidate({}, [member]);
    const prisma = harness([link]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.skipped.MEMBER_BUNNY_REMOTE_MISSING, 1);
    assert.equal(summary.reactivated, 0);
    assert.deepEqual(prisma.writes, []);
    assert.equal(link.status, ShareLinkStatus.DISABLED);
  });

  it("REC-14 a malformed Bunny EMBED shape is NOT eligible", async () => {
    // Fails the strict classifier: the metadata marker disagrees with the
    // provider asset id. Every other Bunny branch fails such a row closed.
    const member = bunnyMember({ playbackId: "not-the-guid" });
    const prisma = harness([candidate({}, [member])]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.skipped.MEMBER_BUNNY_REMOTE_MISSING, 1);
    assert.deepEqual(prisma.writes, []);
  });

  it("a legacy provider:BUNNY DIRECT_URL record is treated as not-bunny", async () => {
    const prisma = harness([
      candidate({}, [directUrlMember({ provider: VideoProvider.BUNNY })]),
    ]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.reactivated, 1, "legacy labelling changes nothing");
  });

  it("REC-12/13 a DB_BLOB member is eligible when its blob is usable", async () => {
    const prisma = harness([candidate({}, [dbBlobMember()])]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.reactivated, 1);
  });
});

describe("the member playability predicate mirrors the service predicate", () => {
  // Parity across all five VideoSourceType values, so the local copy in the
  // script cannot silently drift from `isPublicPlayableVideo()`.
  it("requires playbackUrl for UPLOAD and DIRECT_URL", () => {
    for (const sourceType of [
      VideoSourceType.UPLOAD,
      VideoSourceType.DIRECT_URL,
    ]) {
      assert.equal(
        hasPlayableAssetForSourceType(directUrlMember({ sourceType })),
        true,
      );
      assert.equal(
        hasPlayableAssetForSourceType(
          directUrlMember({ sourceType, playbackUrl: null }),
        ),
        false,
      );
    }
  });

  it("requires embedUrl for EMBED", () => {
    assert.equal(hasPlayableAssetForSourceType(bunnyMember()), true);
    assert.equal(
      hasPlayableAssetForSourceType(bunnyMember({ embedUrl: "" })),
      false,
    );
  });

  it("requires a video/* blob of non-zero size for DB_BLOB", () => {
    assert.equal(hasPlayableAssetForSourceType(dbBlobMember()), true);
    assert.equal(
      hasPlayableAssetForSourceType(
        dbBlobMember({
          binaryAsset: { mimeType: "text/plain", sizeBytes: 9n },
        }),
      ),
      false,
    );
    assert.equal(
      hasPlayableAssetForSourceType(dbBlobMember({ binaryAsset: null })),
      false,
    );
  });

  it("requires a video/* file of non-zero size for LOCAL_FILE", () => {
    assert.equal(hasPlayableAssetForSourceType(localFileMember()), true);
    assert.equal(
      hasPlayableAssetForSourceType(localFileMember({ localFileAsset: null })),
      false,
    );
  });
});

/* ------------------------------------------------------------------ *
 * REC-15 / REC-16 — the documented expiry and view-limit policy
 * ------------------------------------------------------------------ */

describe("REC-15/16 expiry and view-limit policy: report, never write", () => {
  it("REC-15 an expired link is classified RESTORABLE_BUT_EXPIRED and NOT written", async () => {
    // POLICY. `ShareLinkStatus.EXPIRED` is written by no code path - expiry is
    // enforced from `expiresAt` alone - so there is no status-normalization
    // semantic to honour. Flipping this row to ACTIVE would change nothing a
    // viewer can observe while erasing the evidence of the historical bug.
    const link = candidate({
      expiresAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const prisma = harness([link]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.restorableButExpired, 1);
    assert.equal(summary.restorableAndCurrentlyUsable, 0);
    assert.equal(summary.reactivated, 0);
    assert.deepEqual(prisma.writes, []);
    assert.equal(link.status, ShareLinkStatus.DISABLED);
    // Expiry itself is untouched.
    assert.equal(link.expiresAt?.toISOString(), "2026-01-01T00:00:00.000Z");
  });

  it("REC-15 a link expiring in the future stays currently usable", async () => {
    const link = candidate({
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    });
    const prisma = harness([link]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.reactivated, 1);
    assert.equal(link.expiresAt?.toISOString(), "2099-01-01T00:00:00.000Z");
  });

  it("REC-16 a view-exhausted link is classified and NOT written", async () => {
    const link = candidate({ maxViews: 5, currentViews: 5 });
    const prisma = harness([link]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.restorableButViewLimitReached, 1);
    assert.equal(summary.reactivated, 0);
    assert.deepEqual(prisma.writes, []);
    assert.equal(link.status, ShareLinkStatus.DISABLED);
    assert.equal(link.maxViews, 5);
    assert.equal(link.currentViews, 5);
  });

  it("REC-16 a link with views remaining is currently usable and keeps its budget", async () => {
    const link = candidate({ maxViews: 5, currentViews: 2 });
    const prisma = harness([link]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.reactivated, 1);
    assert.equal(link.maxViews, 5, "maxViews must not be reset");
    assert.equal(link.currentViews, 2, "currentViews must not be reset");
  });
});

/* ------------------------------------------------------------------ *
 * REC-17 .. REC-19 — nothing else is mutated
 * ------------------------------------------------------------------ */

describe("REC-17/18/19 no field or relation other than status is mutated", () => {
  it("REC-17 alias, tokenHash, websiteId and expiry are byte-identical after --apply", async () => {
    // The fixture carries the credential columns even though the sweep does not
    // select them, so an accidental write would be visible here.
    const link = candidate({
      expiresAt: new Date("2099-06-01T00:00:00.000Z"),
      maxViews: 9,
      currentViews: 3,
    }) as ReconcileShareLinkCandidate & {
      alias: string;
      tokenHash: string;
      label: string | null;
      lastViewedAt: Date | null;
    };
    link.alias = "Ab3dEf7";
    link.tokenHash = "f".repeat(64);
    link.label = "reviewer batch 4";
    link.lastViewedAt = new Date("2026-02-02T00:00:00.000Z");
    const before = { ...link };
    const prisma = harness([link]);

    await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(link.status, ShareLinkStatus.ACTIVE, "status did change");
    assert.equal(link.alias, before.alias);
    assert.equal(link.tokenHash, before.tokenHash);
    assert.equal(link.websiteId, before.websiteId);
    assert.equal(link.label, before.label);
    assert.equal(link.expiresAt?.toISOString(), "2099-06-01T00:00:00.000Z");
    assert.equal(link.maxViews, 9);
    assert.equal(link.currentViews, 3);
    assert.equal(
      link.lastViewedAt?.toISOString(),
      before.lastViewedAt?.toISOString(),
    );
  });

  it("REC-17 every update payload the sweep can ever emit contains only status", async () => {
    const prisma = harness([
      candidate({ id: "share-link-1" }),
      candidate({ id: "share-link-2" }, [localFileMember()]),
      candidate({ id: "share-link-3" }, [bunnyMember()]),
    ]);

    await reconcileShareLinks(prisma as never, APPLY, NOW);

    const updates = prisma.writes.filter(
      (write) => write.kind === "shareLink.updateMany",
    );
    assert.equal(updates.length, 3);
    for (const update of updates) {
      assert.ok(update.kind === "shareLink.updateMany");
      assert.deepEqual(Object.keys(update.data), ["status"]);
      assert.equal(update.data.status, ShareLinkStatus.ACTIVE);
    }
  });

  it("REC-18/19 WebsiteVideo and ShareLinkVideo are untouched", async () => {
    const member = directUrlMember();
    const link = candidate({}, [member]);
    const assignmentsBefore = JSON.stringify(member.websiteVideos);
    const membershipBefore = link.shareLinkVideos.map((row) => ({
      sortOrder: row.sortOrder,
      videoId: row.video?.id,
    }));
    const prisma = harness([link]);

    await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(JSON.stringify(member.websiteVideos), assignmentsBefore);
    assert.deepEqual(
      link.shareLinkVideos.map((row) => ({
        sortOrder: row.sortOrder,
        videoId: row.video?.id,
      })),
      membershipBefore,
    );
    // Structural: the sweep is only handed `shareLink` and `adminAuditLog`, so
    // it has no route to a video, assignment or membership table at all.
    assert.deepEqual(
      prisma.writes
        .map((write) => write.kind)
        .filter((kind, index, all) => all.indexOf(kind) === index),
      ["shareLink.updateMany", "adminAuditLog.create"],
    );
  });

  it("member VideoAsset status is never rewritten", async () => {
    const member = directUrlMember();
    const prisma = harness([candidate({}, [member])]);

    await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(member.status, VideoStatus.READY);
    assert.equal(member.provider, VideoProvider.MANUAL);
    assert.equal(member.metadataJson, null);
  });
});

/* ------------------------------------------------------------------ *
 * Audit, output hygiene, batching, CLI
 * ------------------------------------------------------------------ */

describe("audit and output hygiene", () => {
  it("records its own maintenance action, never a fabricated user action", async () => {
    const prisma = harness([candidate()]);

    await reconcileShareLinks(prisma as never, APPLY, NOW);

    const audits = prisma.writes.filter(
      (write) => write.kind === "adminAuditLog.create",
    );
    assert.equal(audits.length, 1);
    const audit = audits[0];
    assert.ok(audit?.kind === "adminAuditLog.create");
    assert.equal(audit.data.action, SHARE_LINK_RECONCILE_ACTION);
    assert.notEqual(audit.data.action, "VIDEO_RESTORE");
    assert.notEqual(audit.data.action, "VIDEO_UPDATE");
    assert.notEqual(audit.data.action, "SHARE_LINK_CREATE");
    assert.equal(audit.data.entityType, "ShareLink");
    assert.equal(audit.data.entityId, "share-link-reconcile-1");
    // Unattended: attributing it to a person would falsify the trail.
    assert.equal(audit.data.adminId, null);
  });

  it("writes no audit row in dry run", async () => {
    const prisma = harness([candidate()]);

    await reconcileShareLinks(prisma as never, DRY_RUN, NOW);

    assert.deepEqual(prisma.writes, []);
  });

  it("emits no credential in the summary or the audit metadata", async () => {
    const link = candidate() as ReconcileShareLinkCandidate & {
      alias: string;
      tokenHash: string;
    };
    link.alias = "Ab3dEf7";
    link.tokenHash = "f".repeat(64);
    const prisma = harness([link]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    const serialized = JSON.stringify({ summary, writes: prisma.writes });
    assert.ok(!serialized.includes("Ab3dEf7"), "alias must never be emitted");
    assert.ok(!serialized.includes("f".repeat(64)), "no tokenHash");
    // The one identifier it does emit is the database id, matching the other
    // operational scripts.
    assert.deepEqual(summary.reactivatedShareLinkIds, [link.id]);
  });
});

describe("batching and CLI options", () => {
  it("pages through more rows than one batch holds", async () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      candidate({ id: `share-link-${index}` }),
    );
    const prisma = harness(rows);

    const summary = await reconcileShareLinks(
      prisma as never,
      { apply: true, batchSize: 2, maxBatches: 50 },
      NOW,
    );

    assert.equal(summary.examined, 7);
    assert.equal(summary.reactivated, 7);
    assert.ok(rows.every((row) => row.status === ShareLinkStatus.ACTIVE));
  });

  it("honours maxBatches as a hard bound", async () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      candidate({ id: `share-link-${index}` }),
    );
    const prisma = harness(rows);

    const summary = await reconcileShareLinks(
      prisma as never,
      { apply: true, batchSize: 2, maxBatches: 2 },
      NOW,
    );

    assert.equal(summary.examined, 4);
    assert.equal(summary.reactivated, 4);
  });

  it("defaults to dry run and rejects unknown arguments", () => {
    assert.equal(parseReconcileShareLinkOptions([]).apply, false);
    assert.equal(parseReconcileShareLinkOptions(["--apply"]).apply, true);
    assert.equal(
      parseReconcileShareLinkOptions(["--confirm-env=local"])
        .confirmEnvironment,
      "local",
    );
    assert.throws(
      () => parseReconcileShareLinkOptions(["--force"]),
      /Unknown reconcile argument/,
    );
    assert.throws(
      () => parseReconcileShareLinkOptions(["--batch-size=0"]),
      /--batch-size must be 1-500/,
    );
  });
});

/* ------------------------------------------------------------------ *
 * KI-021 — historical purge provenance
 *
 * `MEMBERSHIP_GAP` sees a purge that left a hole in `sortOrder`. It CANNOT see
 * a purge of the highest-indexed member, which leaves {0..n-2} - still
 * contiguous. These cases prove the creation-provenance gate closes that gap,
 * using only `SHARE_LINK_CREATE.metadataJson.videoCount`, which has existed in
 * every commit of this repository and is therefore present on historical
 * production rows.
 * ------------------------------------------------------------------ */

describe("KI-021 provenance: purge of the HIGHEST-indexed member", () => {
  it("case 3 - is PURGE_PROVEN even though sortOrder stayed contiguous", async () => {
    // Issued with two videos; the one at sortOrder 1 was purged. What survives
    // is {0} - contiguous, and therefore invisible to the gap check.
    const link = candidate({}, [directUrlMember()]);
    const prisma = harness([link], {
      creationAudits: [
        {
          entityId: link.id,
          metadataJson: { websiteId: WEBSITE_ID, videoCount: 2 },
        },
      ],
    });

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.skipped.MEMBERSHIP_SHRANK, 1);
    assert.equal(
      summary.skipped.MEMBERSHIP_GAP,
      0,
      "the gap check is blind to this case",
    );
    assert.equal(summary.provenance.PURGE_PROVEN, 1);
    assert.equal(summary.provenance.SAFE_PROVEN, 0);
    assert.equal(summary.reactivated, 0);
    assert.deepEqual(prisma.writes, []);
    assert.equal(link.status, ShareLinkStatus.DISABLED);
  });

  it("case 1 - an untouched contiguous historical link is SAFE_PROVEN", async () => {
    const link = candidate({}, [
      directUrlMember(),
      directUrlMember({ id: "video-b" }),
    ]);
    const prisma = harness([link], {
      creationAudits: [
        {
          entityId: link.id,
          metadataJson: { websiteId: WEBSITE_ID, videoCount: 2 },
        },
      ],
    });

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.provenance.SAFE_PROVEN, 1);
    assert.equal(summary.provenance.PURGE_PROVEN, 0);
    assert.equal(summary.provenance.AMBIGUOUS_PURGE_HISTORY, 0);
    assert.equal(summary.reactivated, 1);
  });

  it("case 2 - a middle-member purge is caught by MEMBERSHIP_GAP first", async () => {
    const link = candidate();
    link.shareLinkVideos = [
      { sortOrder: 0, video: directUrlMember() },
      { sortOrder: 2, video: directUrlMember({ id: "video-c" }) },
    ];
    const prisma = harness([link], {
      creationAudits: [
        {
          entityId: link.id,
          metadataJson: { websiteId: WEBSITE_ID, videoCount: 3 },
        },
      ],
    });

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.skipped.MEMBERSHIP_GAP, 1);
    assert.equal(summary.provenance.PURGE_PROVEN, 1);
    assert.deepEqual(prisma.writes, []);
  });

  it("case 4 - a purge of the ONLY member leaves zero members and is skipped", async () => {
    const link = candidate({}, []);
    const prisma = harness([link], {
      creationAudits: [
        {
          entityId: link.id,
          metadataJson: { websiteId: WEBSITE_ID, videoCount: 1 },
        },
      ],
    });

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.skipped.NO_MEMBERS, 1);
    assert.equal(summary.reactivated, 0);
    assert.deepEqual(prisma.writes, []);
  });
});

describe("KI-021 provenance: absent, malformed and impossible evidence", () => {
  it("case 9 - no creation provenance is AMBIGUOUS, never reactivated", async () => {
    // `writeAudit()` on the creation path is best effort, so a missing row is a
    // real possibility. Absence of evidence must never read as absence of harm.
    const link = candidate();
    const prisma = harness([link], { creationAudits: [] });

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.skipped.PROVENANCE_MISSING, 1);
    assert.equal(summary.provenance.AMBIGUOUS_PURGE_HISTORY, 1);
    assert.equal(summary.provenance.SAFE_PROVEN, 0);
    assert.equal(summary.reactivated, 0);
    assert.deepEqual(prisma.writes, []);
    assert.equal(link.status, ShareLinkStatus.DISABLED);
  });

  const malformedCases: Array<[string, unknown]> = [
    ["absent videoCount", { websiteId: WEBSITE_ID }],
    ["null metadata", null],
    ["non-numeric videoCount", { videoCount: "2" }],
    ["negative videoCount", { videoCount: -1 }],
    ["fractional videoCount", { videoCount: 1.5 }],
    ["NaN videoCount", { videoCount: Number.NaN }],
  ];

  for (const [label, metadataJson] of malformedCases) {
    it(`case 10 - ${label} is AMBIGUOUS, never reactivated`, async () => {
      const link = candidate();
      const prisma = harness([link], {
        creationAudits: [{ entityId: link.id, metadataJson }],
      });

      const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

      assert.equal(summary.skipped.PROVENANCE_MALFORMED, 1);
      assert.equal(summary.provenance.AMBIGUOUS_PURGE_HISTORY, 1);
      assert.equal(summary.reactivated, 0);
      assert.deepEqual(prisma.writes, []);
    });
  }

  it("more members than recorded is unexplainable, so AMBIGUOUS", async () => {
    // Nothing adds a member after creation, so an excess cannot be explained
    // and must not be read as healthy.
    const link = candidate({}, [
      directUrlMember(),
      directUrlMember({ id: "video-b" }),
    ]);
    const prisma = harness([link], {
      creationAudits: [
        {
          entityId: link.id,
          metadataJson: { websiteId: WEBSITE_ID, videoCount: 1 },
        },
      ],
    });

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.skipped.PROVENANCE_MALFORMED, 1);
    assert.deepEqual(prisma.writes, []);
  });

  it("readRecordedVideoCount accepts only a non-negative safe integer", () => {
    assert.equal(readRecordedVideoCount({ videoCount: 0 }), 0);
    assert.equal(readRecordedVideoCount({ videoCount: 3 }), 3);
    assert.equal(readRecordedVideoCount({ videoCount: "3" }), null);
    assert.equal(readRecordedVideoCount({ videoCount: -1 }), null);
    assert.equal(readRecordedVideoCount({ videoCount: 2.5 }), null);
    assert.equal(readRecordedVideoCount({}), null);
    assert.equal(readRecordedVideoCount(null), null);
    assert.equal(readRecordedVideoCount("nonsense"), null);
    assert.equal(
      readRecordedVideoCount({ videoCount: Number.MAX_SAFE_INTEGER + 2 }),
      null,
    );
  });
});

describe("KI-021 provenance: canonical links are structurally purge-immune", () => {
  it("a canonical anchor with one member is SAFE_PROVEN without an audit row", async () => {
    // purgeVideo() refuses a video anchoring a canonical link with 409, and all
    // four relations are onDelete: Restrict - so its member cannot have been
    // purged, with or without surviving audit evidence.
    const link = candidate();
    const prisma = harness([link], {
      creationAudits: [],
      canonicalShareLinkIds: [link.id],
    });

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.provenance.SAFE_PROVEN, 1);
    assert.equal(summary.reactivated, 1);
    assert.equal(link.status, ShareLinkStatus.ACTIVE);
  });

  it("a canonical row with an unexpected member count is AMBIGUOUS", async () => {
    const link = candidate({}, [
      directUrlMember(),
      directUrlMember({ id: "video-b" }),
    ]);
    const prisma = harness([link], {
      creationAudits: [],
      canonicalShareLinkIds: [link.id],
    });

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.skipped.PROVENANCE_MALFORMED, 1);
    assert.deepEqual(prisma.writes, []);
  });
});

describe("KI-021 provenance: the resolver reads only historical evidence", () => {
  it("prefers the canonical structural proof over an audit row", async () => {
    const prisma = harness([], {
      creationAudits: [{ entityId: "link-1", metadataJson: { videoCount: 9 } }],
      canonicalShareLinkIds: ["link-1"],
    });

    const resolved = await resolveShareLinkProvenance(prisma as never, [
      "link-1",
    ]);

    assert.deepEqual(resolved.get("link-1"), { kind: "CANONICAL" });
  });

  it("returns MISSING for a link with no surviving evidence", async () => {
    const prisma = harness([], { creationAudits: [] });

    const resolved = await resolveShareLinkProvenance(prisma as never, [
      "link-unknown",
    ]);

    assert.deepEqual(resolved.get("link-unknown"), { kind: "MISSING" });
  });

  it("scopes its lookup to the SHARE_LINK_CREATE action on ShareLink", async () => {
    // The new SHARE_LINK_STATUS_RECONCILE event postdates the damage, so it
    // must never be mistaken for creation provenance. The fake honours the
    // action and entityType predicates only when the query supplies them.
    const prisma = harness([], {
      creationAudits: [{ entityId: "link-1", metadataJson: { videoCount: 2 } }],
    });

    const resolved = await resolveShareLinkProvenance(prisma as never, [
      "link-1",
    ]);

    assert.deepEqual(resolved.get("link-1"), {
      kind: "CREATED",
      recordedVideoCount: 2,
    });
  });

  it("issues no lookup for an empty batch", async () => {
    const prisma = harness([]);

    const resolved = await resolveShareLinkProvenance(prisma as never, []);

    assert.equal(resolved.size, 0);
  });
});

describe("cases 5/6/7/8 remain unaffected by the provenance gate", () => {
  it("case 5 - an explicitly REVOKED link is still never read", async () => {
    const link = candidate({ status: ShareLinkStatus.REVOKED });
    const prisma = harness([link]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.examined, 0);
    assert.deepEqual(prisma.writes, []);
    assert.equal(link.status, ShareLinkStatus.REVOKED);
  });

  it("case 6 - an expired link with intact provenance stays DISABLED", async () => {
    const link = candidate({ expiresAt: new Date("2026-01-01T00:00:00.000Z") });
    const prisma = harness([link]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(
      summary.provenance.SAFE_PROVEN,
      1,
      "provenance itself is fine",
    );
    assert.equal(summary.restorableButExpired, 1);
    assert.equal(summary.reactivated, 0);
    assert.deepEqual(prisma.writes, []);
  });

  it("case 7 - an exhausted link with intact provenance stays DISABLED", async () => {
    const link = candidate({ maxViews: 2, currentViews: 2 });
    const prisma = harness([link]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.provenance.SAFE_PROVEN, 1);
    assert.equal(summary.restorableButViewLimitReached, 1);
    assert.equal(summary.reactivated, 0);
    assert.deepEqual(prisma.writes, []);
  });

  it("case 8 - a healthy multi-provider reversible disable/restore reactivates", async () => {
    const link = candidate({}, [
      directUrlMember(),
      localFileMember(),
      bunnyMember(),
    ]);
    const prisma = harness([link]);

    const summary = await reconcileShareLinks(prisma as never, APPLY, NOW);

    assert.equal(summary.provenance.SAFE_PROVEN, 1);
    assert.equal(summary.reactivated, 1);
    assert.equal(link.status, ShareLinkStatus.ACTIVE);
  });
});

describe("the classifier is pure", () => {
  it("does not mutate the candidate it classifies", () => {
    const link = candidate({ maxViews: 4, currentViews: 1 });
    const snapshot = JSON.stringify(link, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );

    const classification = classifyShareLink(
      link,
      { kind: "CREATED", recordedVideoCount: link.shareLinkVideos.length },
      NOW,
    );

    assert.equal(classification.kind, "RESTORABLE_AND_CURRENTLY_USABLE");
    assert.equal(
      JSON.stringify(link, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
      snapshot,
    );
  });
});

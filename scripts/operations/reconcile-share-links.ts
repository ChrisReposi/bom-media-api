/**
 * HISTORICAL SHARE-LINK STATUS RECONCILIATION.
 *
 *     yarn reconcile:share-links                              # dry run, reports only
 *     yarn reconcile:share-links --apply --confirm-env=local   # writes
 *
 * WHY THIS EXISTS. Until 2026-08-24, disabling a video swept every ACTIVE
 * `ShareLink` containing it to `DISABLED` and **nothing ever wrote that status
 * back**: `ShareLinkStatus.DISABLED` was written in one place and read in none,
 * so it was a one-way trapdoor. Restoring the video left every one of its share
 * links dead forever. `reactivateShareLinksDisabledWithVideo()` closes that for
 * every FUTURE `DISABLED -> READY` transition, but it cannot retroactively heal
 * links that were already stranded before it shipped — no transition will ever
 * fire for them again.
 *
 * This is the one-shot administrative sweep for that historical residue. It is
 * NOT part of the lifecycle, NOT wired into request handling, NOT run at
 * startup or on deploy, and nothing schedules it.
 *
 * THE ONLY DATABASE MUTATION IT CAN PERFORM:
 *
 *     ShareLink.status : DISABLED -> ACTIVE
 *
 * `alias`, `tokenHash`, `websiteId`, `label`, `expiresAt`, `maxViews`,
 * `currentViews` and `lastViewedAt` are never in an update payload. Neither is
 * any `ShareLinkVideo`, `WebsiteVideo`, `VideoAsset` or provider metadata. The
 * script calls `updateMany` on `shareLink` and nothing else; there is no
 * `delete`, no `create` except the audit row, and no provider request of any
 * kind — remote existence is NOT re-validated here, deliberately (see below).
 *
 * WHY AUTO-REACTIVATION IS PROVABLY SAFE — the provenance argument.
 *
 * `ShareLinkStatus.DISABLED` has exactly ONE writer in the whole backend:
 * `disableActiveShareLinksForVideo()`. There is no admin route, DTO or service
 * method that can set a share-link status directly — the entire share-link HTTP
 * surface is list, create, canonical get/create and revoke, and
 * `CreateShareLinkDto` carries no `status` field. So a `DISABLED` row cannot
 * encode an operator's independent decision; the only decision that produces it
 * is "a member video was disabled". Revocation is a separate, deliberate status
 * (`REVOKED`) and is never touched here.
 *
 * THE PURGE FOOTPRINT, and why membership contiguity is checked.
 *
 * `disableActiveShareLinksForVideo()` has three callers: `updateVideo()`,
 * `disableVideo()` and — belt-and-braces — the `purgeVideo()` transaction. A
 * purge then DELETES the video's `ShareLinkVideo` row. So a link can be dark
 * because a member was disabled and subsequently **destroyed**, in which case
 * its darkness is entangled with an intentional destructive operation and the
 * link no longer holds the content it was issued for.
 *
 * `ShareLinkVideo.sortOrder` is assigned contiguously from 0 at creation and is
 * **never updated afterwards** — there is no `shareLinkVideo.update` anywhere in
 * the production sources. A surviving membership set whose `sortOrder` values
 * are not exactly {0 .. n-1} is therefore proof that a row was deleted, which
 * only a purge does. Such links are skipped as `MEMBERSHIP_GAP`. This test has
 * ZERO false positives against legitimately created links, by construction.
 *
 * It is not a complete detector: a purge of the LAST member leaves {0 .. n-2},
 * which is still contiguous. That residue is accepted knowingly and is a
 * content-completeness matter, not a security one — every surviving member was
 * already authorized through this exact credential when the link was issued, so
 * reactivation can never expose a video the credential did not already cover.
 * A purge of the ONLY member leaves a zero-member link, which is skipped
 * outright.
 *
 * EXPIRY AND VIEW-LIMIT POLICY — reported, never written.
 *
 * `ShareLinkStatus.EXPIRED` is written by NO code path; expiry is enforced
 * purely from the `expiresAt` column by `getDeniedReason()`. There is therefore
 * no "status normalization" semantic in this repository that would justify
 * touching a link the viewer cannot use anyway. `--apply` writes ONLY links
 * classified `RESTORABLE_AND_CURRENTLY_USABLE`. An expired or view-exhausted
 * link is reported under its own classification and left `DISABLED`, because
 * flipping it to `ACTIVE` would be a no-op for every viewer — the independent
 * expiry and `maxViews` gates still deny it — while destroying the evidence
 * that it was darkened by the historical bug. Smallest write set, same
 * observable behaviour.
 *
 * SECRETS. Output is aggregate counts plus `ShareLink` database ids, matching
 * the existing operational scripts. `alias` and `tokenHash` are bearer
 * credentials and are never selected, logged or audited.
 */
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import {
  classifyBunnyVideoAsset,
  isBunnyRemoteMissing,
} from "../../src/bunny/bunny-video-asset.util";
import { loadApiEnv } from "../../src/config/load-env";
import {
  AssignmentStatus,
  AuditStatus,
  PrismaClient,
  ShareLinkStatus,
  VideoProvider,
  VideoSourceType,
  VideoStatus,
  type Prisma,
} from "../../src/generated/prisma/client";

/**
 * The audit action for this sweep. Deliberately its OWN action rather than
 * `VIDEO_RESTORE` or `SHARE_LINK_CREATE`: this is offline maintenance, not a
 * user action, and attributing it to one would falsify the audit trail.
 */
export const SHARE_LINK_RECONCILE_ACTION = "SHARE_LINK_STATUS_RECONCILE";

export type ReconcileShareLinkOptions = {
  apply: boolean;
  batchSize: number;
  maxBatches: number;
  confirmEnvironment?: string;
};

/** Why a `DISABLED` link was left alone. Every skip is fail-closed. */
export type ShareLinkSkipReason =
  /** No `ShareLinkVideo` rows remain - nothing to serve. */
  | "NO_MEMBERS"
  /** A membership row references a video that no longer resolves. */
  | "MEMBER_MISSING"
  /** `sortOrder` is not {0..n-1}: a member was deleted, i.e. purged. */
  | "MEMBERSHIP_GAP"
  /** A member is not `READY` (covers DISABLED, DRAFT, PROCESSING, FAILED). */
  | "MEMBER_NOT_READY"
  /** A member is `READY` but has no usable asset for its `sourceType`. */
  | "MEMBER_NOT_PLAYABLE"
  /** A Bunny member is reconciled as gone from Bunny, or is malformed. */
  | "MEMBER_BUNNY_REMOTE_MISSING"
  /** A member has no ACTIVE `WebsiteVideo` row for this link's website. */
  | "MEMBER_NOT_ASSIGNED"
  /**
   * PURGE PROVEN. Fewer members survive than `SHARE_LINK_CREATE` recorded, and
   * the only production path that deletes a `ShareLinkVideo` row is a purge.
   * This is what closes the KI-021 residual that `MEMBERSHIP_GAP` cannot see.
   */
  | "MEMBERSHIP_SHRANK"
  /** AMBIGUOUS. No creation provenance survives for this link. */
  | "PROVENANCE_MISSING"
  /** AMBIGUOUS. Creation provenance exists but cannot be trusted. */
  | "PROVENANCE_MALFORMED";

/**
 * WHAT SURVIVING DATA CAN PROVE ABOUT ONE LINK'S CREATION.
 *
 * `SHARE_LINK_CREATE` has recorded `metadataJson.videoCount` - the exact
 * `ShareLinkVideo` count at creation - keyed by `entityId = shareLinkId`, in
 * EVERY commit of this repository back to the initial one. It is therefore
 * available for historical production rows, which is what makes it usable as
 * provenance for damage done before the lifecycle fix shipped.
 *
 * `CanonicalVideoShareLink` is stronger still: a video anchoring one CANNOT be
 * purged. `purgeVideo()` refuses with `409 VIDEO_HAS_CANONICAL_SHARE_LINK`
 * before its transaction, and all four relations are `onDelete: Restrict`, so
 * the database would reject the delete even if the guard were bypassed. A
 * canonical link's membership is structurally purge-immune.
 */
export type ShareLinkProvenance =
  /** `SHARE_LINK_CREATE` survives and names the membership size at creation. */
  | { kind: "CREATED"; recordedVideoCount: number }
  /** Anchors a canonical provenance record: its member cannot be purged. */
  | { kind: "CANONICAL" }
  /** No creation evidence survives - `writeAudit()` is best effort. */
  | { kind: "MISSING" }
  /** Evidence exists but `videoCount` is absent or not a usable integer. */
  | { kind: "MALFORMED" };

/** The three-way provenance verdict this audit was commissioned to produce. */
export type ProvenanceVerdict =
  | "SAFE_PROVEN"
  | "AMBIGUOUS_PURGE_HISTORY"
  | "PURGE_PROVEN";

export type ShareLinkClassification =
  /** The only classification `--apply` writes. */
  | { kind: "RESTORABLE_AND_CURRENTLY_USABLE" }
  /** Restorable by provenance, but past `expiresAt`. Reported, not written. */
  | { kind: "RESTORABLE_BUT_EXPIRED" }
  /** Restorable by provenance, but `currentViews >= maxViews`. Not written. */
  | { kind: "RESTORABLE_BUT_VIEW_LIMIT_REACHED" }
  | { kind: "SKIPPED"; reason: ShareLinkSkipReason };

export type ReconcileShareLinkSummary = {
  mode: "apply" | "dry-run";
  /** `DISABLED` links examined. */
  examined: number;
  restorableAndCurrentlyUsable: number;
  restorableButExpired: number;
  restorableButViewLimitReached: number;
  /** Rows actually flipped `DISABLED -> ACTIVE`. Always 0 in dry-run. */
  reactivated: number;
  /**
   * The three-way provenance verdict, counted over every link that reached the
   * provenance stage. `--apply` can only ever write a `SAFE_PROVEN` link,
   * because the other two verdicts short-circuit to a skip.
   */
  provenance: Record<ProvenanceVerdict, number>;
  skipped: Record<ShareLinkSkipReason, number>;
  /** Ids of the links `--apply` would flip, or did. Never a credential. */
  reactivatedShareLinkIds: string[];
};

/** Shapes the classifier needs. Deliberately narrow - no credential fields. */
export type ReconcileMemberVideo = {
  id: string;
  status: VideoStatus;
  provider: VideoProvider;
  sourceType: VideoSourceType;
  providerAssetId: string | null;
  playbackId: string | null;
  playbackUrl: string | null;
  embedUrl: string | null;
  metadataJson: Prisma.JsonValue | null;
  binaryAsset: { mimeType: string; sizeBytes: bigint } | null;
  localFileAsset: { mimeType: string; sizeBytes: bigint } | null;
  websiteVideos: Array<{ websiteId: string; status: AssignmentStatus }>;
};

export type ReconcileShareLinkCandidate = {
  id: string;
  websiteId: string;
  status: ShareLinkStatus;
  expiresAt: Date | null;
  maxViews: number | null;
  currentViews: number;
  shareLinkVideos: Array<{
    sortOrder: number;
    video: ReconcileMemberVideo | null;
  }>;
};

function isNonEmpty(value: string | null): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function hasUsableAsset(
  asset: { mimeType: string; sizeBytes: bigint } | null,
): boolean {
  if (asset === null) return false;
  const sizeBytes = Number(asset.sizeBytes);

  return (
    String(asset.mimeType).startsWith("video/") &&
    Number.isFinite(sizeBytes) &&
    sizeBytes > 0
  );
}

/**
 * Mirrors the private `isPublicPlayableVideo()` predicate that
 * `AdminWebsitesService` and `PublicService` both apply, for the same five
 * source types and with the same asset requirements.
 *
 * It is a local copy rather than a shared import because extracting the service
 * predicate would mean editing the lifecycle services this sweep must not
 * touch. `test/share-link-status-reconcile.test.ts` pins the parity across all
 * five `VideoSourceType` values so the two cannot drift silently.
 *
 * The `status === READY` half is checked separately by the caller so a
 * not-ready member gets its own, more precise skip reason.
 */
export function hasPlayableAssetForSourceType(
  video: ReconcileMemberVideo,
): boolean {
  if (
    video.sourceType === VideoSourceType.UPLOAD ||
    video.sourceType === VideoSourceType.DIRECT_URL
  ) {
    return isNonEmpty(video.playbackUrl);
  }

  if (video.sourceType === VideoSourceType.EMBED) {
    return isNonEmpty(video.embedUrl);
  }

  if (video.sourceType === VideoSourceType.DB_BLOB) {
    return hasUsableAsset(video.binaryAsset);
  }

  if (video.sourceType === VideoSourceType.LOCAL_FILE) {
    return hasUsableAsset(video.localFileAsset);
  }

  return false;
}

/**
 * A Bunny member must be healthy in the LOCAL record. `status === READY` is not
 * sufficient on its own: reconciliation or an operator can leave a `READY` row
 * carrying an authoritative `metadataJson.bunnyStream.remoteMissing` marker, and
 * the public signing gate refuses such a row regardless of status. A malformed
 * Bunny EMBED shape is refused too, exactly as every other Bunny branch does.
 *
 * NO Bunny Management request is made. Remote existence is eventual-consistency
 * state owned by `yarn reconcile:bunny` and per-video sync; re-validating it
 * here would put an external service in the path of a local sweep.
 */
function isBunnyMemberLocallyHealthy(video: ReconcileMemberVideo): boolean {
  const classification = classifyBunnyVideoAsset(video);

  if (classification.kind === "not-bunny") {
    return true;
  }

  if (classification.kind === "bunny-malformed") {
    return false;
  }

  return !isBunnyRemoteMissing(video.metadataJson);
}

/**
 * Decides what one `DISABLED` link means. PURE - reads nothing, writes nothing.
 *
 * Skip order runs cheapest-and-most-specific first so the reported reason is
 * the most informative one, not merely the first that happens to match.
 */
/**
 * Reads `metadataJson.videoCount` out of one `SHARE_LINK_CREATE` row.
 *
 * Anything that is not a non-negative safe integer is MALFORMED rather than
 * assumed - a provenance check that guesses is not a provenance check.
 */
export function readRecordedVideoCount(metadataJson: unknown): number | null {
  if (typeof metadataJson !== "object" || metadataJson === null) {
    return null;
  }

  const raw = (metadataJson as Record<string, unknown>).videoCount;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    return null;
  }

  return raw;
}

/**
 * Resolves creation provenance for a batch of candidate links, using ONLY data
 * that historical production rows can already contain.
 *
 * Two independent sources, canonical first because it is structural rather than
 * observational:
 *
 *   1. `CanonicalVideoShareLink` - the link anchors a provenance record, so its
 *      video cannot have been purged (409 guard plus `onDelete: Restrict`).
 *   2. `SHARE_LINK_CREATE` - `metadataJson.videoCount` is the membership size at
 *      creation, present in every commit of this repository.
 *
 * Neither the new `SHARE_LINK_STATUS_RECONCILE` event nor the new
 * `reactivatedShareLinkCount` field is consulted: both postdate the damage and
 * would be worthless as historical evidence.
 *
 * A link with no surviving evidence resolves to `MISSING`, which fails closed.
 * `writeAudit()` on the creation path is best effort, so a missing row is a real
 * possibility and must never be read as "nothing happened".
 */
export async function resolveShareLinkProvenance(
  prisma: Pick<
    ReconcileShareLinkPrisma,
    "adminAuditLog" | "canonicalVideoShareLink"
  >,
  shareLinkIds: string[],
): Promise<Map<string, ShareLinkProvenance>> {
  const provenance = new Map<string, ShareLinkProvenance>();

  if (shareLinkIds.length === 0) {
    return provenance;
  }

  const canonicals = await prisma.canonicalVideoShareLink.findMany({
    where: { shareLinkId: { in: shareLinkIds } },
    select: { shareLinkId: true },
  });
  for (const canonical of canonicals) {
    provenance.set(canonical.shareLinkId, { kind: "CANONICAL" });
  }

  const creations = await prisma.adminAuditLog.findMany({
    where: {
      action: "SHARE_LINK_CREATE",
      entityType: "ShareLink",
      entityId: { in: shareLinkIds },
    },
    // Earliest first: a duplicated action could only mean a re-logged create,
    // and the original is the one that describes the membership as issued.
    orderBy: { createdAt: "asc" },
    select: { entityId: true, metadataJson: true },
  });

  for (const creation of creations) {
    const id = creation.entityId;
    if (id === null || provenance.has(id)) continue;

    const recordedVideoCount = readRecordedVideoCount(creation.metadataJson);
    provenance.set(
      id,
      recordedVideoCount === null
        ? { kind: "MALFORMED" }
        : { kind: "CREATED", recordedVideoCount },
    );
  }

  for (const id of shareLinkIds) {
    if (!provenance.has(id)) {
      provenance.set(id, { kind: "MISSING" });
    }
  }

  return provenance;
}

/**
 * Decides what surviving provenance says about ONE link's membership.
 *
 * This is the guard that closes the KI-021 residual. `MEMBERSHIP_GAP` can only
 * see a purge that left a hole in `sortOrder`; purging the HIGHEST-indexed
 * member leaves `{0..n-2}`, still contiguous and therefore invisible to it.
 * Comparing the surviving member count against the count recorded at creation
 * sees that case directly, because the only production path that deletes a
 * `ShareLinkVideo` row is `detachShareLinkVideosForVideo()`, called only from
 * `purgeVideo()`.
 */
function classifyMembershipProvenance(
  memberCount: number,
  provenance: ShareLinkProvenance,
): ShareLinkSkipReason | null {
  if (provenance.kind === "MISSING") {
    return "PROVENANCE_MISSING";
  }

  if (provenance.kind === "MALFORMED") {
    return "PROVENANCE_MALFORMED";
  }

  if (provenance.kind === "CANONICAL") {
    // A canonical link is created with exactly one member and its video cannot
    // be purged. Any other shape means this row is not what it claims to be.
    return memberCount === 1 ? null : "PROVENANCE_MALFORMED";
  }

  if (memberCount < provenance.recordedVideoCount) {
    return "MEMBERSHIP_SHRANK";
  }

  if (memberCount > provenance.recordedVideoCount) {
    // No path adds a member after creation, so this cannot be explained.
    return "PROVENANCE_MALFORMED";
  }

  return null;
}

export function classifyShareLink(
  link: ReconcileShareLinkCandidate,
  provenance: ShareLinkProvenance,
  now: Date,
): ShareLinkClassification {
  const members = link.shareLinkVideos;

  if (members.length === 0) {
    return { kind: "SKIPPED", reason: "NO_MEMBERS" };
  }

  const videos: ReconcileMemberVideo[] = [];
  for (const member of members) {
    if (member.video === null) {
      return { kind: "SKIPPED", reason: "MEMBER_MISSING" };
    }
    videos.push(member.video);
  }

  // A purge footprint. See the module header: creation always assigns 0..n-1
  // and nothing ever updates `sortOrder`, so a gap can only mean a deletion.
  const sortOrders = new Set(members.map((member) => member.sortOrder));
  const isContiguousFromZero =
    sortOrders.size === members.length &&
    [...sortOrders].every((value) => value >= 0 && value < members.length);
  if (!isContiguousFromZero) {
    return { kind: "SKIPPED", reason: "MEMBERSHIP_GAP" };
  }

  // Structural checks above need no audit data. This one does, and it is what
  // turns "no visible damage" into "provably no destructive membership change".
  const provenanceFinding = classifyMembershipProvenance(
    members.length,
    provenance,
  );
  if (provenanceFinding !== null) {
    return { kind: "SKIPPED", reason: provenanceFinding };
  }

  if (videos.some((video) => video.status !== VideoStatus.READY)) {
    return { kind: "SKIPPED", reason: "MEMBER_NOT_READY" };
  }

  if (videos.some((video) => !hasPlayableAssetForSourceType(video))) {
    return { kind: "SKIPPED", reason: "MEMBER_NOT_PLAYABLE" };
  }

  if (videos.some((video) => !isBunnyMemberLocallyHealthy(video))) {
    return { kind: "SKIPPED", reason: "MEMBER_BUNNY_REMOTE_MISSING" };
  }

  // The link's own website, read from the link. No cross-domain lookup and no
  // reassignment: this only asks whether the assignment the link was created
  // against is still ACTIVE.
  const isAssignedToLinkWebsite = (video: ReconcileMemberVideo): boolean =>
    video.websiteVideos.some(
      (assignment) =>
        assignment.websiteId === link.websiteId &&
        assignment.status === AssignmentStatus.ACTIVE,
    );
  if (videos.some((video) => !isAssignedToLinkWebsite(video))) {
    return { kind: "SKIPPED", reason: "MEMBER_NOT_ASSIGNED" };
  }

  // Provenance says restorable. Now classify CURRENT usability. Neither of the
  // next two is ever written - see the expiry/view-limit policy in the header.
  if (link.expiresAt !== null && link.expiresAt <= now) {
    return { kind: "RESTORABLE_BUT_EXPIRED" };
  }

  if (link.maxViews !== null && link.currentViews >= link.maxViews) {
    return { kind: "RESTORABLE_BUT_VIEW_LIMIT_REACHED" };
  }

  return { kind: "RESTORABLE_AND_CURRENTLY_USABLE" };
}

function emptySkipCounters(): Record<ShareLinkSkipReason, number> {
  return {
    NO_MEMBERS: 0,
    MEMBER_MISSING: 0,
    MEMBERSHIP_GAP: 0,
    MEMBER_NOT_READY: 0,
    MEMBER_NOT_PLAYABLE: 0,
    MEMBER_BUNNY_REMOTE_MISSING: 0,
    MEMBER_NOT_ASSIGNED: 0,
    MEMBERSHIP_SHRANK: 0,
    PROVENANCE_MISSING: 0,
    PROVENANCE_MALFORMED: 0,
  };
}

/**
 * Maps a skip reason onto the provenance verdict it represents, for reasons
 * that are provenance findings. Member-health skips are not provenance
 * findings - such a link is `SAFE_PROVEN` and merely not currently usable.
 */
const PROVENANCE_SKIP_VERDICT: Partial<
  Record<ShareLinkSkipReason, ProvenanceVerdict>
> = {
  MEMBERSHIP_GAP: "PURGE_PROVEN",
  MEMBERSHIP_SHRANK: "PURGE_PROVEN",
  PROVENANCE_MISSING: "AMBIGUOUS_PURGE_HISTORY",
  PROVENANCE_MALFORMED: "AMBIGUOUS_PURGE_HISTORY",
};

/**
 * `adminId` is null: this runs unattended, so attributing it to a person would
 * be a lie. The column is nullable for exactly that reason. No credential is
 * recorded - only the link id, the transition and the member count.
 */
async function writeReconcileAudit(
  prisma: Pick<PrismaClient, "adminAuditLog">,
  shareLinkId: string,
  memberCount: number,
): Promise<void> {
  try {
    await prisma.adminAuditLog.create({
      data: {
        adminId: null,
        action: SHARE_LINK_RECONCILE_ACTION,
        module: "admin-websites",
        entityType: "ShareLink",
        entityId: shareLinkId,
        status: AuditStatus.SUCCESS,
        metadataJson: {
          previousStatus: ShareLinkStatus.DISABLED,
          nextStatus: ShareLinkStatus.ACTIVE,
          memberCount,
          source: "reconcile-share-links",
        } as Prisma.InputJsonValue,
      },
    });
  } catch {
    // Audit is best effort; a failed log must not abort the sweep, exactly as
    // in `writeAudit()` on the video paths.
  }
}

/** The subset of the client this sweep is allowed to reach. */
export type ReconcileShareLinkPrisma = Pick<
  PrismaClient,
  "shareLink" | "adminAuditLog" | "canonicalVideoShareLink"
>;

export async function reconcileShareLinks(
  prisma: ReconcileShareLinkPrisma,
  options: ReconcileShareLinkOptions,
  now: Date = new Date(),
): Promise<ReconcileShareLinkSummary> {
  const summary: ReconcileShareLinkSummary = {
    mode: options.apply ? "apply" : "dry-run",
    examined: 0,
    restorableAndCurrentlyUsable: 0,
    restorableButExpired: 0,
    restorableButViewLimitReached: 0,
    reactivated: 0,
    provenance: {
      SAFE_PROVEN: 0,
      AMBIGUOUS_PURGE_HISTORY: 0,
      PURGE_PROVEN: 0,
    },
    skipped: emptySkipCounters(),
    reactivatedShareLinkIds: [],
  };

  let cursorId: string | undefined;

  for (let batch = 0; batch < options.maxBatches; batch += 1) {
    const links = (await prisma.shareLink.findMany({
      // ONLY `DISABLED`. `ACTIVE`, `REVOKED` and `EXPIRED` rows are never even
      // read, so they cannot be affected by a bug further down this function.
      where: {
        status: ShareLinkStatus.DISABLED,
        ...(cursorId === undefined ? {} : { id: { gt: cursorId } }),
      },
      orderBy: { id: "asc" },
      take: options.batchSize,
      // `alias` and `tokenHash` are deliberately NOT selected. They are bearer
      // credentials and this sweep has no use for them.
      select: {
        id: true,
        websiteId: true,
        status: true,
        expiresAt: true,
        maxViews: true,
        currentViews: true,
        shareLinkVideos: {
          select: {
            sortOrder: true,
            video: {
              select: {
                id: true,
                status: true,
                provider: true,
                sourceType: true,
                providerAssetId: true,
                playbackId: true,
                playbackUrl: true,
                embedUrl: true,
                metadataJson: true,
                binaryAsset: { select: { mimeType: true, sizeBytes: true } },
                localFileAsset: { select: { mimeType: true, sizeBytes: true } },
                websiteVideos: { select: { websiteId: true, status: true } },
              },
            },
          },
        },
      },
    })) as unknown as ReconcileShareLinkCandidate[];

    if (links.length === 0) break;
    cursorId = links[links.length - 1]?.id;

    // ONE provenance lookup per batch, over historical evidence only.
    const provenanceByShareLinkId = await resolveShareLinkProvenance(
      prisma,
      links.map((link) => link.id),
    );

    for (const link of links) {
      summary.examined += 1;
      const classification = classifyShareLink(
        link,
        provenanceByShareLinkId.get(link.id) ?? { kind: "MISSING" },
        now,
      );

      if (classification.kind === "SKIPPED") {
        summary.skipped[classification.reason] += 1;
        // Only provenance findings move a provenance counter. A member-health
        // skip leaves the link SAFE_PROVEN but not currently usable.
        const verdict = PROVENANCE_SKIP_VERDICT[classification.reason];
        if (verdict !== undefined) {
          summary.provenance[verdict] += 1;
        } else if (
          classification.reason !== "NO_MEMBERS" &&
          classification.reason !== "MEMBER_MISSING"
        ) {
          summary.provenance.SAFE_PROVEN += 1;
        }
        continue;
      }

      // Reaching here means the provenance gate passed.
      summary.provenance.SAFE_PROVEN += 1;

      if (classification.kind === "RESTORABLE_BUT_EXPIRED") {
        summary.restorableButExpired += 1;
        continue;
      }

      if (classification.kind === "RESTORABLE_BUT_VIEW_LIMIT_REACHED") {
        summary.restorableButViewLimitReached += 1;
        continue;
      }

      summary.restorableAndCurrentlyUsable += 1;

      if (!options.apply) {
        // DRY RUN PERFORMS ZERO WRITES. Not a conditional write, not a
        // rolled-back transaction - no write is issued at all.
        summary.reactivatedShareLinkIds.push(link.id);
        continue;
      }

      // TOCTOU: `status` is part of the WHERE, so a row that stopped being
      // DISABLED between the read and here is not touched and reports count 0.
      // This is also what makes a second `--apply` change zero rows.
      const result = await prisma.shareLink.updateMany({
        where: { id: link.id, status: ShareLinkStatus.DISABLED },
        data: { status: ShareLinkStatus.ACTIVE },
      });

      if (result.count === 1) {
        summary.reactivated += 1;
        summary.reactivatedShareLinkIds.push(link.id);
        await writeReconcileAudit(prisma, link.id, link.shareLinkVideos.length);
      }
    }
  }

  return summary;
}

const KNOWN_ARGUMENTS = [
  "--apply",
  "--batch-size=",
  "--max-batches=",
  "--confirm-env=",
];

export function parseReconcileShareLinkOptions(
  args: string[],
): ReconcileShareLinkOptions {
  const readInt = (
    name: string,
    fallback: number,
    min: number,
    max: number,
  ): number => {
    const raw = args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`--${name} must be ${min}-${max}.`);
    }

    return value;
  };

  if (
    args.some(
      (arg) =>
        !KNOWN_ARGUMENTS.some((known) =>
          known.endsWith("=") ? arg.startsWith(known) : arg === known,
        ),
    )
  ) {
    throw new Error("Unknown reconcile argument.");
  }

  return {
    apply: args.includes("--apply"),
    batchSize: readInt("batch-size", 100, 1, 500),
    maxBatches: readInt("max-batches", 50, 1, 500),
    confirmEnvironment: args
      .find((arg) => arg.startsWith("--confirm-env="))
      ?.split("=")[1],
  };
}

function createClient(): PrismaClient {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) throw new Error("DATABASE_URL is required.");
  const url = new URL(raw);

  return new PrismaClient({
    adapter: new PrismaMariaDb({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ""),
      connectionLimit: 1,
    }),
  });
}

async function run(): Promise<void> {
  const options = parseReconcileShareLinkOptions(process.argv.slice(2));
  loadApiEnv();

  const environment =
    process.env.APP_ENV?.trim() || process.env.NODE_ENV?.trim() || "unknown";
  if (
    options.apply &&
    (!options.confirmEnvironment || options.confirmEnvironment !== environment)
  ) {
    throw new Error(
      "--apply requires --confirm-env matching APP_ENV/NODE_ENV exactly.",
    );
  }

  const prisma = createClient();
  try {
    const summary = await reconcileShareLinks(prisma, options);
    console.info(
      JSON.stringify({
        ...summary,
        environment,
        batchSize: options.batchSize,
        maxBatches: options.maxBatches,
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  run().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Share-link status reconciliation failed.",
    );
    process.exitCode = 1;
  });
}

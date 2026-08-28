/**
 * Pure classification logic for the canonical share-link audit. Kept free of
 * Prisma so the rules are unit-testable. Never handles tokenHash or raw
 * tokens — callers must not select them.
 *
 * THE PREDICTION IS BINDING. `resolution` / `deterministicWinnerId` are
 * computed by the SAME `selectCanonicalHistoricalWinner()` the request path uses
 * (`src/admin-websites/utils/canonical-adoption-policy.util.ts`), not by a
 * second implementation of the same intent. An audit that told an operator a
 * different link would win than the code actually picks is worse than no audit.
 */
import {
  isDenyingShareLinkStatus,
  selectCanonicalHistoricalWinner,
  type CanonicalAdoptionCandidate,
  type CanonicalPinBlocker,
} from "../../src/admin-websites/utils/canonical-adoption-policy.util";

export type AuditShareLinkRow = {
  id: string;
  websiteId: string;
  alias: string | null;
  status: string;
  expiresAt: Date | null;
  maxViews: number | null;
  createdAt: Date;
  lastViewedAt: Date | null;
  currentViews: number;
  videoIds: string[];
  /** Set when this link already anchors SOME canonical mapping. */
  anchoredCanonicalPair?: { websiteId: string; videoId: string } | undefined;
};

export type PairClassification =
  | "NO_LINKS"
  | "SINGLE_CANDIDATE"
  | "DUPLICATE_ACTIVE_LINKS"
  | "ACTIVE_PLUS_REVOKED"
  | "REVOKED_ONLY"
  | "MULTI_VIDEO_ONLY";

/**
 * What `POST /admin/websites/:id/share-links` will do for this pair the next
 * time it is called — stated in advance, so an operator can review the whole
 * estate before anything runs.
 */
export type PairResolution =
  | "ALREADY_CANONICAL"
  /** The newest historical link is pinnable and ACTIVE — it will just work. */
  | "ADOPT_HISTORICAL"
  /**
   * The newest historical link is pinnable but REVOKED / DISABLED / EXPIRED.
   * It WILL become the pair's permanent identity and the request will then fail
   * closed. That is the intended outcome — the alternative is bypassing the
   * owner's restriction — but an operator should not meet it by surprise.
   */
  | "ADOPT_HISTORICAL_THEN_DENY"
  /** A structural fault blocks the pin. Nothing is written; see `pinBlocker`. */
  | "BLOCKED_OWNER_REVIEW"
  /** No history at all. The only case that mints. */
  | "MINT_NEW";

export type PairAuditResult = {
  websiteId: string;
  videoId: string;
  classification: PairClassification;
  activeSingleVideoLinkCount: number;
  revokedLinkCount: number;
  multiVideoLinkCount: number;
  linksWithLimits: number;
  linksMissingAlias: number;
  candidateLinkIds: string[];
  /** Every EXACT single-video link for the pair, whatever its status. */
  historicalCandidateCount: number;
  /** The newest link — the pair's identity — or null when it will mint. */
  deterministicWinnerId: string | null;
  /** The winner's status, so a pin-then-deny outcome is visible in advance. */
  deterministicWinnerStatus: string | null;
  /** Set when a structural fault stops the winner being pinned at all. */
  pinBlocker: CanonicalPinBlocker | null;
  resolution: PairResolution;
  /**
   * EXACT single-video links created AFTER the pair's mapping. Never adopted
   * and never a problem for correctness — canonical identity is pinned — but
   * worth an operator's eye, because each one is a second circulating URL for a
   * video that is supposed to have exactly one.
   */
  postCanonicalDuplicateCount: number;
};

export function mask(value: string | null | undefined): string {
  if (!value) {
    return "(none)";
  }
  return value.length <= 4
    ? `${value.slice(0, 1)}***`
    : `${value.slice(0, 4)}***`;
}

export function classifyPair(
  websiteId: string,
  videoId: string,
  links: AuditShareLinkRow[],
  options: {
    /** The mapping that already pins this pair, when one exists. */
    canonical?: { shareLinkId: string; createdAt: Date } | undefined;
  } = {},
): PairAuditResult {
  const relevant = links.filter(
    (link) => link.websiteId === websiteId && link.videoIds.includes(videoId),
  );
  const singleVideo = relevant.filter((link) => link.videoIds.length === 1);
  const activeSingle = singleVideo.filter((link) => link.status === "ACTIVE");
  const revoked = relevant.filter((link) => link.status === "REVOKED");
  const multiVideo = relevant.filter((link) => link.videoIds.length > 1);

  let classification: PairClassification;
  if (relevant.length === 0) {
    classification = "NO_LINKS";
  } else if (activeSingle.length === 1) {
    classification =
      revoked.length > 0 ? "ACTIVE_PLUS_REVOKED" : "SINGLE_CANDIDATE";
  } else if (activeSingle.length > 1) {
    classification = "DUPLICATE_ACTIVE_LINKS";
  } else if (multiVideo.length > 0 && singleVideo.length === 0) {
    classification = "MULTI_VIDEO_ONLY";
  } else {
    classification = "REVOKED_ONLY";
  }

  // The request path's candidate set, reproduced exactly: EXACT single-video
  // membership and NOTHING ELSE removed. No status filter and no
  // already-anchored filter — filtering either out here would make this report
  // name an older link than the code will actually pick.
  const candidates: CanonicalAdoptionCandidate[] = singleVideo.map((link) => ({
    id: link.id,
    alias: link.alias,
    status: link.status,
    expiresAt: link.expiresAt,
    maxViews: link.maxViews,
    createdAt: link.createdAt,
    anchoredPair: link.anchoredCanonicalPair ?? null,
  }));

  const selection = selectCanonicalHistoricalWinner(candidates, {
    websiteId,
    videoId,
  });
  const canonical = options.canonical;

  const resolution: PairResolution =
    canonical !== undefined
      ? "ALREADY_CANONICAL"
      : selection.winner === null
        ? "MINT_NEW"
        : selection.pinBlocker !== null
          ? "BLOCKED_OWNER_REVIEW"
          : isDenyingShareLinkStatus(selection.winner.status)
            ? "ADOPT_HISTORICAL_THEN_DENY"
            : "ADOPT_HISTORICAL";

  return {
    websiteId,
    videoId,
    classification,
    activeSingleVideoLinkCount: activeSingle.length,
    revokedLinkCount: revoked.length,
    multiVideoLinkCount: multiVideo.length,
    linksWithLimits: relevant.filter(
      (link) => link.expiresAt !== null || link.maxViews !== null,
    ).length,
    linksMissingAlias: relevant.filter((link) => link.alias === null).length,
    candidateLinkIds: activeSingle.map((link) => link.id),
    historicalCandidateCount: selection.historicalCandidateCount,
    deterministicWinnerId:
      canonical !== undefined
        ? canonical.shareLinkId
        : (selection.winner?.id ?? null),
    deterministicWinnerStatus:
      canonical !== undefined ? null : (selection.winner?.status ?? null),
    pinBlocker: canonical !== undefined ? null : selection.pinBlocker,
    resolution,
    postCanonicalDuplicateCount:
      canonical === undefined
        ? 0
        : singleVideo.filter(
            (link) =>
              link.id !== canonical.shareLinkId &&
              link.createdAt.getTime() > canonical.createdAt.getTime(),
          ).length,
  };
}

export function summarize(results: PairAuditResult[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const result of results) {
    summary[result.classification] = (summary[result.classification] ?? 0) + 1;
  }
  return summary;
}

/** Counts by predicted resolution — the number an operator actually plans on. */
export function summarizeResolutions(
  results: PairAuditResult[],
): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const result of results) {
    summary[result.resolution] = (summary[result.resolution] ?? 0) + 1;
  }
  return summary;
}

/* ------------------------------------------------------------------ *
 * EXISTING CanonicalVideoShareLink ROWS
 *
 * Everything above answers "what will the request path DO next?". This block
 * answers a different question: "what did the PREVIOUS implementation already
 * write, and is any of it unusable?"
 *
 * It is READ-ONLY CLASSIFICATION. Nothing here repoints, repairs or removes a
 * mapping — canonical identity is provenance, and moving it is an explicit
 * owner decision made after a backup, never a side effect of running an audit.
 * ------------------------------------------------------------------ */

/**
 * A fault in a mapping that ALREADY EXISTS.
 *
 * Ordered by how badly it breaks the pair, because only the first is reported
 * per mapping:
 *
 * - `ALIAS_MISSING` — the anchored link has no usable alias, so
 *   `buildCanonicalReviewUrl()` throws while building the response. The pair has
 *   no resolvable canonical URL and no HTTP path can give it one. This is the
 *   residue of the defect fixed on 2026-08-28 (KI-022).
 * - `WEBSITE_MISMATCH` / `MEMBERSHIP_MISMATCH` — the anchored link does not
 *   belong to the mapped website, or its `ShareLinkVideo` membership is not
 *   exactly the mapped video. Either means the mapping points at a link that
 *   cannot legitimately represent the pair; a membership of `[A, B]` anchored
 *   for A would publish B to everyone following A's canonical URL.
 * - `SHARE_LINK_MISSING` — the anchored link row is absent. All four relations
 *   are `onDelete: Restrict`, so this should be impossible and indicates a
 *   restore or a direct SQL edit.
 * - `HAS_EXPIRY` / `HAS_MAX_VIEWS` — the anchored link carries a legacy access
 *   control the canonical contract cannot represent. Public resolution still
 *   enforces both, so nothing is bypassed; what is wrong is that the admin side
 *   reports a "permanent" URL that will stop working.
 * - `STATUS_NOT_ACTIVE` — reported for completeness, and deliberately LAST. It
 *   is **not a fault**: pinning a revoked or disabled link is the intended
 *   separation of identity from usability. It is surfaced only so an operator
 *   investigating a `409` can see the cause without opening the database.
 */
export type ExistingCanonicalFinding =
  | "ALIAS_MISSING"
  | "WEBSITE_MISMATCH"
  | "MEMBERSHIP_MISMATCH"
  | "SHARE_LINK_MISSING"
  | "HAS_EXPIRY"
  | "HAS_MAX_VIEWS"
  | "STATUS_NOT_ACTIVE";

export type ExistingCanonicalAudit = {
  websiteId: string;
  videoId: string;
  shareLinkId: string;
  /** Null when the mapping is healthy AND its link is ACTIVE. */
  finding: ExistingCanonicalFinding | null;
  /**
   * True when the pair has no resolvable canonical URL and no HTTP path can
   * give it one. These are the rows an operator must remediate by hand.
   */
  unresolvable: boolean;
};

/**
 * Classifies one existing mapping against the share-link rows already loaded.
 *
 * `links` is the same masked, tokenHash-free row set the rest of this module
 * uses; nothing additional is read and no credential is touched.
 */
export function classifyExistingCanonical(
  mapping: { websiteId: string; videoId: string; shareLinkId: string },
  links: AuditShareLinkRow[],
): ExistingCanonicalAudit {
  const base = {
    websiteId: mapping.websiteId,
    videoId: mapping.videoId,
    shareLinkId: mapping.shareLinkId,
  };
  const link = links.find((row) => row.id === mapping.shareLinkId);

  if (link === undefined) {
    return { ...base, finding: "SHARE_LINK_MISSING", unresolvable: true };
  }
  if (link.alias === null || link.alias.trim() === "") {
    return { ...base, finding: "ALIAS_MISSING", unresolvable: true };
  }
  if (link.websiteId !== mapping.websiteId) {
    return { ...base, finding: "WEBSITE_MISMATCH", unresolvable: true };
  }
  if (link.videoIds.length !== 1 || link.videoIds[0] !== mapping.videoId) {
    return { ...base, finding: "MEMBERSHIP_MISMATCH", unresolvable: true };
  }
  if (link.expiresAt !== null) {
    return { ...base, finding: "HAS_EXPIRY", unresolvable: false };
  }
  if (link.maxViews !== null) {
    return { ...base, finding: "HAS_MAX_VIEWS", unresolvable: false };
  }
  if (link.status !== "ACTIVE") {
    // Intended behaviour, not a fault. Reported so a 409 is diagnosable.
    return { ...base, finding: "STATUS_NOT_ACTIVE", unresolvable: false };
  }

  return { ...base, finding: null, unresolvable: false };
}

/** Counts by finding, for the summary line. */
export function summarizeExistingCanonical(
  results: ExistingCanonicalAudit[],
): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const result of results) {
    const key = result.finding ?? "HEALTHY";
    summary[key] = (summary[key] ?? 0) + 1;
  }
  return summary;
}

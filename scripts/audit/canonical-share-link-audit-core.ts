/**
 * Pure classification logic for the canonical share-link audit. Kept free of
 * Prisma so the rules are unit-testable. Never handles tokenHash or raw
 * tokens — callers must not select them.
 */

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
};

export type PairClassification =
  | "NO_LINKS"
  | "SINGLE_CANDIDATE"
  | "DUPLICATE_ACTIVE_LINKS"
  | "ACTIVE_PLUS_REVOKED"
  | "REVOKED_ONLY"
  | "MULTI_VIDEO_ONLY";

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
  };
}

export function summarize(results: PairAuditResult[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const result of results) {
    summary[result.classification] = (summary[result.classification] ?? 0) + 1;
  }
  return summary;
}

export type AssignmentAuditStatus = "ACTIVE" | "DISABLED";

export type ShareLinkAuditInput = {
  id: string;
  alias: string | null;
  status: string;
  expiresAt: Date | null;
  website: {
    id: string;
    status: string;
    activeDomainCount: number;
  };
  videos: Array<{
    id: string;
    status: string;
    sourceType: string;
    playbackUrlPresent: boolean;
    embedUrlPresent: boolean;
    binaryAssetPlayable: boolean;
    localFileAssetPlayable: boolean;
    assignments: Array<{
      websiteId: string;
      status: AssignmentAuditStatus;
    }>;
  }>;
};

export type RemediationRecommendation =
  | "REVIEW — likely create/activate assignment"
  | "REVIEW — likely revoke link"
  | "REVIEW — likely remove video from link"
  | "REVIEW — local/test fixture only"
  | "NO ACTION"
  | "INSUFFICIENT EVIDENCE";

export type ShareLinkAuditCase = {
  caseLabel: string;
  website: string;
  shareLinkStatus: string;
  videoStatus: string;
  sameSiteAssignment: AssignmentAuditStatus | "MISSING";
  otherSiteAssignment: string;
  currentImpact: string;
  recommendation: RemediationRecommendation;
  confidence: "High" | "Medium" | "Low";
};

export type ShareLinkAuditResult = {
  counts: {
    shareLinks: number;
    shareLinkVideoRows: number;
    missingSameSiteAssignments: number;
    inactiveSameSiteAssignments: number;
    onlyOtherSiteAssignments: number;
    activeLinksWithoutPlayableAssignedVideos: number;
    activeLinksWithPartialValidity: number;
    disabledOrExpiredContextRows: number;
    nonPlayableVideoRows: number;
    affectedActiveLinks: number;
  };
  cases: ShareLinkAuditCase[];
};

export function maskIdentifier(value: string): string {
  return value.slice(0, 8);
}

export function maskAlias(value: string | null): string {
  if (!value) {
    return "none";
  }

  if (value.length <= 5) {
    return `${value.slice(0, 1)}***${value.slice(-1)}`;
  }

  return `${value.slice(0, 3)}***${value.slice(-2)}`;
}

export function isAuditVideoPlayable(
  video: ShareLinkAuditInput["videos"][number],
): boolean {
  if (video.status !== "READY") {
    return false;
  }

  if (video.sourceType === "EMBED") {
    return video.embedUrlPresent;
  }

  if (video.sourceType === "DB_BLOB") {
    return video.binaryAssetPlayable;
  }

  if (video.sourceType === "LOCAL_FILE") {
    return video.localFileAssetPlayable;
  }

  return video.playbackUrlPresent;
}

export function analyzeShareLinkAssignments(
  links: ShareLinkAuditInput[],
  now: Date,
): ShareLinkAuditResult {
  let shareLinkVideoRows = 0;
  let missingSameSiteAssignments = 0;
  let inactiveSameSiteAssignments = 0;
  let onlyOtherSiteAssignments = 0;
  let activeLinksWithoutPlayableAssignedVideos = 0;
  let activeLinksWithPartialValidity = 0;
  let disabledOrExpiredContextRows = 0;
  let nonPlayableVideoRows = 0;
  const affectedActiveLinkIds = new Set<string>();
  const cases: ShareLinkAuditCase[] = [];

  for (const link of links) {
    const isExpired = link.expiresAt !== null && link.expiresAt <= now;
    const isActiveLink = link.status === "ACTIVE" && !isExpired;
    let validVideoCount = 0;

    for (const video of link.videos) {
      shareLinkVideoRows += 1;
      const sameSiteAssignment = video.assignments.find(
        (assignment) => assignment.websiteId === link.website.id,
      );
      const otherSiteAssignments = video.assignments.filter(
        (assignment) => assignment.websiteId !== link.website.id,
      );
      const playable = isAuditVideoPlayable(video);
      const contextEnabled =
        link.status === "ACTIVE" &&
        !isExpired &&
        link.website.status === "ACTIVE" &&
        link.website.activeDomainCount > 0;
      const isValid =
        contextEnabled && sameSiteAssignment?.status === "ACTIVE" && playable;

      if (isValid) {
        validVideoCount += 1;
      }

      if (!sameSiteAssignment) {
        missingSameSiteAssignments += 1;
        if (otherSiteAssignments.length > 0) {
          onlyOtherSiteAssignments += 1;
        }
      } else if (sameSiteAssignment.status !== "ACTIVE") {
        inactiveSameSiteAssignments += 1;
      }

      if (!playable) {
        nonPlayableVideoRows += 1;
      }

      if (!contextEnabled) {
        disabledOrExpiredContextRows += 1;
      }

      if (isActiveLink && !isValid) {
        affectedActiveLinkIds.add(link.id);
      }

      if (isValid) {
        continue;
      }

      const recommendation = getRecommendation({
        linkStatus: link.status,
        isExpired,
        websiteStatus: link.website.status,
        activeDomainCount: link.website.activeDomainCount,
        sameSiteAssignment: sameSiteAssignment?.status ?? "MISSING",
        otherSiteAssignmentCount: otherSiteAssignments.length,
        playable,
      });

      cases.push({
        caseLabel: `link ${maskIdentifier(link.id)} (${maskAlias(link.alias)}) / video ${maskIdentifier(video.id)}`,
        website: maskIdentifier(link.website.id),
        shareLinkStatus: [
          link.status,
          isExpired ? "expired" : "not expired",
          `website ${link.website.status}`,
          `${link.website.activeDomainCount} active domain(s)`,
        ].join("; "),
        videoStatus: `${video.status}; ${video.sourceType}; ${playable ? "playable" : "not playable"}`,
        sameSiteAssignment: sameSiteAssignment?.status ?? "MISSING",
        otherSiteAssignment:
          otherSiteAssignments.length === 0
            ? "none"
            : otherSiteAssignments
                .map((assignment) => assignment.status)
                .join(", "),
        currentImpact: isActiveLink
          ? "Video is excluded by the hardened policy; link validity depends on its remaining valid videos."
          : "No current public access from this inactive or expired link, but the stale relation remains.",
        recommendation,
        confidence:
          recommendation === "INSUFFICIENT EVIDENCE" ? "Low" : "Medium",
      });
    }

    if (isActiveLink && validVideoCount === 0) {
      activeLinksWithoutPlayableAssignedVideos += 1;
    } else if (
      isActiveLink &&
      validVideoCount > 0 &&
      validVideoCount < link.videos.length
    ) {
      activeLinksWithPartialValidity += 1;
    }
  }

  return {
    counts: {
      shareLinks: links.length,
      shareLinkVideoRows,
      missingSameSiteAssignments,
      inactiveSameSiteAssignments,
      onlyOtherSiteAssignments,
      activeLinksWithoutPlayableAssignedVideos,
      activeLinksWithPartialValidity,
      disabledOrExpiredContextRows,
      nonPlayableVideoRows,
      affectedActiveLinks: affectedActiveLinkIds.size,
    },
    cases,
  };
}

function getRecommendation(input: {
  linkStatus: string;
  isExpired: boolean;
  websiteStatus: string;
  activeDomainCount: number;
  sameSiteAssignment: AssignmentAuditStatus | "MISSING";
  otherSiteAssignmentCount: number;
  playable: boolean;
}): RemediationRecommendation {
  if (input.linkStatus !== "ACTIVE" || input.isExpired) {
    return "NO ACTION";
  }

  if (input.websiteStatus !== "ACTIVE" || input.activeDomainCount === 0) {
    return "REVIEW — likely revoke link";
  }

  if (!input.playable) {
    return "REVIEW — likely remove video from link";
  }

  if (
    input.sameSiteAssignment === "MISSING" &&
    input.otherSiteAssignmentCount > 0
  ) {
    return "INSUFFICIENT EVIDENCE";
  }

  if (input.sameSiteAssignment !== "ACTIVE") {
    return "REVIEW — likely create/activate assignment";
  }

  return "NO ACTION";
}

export function formatAuditCounts(result: ShareLinkAuditResult): string {
  return Object.entries(result.counts)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

export function formatAuditWorksheet(result: ShareLinkAuditResult): string {
  const header =
    "| Case | Website | Share-link status | Video status | Same-site assignment | Other-site assignment | Current impact | Recommended owner decision | Confidence |";
  const separator =
    "| ---- | ------- | ----------------- | ------------ | -------------------- | --------------------- | -------------- | -------------------------- | ---------- |";
  const rows = result.cases.map((item) =>
    [
      item.caseLabel,
      item.website,
      item.shareLinkStatus,
      item.videoStatus,
      item.sameSiteAssignment,
      item.otherSiteAssignment,
      item.currentImpact,
      item.recommendation,
      item.confidence,
    ]
      .map((value) => String(value).replaceAll("|", "\\|"))
      .join(" | "),
  );

  return [header, separator, ...rows.map((row) => `| ${row} |`)].join("\n");
}

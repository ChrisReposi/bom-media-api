/**
 * PC-D01 production impact audit — READ ONLY.
 *
 * PC-D01 is a CONFIRMED CURRENT BUG in the PUBLIC CLIENT, not in this backend.
 * `public_website/assets/app.js` -> `isForbiddenMediaUrl()` rejects any URL
 * containing an `upload` path segment. Every Cloudinary delivery URL contains
 * `/video/upload/`, so `buildApiResourceUrl()` returns "" and the viewer sees
 * "This video does not have a protected playback URL." The Cloudinary
 * thumbnail is rejected by the same predicate, so there is no poster either.
 *
 * THIS SCRIPT DOES NOT FIX ANYTHING. It counts how many current share links may
 * be affected so a human can judge urgency.
 *
 * ── TWO PASSES ──────────────────────────────────────────────────────────────
 *
 *   PASS A — THE ORIGINAL PC-D01 TICKET SUBSET.
 *            Scope: VideoAsset.sourceType = UPLOAD.
 *            This is the set the ticket named. It is a SUBSET of the real
 *            impact and must not be reported as the blast radius.
 *
 *   PASS B — THE AUTHORITATIVE BLAST RADIUS.
 *            Scope: every video whose `playbackUrl` the CURRENT public client
 *            would reject, restricted to the source types whose public
 *            playback actually flows through that guard.
 *
 *            Includes:  CLOUDINARY UPLOAD (secure_url)
 *                       CLOUDINARY DIRECT_URL using /video/upload/
 *                       any other DIRECT_URL matching the same predicate
 *            Excludes:  EMBED — `isEmbedVideo()` short-circuits to the iframe
 *                       branch and `resolveProtectedPlaybackUrl()` returns ""
 *                       for embeds, so an embed URL never reaches the guard.
 *                       DB_BLOB / LOCAL_FILE — `toPublicVideoResponses()`
 *                       emits `playbackUrl: null` for these, so whatever the
 *                       column holds is never seen by the client.
 *
 *            REPORT PASS B AS THE IMPACT FIGURE.
 *
 * ── READ-ONLY GUARANTEE ─────────────────────────────────────────────────────
 *
 *   The only executable database operations in this file are
 *   `prisma.videoAsset.findMany` and `prisma.$disconnect`. There is no
 *   create / createMany / update / updateMany / delete / deleteMany / upsert,
 *   no $executeRaw, no $queryRaw and no $transaction.
 *
 * ── PRIVACY ─────────────────────────────────────────────────────────────────
 *
 *   Default output is aggregate counts only. It never prints a rawToken,
 *   tokenHash, alias, domain hostname, website name, playbackUrl,
 *   thumbnailUrl, Cloudinary secure_url, DATABASE_URL, video title, secret or
 *   password.
 *
 *   URL columns are read solely to evaluate a boolean predicate; only the
 *   boolean is reported. The Website/WebsiteDomain relation is traversed for
 *   reachability only — the domain STRING is never selected, only a row id,
 *   and even that is never printed.
 *
 *   `--ids` additionally prints internal identifiers only — videoId,
 *   shareLinkId, websiteId — truncated to 8 characters. Off by default.
 *   DO NOT USE `--ids` ON THE FIRST PRODUCTION RUN. Run aggregate-only first;
 *   request identifiers later, and only if Level 5 > 0 and remediation
 *   genuinely needs to locate specific records.
 *
 * ── MULTI-CUSTOMER ──────────────────────────────────────────────────────────
 *
 *   Each customer has an independent database. This script reads exactly one
 *   DATABASE_URL per invocation, holds nothing across invocations, and never
 *   writes results anywhere. Run it once per customer. Never merge two
 *   customers' output into a database.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *
 *   DATABASE_URL comes from the operator's shell or secret manager. It is never
 *   defined here and never printed.
 *
 *     tsx scripts/audit/pc-d01-cloudinary-upload-audit.ts          <- first run
 *     tsx scripts/audit/pc-d01-cloudinary-upload-audit.ts --json
 *     tsx scripts/audit/pc-d01-cloudinary-upload-audit.ts --ids    <- later only
 */
import { createHash } from "node:crypto";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../../src/generated/prisma/client";
import {
  AssignmentStatus,
  DomainStatus,
  ShareLinkStatus,
  VideoProvider,
  VideoSourceType,
  VideoStatus,
  WebsiteStatus,
} from "../../src/generated/prisma/enums";

const READ_BATCH_SIZE = 200;
const ID_SAMPLE_LIMIT = 50;

/**
 * Copied verbatim from public_website/assets/app.js `isForbiddenMediaUrl()`
 * (the forbidden-path-segment branch, line ~1081 as of 2026-08-22).
 *
 * Embedded rather than imported because this script runs on a backend host
 * that does not have the public repository checked out.
 *
 * >> PASS B IS VALID ONLY WHEN THIS PREDICATE MATCHES THE DEPLOYED PUBLIC
 * >> WEBSITE'S isForbiddenMediaUrl() BEHAVIOUR.
 *
 * The pattern and a short fingerprint of it are printed on every run so a
 * reviewer can diff them against the deployed bundle before trusting Pass B.
 * Pass A's Levels 1-4 do not depend on it.
 */
const PUBLIC_FORBIDDEN_SEGMENT_PATTERN =
  /(?:^|\/)(?:admin|private|manage|management|upload|uploads|dashboard|settings|auth|login)(?:\/|$)/i;

/** Short, stable fingerprint of the embedded predicate, for drift review. */
const PUBLIC_PREDICATE_FINGERPRINT = createHash("sha256")
  .update(PUBLIC_FORBIDDEN_SEGMENT_PATTERN.source)
  .digest("hex")
  .slice(0, 16);

/** True when the CURRENT public client would refuse to use this URL. */
function publicClientWouldRejectUrl(url: string | null): boolean {
  if (url === null) return false;
  const trimmed = url.trim();
  if (trimmed === "") return false;
  return PUBLIC_FORBIDDEN_SEGMENT_PATTERN.test(trimmed.toLowerCase());
}

function requireDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) {
    // The value itself is never echoed.
    throw new Error("DATABASE_URL is required for the read-only audit.");
  }
  return value;
}

function createAuditClient(databaseUrl: string): PrismaClient {
  const url = new URL(databaseUrl);

  return new PrismaClient({
    adapter: new PrismaMariaDb({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ""),
      connectionLimit: 2,
    }),
  });
}

/** Never print a full identifier. */
function mask(value: string): string {
  return value.slice(0, 8);
}

export type AuditVideo = {
  id: string;
  provider: VideoProvider;
  sourceType: VideoSourceType;
  status: VideoStatus;
  playbackUrl: string | null;
  thumbnailUrl: string | null;
  websiteVideos: { websiteId: string; status: AssignmentStatus }[];
  shareLinkVideos: {
    shareLink: {
      id: string;
      websiteId: string;
      status: ShareLinkStatus;
      expiresAt: Date | null;
      maxViews: number | null;
      currentViews: number;
      website: {
        id: string;
        status: WebsiteStatus;
        /**
         * Pre-filtered to ACTIVE and capped at one row. Only the row id is
         * selected — the `domain` hostname is never read. Presence is the
         * only thing this is used for, so multiple ACTIVE domains on one
         * website cannot inflate any count.
         */
        domains: { id: string }[];
      } | null;
    };
  }[];
};

type ShareLinkRow = AuditVideo["shareLinkVideos"][number]["shareLink"];

/**
 * Whether a share link could admit a viewer right now.
 *
 * Mirrors the prerequisites `PublicService.resolvePublicWatch()` applies that
 * are checkable from these already-read relational records, with no credential
 * and no network call:
 *
 *   public.service.ts:207-226   domain row ACTIVE **and** its Website ACTIVE
 *   public.service.ts (policy)  ShareLink ACTIVE, not past expiresAt,
 *                               currentViews < maxViews
 *
 * Not checkable here, and therefore NOT claimed:
 *   - host normalisation (needs an actual request host)
 *   - credential match by alias or peppered tokenHash (needs the credential)
 */
function isPotentiallyUsableNow(link: ShareLinkRow, now: Date): boolean {
  if (link.status !== ShareLinkStatus.ACTIVE) return false;
  if (link.expiresAt !== null && link.expiresAt.getTime() <= now.getTime()) {
    return false;
  }
  if (link.maxViews !== null && link.currentViews >= link.maxViews) {
    return false;
  }
  // FIX 1 — the ShareLink's Website must be ACTIVE.
  if (link.website === null) return false;
  if (link.website.status !== WebsiteStatus.ACTIVE) return false;
  // FIX 2 — that same Website must have at least one ACTIVE WebsiteDomain,
  // otherwise no host can ever resolve to it.
  if (link.website.domains.length === 0) return false;
  return true;
}

/**
 * The remaining public prerequisite that IS checkable from the rows already
 * read: `isPublicPlayableVideo()` (public.service.ts:804) requires, for every
 * source type other than EMBED / DB_BLOB / LOCAL_FILE, a non-empty
 * `playbackUrl`. Both passes deal only with UPLOAD and DIRECT_URL, so this is
 * the whole of the "usable asset" condition for them.
 *
 * Reported as a refinement of Level 5 rather than folded into it, because the
 * agreed Level definitions are fixed.
 */
function wouldBePubliclyListable(video: AuditVideo): boolean {
  return video.playbackUrl !== null && video.playbackUrl.trim() !== "";
}

export type AuditAccumulator = {
  level1Videos: number;
  level2ReadyVideos: number;
  level3VideosWithActiveAssignment: number;
  level4VideosOnActiveShare: number;
  level5VideosOnUsableShare: number;
  /** Level 5 rows excluded solely by the Website/domain reachability gate. */
  level5ExcludedByWebsiteReachability: number;
  /** Level 5 rows that would also survive isPublicPlayableVideo(). */
  level5PubliclyListable: number;
  level5WithRejectedPlaybackUrl: number;
  level5MissingPlaybackUrl: number;
  playbackUrlRejected: number;
  thumbnailUrlRejected: number;
  providerBreakdown: Record<string, number>;
  sourceTypeBreakdown: Record<string, number>;
  statusBreakdown: Record<string, number>;
  /** Deduplicating sets — one video with three assignments counts once. */
  activeAssignmentKeys: Set<string>;
  activeShareLinkIds: Set<string>;
  usableShareLinkIds: Set<string>;
  affectedWebsiteIds: Set<string>;
  level5VideoIds: Set<string>;
};

export function createAccumulator(): AuditAccumulator {
  return {
    level1Videos: 0,
    level2ReadyVideos: 0,
    level3VideosWithActiveAssignment: 0,
    level4VideosOnActiveShare: 0,
    level5VideosOnUsableShare: 0,
    level5ExcludedByWebsiteReachability: 0,
    level5PubliclyListable: 0,
    level5WithRejectedPlaybackUrl: 0,
    level5MissingPlaybackUrl: 0,
    playbackUrlRejected: 0,
    thumbnailUrlRejected: 0,
    providerBreakdown: {},
    sourceTypeBreakdown: {},
    statusBreakdown: {},
    activeAssignmentKeys: new Set(),
    activeShareLinkIds: new Set(),
    usableShareLinkIds: new Set(),
    affectedWebsiteIds: new Set(),
    level5VideoIds: new Set(),
  };
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

/**
 * The LEVEL 1 -> 5 walk. Pure: no I/O, so it is unit-testable with synthetic
 * rows. Accumulating into shared Sets is what makes the deduplication correct
 * across pagination batches.
 */
export function accumulateVideos(
  accumulator: AuditAccumulator,
  videos: AuditVideo[],
  now: Date,
): void {
  for (const video of videos) {
    // LEVEL 1 — the caller has already applied the scope filter.
    accumulator.level1Videos += 1;
    bump(accumulator.providerBreakdown, video.provider);
    bump(accumulator.sourceTypeBreakdown, video.sourceType);
    bump(accumulator.statusBreakdown, video.status);

    if (publicClientWouldRejectUrl(video.playbackUrl)) {
      accumulator.playbackUrlRejected += 1;
    }
    if (publicClientWouldRejectUrl(video.thumbnailUrl)) {
      accumulator.thumbnailUrlRejected += 1;
    }

    // LEVEL 2 — READY. isPublicPlayableVideo() gates on this before anything
    // else.
    if (video.status !== VideoStatus.READY) continue;
    accumulator.level2ReadyVideos += 1;

    // LEVEL 3 — at least one ACTIVE WebsiteVideo assignment.
    const activeAssignments = video.websiteVideos.filter(
      (assignment) => assignment.status === AssignmentStatus.ACTIVE,
    );
    if (activeAssignments.length === 0) continue;
    accumulator.level3VideosWithActiveAssignment += 1;
    for (const assignment of activeAssignments) {
      accumulator.activeAssignmentKeys.add(
        `${assignment.websiteId}:${video.id}`,
      );
    }
    const activeWebsiteIds = new Set(
      activeAssignments.map((assignment) => assignment.websiteId),
    );

    // LEVEL 4 — reachable through an ACTIVE ShareLink.
    //
    // The share link must belong to a website the video is ACTIVELY assigned
    // to. public.service.ts resolves the share link within the website
    // resolved from the request host AND intersects ShareLinkVideo with an
    // ACTIVE WebsiteVideo for that same website, so a share link on another
    // website cannot surface this video.
    const reachableLinks = video.shareLinkVideos
      .map((membership) => membership.shareLink)
      .filter(
        (link) =>
          link.status === ShareLinkStatus.ACTIVE &&
          activeWebsiteIds.has(link.websiteId),
      );
    if (reachableLinks.length === 0) continue;
    accumulator.level4VideosOnActiveShare += 1;
    for (const link of reachableLinks) {
      accumulator.activeShareLinkIds.add(link.id);
    }

    // LEVEL 5 — that share link could admit a viewer right now, and its
    // website is publicly reachable.
    const usableLinks = reachableLinks.filter((link) =>
      isPotentiallyUsableNow(link, now),
    );

    if (usableLinks.length === 0) {
      // Distinguish "excluded by the new reachability gate" from "excluded by
      // status / expiry / budget", so the tightening is visible in the report.
      const blockedOnlyByReachability = reachableLinks.some(
        (link) =>
          link.status === ShareLinkStatus.ACTIVE &&
          (link.expiresAt === null ||
            link.expiresAt.getTime() > now.getTime()) &&
          (link.maxViews === null || link.currentViews < link.maxViews) &&
          (link.website === null ||
            link.website.status !== WebsiteStatus.ACTIVE ||
            link.website.domains.length === 0),
      );
      if (blockedOnlyByReachability) {
        accumulator.level5ExcludedByWebsiteReachability += 1;
      }
      continue;
    }

    accumulator.level5VideosOnUsableShare += 1;
    accumulator.level5VideoIds.add(video.id);
    for (const link of usableLinks) {
      accumulator.usableShareLinkIds.add(link.id);
      accumulator.affectedWebsiteIds.add(link.websiteId);
    }

    if (wouldBePubliclyListable(video)) {
      accumulator.level5PubliclyListable += 1;
    }
    if (publicClientWouldRejectUrl(video.playbackUrl)) {
      accumulator.level5WithRejectedPlaybackUrl += 1;
    }
    if (video.playbackUrl === null || video.playbackUrl.trim() === "") {
      accumulator.level5MissingPlaybackUrl += 1;
    }
  }
}

const AUDIT_SELECT = {
  id: true,
  provider: true,
  sourceType: true,
  status: true,
  // Read solely to evaluate the public client's URL predicate.
  // NEVER printed — only the boolean result is reported.
  playbackUrl: true,
  thumbnailUrl: true,
  websiteVideos: { select: { websiteId: true, status: true } },
  shareLinkVideos: {
    select: {
      shareLink: {
        select: {
          id: true,
          websiteId: true,
          status: true,
          expiresAt: true,
          maxViews: true,
          currentViews: true,
          website: {
            select: {
              id: true,
              status: true,
              // Existence check only. `domain` (the hostname) is deliberately
              // NOT selected. `take: 1` means several ACTIVE domains on one
              // website can never duplicate anything downstream.
              domains: {
                where: { status: DomainStatus.ACTIVE },
                select: { id: true },
                take: 1,
              },
            },
          },
        },
      },
    },
  },
} as const;

/**
 * READ: keyset-paginated findMany over VideoAsset. `where` is supplied by the
 * caller so the same walk serves both passes.
 */
async function* streamVideoBatches(
  prisma: PrismaClient,
  where: Record<string, unknown>,
): AsyncGenerator<AuditVideo[]> {
  let cursorId: string | undefined;

  for (;;) {
    const videos = (await prisma.videoAsset.findMany({
      where,
      select: AUDIT_SELECT,
      orderBy: { id: "asc" },
      take: READ_BATCH_SIZE,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    })) as AuditVideo[];

    if (videos.length === 0) return;
    yield videos;
    if (videos.length < READ_BATCH_SIZE) return;
    cursorId = videos[videos.length - 1]?.id;
  }
}

async function runPass(
  prisma: PrismaClient,
  where: Record<string, unknown>,
  now: Date,
  rowFilter?: (video: AuditVideo) => boolean,
): Promise<AuditAccumulator> {
  const accumulator = createAccumulator();

  for await (const batch of streamVideoBatches(prisma, where)) {
    accumulateVideos(
      accumulator,
      rowFilter ? batch.filter(rowFilter) : batch,
      now,
    );
  }

  return accumulator;
}

function pad(label: string): string {
  return label.padEnd(50, " ");
}

function printPass(title: string, note: string, a: AuditAccumulator): void {
  console.log(title);
  console.log(`  ${note}`);
  console.log("");
  console.log(`${pad("  LEVEL 1  in scope")}${a.level1Videos}`);
  console.log(`${pad("  LEVEL 2  ...READY")}${a.level2ReadyVideos}`);
  console.log(
    `${pad("  LEVEL 3  ...ACTIVE website assignment")}${a.level3VideosWithActiveAssignment}`,
  );
  console.log(
    `${pad("  LEVEL 4  ...on an ACTIVE share link")}${a.level4VideosOnActiveShare}`,
  );
  console.log(
    `${pad("  LEVEL 5  ...share usable NOW + site reachable")}${a.level5VideosOnUsableShare}`,
  );
  console.log("");
  console.log("  Level 5 detail");
  console.log(
    `${pad("    excluded by website/domain reachability")}${a.level5ExcludedByWebsiteReachability}`,
  );
  console.log(
    `${pad("    also passes isPublicPlayableVideo()")}${a.level5PubliclyListable}`,
  );
  console.log(
    `${pad("    playbackUrl rejected by public client")}${a.level5WithRejectedPlaybackUrl}`,
  );
  console.log(
    `${pad("    playbackUrl null/empty (other cause)")}${a.level5MissingPlaybackUrl}`,
  );
  console.log("");
  console.log("  Distinct entities (deduplicated)");
  console.log(
    `${pad("    ACTIVE website assignments")}${a.activeAssignmentKeys.size}`,
  );
  console.log(
    `${pad("    ACTIVE share links reached")}${a.activeShareLinkIds.size}`,
  );
  console.log(
    `${pad("    share links usable NOW")}${a.usableShareLinkIds.size}`,
  );
  console.log(`${pad("    websites affected")}${a.affectedWebsiteIds.size}`);
  console.log("");
  console.log("  Whole-scope URL predicate");
  console.log(
    `${pad("    playbackUrl would be rejected")}${a.playbackUrlRejected}`,
  );
  console.log(
    `${pad("    thumbnailUrl would be rejected")}${a.thumbnailUrlRejected}`,
  );
  console.log("");
  console.log("  Breakdown of LEVEL 1");
  for (const [key, value] of Object.entries(a.providerBreakdown).sort()) {
    console.log(`${pad(`    provider ${key}`)}${value}`);
  }
  for (const [key, value] of Object.entries(a.sourceTypeBreakdown).sort()) {
    console.log(`${pad(`    sourceType ${key}`)}${value}`);
  }
  for (const [key, value] of Object.entries(a.statusBreakdown).sort()) {
    console.log(`${pad(`    status ${key}`)}${value}`);
  }
}

function printIds(a: AuditAccumulator): void {
  const take = (set: Set<string>) =>
    [...set].slice(0, ID_SAMPLE_LIMIT).map(mask).join(" ") || "(none)";

  console.log("");
  console.log("Internal identifiers (truncated; no credentials, no URLs)");
  console.log(`  level5 videoIds     : ${take(a.level5VideoIds)}`);
  console.log(`  usable shareLinkIds : ${take(a.usableShareLinkIds)}`);
  console.log(`  websiteIds          : ${take(a.affectedWebsiteIds)}`);
  if (a.level5VideoIds.size > ID_SAMPLE_LIMIT) {
    console.log(`  (video list truncated at ${ID_SAMPLE_LIMIT})`);
  }
}

function toJson(
  a: AuditAccumulator,
  showIds: boolean,
): Record<string, unknown> {
  return {
    level1Videos: a.level1Videos,
    level2ReadyVideos: a.level2ReadyVideos,
    level3VideosWithActiveAssignment: a.level3VideosWithActiveAssignment,
    level4VideosOnActiveShare: a.level4VideosOnActiveShare,
    level5VideosOnUsableShare: a.level5VideosOnUsableShare,
    level5ExcludedByWebsiteReachability: a.level5ExcludedByWebsiteReachability,
    level5PubliclyListable: a.level5PubliclyListable,
    level5WithRejectedPlaybackUrl: a.level5WithRejectedPlaybackUrl,
    level5MissingPlaybackUrl: a.level5MissingPlaybackUrl,
    distinctActiveAssignments: a.activeAssignmentKeys.size,
    distinctActiveShareLinks: a.activeShareLinkIds.size,
    distinctUsableShareLinks: a.usableShareLinkIds.size,
    distinctAffectedWebsites: a.affectedWebsiteIds.size,
    playbackUrlRejected: a.playbackUrlRejected,
    thumbnailUrlRejected: a.thumbnailUrlRejected,
    providerBreakdown: a.providerBreakdown,
    sourceTypeBreakdown: a.sourceTypeBreakdown,
    statusBreakdown: a.statusBreakdown,
    ...(showIds
      ? {
          ids: {
            level5VideoIds: [...a.level5VideoIds]
              .slice(0, ID_SAMPLE_LIMIT)
              .map(mask),
            usableShareLinkIds: [...a.usableShareLinkIds]
              .slice(0, ID_SAMPLE_LIMIT)
              .map(mask),
            affectedWebsiteIds: [...a.affectedWebsiteIds]
              .slice(0, ID_SAMPLE_LIMIT)
              .map(mask),
          },
        }
      : {}),
  };
}

/** PASS A scope — the original ticket subset. */
const PASS_A_WHERE = { sourceType: VideoSourceType.UPLOAD };

/**
 * PASS B scope — the authoritative blast radius.
 *
 * Restricted to the source types whose public playback actually flows through
 * the `playbackUrl` guard. `embedUrl: null` is a defensive precision: the
 * public client's `isEmbedVideo()` returns true for ANY row carrying an
 * embedUrl and routes it to the iframe branch, bypassing the guard entirely.
 * (The backend forces `sourceType = EMBED` whenever `embedUrl` is set, so this
 * should never exclude anything — it exists so a drifted row cannot be
 * miscounted as affected.)
 */
const PASS_B_WHERE = {
  sourceType: {
    in: [VideoSourceType.UPLOAD, VideoSourceType.DIRECT_URL],
  },
  playbackUrl: { not: null },
  embedUrl: null,
};

export async function runPcD01Audit(argv: string[]): Promise<number> {
  const showIds = argv.includes("--ids");
  const asJson = argv.includes("--json");

  const prisma = createAuditClient(requireDatabaseUrl());
  const now = new Date();

  try {
    const passA = await runPass(prisma, PASS_A_WHERE, now);
    const passB = await runPass(prisma, PASS_B_WHERE, now, (video) =>
      publicClientWouldRejectUrl(video.playbackUrl),
    );

    if (asJson) {
      console.log(
        JSON.stringify(
          {
            audit: "PC-D01",
            generatedAt: now.toISOString(),
            publicPredicate: PUBLIC_FORBIDDEN_SEGMENT_PATTERN.source,
            publicPredicateFingerprint: PUBLIC_PREDICATE_FINGERPRINT,
            publicPredicateCaveat:
              "Pass B is valid only when this predicate matches the deployed Public Website's isForbiddenMediaUrl() behaviour.",
            passA: {
              role: "ORIGINAL PC-D01 TICKET SUBSET",
              scope: "VideoAsset.sourceType = UPLOAD",
              ...toJson(passA, showIds),
            },
            passB: {
              role: "AUTHORITATIVE BLAST RADIUS",
              scope:
                "UPLOAD or DIRECT_URL, no embedUrl, playbackUrl rejected by the current public client",
              ...toJson(passB, showIds),
            },
          },
          null,
          2,
        ),
      );
      return 0;
    }

    console.log("PC-D01 impact audit   READ-ONLY   one database per run");
    console.log(`  evaluated at:     ${now.toISOString()}`);
    console.log(
      `  public predicate: ${PUBLIC_FORBIDDEN_SEGMENT_PATTERN.source}`,
    );
    console.log(`  fingerprint:      ${PUBLIC_PREDICATE_FINGERPRINT}`);
    console.log(
      "  CAVEAT: Pass B is valid only when this predicate matches the deployed",
    );
    console.log(
      "          Public Website's isForbiddenMediaUrl() behaviour. Diff it first.",
    );
    console.log("");
    console.log(
      "  LEVEL 5 requires: share ACTIVE, not expired, budget remaining,",
    );
    console.log(
      "                    Website ACTIVE, and >=1 ACTIVE WebsiteDomain.",
    );
    console.log("");
    printPass(
      "PASS A — ORIGINAL PC-D01 TICKET SUBSET (not the impact figure)",
      "scope: VideoAsset.sourceType = UPLOAD",
      passA,
    );
    console.log("");
    console.log(
      "─────────────────────────────────────────────────────────────────",
    );
    console.log("");
    printPass(
      "PASS B — AUTHORITATIVE BLAST RADIUS  <<< REPORT THIS ONE",
      "scope: UPLOAD or DIRECT_URL, no embedUrl, playbackUrl rejected by the public client",
      passB,
    );
    console.log("");
    console.log(
      "Pass B is the impact figure. Pass A is the subset the ticket named;",
    );
    console.log(
      "a DIRECT_URL video pointing at Cloudinary breaks identically. EMBED is",
    );
    console.log(
      "excluded from both because embeds never reach the playbackUrl guard.",
    );
    if (showIds) printIds(passB);

    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  runPcD01Audit(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      // Never echo the error: a Prisma connection error can contain the DSN.
      console.error(
        "PC-D01 audit failed. Check configuration and database connectivity.",
      );
      process.exitCode = 1;
    });
}

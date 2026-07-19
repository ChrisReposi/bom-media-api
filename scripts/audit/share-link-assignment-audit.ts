import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../../src/generated/prisma/client";
import { loadApiEnv } from "../../src/config/load-env";
import {
  analyzeShareLinkAssignments,
  formatAuditCounts,
  formatAuditWorksheet,
  isAuditVideoPlayable,
  type ShareLinkAuditResult,
  type ShareLinkAuditInput,
} from "./share-link-assignment-audit-core";

const AUDIT_BATCH_SIZE = 100;
const AUDIT_SAMPLE_SIZE = 20;

type ExactPairArgs = { websiteId: string; videoId: string };

function requireDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();

  if (!value) {
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

function isPlayableStoredAsset(
  asset: { mimeType: string; sizeBytes: bigint } | null,
): boolean {
  return (
    asset !== null &&
    asset.mimeType.startsWith("video/") &&
    asset.sizeBytes > 0n
  );
}

async function* readAuditInputBatches(
  prisma: PrismaClient,
): AsyncGenerator<ShareLinkAuditInput[]> {
  let cursorId: string | undefined;

  while (true) {
    const links = await prisma.shareLink.findMany({
      take: AUDIT_BATCH_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      orderBy: { id: "asc" },
      select: {
        id: true,
        alias: true,
        status: true,
        expiresAt: true,
        website: {
          select: {
            id: true,
            status: true,
            domains: { select: { status: true } },
          },
        },
        shareLinkVideos: {
          orderBy: { sortOrder: "asc" },
          select: {
            video: {
              select: {
                id: true,
                status: true,
                sourceType: true,
                playbackUrl: true,
                embedUrl: true,
                binaryAsset: { select: { mimeType: true, sizeBytes: true } },
                localFileAsset: { select: { mimeType: true, sizeBytes: true } },
                websiteVideos: {
                  select: { websiteId: true, status: true },
                },
              },
            },
          },
        },
      },
    });

    if (links.length === 0) {
      return;
    }

    yield links.map((link) => ({
      id: link.id,
      alias: link.alias,
      status: link.status,
      expiresAt: link.expiresAt,
      website: {
        id: link.website.id,
        status: link.website.status,
        activeDomainCount: link.website.domains.filter(
          (domain) => domain.status === "ACTIVE",
        ).length,
      },
      videos: link.shareLinkVideos.map(({ video }) => ({
        id: video.id,
        status: video.status,
        sourceType: video.sourceType,
        playbackUrlPresent: Boolean(video.playbackUrl?.trim()),
        embedUrlPresent: Boolean(video.embedUrl?.trim()),
        binaryAssetPlayable: isPlayableStoredAsset(video.binaryAsset),
        localFileAssetPlayable: isPlayableStoredAsset(video.localFileAsset),
        assignments: video.websiteVideos,
      })),
    }));

    if (links.length < AUDIT_BATCH_SIZE) {
      return;
    }

    cursorId = links.at(-1)?.id;
  }
}

function createEmptyResult(): ShareLinkAuditResult {
  return {
    counts: {
      shareLinks: 0,
      shareLinkVideoRows: 0,
      missingSameSiteAssignments: 0,
      inactiveSameSiteAssignments: 0,
      onlyOtherSiteAssignments: 0,
      activeLinksWithoutPlayableAssignedVideos: 0,
      activeLinksWithPartialValidity: 0,
      disabledOrExpiredContextRows: 0,
      nonPlayableVideoRows: 0,
      affectedActiveLinks: 0,
    },
    cases: [],
  };
}

function mergeAuditResult(
  target: ShareLinkAuditResult,
  batch: ShareLinkAuditResult,
  includeCases: boolean,
): void {
  for (const key of Object.keys(target.counts) as Array<
    keyof ShareLinkAuditResult["counts"]
  >) {
    target.counts[key] += batch.counts[key];
  }

  if (includeCases) {
    target.cases.push(...batch.cases);
  }
}

export async function runShareLinkAssignmentAudit(
  args: string[],
): Promise<number> {
  const exactPair = readExactPairArgs(args);
  const unknownArguments = args.filter(
    (arg) =>
      arg !== "--counts-only" &&
      !arg.startsWith("--website-id=") &&
      !arg.startsWith("--video-id="),
  );
  if (unknownArguments.length > 0) {
    throw new Error(
      "Unknown audit argument. Allowed: --counts-only, --website-id, --video-id.",
    );
  }

  loadApiEnv();
  const prisma = createAuditClient(requireDatabaseUrl());

  try {
    const countsOnly = args.includes("--counts-only");
    const result = createEmptyResult();
    const auditedAt = new Date();

    if (exactPair) {
      console.info("Exact website/video pair (read-only; identifiers masked)");
      console.info(JSON.stringify(await readExactPair(prisma, exactPair)));
    }

    for await (const batch of readAuditInputBatches(prisma)) {
      mergeAuditResult(
        result,
        analyzeShareLinkAssignments(batch, auditedAt),
        !countsOnly,
      );
    }

    console.info("Share-link assignment audit (read-only; identifiers masked)");
    console.info(formatAuditCounts(result));
    console.info("\nLegacy compatibility inventory (read-only)");
    console.info(
      JSON.stringify(
        await readCompatibilityInventory(prisma, countsOnly),
        null,
        2,
      ),
    );

    if (!countsOnly) {
      console.info("\nMasked remediation worksheet rows");
      console.info(formatAuditWorksheet(result));
    }

    return result.counts.affectedActiveLinks > 0 ? 2 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

function readExactPairArgs(args: string[]): ExactPairArgs | null {
  const websiteId = args
    .find((arg) => arg.startsWith("--website-id="))
    ?.slice("--website-id=".length)
    .trim();
  const videoId = args
    .find((arg) => arg.startsWith("--video-id="))
    ?.slice("--video-id=".length)
    .trim();

  if (Boolean(websiteId) !== Boolean(videoId)) {
    throw new Error("--website-id and --video-id must be provided together.");
  }

  return websiteId && videoId ? { websiteId, videoId } : null;
}

async function readExactPair(prisma: PrismaClient, pair: ExactPairArgs) {
  const [website, video, sameSiteAssignment, otherAssignments, references] =
    await Promise.all([
      prisma.website.findUnique({
        where: { id: pair.websiteId },
        select: {
          status: true,
          domains: { where: { status: "ACTIVE" }, select: { id: true } },
        },
      }),
      prisma.videoAsset.findUnique({
        where: { id: pair.videoId },
        select: {
          status: true,
          sourceType: true,
          playbackUrl: true,
          embedUrl: true,
          binaryAsset: { select: { mimeType: true, sizeBytes: true } },
          localFileAsset: { select: { mimeType: true, sizeBytes: true } },
        },
      }),
      prisma.websiteVideo.findUnique({
        where: {
          websiteId_videoId: {
            websiteId: pair.websiteId,
            videoId: pair.videoId,
          },
        },
        select: { status: true },
      }),
      prisma.websiteVideo.findMany({
        where: { videoId: pair.videoId, websiteId: { not: pair.websiteId } },
        select: { websiteId: true, status: true },
        take: AUDIT_SAMPLE_SIZE,
      }),
      prisma.shareLinkVideo.findMany({
        where: { videoId: pair.videoId },
        select: {
          shareLink: {
            select: {
              id: true,
              websiteId: true,
              status: true,
              expiresAt: true,
            },
          },
        },
        take: AUDIT_SAMPLE_SIZE,
      }),
    ]);

  const playable = video
    ? isAuditVideoPlayable({
        id: pair.videoId,
        status: video.status,
        sourceType: video.sourceType,
        playbackUrlPresent: Boolean(video.playbackUrl?.trim()),
        embedUrlPresent: Boolean(video.embedUrl?.trim()),
        binaryAssetPlayable: isPlayableStoredAsset(video.binaryAsset),
        localFileAssetPlayable: isPlayableStoredAsset(video.localFileAsset),
        assignments: [],
      })
    : false;
  const now = new Date();

  return {
    website: mask(pair.websiteId),
    websiteExists: website !== null,
    websiteStatus: website?.status ?? null,
    activeDomainCount: website?.domains.length ?? 0,
    video: mask(pair.videoId),
    videoExists: video !== null,
    videoStatus: video?.status ?? null,
    videoSourceType: video?.sourceType ?? null,
    videoPlayable: playable,
    sameSiteAssignment: sameSiteAssignment?.status ?? "MISSING",
    otherSiteAssignments: otherAssignments.map((assignment) => ({
      website: mask(assignment.websiteId),
      status: assignment.status,
    })),
    shareLinkReferences: references.length,
    activeShareLinkReferences: references.filter(
      ({ shareLink }) =>
        shareLink.status === "ACTIVE" &&
        (shareLink.expiresAt === null || shareLink.expiresAt > now),
    ).length,
    referencedWebsites: Array.from(
      new Set(references.map(({ shareLink }) => mask(shareLink.websiteId))),
    ),
  };
}

async function readCompatibilityInventory(
  prisma: PrismaClient,
  countsOnly: boolean,
) {
  const [
    readyWithoutActiveAssignmentCount,
    websitesWithActiveLinksWithoutActiveAssignmentsCount,
    disabledAssignmentCount,
    readySamples,
    websiteSamples,
    disabledSamples,
    multiWebsiteAssignments,
  ] = await Promise.all([
    prisma.videoAsset.count({
      where: {
        status: "READY",
        websiteVideos: { none: { status: "ACTIVE" } },
      },
    }),
    prisma.website.count({
      where: {
        shareLinks: { some: { status: "ACTIVE" } },
        websiteVideos: { none: { status: "ACTIVE" } },
      },
    }),
    prisma.websiteVideo.count({ where: { status: "DISABLED" } }),
    countsOnly
      ? Promise.resolve([])
      : prisma.videoAsset.findMany({
          where: {
            status: "READY",
            websiteVideos: { none: { status: "ACTIVE" } },
          },
          select: { id: true },
          orderBy: { id: "asc" },
          take: AUDIT_SAMPLE_SIZE,
        }),
    countsOnly
      ? Promise.resolve([])
      : prisma.website.findMany({
          where: {
            shareLinks: { some: { status: "ACTIVE" } },
            websiteVideos: { none: { status: "ACTIVE" } },
          },
          select: { id: true },
          orderBy: { id: "asc" },
          take: AUDIT_SAMPLE_SIZE,
        }),
    countsOnly
      ? Promise.resolve([])
      : prisma.websiteVideo.findMany({
          where: { status: "DISABLED" },
          select: { websiteId: true, videoId: true },
          orderBy: { id: "asc" },
          take: AUDIT_SAMPLE_SIZE,
        }),
    prisma.websiteVideo.groupBy({
      by: ["videoId"],
      where: { status: "ACTIVE" },
      _count: { websiteId: true },
      having: { websiteId: { _count: { gt: 1 } } },
      orderBy: { videoId: "asc" },
      take: AUDIT_SAMPLE_SIZE,
    }),
  ]);

  return {
    readyVideosWithoutActiveAssignment: readyWithoutActiveAssignmentCount,
    websitesWithActiveLinksButNoActiveAssignments:
      websitesWithActiveLinksWithoutActiveAssignmentsCount,
    disabledAssignments: disabledAssignmentCount,
    multiWebsiteActiveVideoSampleCount: multiWebsiteAssignments.length,
    ...(countsOnly
      ? {}
      : {
          samples: {
            readyVideosWithoutActiveAssignment: readySamples.map(({ id }) =>
              mask(id),
            ),
            websitesWithActiveLinksButNoActiveAssignments: websiteSamples.map(
              ({ id }) => mask(id),
            ),
            disabledAssignments: disabledSamples.map((assignment) => ({
              website: mask(assignment.websiteId),
              video: mask(assignment.videoId),
            })),
            multiWebsiteActiveVideos: multiWebsiteAssignments.map((row) => ({
              video: mask(row.videoId),
              activeWebsiteCount: row._count.websiteId,
            })),
          },
        }),
  };
}

function mask(value: string): string {
  return value.slice(0, 8);
}

if (require.main === module) {
  runShareLinkAssignmentAudit(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      console.error(
        "Share-link assignment audit failed. Check configuration and database connectivity.",
      );
      process.exitCode = 1;
    });
}

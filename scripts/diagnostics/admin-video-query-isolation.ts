/**
 * Opt-in, read-only isolation probe for the three Production admin-video list
 * paths. It prints operation names, durations, aggregate counts and allowlisted
 * database error context only. It never prints request inputs, row contents,
 * SQL, connection details or raw error messages.
 */
import "reflect-metadata";
import { performance } from "node:perf_hooks";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import type { ConfigService } from "@nestjs/config";
import { AdminWebsitesService } from "../../src/admin-websites/admin-websites.service";
import type { PrismaService } from "../../src/database/prisma.service";
import type { CorsOriginService } from "../../src/security/cors-origin.service";
import { VideosService } from "../../src/videos/videos.service";
import type { CloudinaryService } from "../../src/cloudinary/cloudinary.service";
import type { VideoMetadataService } from "../../src/videos/metadata/video-metadata.service";
import type { LocalVideoStorageService } from "../../src/videos/storage/local-video-storage.service";
import { loadApiEnv } from "../../src/config/load-env";
import {
  AssignmentStatus,
  Prisma,
  PrismaClient,
  VideoStatus,
} from "../../src/generated/prisma/client";
import { normalizeAdminVideoSearch } from "../../src/videos/utils/video-search.util";
import {
  readAdminVideoDiagnosticOptions,
  toSafeDiagnosticFailure,
} from "./admin-video-query-isolation-core";

type ProbeResult = Record<string, number | boolean | string | null>;
type Probe = {
  operation: string;
  run: () => Promise<ProbeResult>;
};

type VideosServiceInternals = {
  buildVideoWhere(
    query: { status?: VideoStatus },
    normalizedSearch: string,
    normalizedFilterKey: string | undefined,
  ): Prisma.VideoAssetWhereInput;
  buildVideoOrderBy(
    sortBy: "createdAt",
    sortOrder: "desc",
  ): Prisma.VideoAssetOrderByWithRelationInput;
};

type AdminWebsitesServiceInternals = {
  buildWebsiteVideoListWhere(
    websiteId: string,
    query: Record<string, unknown>,
  ): Prisma.WebsiteVideoWhereInput;
  buildWebsiteVideoOrderBy(
    sortBy: "createdAt",
    sortOrder: "desc",
  ): Prisma.WebsiteVideoOrderByWithRelationInput;
  buildVideoAssignmentOptionWhere(
    websiteId: string,
    query: Record<string, unknown>,
  ): Prisma.VideoAssetWhereInput;
  buildEligibleAssignmentCandidateWhere(
    websiteId: string,
  ): Prisma.VideoAssetWhereInput;
};

const mediaInclude = {
  binaryAsset: { select: { mimeType: true, sizeBytes: true } },
  localFileAsset: {
    select: {
      mimeType: true,
      sizeBytes: true,
      checksumSha256: true,
      originalFilename: true,
    },
  },
  localThumbnailAsset: {
    select: {
      mimeType: true,
      sizeBytes: true,
      checksumSha256: true,
      originalFilename: true,
    },
  },
} satisfies Prisma.VideoAssetInclude;

function writeSafeResult(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function executeProbe(probe: Probe): Promise<boolean> {
  const startedAt = performance.now();
  try {
    const result = await probe.run();
    writeSafeResult({
      operation: probe.operation,
      status: "PASS",
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      result,
    });
    return true;
  } catch (error) {
    writeSafeResult({
      operation: probe.operation,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      ...toSafeDiagnosticFailure(error),
    });
    return false;
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createDiagnosticClient(): {
  prisma: PrismaClient;
  connectionLimit: number;
  acquireTimeoutMs: number;
  connectTimeoutMs: number;
} {
  const rawDatabaseUrl = process.env.DATABASE_URL?.trim();
  if (!rawDatabaseUrl) {
    throw new Error("Diagnostic database configuration is missing.");
  }
  const url = new URL(rawDatabaseUrl);
  const database = url.pathname.replace(/^\//, "");
  if (!database) {
    throw new Error("Diagnostic database name is missing.");
  }
  const connectionLimit = positiveInteger(process.env.DB_CONNECTION_LIMIT, 5);
  const acquireTimeoutMs = positiveInteger(
    process.env.DB_ACQUIRE_TIMEOUT_MS,
    10_000,
  );
  const connectTimeoutMs = positiveInteger(
    process.env.DB_CONNECT_TIMEOUT_MS,
    10_000,
  );
  return {
    prisma: new PrismaClient({
      adapter: new PrismaMariaDb({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database,
        connectionLimit,
        acquireTimeout: acquireTimeoutMs,
        connectTimeout: connectTimeoutMs,
        idleTimeout: positiveInteger(process.env.DB_IDLE_TIMEOUT_SECONDS, 300),
        allowPublicKeyRetrieval: true,
      }),
    }),
    connectionLimit,
    acquireTimeoutMs,
    connectTimeoutMs,
  };
}

async function main(): Promise<number> {
  loadApiEnv();
  const options = readAdminVideoDiagnosticOptions(process.env, process.argv);
  writeSafeResult({ diagnosticStage: "ENVIRONMENT_VALIDATED" });
  const { prisma, connectionLimit, acquireTimeoutMs, connectTimeoutMs } =
    createDiagnosticClient();
  await prisma.$connect();
  writeSafeResult({ diagnosticStage: "DATABASE_CONNECTED" });

  try {
    const prismaService = prisma as unknown as PrismaService;
    const configService = {
      get(): undefined {
        return undefined;
      },
    } as unknown as ConfigService;
    const videosService = new VideosService(
      prismaService,
      {} as CloudinaryService,
      configService,
      {} as VideoMetadataService,
      {} as LocalVideoStorageService,
      undefined,
    );
    const websitesService = new AdminWebsitesService(
      prismaService,
      configService,
      { clearDomainOriginCache() {} } as CorsOriginService,
      undefined,
    );
    writeSafeResult({ diagnosticStage: "SERVICES_READY" });
    const website = options.websiteId
      ? await prisma.website.findUnique({
          where: { id: options.websiteId },
          select: { id: true },
        })
      : await prisma.website.findFirst({
          where: { websiteVideos: { some: {} } },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        });
    if (website === null) {
      throw new Error("No diagnostic website is available.");
    }
    writeSafeResult({ diagnosticStage: "WEBSITE_SCOPE_RESOLVED" });

    writeSafeResult({
      diagnostic: "ADMIN_VIDEO_QUERY_ISOLATION",
      environment: options.isProduction ? "production" : "non-production",
      inputValuesRedacted: true,
      connectionLimit,
      acquireTimeoutMs,
      connectTimeoutMs,
      concurrencyComparison: options.includeConcurrencyComparison,
    });

    const videoInternals = videosService as unknown as VideosServiceInternals;
    const websiteInternals =
      websitesService as unknown as AdminWebsitesServiceInternals;
    const normalizedSearch = normalizeAdminVideoSearch(options.search);
    const globalQuery = {
      page: 1,
      limit: 20,
      search: normalizedSearch,
      status: VideoStatus.READY,
      sortBy: "createdAt" as const,
      sortOrder: "desc" as const,
    };
    const globalNoSearchQuery = {
      page: 1,
      limit: 20,
      status: VideoStatus.READY,
      sortBy: "createdAt" as const,
      sortOrder: "desc" as const,
    };
    const globalWhere = videoInternals.buildVideoWhere(
      globalQuery,
      normalizedSearch,
      undefined,
    );
    const globalOrderBy = videoInternals.buildVideoOrderBy("createdAt", "desc");

    const assignedQuery = {
      page: 1,
      limit: 24,
      assignmentStatus: AssignmentStatus.ACTIVE,
      eligibleForShareLink: true,
      sortBy: "createdAt" as const,
      sortOrder: "desc" as const,
    };
    const assignedSearchQuery = {
      ...assignedQuery,
      search: normalizedSearch,
    };
    const assignedWhere = websiteInternals.buildWebsiteVideoListWhere(
      website.id,
      assignedQuery,
    );
    const assignedOrderBy = websiteInternals.buildWebsiteVideoOrderBy(
      "createdAt",
      "desc",
    );
    const eligibleAssignedWhere = websiteInternals.buildWebsiteVideoListWhere(
      website.id,
      { assignmentStatus: AssignmentStatus.ACTIVE, eligibleForShareLink: true },
    );

    const optionQuery = { page: 1, limit: 24 };
    const optionSearchQuery = {
      ...optionQuery,
      search: normalizedSearch,
    };
    const optionWhere = websiteInternals.buildVideoAssignmentOptionWhere(
      website.id,
      optionQuery,
    );
    const optionSearchWhere = websiteInternals.buildVideoAssignmentOptionWhere(
      website.id,
      optionSearchQuery,
    );
    const activeAssignmentWhere: Prisma.WebsiteVideoWhereInput = {
      websiteId: website.id,
      status: AssignmentStatus.ACTIVE,
    };
    const eligibleCandidateWhere =
      websiteInternals.buildEligibleAssignmentCandidateWhere(website.id);
    const optionFindMany = () =>
      prisma.videoAsset.findMany({
        where: optionWhere,
        include: {
          websiteVideos: {
            where: { websiteId: website.id },
            select: { id: true, status: true },
            take: 1,
          },
          ...mediaInclude,
        },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: 24,
      });
    writeSafeResult({ diagnosticStage: "QUERY_SHAPES_BUILT" });

    const probes: Probe[] = [
      {
        operation: "ENVIRONMENT_SQL_MODE",
        run: async () => {
          const rows = await prisma.$queryRaw<
            Array<{ sessionMode: string; globalMode: string }>
          >`SELECT @@SESSION.sql_mode AS sessionMode, @@GLOBAL.sql_mode AS globalMode`;
          return {
            sessionNoBackslashEscapes:
              rows[0]?.sessionMode
                ?.split(",")
                .includes("NO_BACKSLASH_ESCAPES") ?? false,
            globalNoBackslashEscapes:
              rows[0]?.globalMode
                ?.split(",")
                .includes("NO_BACKSLASH_ESCAPES") ?? false,
          };
        },
      },
      {
        operation: "ENVIRONMENT_VIDEO_COLLATION",
        run: async () => {
          const rows = await prisma.$queryRaw<Array<{ present: bigint }>>`
            SELECT COUNT(*) AS present
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'VideoAsset'
              AND COLUMN_NAME IN ('title', 'slug', 'filterKey')
              AND COLLATION_NAME IS NOT NULL
          `;
          return { columnsWithCollation: Number(rows[0]?.present ?? 0n) };
        },
      },
      {
        operation: "GLOBAL_NO_SEARCH_SERVICE_MAPPING",
        run: async () => {
          const result = await videosService.listVideos(globalNoSearchQuery);
          JSON.stringify(result);
          return { rows: result.items.length, total: result.meta.total };
        },
      },
      {
        operation: "GLOBAL_SEARCH_COUNT",
        run: async () => ({
          total: await prisma.videoAsset.count({ where: globalWhere }),
        }),
      },
      {
        operation: "GLOBAL_SEARCH_IDS_ONLY",
        run: async () => ({
          rows: (
            await prisma.videoAsset.findMany({
              where: globalWhere,
              orderBy: globalOrderBy,
              take: 20,
              select: { id: true },
            })
          ).length,
        }),
      },
      {
        operation: "GLOBAL_SEARCH_SCALARS",
        run: async () => ({
          rows: (
            await prisma.videoAsset.findMany({
              where: globalWhere,
              orderBy: globalOrderBy,
              take: 20,
            })
          ).length,
        }),
      },
      ...Object.entries(mediaInclude).map(([relation, include]) => ({
        operation: `GLOBAL_SEARCH_RELATION_${relation.toUpperCase()}`,
        run: async () => ({
          rows: (
            await prisma.videoAsset.findMany({
              where: globalWhere,
              orderBy: globalOrderBy,
              take: 20,
              select: { id: true, [relation]: include },
            })
          ).length,
        }),
      })),
      {
        operation: "GLOBAL_SEARCH_FULL_INCLUDE",
        run: async () => ({
          rows: (
            await prisma.videoAsset.findMany({
              where: globalWhere,
              orderBy: globalOrderBy,
              take: 20,
              include: mediaInclude,
            })
          ).length,
        }),
      },
      {
        operation: "GLOBAL_SEARCH_ARRAY_TRANSACTION",
        run: async () => {
          const [rows, total] = await prisma.$transaction([
            prisma.videoAsset.findMany({
              where: globalWhere,
              orderBy: globalOrderBy,
              take: 20,
              include: mediaInclude,
            }),
            prisma.videoAsset.count({ where: globalWhere }),
          ]);
          return { rows: rows.length, total };
        },
      },
      {
        operation: "GLOBAL_SEARCH_SERVICE_MAPPING",
        run: async () => {
          const result = await videosService.listVideos(globalQuery);
          JSON.stringify(result);
          return { rows: result.items.length, total: result.meta.total };
        },
      },
      {
        operation: "WEBSITE_ASSIGNED_COUNT",
        run: async () => ({
          total: await prisma.websiteVideo.count({ where: assignedWhere }),
        }),
      },
      {
        operation: "WEBSITE_ASSIGNED_IDS_ONLY",
        run: async () => ({
          rows: (
            await prisma.websiteVideo.findMany({
              where: assignedWhere,
              orderBy: assignedOrderBy,
              take: 24,
              select: { id: true, videoId: true },
            })
          ).length,
        }),
      },
      {
        operation: "WEBSITE_ASSIGNED_FULL_FIND_MANY",
        run: async () => ({
          rows: (
            await prisma.websiteVideo.findMany({
              where: assignedWhere,
              orderBy: assignedOrderBy,
              take: 24,
              include: { video: { include: mediaInclude } },
            })
          ).length,
        }),
      },
      {
        operation: "WEBSITE_ASSIGNED_ARRAY_TRANSACTION",
        run: async () => {
          const [total, active, eligible, rows] = await prisma.$transaction([
            prisma.websiteVideo.count({ where: assignedWhere }),
            prisma.websiteVideo.count({
              where: activeAssignmentWhere,
            }),
            prisma.websiteVideo.count({ where: eligibleAssignedWhere }),
            prisma.websiteVideo.findMany({
              where: assignedWhere,
              orderBy: assignedOrderBy,
              take: 24,
              include: { video: { include: mediaInclude } },
            }),
          ]);
          return { total, active, eligible, rows: rows.length };
        },
      },
      {
        operation: "WEBSITE_ASSIGNED_SERVICE_MAPPING",
        run: async () => {
          const result = await websitesService.listAssignedVideos(
            website.id,
            assignedQuery,
          );
          JSON.stringify(result);
          return { rows: result.items.length, total: result.meta.total };
        },
      },
      {
        operation: "WEBSITE_ASSIGNED_SEARCH_SERVICE_MAPPING",
        run: async () => {
          const result = await websitesService.listAssignedVideos(
            website.id,
            assignedSearchQuery,
          );
          JSON.stringify(result);
          return { rows: result.items.length, total: result.meta.total };
        },
      },
      {
        operation: "ASSIGNMENT_OPTIONS_A_COUNT",
        run: async () => ({
          total: await prisma.videoAsset.count({ where: optionWhere }),
        }),
      },
      {
        operation: "ASSIGNMENT_OPTIONS_B_ACTIVE_IDS",
        run: async () => ({
          rows: (
            await prisma.websiteVideo.findMany({
              where: activeAssignmentWhere,
              orderBy: [{ sortOrder: "asc" }, { videoId: "asc" }],
              select: { videoId: true },
            })
          ).length,
        }),
      },
      {
        operation: "ASSIGNMENT_OPTIONS_C_ELIGIBLE_COUNT",
        run: async () => ({
          total: await prisma.videoAsset.count({
            where: eligibleCandidateWhere,
          }),
        }),
      },
      {
        operation: "ASSIGNMENT_OPTIONS_D_FULL_FIND_MANY",
        run: async () => ({ rows: (await optionFindMany()).length }),
      },
      {
        operation: "ASSIGNMENT_OPTIONS_ARRAY_TRANSACTION",
        run: async () => {
          const [total, active, eligible, rows] = await prisma.$transaction([
            prisma.videoAsset.count({ where: optionWhere }),
            prisma.websiteVideo.findMany({
              where: activeAssignmentWhere,
              orderBy: [{ sortOrder: "asc" }, { videoId: "asc" }],
              select: { videoId: true },
            }),
            prisma.videoAsset.count({ where: eligibleCandidateWhere }),
            optionFindMany(),
          ]);
          return { total, active: active.length, eligible, rows: rows.length };
        },
      },
      {
        operation: "ASSIGNMENT_OPTIONS_SERVICE_MAPPING",
        run: async () => {
          const result = await websitesService.listVideoAssignmentOptions(
            website.id,
            optionQuery,
          );
          JSON.stringify(result);
          return { rows: result.items.length, total: result.meta.total };
        },
      },
      {
        operation: "ASSIGNMENT_OPTIONS_SEARCH_COUNT",
        run: async () => ({
          total: await prisma.videoAsset.count({ where: optionSearchWhere }),
        }),
      },
      {
        operation: "ASSIGNMENT_OPTIONS_SEARCH_SERVICE_MAPPING",
        run: async () => {
          const result = await websitesService.listVideoAssignmentOptions(
            website.id,
            optionSearchQuery,
          );
          JSON.stringify(result);
          return { rows: result.items.length, total: result.meta.total };
        },
      },
    ];

    if (options.includeConcurrencyComparison) {
      probes.push({
        operation: "NON_PRODUCTION_PROMISE_ALL_COMPARISON",
        run: async () => {
          const [total, active, eligible, rows] = await Promise.all([
            prisma.videoAsset.count({ where: optionWhere }),
            prisma.websiteVideo.findMany({
              where: activeAssignmentWhere,
              select: { videoId: true },
            }),
            prisma.videoAsset.count({ where: eligibleCandidateWhere }),
            optionFindMany(),
          ]);
          return { total, active: active.length, eligible, rows: rows.length };
        },
      });
    }

    let allPassed = true;
    for (const probe of probes) {
      allPassed = (await executeProbe(probe)) && allPassed;
    }
    return allPassed ? 0 : 2;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    writeSafeResult({
      diagnostic: "ADMIN_VIDEO_QUERY_ISOLATION",
      status: "ERROR",
      ...toSafeDiagnosticFailure(error),
    });
    process.exitCode = 1;
  });

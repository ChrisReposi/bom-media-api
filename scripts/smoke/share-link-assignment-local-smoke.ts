import { ConfigService } from "@nestjs/config";
import { AdminWebsitesService } from "../../src/admin-websites/admin-websites.service";
import { apiConfig } from "../../src/config/env.config";
import { validateEnv } from "../../src/config/env.validation";
import { loadApiEnv } from "../../src/config/load-env";
import { PrismaService } from "../../src/database/prisma.service";
import {
  AccountStatus,
  AdminRole,
  AssignmentStatus,
} from "../../src/generated/prisma/client";
import { PublicMediaGrantService } from "../../src/public/public-media-grant.service";
import { PublicService } from "../../src/public/public.service";
import { LocalVideoStorageService } from "../../src/videos/storage/local-video-storage.service";
import { VideoViewGrowthService } from "../../src/videos/video-view-growth.service";

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

function maskId(value: string): string {
  return value.slice(0, 8);
}

async function main(): Promise<void> {
  loadApiEnv();
  if (
    process.env.APP_ENV !== "local" ||
    process.env.NODE_ENV === "production"
  ) {
    throw new Error("This smoke command is restricted to APP_ENV=local.");
  }
  if (!process.argv.includes("--confirm-local")) {
    throw new Error("Pass --confirm-local after reviewing local data safety.");
  }

  const websiteId = readArg("website-id")?.trim();
  const videoId = readArg("video-id")?.trim();
  if (!websiteId || !videoId) {
    throw new Error("Both --website-id and --video-id are required.");
  }

  const validated = validateEnv(process.env);
  const config = new ConfigService({ ...validated, api: apiConfig() });
  const prisma = new PrismaService(config);
  await prisma.onModuleInit();
  const websitesService = new AdminWebsitesService(prisma, config, {
    clearDomainOriginCache: () => undefined,
  } as never);
  const publicService = new PublicService(
    prisma,
    config,
    new LocalVideoStorageService(config),
    new VideoViewGrowthService(prisma, config),
    new PublicMediaGrantService(config),
  );
  let temporaryShareLinkId: string | null = null;
  let assignmentRemoved = false;
  let ownerId: string | null = null;

  try {
    const [domain, owner, assignment] = await Promise.all([
      prisma.websiteDomain.findFirst({
        where: { websiteId, status: "ACTIVE" },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        select: { domain: true },
      }),
      prisma.adminUser.findFirst({
        where: { status: AccountStatus.ACTIVE, role: AdminRole.OWNER },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      }),
      prisma.websiteVideo.findUnique({
        where: { websiteId_videoId: { websiteId, videoId } },
        select: { status: true },
      }),
    ]);
    if (domain === null || owner === null) {
      throw new Error("Smoke requires an ACTIVE domain and ACTIVE OWNER.");
    }
    if (assignment?.status !== AssignmentStatus.ACTIVE) {
      throw new Error("Smoke requires the exact ACTIVE assignment.");
    }
    ownerId = owner.id;

    const created = await websitesService.createShareLink(
      websiteId,
      {
        label: `LOCAL_ASSIGNMENT_SMOKE_${Date.now()}`,
        videoIds: [videoId],
      },
      owner.id,
    );
    temporaryShareLinkId = created.shareLink.id;

    const initialWatch = await publicService.resolvePublicWatch({
      host: domain.domain,
      token: created.rawToken,
    });
    if (!initialWatch.valid || initialWatch.videos[0]?.id !== videoId) {
      throw new Error("Public watch did not include the assigned video.");
    }

    await websitesService.assignVideos(websiteId, { videoIds: [] }, owner.id);
    assignmentRemoved = true;
    const watchAfterRemoval = await publicService.resolvePublicWatch({
      host: domain.domain,
      token: created.rawToken,
    });
    if (watchAfterRemoval.valid) {
      throw new Error("Public watch remained valid after assignment removal.");
    }

    await websitesService.assignSingleVideo(websiteId, videoId, owner.id);
    assignmentRemoved = false;
    const watchAfterRestore = await publicService.resolvePublicWatch({
      host: domain.domain,
      token: created.rawToken,
    });
    if (!watchAfterRestore.valid) {
      throw new Error(
        "Public watch did not recover after explicit reassignment.",
      );
    }

    const otherWebsite = await prisma.website.findFirst({
      where: { id: { not: websiteId }, status: "ACTIVE" },
      select: { id: true },
    });
    let crossWebsiteRejected: boolean | "SKIPPED_NO_OTHER_WEBSITE" =
      "SKIPPED_NO_OTHER_WEBSITE";
    if (otherWebsite) {
      try {
        await websitesService.createShareLink(
          otherWebsite.id,
          { videoIds: [videoId] },
          owner.id,
        );
        crossWebsiteRejected = false;
      } catch (error: unknown) {
        crossWebsiteRejected =
          typeof error === "object" &&
          error !== null &&
          "getResponse" in error &&
          (error as { getResponse: () => { code?: string } }).getResponse()
            .code === "VIDEO_NOT_ACTIVE_FOR_WEBSITE";
      }
    }
    if (crossWebsiteRejected === false) {
      throw new Error("A different website created a link without assignment.");
    }

    console.log(
      JSON.stringify({
        website: maskId(websiteId),
        video: maskId(videoId),
        createShareLink: "PASS",
        publicWatchBeforeRemoval: "PASS",
        publicWatchAfterRemoval: "GENERIC_INVALID_PASS",
        publicWatchAfterRestore: "PASS",
        crossWebsiteCreateRejected: crossWebsiteRejected,
        rawCredentialPrinted: false,
      }),
    );
  } finally {
    if (assignmentRemoved && ownerId) {
      await websitesService.assignSingleVideo(websiteId, videoId, ownerId);
    }
    if (temporaryShareLinkId && ownerId) {
      await websitesService.revokeShareLink(temporaryShareLinkId, ownerId);
    }
    await prisma.onModuleDestroy();
  }
}

void main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      status: "failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
      message: "Local share-link assignment smoke failed.",
    }),
  );
  process.exitCode = 1;
});

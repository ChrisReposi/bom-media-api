import { ConfigService } from "@nestjs/config";
import { AdminWebsitesService } from "../../src/admin-websites/admin-websites.service";
import {
  AdminRole,
  AccountStatus,
  AssignmentStatus,
  VideoStatus,
  WebsiteStatus,
} from "../../src/generated/prisma/client";
import { apiConfig } from "../../src/config/env.config";
import { validateEnv } from "../../src/config/env.validation";
import { loadApiEnv } from "../../src/config/load-env";
import { PrismaService } from "../../src/database/prisma.service";

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
    throw new Error("This remediation command is restricted to APP_ENV=local.");
  }
  if (!process.argv.includes("--confirm-local")) {
    throw new Error(
      "Pass --confirm-local after reviewing the exact pair audit.",
    );
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

  try {
    const [website, video, existingAssignment, otherAssignments, admin] =
      await Promise.all([
        prisma.website.findUnique({
          where: { id: websiteId },
          select: { status: true },
        }),
        prisma.videoAsset.findUnique({
          where: { id: videoId },
          select: { status: true },
        }),
        prisma.websiteVideo.findUnique({
          where: { websiteId_videoId: { websiteId, videoId } },
          select: { status: true },
        }),
        prisma.websiteVideo.count({
          where: { videoId, websiteId: { not: websiteId } },
        }),
        prisma.adminUser.findFirst({
          where: { status: AccountStatus.ACTIVE, role: AdminRole.OWNER },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        }),
      ]);

    console.log(
      JSON.stringify({
        phase: "before",
        website: maskId(websiteId),
        websiteStatus: website?.status ?? "NOT_FOUND",
        video: maskId(videoId),
        videoStatus: video?.status ?? "NOT_FOUND",
        assignmentStatus: existingAssignment?.status ?? "MISSING",
        otherWebsiteAssignmentCount: otherAssignments,
      }),
    );

    if (website?.status !== WebsiteStatus.ACTIVE) {
      throw new Error("The exact website is not ACTIVE.");
    }
    if (video?.status !== VideoStatus.READY) {
      throw new Error("The exact video is not READY.");
    }
    if (otherAssignments !== 0) {
      throw new Error(
        "The video has another website assignment; owner review is required.",
      );
    }
    if (admin === null) {
      throw new Error(
        "No ACTIVE OWNER exists to own the remediation audit event.",
      );
    }

    await websitesService.assignSingleVideo(websiteId, videoId, admin.id);

    const after = await prisma.websiteVideo.findUnique({
      where: { websiteId_videoId: { websiteId, videoId } },
      select: { status: true },
    });
    if (after?.status !== AssignmentStatus.ACTIVE) {
      throw new Error(
        "Post-remediation validation did not find an ACTIVE assignment.",
      );
    }

    console.log(
      JSON.stringify({
        phase: "after",
        website: maskId(websiteId),
        video: maskId(videoId),
        assignmentStatus: after.status,
        auditWritten: true,
      }),
    );
  } finally {
    await prisma.onModuleDestroy();
  }
}

void main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      status: "failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : "Remediation failed.",
    }),
  );
  process.exitCode = 1;
});

import { createHash, randomInt } from "node:crypto";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ApiEnvironmentConfig } from "../config/env.config";
import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";

type PublicVideoViewRequestMeta = {
  ip?: string | undefined;
  userAgent?: string | undefined;
};

export type RecordPublicVideoViewGrowthParams = {
  videoId: string;
  shareLinkId: string;
  websiteId: string;
  requestMeta?: PublicVideoViewRequestMeta | undefined;
  now?: Date | undefined;
};

export type RecordPublicVideoViewGrowthResult = {
  videoId: string;
  viewCount: string;
  publishedAt: string | null;
  increment: number;
};

@Injectable()
export class VideoViewGrowthService {
  private readonly logger = new Logger(VideoViewGrowthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async recordPublicVideoView(
    params: RecordPublicVideoViewGrowthParams,
  ): Promise<RecordPublicVideoViewGrowthResult> {
    const config =
      this.configService.getOrThrow<ApiEnvironmentConfig>(
        "api",
      ).videoViewGrowth;
    const now = params.now ?? new Date();

    if (!config.enabled) {
      return this.readVideoCounter(params.videoId);
    }

    const viewerHash = this.buildViewerHash(params);
    const windowStart = this.floorToWindow(now, config.dedupeWindowMinutes);
    const bucketStart = this.floorToHour(now);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existingEvent = await tx.videoViewGrowthEvent.findUnique({
          where: {
            videoId_viewerHash_windowStart: {
              videoId: params.videoId,
              viewerHash,
              windowStart,
            },
          },
          select: {
            id: true,
          },
        });

        if (existingEvent !== null) {
          return this.readVideoCounter(params.videoId, tx);
        }

        const latestEvent = await tx.videoViewGrowthEvent.findFirst({
          where: {
            videoId: params.videoId,
            increment: {
              gt: 0,
            },
          },
          orderBy: {
            createdAt: "desc",
          },
          select: {
            createdAt: true,
          },
        });

        const bucket = await tx.videoViewGrowthBucket.upsert({
          where: {
            videoId_bucketStart: {
              videoId: params.videoId,
              bucketStart,
            },
          },
          create: {
            videoId: params.videoId,
            bucketStart,
            incrementTotal: 0,
          },
          update: {},
          select: {
            incrementTotal: true,
          },
        });

        const remainingHourBudget = Math.max(
          config.maxIncrementPerVideoHour - bucket.incrementTotal,
          0,
        );
        const timeBasedMax = this.computeTimeBasedMaxIncrement({
          latestEventAt: latestEvent?.createdAt ?? null,
          now,
          absoluteMax: config.maxIncrementPerEvent,
        });
        const maxIncrement = Math.min(
          config.maxIncrementPerEvent,
          remainingHourBudget,
          timeBasedMax,
        );
        let increment =
          maxIncrement <= 0
            ? 0
            : this.pickIncrement({
                min: config.randomMinIncrement,
                max: maxIncrement,
              });

        if (increment > 0) {
          const bucketUpdate = await tx.videoViewGrowthBucket.updateMany({
            where: {
              videoId: params.videoId,
              bucketStart,
              incrementTotal: {
                lte: config.maxIncrementPerVideoHour - increment,
              },
            },
            data: {
              incrementTotal: {
                increment,
              },
            },
          });

          if (bucketUpdate.count !== 1) {
            increment = 0;
          }
        }

        await tx.videoViewGrowthEvent.create({
          data: {
            videoId: params.videoId,
            shareLinkId: params.shareLinkId,
            websiteId: params.websiteId,
            viewerHash,
            windowStart,
            increment,
            createdAt: now,
          },
        });

        if (increment <= 0) {
          return this.readVideoCounter(params.videoId, tx);
        }

        const video = await tx.videoAsset.update({
          where: {
            id: params.videoId,
          },
          data: {
            viewCount: {
              increment,
            },
          },
          select: {
            id: true,
            viewCount: true,
            publishedAt: true,
          },
        });

        return {
          videoId: video.id,
          viewCount: video.viewCount.toString(),
          publishedAt: video.publishedAt?.toISOString() ?? null,
          increment,
        };
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        return this.readVideoCounter(params.videoId);
      }

      this.logger.warn(
        {
          videoId: params.videoId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "Public video view growth failed.",
      );
      throw error;
    }
  }

  private async readVideoCounter(
    videoId: string,
    client: Pick<PrismaService, "videoAsset"> = this.prisma,
  ): Promise<RecordPublicVideoViewGrowthResult> {
    const video = await client.videoAsset.findUnique({
      where: {
        id: videoId,
      },
      select: {
        id: true,
        viewCount: true,
        publishedAt: true,
      },
    });

    if (video === null) {
      throw new NotFoundException("Video not found.");
    }

    return {
      videoId: video.id,
      viewCount: video.viewCount.toString(),
      publishedAt: video.publishedAt?.toISOString() ?? null,
      increment: 0,
    };
  }

  private buildViewerHash(params: RecordPublicVideoViewGrowthParams): string {
    const pepper = this.configService
      .getOrThrow<string>("ACCESS_LOG_IP_PEPPER")
      .trim();
    const ip = params.requestMeta?.ip?.trim() || "unknown-ip";
    const userAgent =
      params.requestMeta?.userAgent?.trim().slice(0, 512) ||
      "unknown-user-agent";

    return createHash("sha256")
      .update(
        [
          pepper,
          params.videoId,
          params.shareLinkId,
          params.websiteId,
          ip,
          userAgent,
        ].join("\n"),
        "utf8",
      )
      .digest("hex");
  }

  private floorToWindow(date: Date, windowMinutes: number): Date {
    const windowMs = windowMinutes * 60 * 1000;

    return new Date(Math.floor(date.getTime() / windowMs) * windowMs);
  }

  private floorToHour(date: Date): Date {
    return new Date(
      Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        date.getUTCHours(),
        0,
        0,
        0,
      ),
    );
  }

  private computeTimeBasedMaxIncrement(params: {
    latestEventAt: Date | null;
    now: Date;
    absoluteMax: number;
  }): number {
    if (params.latestEventAt === null) {
      return params.absoluteMax;
    }

    const elapsedMinutes =
      (params.now.getTime() - params.latestEventAt.getTime()) / 60_000;

    if (elapsedMinutes < 5) {
      return Math.min(params.absoluteMax, 10);
    }

    if (elapsedMinutes < 15) {
      return Math.min(params.absoluteMax, 30);
    }

    if (elapsedMinutes < 30) {
      return Math.min(params.absoluteMax, 75);
    }

    return params.absoluteMax;
  }

  private pickIncrement(params: { min: number; max: number }): number {
    const max = Math.floor(params.max);
    const min = Math.min(Math.floor(params.min), max);

    if (max <= 0) {
      return 0;
    }

    if (min >= max) {
      return max;
    }

    return randomInt(min, max + 1);
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    );
  }
}

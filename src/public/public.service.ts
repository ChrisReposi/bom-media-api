import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import {
  AccessLogStatus,
  DomainStatus,
  ShareLinkStatus,
  VideoSourceType,
  VideoStatus,
  WebsiteStatus,
  type ShareLink,
  type VideoAsset,
  type Website,
} from "../generated/prisma/client";
import {
  hashIpAddress,
  truncateAccessLogValue,
  truncateDomain,
  truncateReasonCode,
} from "./utils/access-log.util";
import { normalizePublicHost } from "./utils/normalize-host.util";
import { hashShareToken } from "./utils/share-token.util";
import type { PublicWatchResponse } from "./types/public-watch-response.type";
import {
  type PublicWatchReasonCode,
  type PublicWatchVideoResponse,
  type PublicWatchWebsiteResponse,
} from "./types/public-watch-response.type";

type PublicWatchRequestMeta = {
  ip?: string | undefined;
  userAgent?: string | undefined;
  referer?: string | undefined;
};

type ResolvePublicWatchParams = {
  host: string;
  token?: string;
  requestMeta?: PublicWatchRequestMeta | undefined;
};

type PublicDatabaseVideoBinaryParams = {
  host: string;
  token: string;
  videoId: string;
  rangeHeader?: string | undefined;
};

export type PublicDatabaseVideoBinary = {
  statusCode: 200 | 206 | 416;
  mimeType: string;
  sizeBytes: number;
  contentLength: number;
  contentRange: string | null;
  data: Buffer | null;
};

type PublicBinaryAssetMetadata = {
  mimeType: string;
  sizeBytes: bigint;
};

type PublicWatchVideoWithBinary = VideoAsset & {
  binaryAsset?: PublicBinaryAssetMetadata | null;
};

type ShareLinkWithVideos = ShareLink & {
  shareLinkVideos: Array<{
    sortOrder: number;
    video: PublicWatchVideoWithBinary;
  }>;
};

@Injectable()
export class PublicService {
  private readonly logger = new Logger(PublicService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async resolvePublicWatch(
    params: ResolvePublicWatchParams,
  ): Promise<PublicWatchResponse> {
    const normalizedHost = normalizePublicHost(params.host);

    if (normalizedHost === null) {
      await this.writeAccessLog({
        reasonCode: "MISSING_HOST",
        status: AccessLogStatus.DENIED,
        requestMeta: params.requestMeta,
      });

      return this.invalidResponse("MISSING_HOST");
    }

    const domainRecord = await this.prisma.websiteDomain.findUnique({
      where: { domain: normalizedHost },
      include: { website: true },
    });

    if (
      domainRecord === null ||
      domainRecord.status !== DomainStatus.ACTIVE ||
      domainRecord.website.status !== WebsiteStatus.ACTIVE
    ) {
      await this.writeAccessLog({
        domain: normalizedHost,
        reasonCode: "INVALID_LINK",
        status: AccessLogStatus.DENIED,
        requestMeta: params.requestMeta,
      });

      return this.invalidResponse("INVALID_LINK");
    }

    const website = domainRecord.website;
    const trimmedToken = params.token?.trim();

    if (!trimmedToken) {
      await this.writeAccessLog({
        domain: normalizedHost,
        reasonCode: "MISSING_TOKEN",
        status: AccessLogStatus.DENIED,
        websiteId: website.id,
        requestMeta: params.requestMeta,
      });

      return {
        valid: false,
        reasonCode: "MISSING_TOKEN",
        website: this.toPublicWebsiteResponse(website, normalizedHost),
        videos: [],
      };
    }

    const tokenPepper = this.configService
      .get<string>("SHARE_TOKEN_PEPPER")
      ?.trim();

    if (!tokenPepper) {
      await this.writeAccessLog({
        domain: normalizedHost,
        reasonCode: "SERVER_ERROR",
        status: AccessLogStatus.DENIED,
        websiteId: website.id,
        requestMeta: params.requestMeta,
      });
      this.logger.error("SHARE_TOKEN_PEPPER is missing for public watch.");

      return {
        valid: false,
        reasonCode: "SERVER_ERROR",
        website: null,
        videos: [],
      };
    }

    const tokenHash = hashShareToken({
      pepper: tokenPepper,
      token: trimmedToken,
    });

    const shareLink = await this.prisma.shareLink.findFirst({
      where: {
        tokenHash,
        websiteId: website.id,
      },
      include: {
        shareLinkVideos: {
          orderBy: {
            sortOrder: "asc",
          },
          include: {
            video: {
              include: {
                binaryAsset: {
                  select: {
                    mimeType: true,
                    sizeBytes: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (shareLink === null) {
      await this.writeAccessLog({
        domain: normalizedHost,
        reasonCode: "INVALID_LINK",
        status: AccessLogStatus.DENIED,
        websiteId: website.id,
        requestMeta: params.requestMeta,
      });

      return this.invalidResponse("INVALID_LINK");
    }

    const now = new Date();
    const deniedReason = this.getDeniedReason(shareLink, now);
    if (deniedReason !== null) {
      await this.writeAccessLog({
        domain: normalizedHost,
        reasonCode: deniedReason,
        status: AccessLogStatus.DENIED,
        websiteId: website.id,
        shareLinkId: shareLink.id,
        requestMeta: params.requestMeta,
      });

      return this.invalidResponse(deniedReason, website, normalizedHost);
    }

    const videos = this.toPlayablePublicVideos(shareLink, {
      host: normalizedHost,
      token: trimmedToken,
    });
    if (videos.length === 0) {
      await this.writeAccessLog({
        domain: normalizedHost,
        reasonCode: "NO_VIDEOS",
        status: AccessLogStatus.DENIED,
        websiteId: website.id,
        shareLinkId: shareLink.id,
        requestMeta: params.requestMeta,
      });

      return this.invalidResponse("NO_VIDEOS", website, normalizedHost);
    }

    const viewIncremented = await this.incrementShareLinkView(shareLink, now);
    if (!viewIncremented) {
      const latestShareLink = await this.prisma.shareLink.findUnique({
        where: { id: shareLink.id },
      });
      const latestDeniedReason = latestShareLink
        ? (this.getDeniedReason(latestShareLink, now) ?? "INVALID_LINK")
        : "INVALID_LINK";

      await this.writeAccessLog({
        domain: normalizedHost,
        reasonCode: latestDeniedReason,
        status: AccessLogStatus.DENIED,
        websiteId: website.id,
        shareLinkId: shareLink.id,
        requestMeta: params.requestMeta,
      });

      return this.invalidResponse(latestDeniedReason, website, normalizedHost);
    }

    await this.writeAccessLog({
      domain: normalizedHost,
      reasonCode: "OK",
      status: AccessLogStatus.ALLOWED,
      websiteId: website.id,
      shareLinkId: shareLink.id,
      requestMeta: params.requestMeta,
    });

    return {
      valid: true,
      reasonCode: "OK",
      website: this.toPublicWebsiteResponse(website, normalizedHost),
      videos,
    };
  }

  async getPublicDatabaseVideoBinary(
    params: PublicDatabaseVideoBinaryParams,
  ): Promise<PublicDatabaseVideoBinary> {
    const binaryAsset =
      await this.getAuthorizedPublicDatabaseBinaryAsset(params);
    const totalSize = Number(binaryAsset.sizeBytes);

    if (!Number.isSafeInteger(totalSize) || totalSize <= 0) {
      throw new NotFoundException("Video not found.");
    }

    const range = this.parseRangeHeader(params.rangeHeader, totalSize);

    if (range === null) {
      return {
        statusCode: 416,
        mimeType: binaryAsset.mimeType,
        sizeBytes: totalSize,
        contentLength: 0,
        contentRange: `bytes */${totalSize}`,
        data: null,
      };
    }

    const data = await this.readDatabaseVideoBinaryChunk(
      params.videoId,
      range.start,
      range.length,
    );

    return {
      statusCode: range.statusCode,
      mimeType: binaryAsset.mimeType,
      sizeBytes: totalSize,
      contentLength: data.length,
      contentRange:
        range.statusCode === 206
          ? `bytes ${range.start}-${range.end}/${totalSize}`
          : null,
      data,
    };
  }

  private getDeniedReason(
    shareLink: ShareLink,
    now: Date,
  ): PublicWatchReasonCode | null {
    if (shareLink.status !== ShareLinkStatus.ACTIVE) {
      return "INVALID_LINK";
    }

    if (shareLink.expiresAt !== null && shareLink.expiresAt <= now) {
      return "EXPIRED_LINK";
    }

    if (
      shareLink.maxViews !== null &&
      shareLink.currentViews >= shareLink.maxViews
    ) {
      return "VIEW_LIMIT_REACHED";
    }

    return null;
  }

  private async incrementShareLinkView(
    shareLink: ShareLink,
    now: Date,
  ): Promise<boolean> {
    const where: Prisma.ShareLinkWhereInput = {
      id: shareLink.id,
      status: ShareLinkStatus.ACTIVE,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      ...(shareLink.maxViews !== null
        ? { currentViews: { lt: shareLink.maxViews } }
        : {}),
    };

    const result = await this.prisma.shareLink.updateMany({
      where,
      data: {
        currentViews: {
          increment: 1,
        },
        lastViewedAt: now,
      },
    });

    return result.count === 1;
  }

  private toPlayablePublicVideos(
    shareLink: ShareLinkWithVideos,
    playbackContext: { host: string; token: string },
  ): PublicWatchVideoResponse[] {
    return shareLink.shareLinkVideos
      .map(({ video }) => video)
      .filter((video) => this.isPublicPlayableVideo(video))
      .map((video) => ({
        id: video.id,
        title: video.title,
        description: video.description,
        sourceType: video.sourceType,
        playbackUrl:
          video.sourceType === VideoSourceType.DB_BLOB
            ? null
            : video.playbackUrl,
        binaryPlaybackUrl:
          video.sourceType === VideoSourceType.DB_BLOB
            ? this.buildPublicBinaryPlaybackUrl({
                token: playbackContext.token,
                videoId: video.id,
                host: playbackContext.host,
              })
            : null,
        publicPlaybackUrl:
          video.sourceType === VideoSourceType.DB_BLOB
            ? this.buildPublicBinaryPlaybackUrl({
                token: playbackContext.token,
                videoId: video.id,
                host: playbackContext.host,
              })
            : null,
        binaryAsset:
          video.sourceType === VideoSourceType.DB_BLOB
            ? this.toPublicBinaryAssetResponse(video.binaryAsset ?? null)
            : null,
        embedUrl: video.embedUrl,
        embedProvider: video.embedProvider,
        embedAllow: video.embedAllow,
        thumbnailUrl: video.thumbnailUrl,
        durationSeconds: video.durationSeconds,
        viewCount: video.viewCount.toString(),
        publishedAt: video.publishedAt?.toISOString() ?? null,
      }));
  }

  private isPublicPlayableVideo(video: PublicWatchVideoWithBinary): boolean {
    if (video.status !== VideoStatus.READY) {
      return false;
    }

    if (video.sourceType === VideoSourceType.EMBED) {
      return video.embedUrl !== null && video.embedUrl.trim() !== "";
    }

    if (video.sourceType === VideoSourceType.DB_BLOB) {
      return this.isPlayableBinaryAsset(video.binaryAsset ?? null);
    }

    return video.playbackUrl !== null && video.playbackUrl.trim() !== "";
  }

  private toPublicBinaryAssetResponse(
    binaryAsset: PublicBinaryAssetMetadata | null,
  ): { mimeType: string; sizeBytes: string } | null {
    if (!this.isPlayableBinaryAsset(binaryAsset)) {
      return null;
    }

    return {
      mimeType: binaryAsset.mimeType,
      sizeBytes: binaryAsset.sizeBytes.toString(),
    };
  }

  private async getAuthorizedPublicDatabaseBinaryAsset(
    params: PublicDatabaseVideoBinaryParams,
  ): Promise<PublicBinaryAssetMetadata> {
    const normalizedHost = normalizePublicHost(params.host);
    const trimmedToken = params.token.trim();

    if (normalizedHost === null || trimmedToken === "") {
      throw new NotFoundException("Video not found.");
    }

    const domainRecord = await this.prisma.websiteDomain.findUnique({
      where: { domain: normalizedHost },
      include: { website: true },
    });

    if (
      domainRecord === null ||
      domainRecord.status !== DomainStatus.ACTIVE ||
      domainRecord.website.status !== WebsiteStatus.ACTIVE
    ) {
      throw new NotFoundException("Video not found.");
    }

    const tokenPepper = this.configService
      .get<string>("SHARE_TOKEN_PEPPER")
      ?.trim();

    if (!tokenPepper) {
      this.logger.error("SHARE_TOKEN_PEPPER is missing for public DB video.");
      throw new NotFoundException("Video not found.");
    }

    const tokenHash = hashShareToken({
      pepper: tokenPepper,
      token: trimmedToken,
    });

    const shareLink = await this.prisma.shareLink.findFirst({
      where: {
        tokenHash,
        websiteId: domainRecord.website.id,
      },
      include: {
        shareLinkVideos: {
          where: {
            videoId: params.videoId,
          },
          take: 1,
          include: {
            video: {
              include: {
                binaryAsset: {
                  select: {
                    mimeType: true,
                    sizeBytes: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (
      shareLink === null ||
      this.getDeniedReasonForBinaryPlayback(shareLink, new Date()) !== null
    ) {
      throw new NotFoundException("Video not found.");
    }

    const video = shareLink.shareLinkVideos[0]?.video;
    const binaryAsset = video?.binaryAsset ?? null;

    if (
      video === undefined ||
      video.status !== VideoStatus.READY ||
      video.sourceType !== VideoSourceType.DB_BLOB ||
      !this.isPlayableBinaryAsset(binaryAsset)
    ) {
      throw new NotFoundException("Video not found.");
    }

    return binaryAsset;
  }

  private getDeniedReasonForBinaryPlayback(
    shareLink: ShareLink,
    now: Date,
  ): PublicWatchReasonCode | null {
    if (shareLink.status !== ShareLinkStatus.ACTIVE) {
      return "INVALID_LINK";
    }

    if (shareLink.expiresAt !== null && shareLink.expiresAt <= now) {
      return "EXPIRED_LINK";
    }

    if (
      shareLink.maxViews !== null &&
      shareLink.currentViews > shareLink.maxViews
    ) {
      return "VIEW_LIMIT_REACHED";
    }

    return null;
  }

  private isPlayableBinaryAsset(
    binaryAsset: PublicBinaryAssetMetadata | null,
  ): binaryAsset is PublicBinaryAssetMetadata {
    return (
      binaryAsset !== null &&
      binaryAsset.mimeType.startsWith("video/") &&
      binaryAsset.sizeBytes > BigInt(0)
    );
  }

  private parseRangeHeader(
    rangeHeader: string | undefined,
    totalSize: number,
  ): {
    statusCode: 200 | 206;
    start: number;
    end: number;
    length: number;
  } | null {
    if (rangeHeader === undefined || rangeHeader.trim() === "") {
      return {
        statusCode: 200,
        start: 0,
        end: totalSize - 1,
        length: totalSize,
      };
    }

    const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());

    if (rangeMatch === null) {
      return null;
    }

    const [, rawStart, rawEnd] = rangeMatch;

    if (rawStart === "" && rawEnd === "") {
      return null;
    }

    let start: number;
    let end: number;

    if (rawStart === "") {
      const suffixLength = Number(rawEnd);

      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
        return null;
      }

      start = Math.max(totalSize - suffixLength, 0);
      end = totalSize - 1;
    } else {
      start = Number(rawStart);
      end = rawEnd === "" ? totalSize - 1 : Number(rawEnd);
    }

    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      start >= totalSize
    ) {
      return null;
    }

    const boundedEnd = Math.min(end, totalSize - 1);

    return {
      statusCode: 206,
      start,
      end: boundedEnd,
      length: boundedEnd - start + 1,
    };
  }

  private async readDatabaseVideoBinaryChunk(
    videoId: string,
    start: number,
    length: number,
  ): Promise<Buffer> {
    const rows = await this.prisma.$queryRaw<Array<{ data: Buffer }>>(
      Prisma.sql`SELECT SUBSTRING(\`data\`, ${start + 1}, ${length}) AS \`data\` FROM \`VideoBinaryAsset\` WHERE \`videoId\` = ${videoId} LIMIT 1`,
    );
    const data = rows[0]?.data;

    if (data === undefined) {
      throw new NotFoundException("Video not found.");
    }

    return Buffer.from(data);
  }

  private buildPublicBinaryPlaybackUrl(params: {
    token: string;
    videoId: string;
    host: string;
  }): string {
    const rawPrefix = this.configService.get<string>("API_PREFIX") ?? "api/v1";
    const prefix = rawPrefix.replace(/^\/+|\/+$/g, "") || "api/v1";
    const query = new URLSearchParams({ host: params.host });

    return `/${prefix}/public/watch/${encodeURIComponent(
      params.token,
    )}/videos/${encodeURIComponent(params.videoId)}/binary?${query.toString()}`;
  }

  private toPublicWebsiteResponse(
    website: Website,
    domain: string | null,
  ): PublicWatchWebsiteResponse {
    return {
      id: website.id,
      name: website.name,
      slug: website.slug,
      domain,
    };
  }

  private invalidResponse(
    reasonCode: PublicWatchReasonCode,
    website?: Website,
    domain: string | null = null,
  ): PublicWatchResponse {
    return {
      valid: false,
      reasonCode,
      website: website ? this.toPublicWebsiteResponse(website, domain) : null,
      videos: [],
    };
  }

  private async writeAccessLog(params: {
    status: AccessLogStatus;
    reasonCode: PublicWatchReasonCode;
    requestMeta?: PublicWatchRequestMeta | undefined;
    domain?: string | undefined;
    websiteId?: string | undefined;
    shareLinkId?: string | undefined;
  }): Promise<void> {
    try {
      await this.prisma.accessLog.create({
        data: {
          status: params.status,
          reasonCode: truncateReasonCode(params.reasonCode),
          ...(params.websiteId ? { websiteId: params.websiteId } : {}),
          ...(params.shareLinkId ? { shareLinkId: params.shareLinkId } : {}),
          ...(params.domain ? { domain: truncateDomain(params.domain) } : {}),
          ...(this.getIpHash(params.requestMeta)
            ? { ipHash: this.getIpHash(params.requestMeta) }
            : {}),
          ...(truncateAccessLogValue(params.requestMeta?.userAgent, 1024)
            ? {
                userAgent: truncateAccessLogValue(
                  params.requestMeta?.userAgent,
                  1024,
                ),
              }
            : {}),
          ...(truncateAccessLogValue(params.requestMeta?.referer, 2048)
            ? {
                referer: truncateAccessLogValue(
                  params.requestMeta?.referer,
                  2048,
                ),
              }
            : {}),
        },
      });
    } catch (error) {
      this.logger.warn(
        {
          reasonCode: params.reasonCode,
          status: params.status,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "Public access log write failed.",
      );
    }
  }

  private getIpHash(meta: PublicWatchRequestMeta | undefined): string | null {
    return hashIpAddress({
      ip: meta?.ip,
      pepper: this.configService.get<string>("ACCESS_LOG_IP_PEPPER"),
    });
  }
}

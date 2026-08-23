import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BunnyStreamService } from "../bunny/bunny-stream.service";
import {
  classifyBunnyVideoAsset,
  isBunnyRemoteMissing,
} from "../bunny/bunny-video-asset.util";
import {
  buildCacheKey,
  hashCacheKeyPart,
} from "../cache/memory-cache-key.util";
import { MemoryCacheService } from "../cache/memory-cache.service";
import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import {
  AccessLogStatus,
  AssignmentStatus,
  DomainStatus,
  ShareLinkStatus,
  VideoProvider,
  VideoSourceType,
  VideoStatus,
  WebsiteStatus,
  type ShareLink,
  type VideoAsset,
  type Website,
} from "../generated/prisma/client";
import {
  LocalVideoStorageService,
  type LocalStorageRangeResult,
} from "../videos/storage/local-video-storage.service";
import { VideoViewGrowthService } from "../videos/video-view-growth.service";
import { PublicMediaGrantService } from "./public-media-grant.service";
import {
  hashIpAddress,
  truncateAccessLogValue,
  truncateDomain,
  truncateReasonCode,
} from "./utils/access-log.util";
import { normalizePublicHost } from "./utils/normalize-host.util";
import { hashShareToken } from "./utils/share-token.util";
import type {
  PublicVideoViewResponse,
  PublicWatchResponse,
} from "./types/public-watch-response.type";
import {
  type PublicWatchReasonCode,
  type PublicWatchVideoResponse,
  type PublicWatchWebsiteResponse,
} from "./types/public-watch-response.type";

/**
 * Bunny player overrides for the PUBLIC reviewer embed.
 *
 * `autoplay=false` so the reviewer sees the poster frame before playback
 * instead of the video starting on its own. Bunny's embed page renders
 * `<video ... autoplay ...>` by default (the library's Player setting) and
 * already carries the correct `data-poster`, so suppressing autoplay is what
 * makes that poster visible — a share link that opens on a still frame the
 * reviewer clicks once to play.
 *
 * These parameters are appended after the credential pair and are NOT part of
 * the embed token, which hashes `videoId + expires` only. Authorization,
 * signing order and the atomic view consumption are completely unaffected.
 */
const PUBLIC_BUNNY_PLAYER_PARAMS = { autoplay: "false" } as const;

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
  grant?: string | undefined;
  headOnly?: boolean | undefined;
  rangeHeader?: string | undefined;
};

type PublicLocalVideoFileParams = PublicDatabaseVideoBinaryParams;

type PublicLocalThumbnailParams = {
  host: string;
  token: string;
  videoId: string;
  grant?: string | undefined;
};

type RecordPublicVideoViewParams = {
  host: string;
  token: string;
  videoId: string;
  requestMeta?: Pick<PublicWatchRequestMeta, "ip" | "userAgent"> | undefined;
};

export type PublicDatabaseVideoBinary = {
  statusCode: 200 | 206 | 416;
  mimeType: string;
  sizeBytes: number;
  contentLength: number;
  contentRange: string | null;
  data: Buffer | null;
};

export type PublicLocalVideoFile = LocalStorageRangeResult & {
  mimeType: string;
};

export type PublicLocalThumbnail = {
  mimeType: string;
  contentLength: number;
  stream: NodeJS.ReadableStream;
};

type PublicBinaryAssetMetadata = {
  mimeType: string;
  sizeBytes: bigint;
};

type PublicLocalAssetMetadata = {
  storageKey?: string;
  mimeType: string;
  sizeBytes: bigint;
};

type PublicWatchVideoWithBinary = VideoAsset & {
  binaryAsset?: PublicBinaryAssetMetadata | null;
  localFileAsset?: PublicLocalAssetMetadata | null;
  localThumbnailAsset?: PublicLocalAssetMetadata | null;
};

type ShareLinkWithVideos = ShareLink & {
  shareLinkVideos: Array<{
    sortOrder: number;
    video: PublicWatchVideoWithBinary;
  }>;
};

type ShareLinkWhereInput = Prisma.Args<
  PrismaService["shareLink"],
  "updateMany"
>["where"];

type ShareLinkViewPolicy = Pick<
  ShareLink,
  "id" | "status" | "expiresAt" | "maxViews" | "currentViews"
>;

type CachedPublicWatchMetadata = {
  website: Pick<Website, "id" | "name" | "slug">;
  shareLink: ShareLinkViewPolicy;
  videos: PublicWatchVideoWithBinary[];
};

@Injectable()
export class PublicService {
  private readonly logger = new Logger(PublicService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly localVideoStorageService: LocalVideoStorageService,
    private readonly videoViewGrowthService: VideoViewGrowthService,
    private readonly publicMediaGrantService: PublicMediaGrantService,
    @Optional() private readonly memoryCache?: MemoryCacheService,
    // Appended and optional on purpose. Public watch resolution for every
    // legacy source type must work with no Bunny collaborator at all.
    @Optional() private readonly bunnyStreamService?: BunnyStreamService,
  ) {}

  async resolvePublicWatch(
    params: ResolvePublicWatchParams,
  ): Promise<PublicWatchResponse> {
    const normalizedHost = normalizePublicHost(params.host);
    const trimmedToken = this.normalizePublicToken(params.token);

    if (normalizedHost !== null && trimmedToken) {
      const cacheKey = this.buildPublicWatchCacheKey(
        normalizedHost,
        trimmedToken,
      );
      const cachedMetadata =
        this.memoryCache?.get<CachedPublicWatchMetadata>(cacheKey) ?? null;

      if (cachedMetadata !== null) {
        const cachedResponse = await this.resolveCachedPublicWatch({
          params,
          cacheKey,
          normalizedHost,
          trimmedToken,
          cachedMetadata,
        });

        if (cachedResponse !== null) {
          return cachedResponse;
        }
      }
    }

    return this.resolvePublicWatchUncached(params);
  }

  private async resolvePublicWatchUncached(
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
      domainRecord.website === null ||
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
    const trimmedToken = this.normalizePublicToken(params.token);

    if (!trimmedToken) {
      await this.writeAccessLog({
        domain: normalizedHost,
        reasonCode: "MISSING_TOKEN",
        status: AccessLogStatus.DENIED,
        websiteId: website.id,
        requestMeta: params.requestMeta,
      });

      return this.invalidResponse("MISSING_TOKEN");
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

      return this.invalidResponse("SERVER_ERROR");
    }

    const tokenHash = hashShareToken({
      pepper: tokenPepper,
      token: trimmedToken,
    });

    const publicWatchInclude = {
      shareLinkVideos: {
        where: {
          video: {
            websiteVideos: {
              some: {
                websiteId: website.id,
                status: AssignmentStatus.ACTIVE,
              },
            },
          },
        },
        orderBy: {
          sortOrder: "asc" as const,
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
              localFileAsset: {
                select: {
                  mimeType: true,
                  sizeBytes: true,
                },
              },
              localThumbnailAsset: {
                select: {
                  mimeType: true,
                  sizeBytes: true,
                },
              },
            },
          },
        },
      },
    };

    const shareLink =
      (await this.prisma.shareLink.findFirst({
        where: {
          alias: trimmedToken,
          websiteId: website.id,
        },
        include: publicWatchInclude,
      })) ??
      (await this.prisma.shareLink.findFirst({
        where: {
          tokenHash,
          websiteId: website.id,
        },
        include: publicWatchInclude,
      }));

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

    // SELECTION ONLY - no playback credential is minted here. See
    // `selectPublicPlayableVideos`.
    const playableVideos = this.selectPublicPlayableVideos(
      shareLink.shareLinkVideos.map(({ video }) => video),
    );
    if (playableVideos.length === 0) {
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

    // AUTHORITATIVE ATOMIC CONSUMPTION. Everything above is a candidate check;
    // this conditional update re-verifies status, expiry and `maxViews` and
    // claims the view in one statement. Nothing that grants playback may run
    // before it succeeds.
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
    this.writePublicWatchCache({
      normalizedHost,
      trimmedToken,
      website,
      shareLink,
      now,
    });

    // Consumption succeeded. Only now may playback credentials be minted - and
    // Bunny signing additionally passes the authoritative database gate first.
    const signableBunnyVideoIds =
      await this.loadSignableBunnyVideoIds(playableVideos);

    return {
      valid: true,
      reasonCode: "OK",
      website: this.toPublicWebsiteResponse(website, normalizedHost),
      videos: this.toPublicVideoResponses(
        playableVideos,
        { host: normalizedHost, token: trimmedToken },
        shareLink,
        signableBunnyVideoIds,
      ),
    };
  }

  async getPublicLocalVideoFile(
    params: PublicLocalVideoFileParams,
  ): Promise<PublicLocalVideoFile> {
    const localFileAsset = await this.getAuthorizedPublicLocalFileAsset(params);

    return {
      mimeType: localFileAsset.mimeType,
      ...this.localVideoStorageService.createRangeReadStream({
        storageKey: localFileAsset.storageKey,
        rangeHeader: params.rangeHeader,
      }),
    };
  }

  async recordPublicVideoView(
    params: RecordPublicVideoViewParams,
  ): Promise<PublicVideoViewResponse> {
    const authorized = await this.getAuthorizedPublicVideoForView(params);

    if (authorized === null) {
      return this.invalidVideoViewResponse();
    }

    const result = await this.videoViewGrowthService.recordPublicVideoView({
      videoId: authorized.video.id,
      shareLinkId: authorized.shareLink.id,
      websiteId: authorized.website.id,
      requestMeta: params.requestMeta,
    });

    return {
      valid: true,
      videoId: result.videoId,
      viewCount: result.viewCount,
      publishedAt: result.publishedAt,
    };
  }

  async getPublicLocalThumbnail(
    params: PublicLocalThumbnailParams,
  ): Promise<PublicLocalThumbnail> {
    const localThumbnailAsset =
      await this.getAuthorizedPublicLocalThumbnailAsset(params);
    const result = this.localVideoStorageService.createFullReadStream(
      localThumbnailAsset.storageKey,
    );

    return {
      mimeType: localThumbnailAsset.mimeType,
      contentLength: result.contentLength,
      stream: result.stream,
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

    const data = params.headOnly
      ? null
      : await this.readDatabaseVideoBinaryChunk(
          params.videoId,
          range.start,
          range.length,
        );

    return {
      statusCode: range.statusCode,
      mimeType: binaryAsset.mimeType,
      sizeBytes: totalSize,
      contentLength: data?.length ?? range.length,
      contentRange:
        range.statusCode === 206
          ? `bytes ${range.start}-${range.end}/${totalSize}`
          : null,
      data,
    };
  }

  private async resolveCachedPublicWatch(params: {
    params: ResolvePublicWatchParams;
    cacheKey: string;
    normalizedHost: string;
    trimmedToken: string;
    cachedMetadata: CachedPublicWatchMetadata;
  }): Promise<PublicWatchResponse | null> {
    const now = new Date();
    const deniedReason = this.getDeniedReason(
      params.cachedMetadata.shareLink,
      now,
    );
    if (deniedReason !== null) {
      this.memoryCache?.delete(params.cacheKey);
      return null;
    }

    // A cache hit accelerates LOOKUP only. It must not shortcut the ordering:
    // selection first, authoritative consumption second, signing last.
    const playableVideos = this.selectPublicPlayableVideos(
      params.cachedMetadata.videos,
    );
    if (playableVideos.length === 0) {
      this.memoryCache?.delete(params.cacheKey);
      return null;
    }

    const viewIncremented = await this.incrementShareLinkView(
      params.cachedMetadata.shareLink,
      now,
    );
    if (!viewIncremented) {
      this.memoryCache?.delete(params.cacheKey);
      // Re-runs the full chain, which denies without signing.
      return this.resolvePublicWatchUncached(params.params);
    }

    await this.writeAccessLog({
      domain: params.normalizedHost,
      reasonCode: "OK",
      status: AccessLogStatus.ALLOWED,
      websiteId: params.cachedMetadata.website.id,
      shareLinkId: params.cachedMetadata.shareLink.id,
      requestMeta: params.params.requestMeta,
    });

    // Consumption succeeded. Signing happens here, per request, so a cache hit
    // still yields a freshly signed Bunny URL rather than a replayed one.
    //
    // AND the cached rows do not get the final say. This process's cache cannot
    // be invalidated by reconciliation running elsewhere, so Bunny signing is
    // gated on a fresh read of the current database rows.
    const signableBunnyVideoIds =
      await this.loadSignableBunnyVideoIds(playableVideos);

    return {
      valid: true,
      reasonCode: "OK",
      website: this.toPublicWebsiteResponse(
        params.cachedMetadata.website,
        params.normalizedHost,
      ),
      videos: this.toPublicVideoResponses(
        playableVideos,
        {
          host: params.normalizedHost,
          token: params.trimmedToken,
        },
        undefined,
        signableBunnyVideoIds,
      ),
    };
  }

  private writePublicWatchCache(params: {
    normalizedHost: string;
    trimmedToken: string;
    website: Pick<Website, "id" | "name" | "slug">;
    shareLink: ShareLinkWithVideos;
    now: Date;
  }): void {
    if (this.memoryCache === undefined) {
      return;
    }

    const ttlSeconds =
      this.memoryCache.getRuntimeConfig().publicWatchMetadataTtlSeconds;
    if (
      !this.canCachePublicWatchShareLink(
        params.shareLink,
        params.now,
        ttlSeconds,
      )
    ) {
      return;
    }

    const videos = params.shareLink.shareLinkVideos
      .map(({ video }) => video)
      .filter((video) => this.isPublicPlayableVideo(video));
    if (videos.length === 0) {
      return;
    }

    this.memoryCache.set(
      this.buildPublicWatchCacheKey(params.normalizedHost, params.trimmedToken),
      {
        website: {
          id: params.website.id,
          name: params.website.name,
          slug: params.website.slug,
        },
        shareLink: {
          id: params.shareLink.id,
          status: params.shareLink.status,
          expiresAt: params.shareLink.expiresAt,
          maxViews: params.shareLink.maxViews,
          currentViews: params.shareLink.currentViews,
        },
        videos,
      } satisfies CachedPublicWatchMetadata,
      { ttlSeconds },
    );
  }

  private canCachePublicWatchShareLink(
    shareLink: ShareLink,
    now: Date,
    ttlSeconds: number,
  ): boolean {
    if (shareLink.status !== ShareLinkStatus.ACTIVE) {
      return false;
    }

    if (shareLink.maxViews !== null) {
      return false;
    }

    if (
      shareLink.expiresAt !== null &&
      shareLink.expiresAt.getTime() - now.getTime() <= ttlSeconds * 1000
    ) {
      return false;
    }

    return true;
  }

  private buildPublicWatchCacheKey(host: string, tokenOrAlias: string): string {
    return buildCacheKey("public:watch", host, hashCacheKeyPart(tokenOrAlias));
  }

  private buildPublicLocalMediaMetadataCacheKey(
    host: string,
    tokenOrAlias: string,
    videoId: string,
  ): string {
    return buildCacheKey(
      "media:metadata:public:local-video",
      host,
      hashCacheKeyPart(tokenOrAlias),
      videoId,
    );
  }

  private getDeniedReason(
    shareLink: ShareLinkViewPolicy,
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
    shareLink: ShareLinkViewPolicy,
    now: Date,
  ): Promise<boolean> {
    const where: ShareLinkWhereInput = {
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

  /**
   * Narrows a candidate list to the videos that are publicly playable.
   *
   * SIGNS NOTHING. This runs BEFORE the authoritative view consumption, so it
   * must never mint a playback credential - it only answers "could this be
   * served?". Bunny playability is therefore decided by
   * `BunnyStreamService.canSignEmbedUrl()`, a pure configuration check, not by
   * attempting a signature.
   */
  private selectPublicPlayableVideos(
    videos: PublicWatchVideoWithBinary[],
  ): PublicWatchVideoWithBinary[] {
    return videos.filter((video) => this.isPublicPlayableVideo(video));
  }

  /**
   * Serializes the public video payload, minting playback credentials.
   *
   * MUST ONLY BE CALLED AFTER the authoritative atomic view consumption has
   * succeeded. It issues HMAC media grants and signs Bunny embed URLs; a
   * request whose consumption failed must never reach this method.
   */
  private toPublicVideoResponses(
    videos: PublicWatchVideoWithBinary[],
    playbackContext: { host: string; token: string },
    shareLink: Pick<ShareLink, "id" | "maxViews" | "expiresAt"> | undefined,
    /**
     * Result of the authoritative database gate, computed by the caller after
     * consumption. Deliberately REQUIRED: a caller that forgot it would
     * otherwise silently sign from cached state. An empty map signs nothing.
     */
    signableBunnyVideoIds: Map<string, string>,
  ): PublicWatchVideoResponse[] {
    return this.selectPublicPlayableVideos(videos).map((video) => {
      const grant =
        shareLink === undefined || shareLink.maxViews === null
          ? undefined
          : this.publicMediaGrantService.issue({
              shareLinkId: shareLink.id,
              videoId: video.id,
              host: playbackContext.host,
              shareLinkExpiresAt: shareLink.expiresAt,
            });
      const binaryPlaybackUrl =
        video.sourceType === VideoSourceType.DB_BLOB
          ? this.buildPublicBinaryPlaybackUrl({
              token: playbackContext.token,
              videoId: video.id,
              host: playbackContext.host,
              grant,
            })
          : null;
      const localPlaybackUrl =
        video.sourceType === VideoSourceType.LOCAL_FILE
          ? this.buildPublicLocalPlaybackUrl({
              token: playbackContext.token,
              videoId: video.id,
              host: playbackContext.host,
              grant,
            })
          : null;
      const localThumbnailUrl =
        video.sourceType === VideoSourceType.LOCAL_FILE &&
        this.isPlayableImageAsset(video.localThumbnailAsset ?? null)
          ? this.buildPublicLocalThumbnailUrl({
              token: playbackContext.token,
              videoId: video.id,
              host: playbackContext.host,
              grant,
            })
          : null;
      const thumbnailUrl =
        video.sourceType === VideoSourceType.LOCAL_FILE
          ? localThumbnailUrl
          : this.toSafePublicMediaUrl(video.thumbnailUrl);
      // Bunny-backed assets only. Every other source type - including a
      // legacy `provider: BUNNY` DIRECT_URL record - falls through with
      // `video.embedUrl` untouched.
      const embedUrl = this.resolvePublicEmbedUrl(video, signableBunnyVideoIds);

      return {
        id: video.id,
        title: video.title,
        description: video.description,
        sourceType: video.sourceType,
        playbackUrl:
          video.sourceType === VideoSourceType.DB_BLOB ||
          video.sourceType === VideoSourceType.LOCAL_FILE
            ? null
            : this.toSafePublicMediaUrl(video.playbackUrl),
        binaryPlaybackUrl,
        publicPlaybackUrl:
          video.sourceType === VideoSourceType.DB_BLOB
            ? binaryPlaybackUrl
            : localPlaybackUrl,
        binaryAsset:
          video.sourceType === VideoSourceType.DB_BLOB
            ? this.toPublicBinaryAssetResponse(video.binaryAsset ?? null)
            : null,
        localFileAsset:
          video.sourceType === VideoSourceType.LOCAL_FILE
            ? this.toPublicLocalAssetResponse(video.localFileAsset ?? null)
            : null,
        embedUrl,
        embedProvider: video.embedProvider,
        embedAllow: video.embedAllow,
        thumbnailUrl,
        publicThumbnailUrl:
          video.sourceType === VideoSourceType.LOCAL_FILE
            ? localThumbnailUrl
            : thumbnailUrl,
        durationSeconds: video.durationSeconds,
        viewCount: video.viewCount.toString(),
        publishedAt: video.publishedAt?.toISOString() ?? null,
      };
    });
  }

  /**
   * AUTHORITATIVE DATABASE GATE for Bunny playback signing.
   *
   * WHY THIS EXISTS - and why a cache invalidation cannot replace it.
   *
   * `MemoryCacheService` is PROCESS-LOCAL. Reconciliation that runs anywhere
   * else - `yarn reconcile:bunny --apply`, a second API worker, a manual
   * database fix - commits `status = FAILED` + `remoteMissing` to the database
   * but has no way to reach this process's `public:watch:` entries. Without
   * this gate, a cached READY row would keep minting fresh signed Bunny URLs
   * for a video Bunny has already deleted, for as long as the entry lives.
   *
   * So public Bunny signing no longer trusts cached metadata for the decision
   * that matters. Immediately before a token is minted, the CURRENT row is
   * re-read from the database and must still satisfy every condition:
   *
   *   1. the `VideoAsset` still exists;
   *   2. `status === READY`;
   *   3. it still passes the existing strict `classifyBunnyVideoAsset()`
   *      predicate - the same one used everywhere else, not a weaker copy;
   *   4. `metadataJson.bunnyStream.remoteMissing` is absent;
   *   5. the authoritative Bunny video id equals the one the cached row asked
   *      to sign.
   *
   * Anything else FAILS CLOSED: the video is simply absent from the returned
   * map, `resolvePublicEmbedUrl()` emits `null`, and no token is minted. It
   * never falls back to the stored unsigned `embedUrl`.
   *
   * PERFORMANCE. **ONE** batched, primary-key-indexed local query for the whole
   * response, and only when the share actually contains a Bunny-backed video -
   * a share with none issues no query at all. It performs **no** Bunny
   * Management API request: remote existence remains eventual-consistency state
   * maintained by sync and reconciliation, never re-validated per view.
   *
   * ORDERING. Called by both resolution paths strictly AFTER the atomic view
   * consumption has claimed the view, preserving the existing invariant. If the
   * gate then refuses because the asset became unavailable concurrently, the
   * view is still spent - deliberately. Spending one view is strictly better
   * than issuing playback for a known-unavailable asset.
   *
   * Returns videoId -> authoritative Bunny video id for the assets that may be
   * signed right now.
   */
  private async loadSignableBunnyVideoIds(
    videos: PublicWatchVideoWithBinary[],
  ): Promise<Map<string, string>> {
    // Candidates are decided from the cached rows only so the query stays
    // small; the database is what decides whether each one may actually sign.
    const candidateIds = videos
      .filter((video) => classifyBunnyVideoAsset(video).kind === "bunny")
      .map((video) => video.id);

    if (candidateIds.length === 0) {
      return new Map();
    }

    let currentRows: Array<{
      id: string;
      status: VideoStatus;
      provider: VideoProvider;
      sourceType: VideoSourceType;
      providerAssetId: string | null;
      playbackId: string | null;
      metadataJson: Prisma.JsonValue | null;
    }>;

    try {
      currentRows = await this.prisma.videoAsset.findMany({
        where: { id: { in: candidateIds } },
        select: {
          id: true,
          status: true,
          provider: true,
          sourceType: true,
          providerAssetId: true,
          // Part of the Bunny identification predicate - see
          // `classifyBunnyVideoAsset()`.
          playbackId: true,
          metadataJson: true,
        },
      });
    } catch (error) {
      // FAIL CLOSED on a database error too. Returning an empty map costs a
      // Bunny video its playback for this request; assuming the cached row is
      // still valid could hand out a token for a deleted asset.
      this.logger.error(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "Authoritative Bunny signing gate could not read the current video rows.",
      );

      return new Map();
    }

    const signable = new Map<string, string>();

    for (const row of currentRows) {
      // (2) Current status, read from the database - not from the cache.
      if (row.status !== VideoStatus.READY) {
        continue;
      }

      // (4) Reconciled as gone from Bunny.
      if (isBunnyRemoteMissing(row.metadataJson)) {
        continue;
      }

      // (3) The same strict predicate as every other Bunny branch.
      const classification = classifyBunnyVideoAsset(row);
      if (classification.kind !== "bunny") {
        continue;
      }

      signable.set(row.id, classification.bunnyVideoId);
    }

    // (1) A row that no longer exists is simply absent from `currentRows`, so
    // it never reaches the map and fails closed by construction.
    return signable;
  }

  /**
   * Mints the embed URL the public browser is allowed to see.
   *
   * AUTHORIZATION AND CONSUMPTION BEFORE SIGNING. This runs inside
   * `toPublicVideoResponses`, which is only ever reached after the full chain
   * has passed - host → `ACTIVE` domain → `ACTIVE` website → share link found
   * within that website → status / expiry / `maxViews` → `ShareLinkVideo`
   * membership → `ACTIVE` `WebsiteVideo` assignment → `READY` - **and** after
   * `incrementShareLinkView()` has atomically claimed the view. There is no
   * other caller and no other path to a signed Bunny URL.
   *
   * It runs on every resolution, including cached-metadata hits, because the
   * watch cache stores raw video rows rather than serialized responses. A
   * viewer reloading a valid share page therefore receives a newly signed URL.
   *
   * FAIL CLOSED for the Bunny EMBED shape: a `bunny-malformed` record returns
   * `null` rather than its stored unsigned `embedUrl`. For everything else -
   * ordinary `EMBED`, legacy `provider: BUNNY` `DIRECT_URL`, Cloudinary,
   * `LOCAL_FILE`, `DB_BLOB` - the stored value is returned unchanged.
   */
  private resolvePublicEmbedUrl(
    video: PublicWatchVideoWithBinary,
    signableBunnyVideoIds: Map<string, string>,
  ): string | null {
    const classification = classifyBunnyVideoAsset(video);

    if (classification.kind === "not-bunny") {
      return video.embedUrl;
    }

    if (classification.kind === "bunny-malformed") {
      // Never emit the stored unsigned Bunny URL. `isPublicPlayableVideo()`
      // already filtered this record out; this is the second line of defence.
      return null;
    }

    // AUTHORITATIVE GATE - see `loadSignableBunnyVideoIds()`. Absent means the
    // current database row failed at least one condition, so this request must
    // mint nothing, whatever the cached row said.
    const authoritativeBunnyVideoId = signableBunnyVideoIds.get(video.id);
    if (authoritativeBunnyVideoId === undefined) {
      return null;
    }

    // (5) Identifier agreement. A cached row pointing at a different Bunny
    // video than the one the database now holds must never be signed - with
    // either id.
    if (authoritativeBunnyVideoId !== classification.bunnyVideoId) {
      this.logger.warn(
        { videoId: video.id },
        "Cached Bunny video id no longer matches the stored record; refusing to sign.",
      );

      return null;
    }

    return this.signBunnyEmbedUrl(classification.bunnyVideoId, video.id);
  }

  /**
   * Whether a Bunny embed URL could be signed right now.
   *
   * MINTS NOTHING. Used by `isPublicPlayableVideo()`, which runs before the
   * authoritative view consumption and therefore must not produce a playback
   * credential.
   */
  private canSignBunnyEmbedUrl(): boolean {
    return this.bunnyStreamService?.canSignEmbedUrl() === true;
  }

  /**
   * Signs a short-lived Bunny embed URL, or returns null when it cannot.
   *
   * Fail closed: if Bunny is disabled or misconfigured the caller emits `null`
   * rather than the stored unsigned URL, which would hand out a permanent,
   * unauthorized Bunny link.
   *
   * MUST ONLY BE CALLED AFTER the atomic view consumption has succeeded.
   */
  private signBunnyEmbedUrl(
    bunnyVideoId: string,
    videoId: string,
  ): string | null {
    if (!this.canSignBunnyEmbedUrl() || this.bunnyStreamService === undefined) {
      return null;
    }

    try {
      return this.bunnyStreamService.createSignedEmbedUrl(
        bunnyVideoId,
        new Date(),
        PUBLIC_BUNNY_PLAYER_PARAMS,
      ).embedUrl;
    } catch (error) {
      this.logger.error(
        {
          videoId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "Bunny Stream embed signing failed during public watch resolution.",
      );

      return null;
    }
  }

  private isPublicPlayableVideo(video: PublicWatchVideoWithBinary): boolean {
    if (video.status !== VideoStatus.READY) {
      return false;
    }

    if (video.sourceType === VideoSourceType.EMBED) {
      const classification = classifyBunnyVideoAsset(video);

      // A record that structurally claims to be a new-style Bunny asset but
      // fails the predicate is never publicly playable. It must not fall
      // through to generic embed handling, which would serve its stored
      // unsigned Bunny URL.
      if (classification.kind === "bunny-malformed") {
        return false;
      }

      // A valid Bunny asset is playable only while a signature could actually
      // be produced. This is a pure configuration check - it mints nothing -
      // because this method runs BEFORE the atomic view consumption.
      if (classification.kind === "bunny") {
        return this.canSignBunnyEmbedUrl();
      }

      return video.embedUrl !== null && video.embedUrl.trim() !== "";
    }

    if (video.sourceType === VideoSourceType.DB_BLOB) {
      return this.isPlayableBinaryAsset(video.binaryAsset ?? null);
    }

    if (video.sourceType === VideoSourceType.LOCAL_FILE) {
      return this.isPlayableLocalAsset(video.localFileAsset ?? null);
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

  private toPublicLocalAssetResponse(
    localAsset: PublicLocalAssetMetadata | null,
  ): { mimeType: string; sizeBytes: string } | null {
    if (!this.isPlayableLocalAsset(localAsset)) {
      return null;
    }

    return {
      mimeType: localAsset.mimeType,
      sizeBytes: localAsset.sizeBytes.toString(),
    };
  }

  private async getAuthorizedPublicDatabaseBinaryAsset(
    params: PublicDatabaseVideoBinaryParams,
  ): Promise<PublicBinaryAssetMetadata> {
    const normalizedHost = normalizePublicHost(params.host);
    const trimmedToken = this.normalizePublicToken(params.token);

    if (
      normalizedHost === null ||
      trimmedToken === null ||
      !this.isValidPublicVideoId(params.videoId) ||
      !this.isValidMediaGrantInput(params.grant)
    ) {
      throw new NotFoundException("Video not found.");
    }

    const domainRecord = await this.prisma.websiteDomain.findUnique({
      where: { domain: normalizedHost },
      include: { website: true },
    });

    if (
      domainRecord === null ||
      domainRecord.website === null ||
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

    const binaryInclude = {
      shareLinkVideos: {
        where: {
          videoId: params.videoId,
          video: {
            websiteVideos: {
              some: {
                websiteId: domainRecord.website.id,
                status: AssignmentStatus.ACTIVE,
              },
            },
          },
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
    };

    const shareLink =
      (await this.prisma.shareLink.findFirst({
        where: {
          alias: trimmedToken,
          websiteId: domainRecord.website.id,
        },
        include: binaryInclude,
      })) ??
      (await this.prisma.shareLink.findFirst({
        where: {
          tokenHash,
          websiteId: domainRecord.website.id,
        },
        include: binaryInclude,
      }));

    if (
      shareLink === null ||
      this.getDeniedReasonForMediaPlayback(shareLink, new Date()) !== null ||
      !this.hasValidMediaGrant(shareLink, params, normalizedHost)
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

  private getDeniedReasonForMediaPlayback(
    shareLink: ShareLink,
    now: Date,
  ): PublicWatchReasonCode | null {
    if (shareLink.status !== ShareLinkStatus.ACTIVE) {
      return "INVALID_LINK";
    }

    if (shareLink.expiresAt !== null && shareLink.expiresAt <= now) {
      return "EXPIRED_LINK";
    }

    return null;
  }

  private async getAuthorizedPublicLocalFileAsset(
    params: PublicLocalVideoFileParams,
  ): Promise<Required<PublicLocalAssetMetadata>> {
    const video = await this.getAuthorizedPublicLocalVideo(params);
    const localFileAsset = video?.localFileAsset ?? null;

    if (
      !this.isPlayableLocalAsset(localFileAsset) ||
      !localFileAsset.storageKey
    ) {
      throw new NotFoundException("Video not found.");
    }

    return localFileAsset as Required<PublicLocalAssetMetadata>;
  }

  private async getAuthorizedPublicLocalThumbnailAsset(
    params: PublicLocalThumbnailParams,
  ): Promise<Required<PublicLocalAssetMetadata>> {
    const video = await this.getAuthorizedPublicLocalVideo(params);
    const localThumbnailAsset = video?.localThumbnailAsset ?? null;

    if (
      !this.isPlayableImageAsset(localThumbnailAsset) ||
      !localThumbnailAsset.storageKey
    ) {
      throw new NotFoundException("Video not found.");
    }

    return localThumbnailAsset as Required<PublicLocalAssetMetadata>;
  }

  private async getAuthorizedPublicLocalVideo(params: {
    host: string;
    token: string;
    videoId: string;
    grant?: string | undefined;
  }): Promise<PublicWatchVideoWithBinary> {
    const normalizedHost = normalizePublicHost(params.host);
    const trimmedToken = this.normalizePublicToken(params.token);

    if (
      normalizedHost === null ||
      trimmedToken === null ||
      !this.isValidPublicVideoId(params.videoId) ||
      !this.isValidMediaGrantInput(params.grant)
    ) {
      throw new NotFoundException("Video not found.");
    }

    const cacheKey = this.buildPublicLocalMediaMetadataCacheKey(
      normalizedHost,
      trimmedToken,
      params.videoId,
    );
    const cachedVideo =
      this.memoryCache?.get<PublicWatchVideoWithBinary>(cacheKey) ?? null;
    if (cachedVideo !== null) {
      return cachedVideo;
    }

    const { shareLink, video } = await this.loadAuthorizedPublicLocalVideo({
      normalizedHost,
      trimmedToken,
      videoId: params.videoId,
    });
    if (!this.hasValidMediaGrant(shareLink, params, normalizedHost)) {
      throw new NotFoundException("Video not found.");
    }
    const ttlSeconds =
      this.memoryCache?.getRuntimeConfig().mediaMetadataTtlSeconds ?? null;
    if (
      this.memoryCache !== undefined &&
      ttlSeconds !== null &&
      this.canCachePublicWatchShareLink(shareLink, new Date(), ttlSeconds)
    ) {
      this.memoryCache.set(cacheKey, video, { ttlSeconds });
    }

    return video;
  }

  private async loadAuthorizedPublicLocalVideo(params: {
    normalizedHost: string;
    trimmedToken: string;
    videoId: string;
  }): Promise<{ shareLink: ShareLink; video: PublicWatchVideoWithBinary }> {
    const domainRecord = await this.prisma.websiteDomain.findUnique({
      where: { domain: params.normalizedHost },
      include: { website: true },
    });

    if (
      domainRecord === null ||
      domainRecord.website === null ||
      domainRecord.status !== DomainStatus.ACTIVE ||
      domainRecord.website.status !== WebsiteStatus.ACTIVE
    ) {
      throw new NotFoundException("Video not found.");
    }

    const tokenPepper = this.configService
      .get<string>("SHARE_TOKEN_PEPPER")
      ?.trim();

    if (!tokenPepper) {
      this.logger.error(
        "SHARE_TOKEN_PEPPER is missing for public local video.",
      );
      throw new NotFoundException("Video not found.");
    }

    const tokenHash = hashShareToken({
      pepper: tokenPepper,
      token: params.trimmedToken,
    });

    const localVideoInclude = {
      shareLinkVideos: {
        where: {
          videoId: params.videoId,
          video: {
            websiteVideos: {
              some: {
                websiteId: domainRecord.website.id,
                status: AssignmentStatus.ACTIVE,
              },
            },
          },
        },
        take: 1,
        include: {
          video: {
            include: {
              localFileAsset: {
                select: {
                  storageKey: true,
                  mimeType: true,
                  sizeBytes: true,
                },
              },
              localThumbnailAsset: {
                select: {
                  storageKey: true,
                  mimeType: true,
                  sizeBytes: true,
                },
              },
            },
          },
        },
      },
    };

    const shareLink =
      (await this.prisma.shareLink.findFirst({
        where: {
          alias: params.trimmedToken,
          websiteId: domainRecord.website.id,
        },
        include: localVideoInclude,
      })) ??
      (await this.prisma.shareLink.findFirst({
        where: {
          tokenHash,
          websiteId: domainRecord.website.id,
        },
        include: localVideoInclude,
      }));

    if (
      shareLink === null ||
      this.getDeniedReasonForMediaPlayback(shareLink, new Date()) !== null
    ) {
      throw new NotFoundException("Video not found.");
    }

    const video = shareLink.shareLinkVideos[0]?.video;

    if (
      video === undefined ||
      video.status !== VideoStatus.READY ||
      video.sourceType !== VideoSourceType.LOCAL_FILE ||
      !this.isPlayableLocalAsset(video.localFileAsset ?? null)
    ) {
      throw new NotFoundException("Video not found.");
    }

    return { shareLink, video };
  }

  private async getAuthorizedPublicVideoForView(params: {
    host: string;
    token: string;
    videoId: string;
  }): Promise<{
    website: Website;
    shareLink: ShareLink;
    video: PublicWatchVideoWithBinary;
  } | null> {
    const normalizedHost = normalizePublicHost(params.host);
    const trimmedToken = this.normalizePublicToken(params.token);

    if (
      normalizedHost === null ||
      trimmedToken === null ||
      !this.isValidPublicVideoId(params.videoId)
    ) {
      return null;
    }

    const domainRecord = await this.prisma.websiteDomain.findUnique({
      where: { domain: normalizedHost },
      include: { website: true },
    });

    if (
      domainRecord === null ||
      domainRecord.website === null ||
      domainRecord.status !== DomainStatus.ACTIVE ||
      domainRecord.website.status !== WebsiteStatus.ACTIVE
    ) {
      return null;
    }

    const tokenPepper = this.configService
      .get<string>("SHARE_TOKEN_PEPPER")
      ?.trim();

    if (!tokenPepper) {
      this.logger.error(
        "SHARE_TOKEN_PEPPER is missing for public video view tracking.",
      );
      return null;
    }

    const tokenHash = hashShareToken({
      pepper: tokenPepper,
      token: trimmedToken,
    });

    const publicViewInclude = {
      shareLinkVideos: {
        where: {
          videoId: params.videoId,
          video: {
            websiteVideos: {
              some: {
                websiteId: domainRecord.website.id,
                status: AssignmentStatus.ACTIVE,
              },
            },
          },
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
              localFileAsset: {
                select: {
                  storageKey: true,
                  mimeType: true,
                  sizeBytes: true,
                },
              },
              localThumbnailAsset: {
                select: {
                  storageKey: true,
                  mimeType: true,
                  sizeBytes: true,
                },
              },
            },
          },
        },
      },
    };

    const shareLink =
      (await this.prisma.shareLink.findFirst({
        where: {
          alias: trimmedToken,
          websiteId: domainRecord.website.id,
        },
        include: publicViewInclude,
      })) ??
      (await this.prisma.shareLink.findFirst({
        where: {
          tokenHash,
          websiteId: domainRecord.website.id,
        },
        include: publicViewInclude,
      }));

    if (
      shareLink === null ||
      this.getDeniedReasonForMediaPlayback(shareLink, new Date())
    ) {
      return null;
    }

    const video = shareLink.shareLinkVideos[0]?.video;

    if (video === undefined || !this.isPublicPlayableVideo(video)) {
      return null;
    }

    return {
      website: domainRecord.website,
      shareLink,
      video,
    };
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

  private isPlayableLocalAsset(
    localAsset: PublicLocalAssetMetadata | null,
  ): localAsset is PublicLocalAssetMetadata {
    return (
      localAsset !== null &&
      localAsset.mimeType.startsWith("video/") &&
      localAsset.sizeBytes > BigInt(0)
    );
  }

  private isPlayableImageAsset(
    localAsset: PublicLocalAssetMetadata | null,
  ): localAsset is PublicLocalAssetMetadata {
    return (
      localAsset !== null &&
      localAsset.mimeType.startsWith("image/") &&
      localAsset.sizeBytes > BigInt(0)
    );
  }

  private toSafePublicMediaUrl(url: string | null): string | null {
    const trimmedUrl = url?.trim();

    if (!trimmedUrl || this.isAdminEndpointUrl(trimmedUrl)) {
      return null;
    }

    return trimmedUrl;
  }

  private isAdminEndpointUrl(url: string): boolean {
    try {
      const parsed = new URL(url, "http://public-media.local");
      const pathSegments = parsed.pathname
        .split("/")
        .map((segment) => segment.toLowerCase())
        .filter(Boolean);

      return pathSegments.includes("admin");
    } catch {
      return url.toLowerCase().split(/[?#]/, 1)[0].split("/").includes("admin");
    }
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
    grant?: string | undefined;
  }): string {
    const rawPrefix = this.configService.get<string>("API_PREFIX") ?? "api/v1";
    const prefix = rawPrefix.replace(/^\/+|\/+$/g, "") || "api/v1";
    const query = this.buildPublicMediaQuery(params.host, params.grant);

    return `/${prefix}/public/watch/${encodeURIComponent(
      params.token,
    )}/videos/${encodeURIComponent(params.videoId)}/binary?${query.toString()}`;
  }

  private buildPublicLocalPlaybackUrl(params: {
    token: string;
    videoId: string;
    host: string;
    grant?: string | undefined;
  }): string {
    const rawPrefix = this.configService.get<string>("API_PREFIX") ?? "api/v1";
    const prefix = rawPrefix.replace(/^\/+|\/+$/g, "") || "api/v1";
    const query = this.buildPublicMediaQuery(params.host, params.grant);

    return `/${prefix}/public/watch/${encodeURIComponent(
      params.token,
    )}/videos/${encodeURIComponent(params.videoId)}/local-file?${query.toString()}`;
  }

  private buildPublicLocalThumbnailUrl(params: {
    token: string;
    videoId: string;
    host: string;
    grant?: string | undefined;
  }): string {
    const rawPrefix = this.configService.get<string>("API_PREFIX") ?? "api/v1";
    const prefix = rawPrefix.replace(/^\/+|\/+$/g, "") || "api/v1";
    const query = this.buildPublicMediaQuery(params.host, params.grant);

    return `/${prefix}/public/watch/${encodeURIComponent(
      params.token,
    )}/videos/${encodeURIComponent(params.videoId)}/thumbnail?${query.toString()}`;
  }

  private toPublicWebsiteResponse(
    website: Pick<Website, "id" | "name" | "slug">,
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
    _reasonCode: PublicWatchReasonCode,
    _website?: Pick<Website, "id" | "name" | "slug">,
    _domain: string | null = null,
  ): PublicWatchResponse {
    return {
      valid: false,
      reasonCode: "INVALID_LINK",
      website: null,
      videos: [],
    };
  }

  private hasValidMediaGrant(
    shareLink: ShareLink,
    params: { videoId: string; grant?: string | undefined },
    normalizedHost: string,
  ): boolean {
    if (shareLink.maxViews === null) {
      return true;
    }

    return this.publicMediaGrantService.verify(params.grant, {
      shareLinkId: shareLink.id,
      videoId: params.videoId,
      host: normalizedHost,
    });
  }

  private buildPublicMediaQuery(
    host: string,
    grant: string | undefined,
  ): URLSearchParams {
    return new URLSearchParams({
      host,
      ...(grant === undefined ? {} : { grant }),
    });
  }

  private normalizePublicToken(value: unknown): string | null {
    if (typeof value !== "string" || value.length > 256) {
      return null;
    }

    const normalized = value.trim();
    return normalized.length === 0 ? null : normalized;
  }

  private isValidPublicVideoId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 191;
  }

  private isValidMediaGrantInput(value: unknown): value is string | undefined {
    return (
      value === undefined ||
      (typeof value === "string" && value.length > 0 && value.length <= 2048)
    );
  }

  private invalidVideoViewResponse(): PublicVideoViewResponse {
    return {
      valid: false,
      videoId: null,
      viewCount: null,
      publishedAt: null,
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

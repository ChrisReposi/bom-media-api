import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { buildCacheKey } from "../cache/memory-cache-key.util";
import { MemoryCacheService } from "../cache/memory-cache.service";
import { CloudinaryService } from "../cloudinary/cloudinary.service";
import { PrismaService } from "../database/prisma.service";
import {
  AssignmentStatus,
  AuditStatus,
  EmbedProvider,
  Prisma,
  ShareLinkStatus,
  VideoProvider,
  VideoSourceType,
  VideoUploadSessionStatus,
  VideoStatus,
  type VideoAsset,
} from "../generated/prisma/client";
import type { CompleteLocalVideoUploadDto } from "./dto/complete-local-video-upload.dto";
import type { CreateEmbedVideoDto } from "./dto/create-embed-video.dto";
import type { CreateVideoDto } from "./dto/create-video.dto";
import type { InitLocalVideoUploadDto } from "./dto/init-local-video-upload.dto";
import type { ListVideosQueryDto } from "./dto/list-videos-query.dto";
import {
  SORT_ORDERS,
  VIDEO_SORT_FIELDS,
  type VideoSortField,
} from "./dto/list-videos-query.dto";
import type { PurgeVideoDto } from "./dto/purge-video.dto";
import type { ReplaceDatabaseVideoBinaryDto } from "./dto/replace-database-video-binary.dto";
import type { UploadDatabaseVideoDto } from "./dto/upload-database-video.dto";
import type { UploadLocalVideoChunkDto } from "./dto/upload-local-video-chunk.dto";
import type { UpdateVideoDto } from "./dto/update-video.dto";
import type { UploadVideoDto } from "./dto/upload-video.dto";
import type {
  CancelLocalVideoUploadResponse,
  DisableVideoResponse,
  InitLocalVideoUploadResponse,
  LocalVideoChunkUploadResponse,
  PurgeVideoResponse,
  VideoUploadSessionResponse,
  VideoListResponse,
  VideoResponse,
} from "./types/video-response.type";
import { buildCloudinaryVideoThumbnailUrl } from "./utils/cloudinary-video.util";
import {
  isValidVideoFilterKey,
  normalizeVideoFilterKey,
} from "./utils/video-filter-key.util";
import {
  escapeAdminVideoSearchLike,
  isShortAdminVideoSearch,
  normalizeAdminVideoSearch,
} from "./utils/video-search.util";
import {
  DEFAULT_VIDEO_EMBED_ALLOW,
  DEFAULT_VIDEO_EMBED_ALLOWED_HOSTS,
  parseVideoEmbedInput,
  type ParsedVideoEmbed,
} from "./utils/video-embed.util";
import { createVideoSlug } from "./utils/video-slug.util";
import { computeSha256Hex } from "./utils/video-checksum.util";
import { VideoMetadataService } from "./metadata/video-metadata.service";
import {
  LocalVideoStorageService,
  type LocalStorageRangeResult,
} from "./storage/local-video-storage.service";

type VideoMutationAction =
  | "VIDEO_CREATE"
  | "VIDEO_EMBED_CREATE"
  | "VIDEO_UPLOAD"
  | "VIDEO_DB_UPLOAD"
  | "VIDEO_LOCAL_UPLOAD_INIT"
  | "VIDEO_LOCAL_CHUNK_UPLOAD"
  | "VIDEO_LOCAL_UPLOAD_COMPLETE"
  | "VIDEO_LOCAL_UPLOAD_CANCEL"
  | "VIDEO_LOCAL_THUMBNAIL_UPDATE"
  | "VIDEO_DB_BINARY_REPLACE"
  | "VIDEO_UPDATE"
  | "VIDEO_DISABLE"
  | "VIDEO_PURGE_COMMIT"
  | "VIDEO_PURGE_STORAGE";

const DEFAULT_DB_UPLOAD_MAX_MB = 50;
const MAX_DB_UPLOAD_MAX_MB = 100;
const DEFAULT_THUMBNAIL_UPLOAD_MAX_MB = 5;
const MAX_THUMBNAIL_UPLOAD_MAX_MB = 10;
const DATABASE_PACKET_OVERHEAD_RATIO = 0.15;
const DATABASE_PACKET_MIN_OVERHEAD_BYTES = 5 * 1024 * 1024;
const RECOMMENDED_DATABASE_PACKET_MB = 256;

type VideoAssetWithBinaryMetadata = VideoAsset & {
  binaryAsset?: {
    mimeType: string;
    sizeBytes: bigint;
  } | null;
  localFileAsset?: {
    mimeType: string;
    sizeBytes: bigint;
    checksumSha256: string | null;
    originalFilename: string;
  } | null;
  localThumbnailAsset?: {
    mimeType: string;
    sizeBytes: bigint;
    checksumSha256: string | null;
    originalFilename: string;
  } | null;
};

type AdminLocalMediaMetadata = {
  storageKey: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: bigint;
  checksumSha256: string | null;
  updatedAt: Date;
};

export type DatabaseVideoBinary = {
  mimeType: string;
  sizeBytes: bigint;
  data: Buffer;
};

export type LocalVideoFileStream = LocalStorageRangeResult & {
  mimeType: string;
};

export type LocalThumbnailStream = {
  mimeType: string;
  contentLength: number;
  stream: NodeJS.ReadableStream;
};

type ResolvedThumbnail = {
  thumbnailUrl: string | null;
  thumbnailMetadata: Record<string, unknown> | null;
};

type VideoAssetUpdateInput = Prisma.Args<
  PrismaService["videoAsset"],
  "update"
>["data"];
type VideoAssetWhereInput = NonNullable<
  Prisma.Args<PrismaService["videoAsset"], "findMany">["where"]
>;
type VideoAssetOrderByInput = NonNullable<
  Prisma.Args<PrismaService["videoAsset"], "findMany">["orderBy"]
>;
type LocalUploadSessionWithChunks = {
  id: string;
  adminId: string;
  title: string;
  slug: string | null;
  description: string | null;
  originalFilename: string;
  mimeType: string;
  totalBytes: bigint;
  totalChunks: number;
  chunkSizeBytes: number;
  checksumSha256: string | null;
  tempStorageKey: string;
  metadataJson: Prisma.JsonValue | null;
  status: VideoUploadSessionStatus;
  expiresAt: Date;
  chunks: Array<{
    chunkIndex: number;
    sizeBytes: bigint;
    checksumSha256: string | null;
    storageKey: string;
  }>;
};

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinaryService: CloudinaryService,
    private readonly configService: ConfigService,
    private readonly videoMetadataService: VideoMetadataService,
    private readonly localVideoStorageService: LocalVideoStorageService,
    @Optional() private readonly memoryCache?: MemoryCacheService,
  ) {}

  async listVideos(query: ListVideosQueryDto): Promise<VideoListResponse> {
    const page = this.resolveVideoListPage(query.page);
    const limit = this.resolveVideoListLimit(query.limit);
    const normalizedSearch = normalizeAdminVideoSearch(query.search);
    const normalizedFilterKey = this.normalizeOptionalVideoFilterKey(
      query.filterKey,
    );
    const sortBy = this.resolveVideoSortField(query.sortBy);
    const sortOrder = this.resolveVideoSortOrder(query.sortOrder);
    const hasSearchInput =
      typeof query.search === "string" && query.search.trim() !== "";

    if (hasSearchInput && isShortAdminVideoSearch(normalizedSearch)) {
      return this.buildEmptyVideoListResponse(page, limit);
    }

    const loader = () =>
      this.loadVideoListFromDatabase({
        query,
        page,
        limit,
        normalizedSearch,
        normalizedFilterKey,
        sortBy,
        sortOrder,
      });
    const cacheKey = this.buildAdminVideoListCacheKey({
      page,
      limit,
      normalizedSearch,
      filterKey: normalizedFilterKey,
      status: query.status,
      provider: query.provider,
      sortBy,
      sortOrder,
    });

    return (
      this.memoryCache?.getOrSet(cacheKey, loader, {
        ttlSeconds:
          this.memoryCache.getRuntimeConfig().adminVideosListTtlSeconds,
      }) ?? loader()
    );
  }

  private async loadVideoListFromDatabase(params: {
    query: ListVideosQueryDto;
    page: number;
    limit: number;
    normalizedSearch: string;
    normalizedFilterKey: string | undefined;
    sortBy: VideoSortField;
    sortOrder: "asc" | "desc";
  }): Promise<VideoListResponse> {
    const skip = (params.page - 1) * params.limit;
    const where = this.buildVideoWhere(
      params.query,
      params.normalizedSearch,
      params.normalizedFilterKey,
    );
    const orderBy = this.buildVideoOrderBy(params.sortBy, params.sortOrder);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.videoAsset.findMany({
        where,
        orderBy,
        skip,
        take: params.limit,
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
        },
      }),
      this.prisma.videoAsset.count({ where }),
    ]);

    return {
      items: items.map((video) => this.toVideoResponse(video)),
      meta: {
        page: params.page,
        limit: params.limit,
        total,
        totalPages: Math.ceil(total / params.limit),
      },
    };
  }

  async getVideo(id: string): Promise<VideoResponse> {
    const video = await this.prisma.videoAsset.findUnique({
      where: { id },
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
      },
    });

    if (video === null) {
      throw new NotFoundException("Video not found.");
    }

    return this.toVideoResponse(video);
  }

  async createVideo(
    dto: CreateVideoDto,
    adminId: string,
    thumbnailFile?: Express.Multer.File,
  ): Promise<VideoResponse> {
    const slug = await this.ensureUniqueSlug(dto.slug ?? dto.title);
    const provider = this.resolveProvider(dto);
    const parsedEmbed =
      dto.embedUrl === undefined ? null : this.parseEmbedInput(dto.embedUrl);
    const playbackUrl = this.trimNullable(dto.playbackUrl);
    const thumbnail = await this.resolveThumbnailUrl({
      thumbnailUrl: dto.thumbnailUrl,
      thumbnailFile,
      tags: ["manual"],
    });
    const durationSeconds =
      dto.durationSeconds ??
      (parsedEmbed === null && playbackUrl !== null
        ? await this.probeRemoteDurationSeconds(playbackUrl)
        : null);
    const status =
      dto.status ??
      (playbackUrl || dto.embedUrl ? VideoStatus.READY : VideoStatus.DRAFT);

    const video = await this.prisma.videoAsset.create({
      data: {
        title: dto.title.trim(),
        slug,
        description: this.trimNullable(dto.description),
        provider,
        sourceType:
          parsedEmbed === null
            ? VideoSourceType.DIRECT_URL
            : VideoSourceType.EMBED,
        providerAssetId: this.trimNullable(dto.providerAssetId),
        playbackId: this.trimNullable(dto.playbackId),
        playbackUrl,
        embedProvider: parsedEmbed?.provider ?? null,
        embedUrl: parsedEmbed?.embedUrl ?? null,
        embedCloudName: parsedEmbed?.cloudName ?? null,
        embedPublicId: parsedEmbed?.publicId ?? null,
        embedAllow: parsedEmbed?.allow ?? null,
        thumbnailUrl: thumbnail.thumbnailUrl,
        durationSeconds,
        viewCount: this.parseViewCount(dto.viewCount),
        publishedAt: this.parseNullableDate(dto.publishedAt),
        status,
        filterKey: this.normalizeNullableVideoFilterKey(dto.filterKey),
        metadataJson: this.buildMetadataJson(
          dto.metadataJson,
          thumbnail.thumbnailMetadata,
        ),
      },
    });

    await this.writeAudit(adminId, "VIDEO_CREATE", video.id, {
      provider: video.provider,
      status: video.status,
    });
    this.invalidateAdminVideoCaches();

    return this.toVideoResponse(video);
  }

  async createEmbedVideo(
    dto: CreateEmbedVideoDto,
    adminId: string,
    thumbnailFile?: Express.Multer.File,
  ): Promise<VideoResponse> {
    const parsedEmbed = this.parseEmbedInput(dto.embedCodeOrUrl);
    const slug = await this.ensureUniqueSlug(dto.slug ?? dto.title);
    const thumbnail = await this.resolveThumbnailUrl({
      thumbnailUrl: dto.thumbnailUrl,
      thumbnailFile,
      tags: ["embed"],
    });
    const thumbnailUrl =
      thumbnail.thumbnailUrl ?? this.buildEmbedThumbnailUrl(parsedEmbed);

    const video = await this.prisma.videoAsset.create({
      data: {
        title: dto.title.trim(),
        slug,
        description: this.trimNullable(dto.description),
        provider:
          parsedEmbed.provider === EmbedProvider.CLOUDINARY_PLAYER
            ? VideoProvider.CLOUDINARY
            : VideoProvider.MANUAL,
        sourceType: VideoSourceType.EMBED,
        providerAssetId: parsedEmbed.publicId ?? null,
        playbackId: null,
        playbackUrl: null,
        embedProvider: parsedEmbed.provider,
        embedUrl: parsedEmbed.embedUrl,
        embedCloudName: parsedEmbed.cloudName ?? null,
        embedPublicId: parsedEmbed.publicId ?? null,
        embedAllow: parsedEmbed.allow,
        thumbnailUrl,
        durationSeconds: dto.durationSeconds ?? null,
        viewCount: this.parseViewCount(dto.viewCount),
        publishedAt: this.parseNullableDate(dto.publishedAt),
        status: dto.status ?? VideoStatus.READY,
        filterKey: this.normalizeNullableVideoFilterKey(dto.filterKey),
        metadataJson: this.buildMetadataJson(
          undefined,
          thumbnail.thumbnailMetadata,
        ),
      },
    });

    await this.writeAudit(adminId, "VIDEO_EMBED_CREATE", video.id, {
      embedProvider: video.embedProvider,
      provider: video.provider,
      status: video.status,
    });
    this.invalidateAdminVideoCaches();

    return this.toVideoResponse(video);
  }

  async uploadVideo(
    dto: UploadVideoDto,
    file: Express.Multer.File | undefined,
    thumbnailFile: Express.Multer.File | undefined,
    adminId: string,
  ): Promise<VideoResponse> {
    try {
      this.validateUploadFile(file);

      const tags = this.parseTags(dto.tags);
      const uploadResult = await this.cloudinaryService.uploadVideo({
        filePath: file.path,
        originalFilename: file.originalname,
        title: dto.title.trim(),
        tags,
        ...(this.trimOptional(dto.description) !== undefined
          ? { description: this.trimOptional(dto.description) }
          : {}),
      });

      const cloudName = this.cloudinaryService.getCloudName();
      const thumbnail = await this.resolveThumbnailUrl({
        thumbnailUrl: dto.thumbnailUrl,
        thumbnailFile,
        tags: [...tags, "video-upload"],
      });
      const thumbnailUrl =
        thumbnail.thumbnailUrl ??
        this.safeBuildCloudinaryThumbnailUrl(cloudName, uploadResult.publicId);
      const slug = await this.ensureUniqueSlug(dto.slug ?? dto.title);
      const uploadMetadata = this.removeUndefinedValues({
        asset_id: uploadResult.assetId,
        public_id: uploadResult.publicId,
        version: uploadResult.version,
        format: uploadResult.format,
        resource_type: uploadResult.resourceType,
        bytes: uploadResult.bytes,
        width: uploadResult.width,
        height: uploadResult.height,
        duration: uploadResult.duration,
        original_filename: uploadResult.originalFilename,
      });

      const video = await this.prisma.videoAsset.create({
        data: {
          title: dto.title.trim(),
          slug,
          description: this.trimNullable(dto.description),
          provider: VideoProvider.CLOUDINARY,
          sourceType: VideoSourceType.UPLOAD,
          providerAssetId: uploadResult.publicId,
          playbackId: uploadResult.publicId,
          playbackUrl: uploadResult.secureUrl,
          thumbnailUrl,
          durationSeconds:
            uploadResult.duration === undefined
              ? (dto.durationSeconds ?? null)
              : Math.round(uploadResult.duration),
          viewCount: this.parseViewCount(dto.viewCount),
          publishedAt: this.parseNullableDate(dto.publishedAt),
          status: dto.status ?? VideoStatus.READY,
          filterKey: this.normalizeNullableVideoFilterKey(dto.filterKey),
          metadataJson: this.buildMetadataJson(
            uploadMetadata,
            thumbnail.thumbnailMetadata,
          ),
        },
      });

      await this.writeAudit(adminId, "VIDEO_UPLOAD", video.id, {
        provider: video.provider,
        status: video.status,
      });
      this.invalidateAdminVideoCaches();

      return this.toVideoResponse(video);
    } finally {
      await this.deleteTempUploadFile(file);
      await this.deleteTempUploadFile(thumbnailFile);
    }
  }

  async uploadDatabaseVideo(
    dto: UploadDatabaseVideoDto,
    file: Express.Multer.File | undefined,
    thumbnailFile: Express.Multer.File | undefined,
    adminId: string,
  ): Promise<VideoResponse> {
    try {
      this.ensureDatabaseVideoStorageEnabled();
      this.validateDatabaseUploadFile(file);
      await this.ensureDatabaseCanAcceptBlob(file.size);

      const slug = await this.ensureUniqueSlug(dto.slug ?? dto.title);
      const thumbnail = await this.resolveThumbnailUrl({
        thumbnailUrl: dto.thumbnailUrl,
        thumbnailFile,
        tags: ["database-upload"],
      });
      const durationSeconds =
        dto.durationSeconds ??
        (await this.probeLocalDurationSeconds(file.path));
      const data = await readFile(file.path);
      const checksumSha256 = computeSha256Hex(data);

      let video: VideoAssetWithBinaryMetadata;

      try {
        video = await this.prisma.$transaction((transaction) =>
          transaction.videoAsset.create({
            data: {
              title: dto.title.trim(),
              slug,
              description: this.trimNullable(dto.description),
              provider: VideoProvider.MANUAL,
              sourceType: VideoSourceType.DB_BLOB,
              providerAssetId: null,
              playbackId: null,
              playbackUrl: null,
              embedProvider: null,
              embedUrl: null,
              embedCloudName: null,
              embedPublicId: null,
              embedAllow: null,
              thumbnailUrl: thumbnail.thumbnailUrl,
              durationSeconds,
              viewCount: this.parseViewCount(dto.viewCount),
              publishedAt: this.parseNullableDate(dto.publishedAt),
              status: dto.status ?? VideoStatus.READY,
              filterKey: this.normalizeNullableVideoFilterKey(dto.filterKey),
              metadataJson: this.buildMetadataJson(
                undefined,
                thumbnail.thumbnailMetadata,
              ),
              binaryAsset: {
                create: {
                  mimeType: file.mimetype,
                  sizeBytes: BigInt(file.size),
                  data,
                  checksumSha256,
                },
              },
            },
            include: {
              binaryAsset: {
                select: {
                  mimeType: true,
                  sizeBytes: true,
                },
              },
            },
          }),
        );
      } catch (error) {
        if (this.isDatabasePacketTooLargeError(error)) {
          throw this.createDatabasePacketLimitException();
        }

        throw error;
      }

      await this.writeAudit(adminId, "VIDEO_DB_UPLOAD", video.id, {
        provider: video.provider,
        sourceType: video.sourceType,
        status: video.status,
        mimeType: file.mimetype,
        sizeBytes: String(file.size),
      });
      this.invalidateAdminVideoCaches();

      return this.toVideoResponse(video);
    } finally {
      await this.deleteTempUploadFile(file);
      await this.deleteTempUploadFile(thumbnailFile);
    }
  }

  async initLocalVideoUpload(
    dto: InitLocalVideoUploadDto,
    adminId: string,
  ): Promise<InitLocalVideoUploadResponse> {
    await this.cleanupStaleLocalUploadSessions();
    this.localVideoStorageService.assertEnabled();
    await this.localVideoStorageService.ensureRootReady();

    const originalFilename =
      this.localVideoStorageService.sanitizeOriginalFilename(
        dto.originalFilename,
      );
    this.validateLocalVideoUploadInit(dto, originalFilename);

    const uploadId = randomUUID();
    const tempStorageKey =
      this.localVideoStorageService.buildUploadTempKey(uploadId);
    const expiresAt = new Date(
      Date.now() +
        this.localVideoStorageService.getUploadSessionTtlMinutes() * 60_000,
    );
    const metadata = this.removeUndefinedValues({
      viewCount: dto.viewCount,
      publishedAt: dto.publishedAt,
      status: dto.status,
      filterKey: this.normalizeOptionalVideoFilterKey(dto.filterKey),
      checksumSha256: dto.checksumSha256?.toLowerCase(),
    });

    const upload = await this.prisma.videoUploadSession.create({
      data: {
        id: uploadId,
        adminId,
        title: dto.title.trim(),
        slug: this.trimNullable(dto.slug),
        description: this.trimNullable(dto.description),
        originalFilename,
        mimeType: dto.mimeType.trim().toLowerCase(),
        totalBytes: BigInt(dto.totalBytes),
        totalChunks: dto.totalChunks,
        chunkSizeBytes: dto.chunkSizeBytes,
        tempStorageKey,
        checksumSha256: dto.checksumSha256?.toLowerCase() ?? null,
        expiresAt,
        metadataJson:
          Object.keys(metadata).length === 0
            ? Prisma.JsonNull
            : this.toJsonInput(metadata),
      },
      include: {
        chunks: {
          orderBy: { chunkIndex: "asc" },
        },
      },
    });

    await this.writeAudit(adminId, "VIDEO_LOCAL_UPLOAD_INIT", upload.id, {
      mimeType: upload.mimeType,
      totalBytes: upload.totalBytes.toString(),
      totalChunks: upload.totalChunks,
    });

    return {
      message: "Local video upload initialized.",
      upload: this.toUploadSessionResponse(upload),
    };
  }

  async uploadLocalVideoChunk(
    uploadId: string,
    dto: UploadLocalVideoChunkDto,
    file: Express.Multer.File | undefined,
    adminId: string,
  ): Promise<LocalVideoChunkUploadResponse> {
    try {
      await this.cleanupStaleLocalUploadSessions();
      this.validateLocalChunkFile(file);

      const upload = await this.getOwnedActiveUploadSession(uploadId, adminId);
      this.validateLocalChunkRequest(upload, dto, file);
      this.localVideoStorageService.ensureAvailableCapacity(file.size);

      const existingChunk = upload.chunks.find(
        (chunk) => chunk.chunkIndex === dto.chunkIndex,
      );
      if (existingChunk !== undefined) {
        await this.deleteTempUploadFile(file);
        if (
          existingChunk.sizeBytes === BigInt(file.size) &&
          (dto.checksumSha256 === undefined ||
            existingChunk.checksumSha256 === dto.checksumSha256.toLowerCase())
        ) {
          return {
            message: "Chunk already uploaded.",
            upload: this.toUploadSessionResponse(upload),
          };
        }

        throw new BadRequestException(
          "Chunk was already uploaded with different metadata.",
        );
      }

      const storedChunk = await this.localVideoStorageService.saveUploadedChunk(
        {
          temporaryPath: file.path,
          tempStorageKey: upload.tempStorageKey,
          chunkIndex: dto.chunkIndex,
        },
      );

      if (
        dto.checksumSha256 !== undefined &&
        storedChunk.checksumSha256 !== dto.checksumSha256.toLowerCase()
      ) {
        await this.localVideoStorageService.deleteStorageKeyBestEffort(
          storedChunk.storageKey,
        );
        throw new BadRequestException("Chunk checksum does not match.");
      }

      let updatedUpload: LocalUploadSessionWithChunks;
      try {
        updatedUpload = await this.prisma.$transaction(async (tx) => {
          await tx.videoUploadSessionChunk.create({
            data: {
              uploadSessionId: upload.id,
              chunkIndex: dto.chunkIndex,
              storageKey: storedChunk.storageKey,
              sizeBytes: storedChunk.sizeBytes,
              checksumSha256:
                dto.checksumSha256?.toLowerCase() ?? storedChunk.checksumSha256,
            },
          });

          const claimed = await tx.videoUploadSession.updateMany({
            where: {
              id: upload.id,
              adminId,
              status: VideoUploadSessionStatus.ACTIVE,
            },
            data: { receivedChunks: { increment: 1 } },
          });
          if (claimed.count !== 1) {
            throw new ConflictException("Upload session is no longer active.");
          }

          return tx.videoUploadSession.findUniqueOrThrow({
            where: { id: upload.id },
            include: { chunks: { orderBy: { chunkIndex: "asc" } } },
          });
        });
      } catch (error) {
        await this.localVideoStorageService.deleteStorageKeyBestEffort(
          storedChunk.storageKey,
        );
        if (this.isPrismaUniqueConstraintError(error)) {
          const latest = await this.prisma.videoUploadSession.findUnique({
            where: { id: upload.id },
            include: { chunks: { orderBy: { chunkIndex: "asc" } } },
          });
          const committed = latest?.chunks.find(
            (chunk) => chunk.chunkIndex === dto.chunkIndex,
          );
          if (
            latest !== null &&
            latest !== undefined &&
            committed !== undefined &&
            committed.sizeBytes === storedChunk.sizeBytes &&
            committed.checksumSha256 === storedChunk.checksumSha256
          ) {
            return {
              message: "Chunk already uploaded.",
              upload: this.toUploadSessionResponse(latest),
            };
          }
          throw new BadRequestException(
            "Chunk was already uploaded with different metadata.",
          );
        }
        throw error;
      }

      await this.writeAudit(adminId, "VIDEO_LOCAL_CHUNK_UPLOAD", upload.id, {
        chunkIndex: dto.chunkIndex,
        uploadedChunks: updatedUpload.chunks.length,
      });

      return {
        message: "Chunk uploaded successfully.",
        upload: this.toUploadSessionResponse(updatedUpload),
      };
    } finally {
      await this.deleteTempUploadFile(file);
    }
  }

  async getLocalVideoUploadStatus(
    uploadId: string,
    adminId: string,
  ): Promise<VideoUploadSessionResponse> {
    const upload = await this.prisma.videoUploadSession.findUnique({
      where: { id: uploadId },
      include: {
        chunks: {
          orderBy: { chunkIndex: "asc" },
        },
      },
    });

    if (upload === null || upload.adminId !== adminId) {
      throw new NotFoundException("Upload session not found.");
    }

    return this.toUploadSessionResponse(upload);
  }

  async completeLocalVideoUpload(
    uploadId: string,
    dto: CompleteLocalVideoUploadDto,
    thumbnailFile: Express.Multer.File | undefined,
    adminId: string,
  ): Promise<VideoResponse> {
    let finalStorageKey: string | null = null;
    let thumbnailStorageKey: string | null = null;
    let completionOwned = false;

    try {
      await this.cleanupStaleLocalUploadSessions();
      const upload = await this.prisma.videoUploadSession.findUnique({
        where: { id: uploadId },
        include: { chunks: { orderBy: { chunkIndex: "asc" } } },
      });
      if (upload === null || upload.adminId !== adminId) {
        throw new NotFoundException("Upload session not found.");
      }
      if (
        upload.status === VideoUploadSessionStatus.COMPLETED &&
        upload.videoId !== null
      ) {
        return this.getVideo(upload.videoId);
      }
      if (upload.status !== VideoUploadSessionStatus.ACTIVE) {
        throw new ConflictException("Upload session cannot be completed.");
      }
      if (upload.expiresAt <= new Date()) {
        await this.prisma.videoUploadSession.updateMany({
          where: { id: upload.id, status: VideoUploadSessionStatus.ACTIVE },
          data: { status: VideoUploadSessionStatus.EXPIRED },
        });
        throw new BadRequestException("Upload session has expired.");
      }
      this.ensureAllUploadChunksPresent(upload);

      const claimed = await this.prisma.videoUploadSession.updateMany({
        where: {
          id: upload.id,
          adminId,
          status: VideoUploadSessionStatus.ACTIVE,
        },
        data: { status: VideoUploadSessionStatus.COMPLETING },
      });
      if (claimed.count !== 1) {
        throw new ConflictException(
          "Upload completion is already in progress.",
        );
      }
      completionOwned = true;

      this.localVideoStorageService.ensureAvailableCapacity(
        Number(upload.totalBytes),
      );

      const videoId = randomUUID();
      finalStorageKey = this.localVideoStorageService.buildFinalVideoKey(
        videoId,
        upload.originalFilename,
      );
      const finalFile =
        await this.localVideoStorageService.mergeChunksToFinalFile({
          chunkStorageKeys: upload.chunks.map((chunk) => chunk.storageKey),
          finalStorageKey,
        });
      const requestedChecksum =
        dto.checksumSha256?.toLowerCase() ?? upload.checksumSha256;
      if (
        requestedChecksum !== null &&
        requestedChecksum !== finalFile.checksumSha256
      ) {
        throw new BadRequestException("Final video checksum does not match.");
      }

      await this.validateFinalLocalVideoFile(finalStorageKey, upload.mimeType);

      const thumbnail = await this.storeLocalThumbnailForVideo(
        videoId,
        thumbnailFile,
      );
      thumbnailStorageKey = thumbnail?.storageKey ?? null;

      const durationSeconds = await this.probeLocalDurationSeconds(
        this.localVideoStorageService.resolveStoragePath(finalStorageKey),
      );
      const metadata = this.metadataJsonToRecord(upload.metadataJson);
      const slug = await this.ensureUniqueSlug(
        upload.slug ?? upload.title,
        videoId,
      );

      const video = await this.prisma.$transaction(async (tx) => {
        const createdVideo = await tx.videoAsset.create({
          data: {
            id: videoId,
            title: upload.title,
            slug,
            description: upload.description,
            provider: VideoProvider.MANUAL,
            sourceType: VideoSourceType.LOCAL_FILE,
            providerAssetId: null,
            playbackId: null,
            playbackUrl: null,
            embedProvider: null,
            embedUrl: null,
            embedCloudName: null,
            embedPublicId: null,
            embedAllow: null,
            thumbnailUrl: null,
            durationSeconds,
            viewCount: this.parseViewCount(
              typeof metadata.viewCount === "string"
                ? metadata.viewCount
                : undefined,
            ),
            publishedAt: this.parseNullableDate(
              typeof metadata.publishedAt === "string"
                ? metadata.publishedAt
                : undefined,
            ),
            status: this.parseVideoStatusFromMetadata(metadata),
            filterKey: this.normalizeNullableVideoFilterKey(
              typeof metadata.filterKey === "string"
                ? metadata.filterKey
                : undefined,
            ),
            metadataJson: this.buildMetadataJson(
              {
                localFile: {
                  uploadSessionId: upload.id,
                  originalFilename: upload.originalFilename,
                },
              },
              null,
            ),
            localFileAsset: {
              create: {
                storageKey: finalFile.storageKey,
                originalFilename: upload.originalFilename,
                mimeType: upload.mimeType,
                sizeBytes: finalFile.sizeBytes,
                checksumSha256: finalFile.checksumSha256,
              },
            },
            ...(thumbnail === null
              ? {}
              : {
                  localThumbnailAsset: {
                    create: {
                      storageKey: thumbnail.storageKey,
                      originalFilename: thumbnail.originalFilename,
                      mimeType: thumbnail.mimeType,
                      sizeBytes: thumbnail.sizeBytes,
                      checksumSha256: thumbnail.checksumSha256,
                    },
                  },
                }),
          },
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
          },
        });

        await tx.videoUploadSessionChunk.deleteMany({
          where: { uploadSessionId: upload.id },
        });

        const completed = await tx.videoUploadSession.updateMany({
          where: {
            id: upload.id,
            status: VideoUploadSessionStatus.COMPLETING,
          },
          data: {
            videoId,
            finalStorageKey: finalFile.storageKey,
            checksumSha256: finalFile.checksumSha256,
            status: VideoUploadSessionStatus.COMPLETED,
            completedAt: new Date(),
            receivedChunks: upload.totalChunks,
          },
        });
        if (completed.count !== 1) {
          throw new ConflictException("Upload completion lost ownership.");
        }

        return createdVideo;
      });

      await this.localVideoStorageService.deleteDirectoryBestEffort(
        upload.tempStorageKey,
      );

      await this.writeAudit(adminId, "VIDEO_LOCAL_UPLOAD_COMPLETE", video.id, {
        uploadSessionId: upload.id,
        sourceType: video.sourceType,
        sizeBytes: finalFile.sizeBytes.toString(),
      });
      this.invalidateAdminVideoCaches();

      return this.toVideoResponse(video);
    } catch (error) {
      if (finalStorageKey !== null) {
        await this.localVideoStorageService.deleteStorageKeyBestEffort(
          finalStorageKey,
        );
      }
      if (thumbnailStorageKey !== null) {
        await this.localVideoStorageService.deleteStorageKeyBestEffort(
          thumbnailStorageKey,
        );
      }
      if (completionOwned) {
        await this.prisma.videoUploadSession.updateMany({
          where: { id: uploadId, status: VideoUploadSessionStatus.COMPLETING },
          data: { status: VideoUploadSessionStatus.FAILED },
        });
      }
      throw error;
    } finally {
      await this.deleteTempUploadFile(thumbnailFile);
    }
  }

  async cancelLocalVideoUpload(
    uploadId: string,
    adminId: string,
  ): Promise<CancelLocalVideoUploadResponse> {
    await this.cleanupStaleLocalUploadSessions();
    const upload = await this.prisma.videoUploadSession.findUnique({
      where: { id: uploadId },
    });

    if (upload === null || upload.adminId !== adminId) {
      throw new NotFoundException("Upload session not found.");
    }

    if (upload.status === VideoUploadSessionStatus.COMPLETING) {
      throw new ConflictException("Upload completion is in progress.");
    }
    if (upload.status === VideoUploadSessionStatus.COMPLETED) {
      return { message: "Upload canceled successfully." };
    }

    if (
      upload.status === VideoUploadSessionStatus.ACTIVE ||
      upload.status === VideoUploadSessionStatus.FAILED
    ) {
      const canceled = await this.prisma.videoUploadSession.updateMany({
        where: {
          id: upload.id,
          status: {
            in: [
              VideoUploadSessionStatus.ACTIVE,
              VideoUploadSessionStatus.FAILED,
            ],
          },
        },
        data: {
          status: VideoUploadSessionStatus.ABORTED,
          abortedAt: new Date(),
        },
      });
      if (canceled.count !== 1) {
        throw new ConflictException("Upload session state changed.");
      }
    }

    await this.localVideoStorageService.deleteDirectoryBestEffort(
      upload.tempStorageKey,
    );

    await this.writeAudit(adminId, "VIDEO_LOCAL_UPLOAD_CANCEL", upload.id, {
      previousStatus: upload.status,
    });

    return {
      message: "Upload canceled successfully.",
    };
  }

  async getDatabaseVideoBinary(id: string): Promise<DatabaseVideoBinary> {
    const binaryAsset = await this.prisma.videoBinaryAsset.findUnique({
      where: { videoId: id },
      select: {
        mimeType: true,
        sizeBytes: true,
        data: true,
      },
    });

    if (binaryAsset === null) {
      throw new NotFoundException("Database video binary asset not found.");
    }

    return {
      mimeType: binaryAsset.mimeType,
      sizeBytes: binaryAsset.sizeBytes,
      data: Buffer.from(binaryAsset.data),
    };
  }

  async getLocalVideoFileStream(
    id: string,
    rangeHeader: string | undefined,
  ): Promise<LocalVideoFileStream> {
    const localFileAsset = await this.getAdminLocalVideoMetadata(id);

    return {
      mimeType: localFileAsset.mimeType,
      ...this.localVideoStorageService.createRangeReadStream({
        storageKey: localFileAsset.storageKey,
        rangeHeader,
      }),
    };
  }

  async getLocalThumbnailStream(id: string): Promise<LocalThumbnailStream> {
    const localThumbnailAsset = await this.getAdminLocalThumbnailMetadata(id);

    const result = this.localVideoStorageService.createFullReadStream(
      localThumbnailAsset.storageKey,
    );

    return {
      mimeType: localThumbnailAsset.mimeType,
      contentLength: result.contentLength,
      stream: result.stream,
    };
  }

  async updateLocalVideoThumbnail(
    id: string,
    thumbnailFile: Express.Multer.File | undefined,
    adminId: string,
  ): Promise<VideoResponse> {
    let nextThumbnailStorageKey: string | null = null;

    try {
      const existingVideo = await this.prisma.videoAsset.findUnique({
        where: { id },
        include: {
          localThumbnailAsset: true,
        },
      });

      if (existingVideo === null) {
        throw new NotFoundException("Video not found.");
      }

      if (existingVideo.sourceType !== VideoSourceType.LOCAL_FILE) {
        throw new BadRequestException(
          "Local thumbnail upload is only supported for LOCAL_FILE videos.",
        );
      }

      const thumbnail = await this.storeLocalThumbnailForVideo(
        existingVideo.id,
        thumbnailFile,
      );

      if (thumbnail === null) {
        throw new BadRequestException("Thumbnail file is required.");
      }

      nextThumbnailStorageKey = thumbnail.storageKey;

      const video = await this.prisma.videoAsset.update({
        where: { id },
        data: {
          thumbnailUrl: null,
          localThumbnailAsset: {
            upsert: {
              create: {
                storageKey: thumbnail.storageKey,
                originalFilename: thumbnail.originalFilename,
                mimeType: thumbnail.mimeType,
                sizeBytes: thumbnail.sizeBytes,
                checksumSha256: thumbnail.checksumSha256,
              },
              update: {
                storageKey: thumbnail.storageKey,
                originalFilename: thumbnail.originalFilename,
                mimeType: thumbnail.mimeType,
                sizeBytes: thumbnail.sizeBytes,
                checksumSha256: thumbnail.checksumSha256,
              },
            },
          },
        },
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
        },
      });

      if (existingVideo.localThumbnailAsset !== null) {
        await this.localVideoStorageService.deleteStorageKeyBestEffort(
          existingVideo.localThumbnailAsset.storageKey,
        );
      }

      await this.deleteOwnedThumbnailBestEffort(
        existingVideo.metadataJson,
        existingVideo.thumbnailUrl,
        existingVideo.id,
      );

      await this.writeAudit(adminId, "VIDEO_LOCAL_THUMBNAIL_UPDATE", id, {
        sourceType: video.sourceType,
      });
      this.invalidateAdminVideoCaches();

      return this.toVideoResponse(video);
    } catch (error) {
      if (nextThumbnailStorageKey !== null) {
        await this.localVideoStorageService.deleteStorageKeyBestEffort(
          nextThumbnailStorageKey,
        );
      }
      throw error;
    } finally {
      await this.deleteTempUploadFile(thumbnailFile);
    }
  }

  async replaceDatabaseVideoBinary(
    id: string,
    dto: ReplaceDatabaseVideoBinaryDto,
    file: Express.Multer.File | undefined,
    thumbnailFile: Express.Multer.File | undefined,
    adminId: string,
  ): Promise<VideoResponse> {
    try {
      this.ensureDatabaseVideoStorageEnabled();
      this.validateDatabaseUploadFile(file);
      await this.ensureDatabaseCanAcceptBlob(file.size);

      const existingVideo = await this.prisma.videoAsset.findUnique({
        where: { id },
      });

      if (existingVideo === null) {
        throw new NotFoundException("Video not found.");
      }

      if (existingVideo.sourceType !== VideoSourceType.DB_BLOB) {
        throw new BadRequestException(
          "Only DB_BLOB videos can replace database binary data.",
        );
      }

      const thumbnail = await this.resolveThumbnailUrl({
        thumbnailUrl: dto.thumbnailUrl,
        thumbnailFile,
        tags: ["database-replace"],
      });
      const hasThumbnailInput =
        thumbnailFile !== undefined || dto.thumbnailUrl !== undefined;
      const nextThumbnailUrl = hasThumbnailInput
        ? thumbnail.thumbnailUrl
        : existingVideo.thumbnailUrl;
      const durationSeconds =
        dto.durationSeconds ??
        (await this.probeLocalDurationSeconds(file.path)) ??
        existingVideo.durationSeconds;
      const data = await readFile(file.path);
      const checksumSha256 = computeSha256Hex(data);
      const updateData: VideoAssetUpdateInput = {
        durationSeconds,
        status: dto.status ?? existingVideo.status,
        binaryAsset: {
          upsert: {
            create: {
              mimeType: file.mimetype,
              sizeBytes: BigInt(file.size),
              data,
              checksumSha256,
            },
            update: {
              mimeType: file.mimetype,
              sizeBytes: BigInt(file.size),
              data,
              checksumSha256,
            },
          },
        },
      };

      if (hasThumbnailInput) {
        updateData.thumbnailUrl = nextThumbnailUrl;
        updateData.metadataJson = this.mergeThumbnailMetadataJson(
          existingVideo.metadataJson,
          thumbnail.thumbnailMetadata,
        );
      }

      let video: VideoAssetWithBinaryMetadata;

      try {
        video = await this.prisma.$transaction((transaction) =>
          transaction.videoAsset.update({
            where: { id },
            data: updateData,
            include: {
              binaryAsset: {
                select: {
                  mimeType: true,
                  sizeBytes: true,
                },
              },
            },
          }),
        );
      } catch (error) {
        if (this.isDatabasePacketTooLargeError(error)) {
          throw this.createDatabasePacketLimitException();
        }

        throw error;
      }

      if (
        hasThumbnailInput &&
        nextThumbnailUrl !== existingVideo.thumbnailUrl
      ) {
        await this.deleteOwnedThumbnailBestEffort(
          existingVideo.metadataJson,
          existingVideo.thumbnailUrl,
          existingVideo.id,
        );
      }

      await this.writeAudit(adminId, "VIDEO_DB_BINARY_REPLACE", video.id, {
        provider: video.provider,
        sourceType: video.sourceType,
        status: video.status,
        mimeType: file.mimetype,
        sizeBytes: String(file.size),
        thumbnailReplaced:
          hasThumbnailInput && nextThumbnailUrl !== existingVideo.thumbnailUrl,
      });
      this.invalidateAdminVideoCaches();

      return this.toVideoResponse(video);
    } finally {
      await this.deleteTempUploadFile(file);
      await this.deleteTempUploadFile(thumbnailFile);
    }
  }

  async updateVideo(
    id: string,
    dto: UpdateVideoDto,
    adminId: string,
  ): Promise<VideoResponse> {
    const existingVideo = await this.prisma.videoAsset.findUnique({
      where: { id },
    });

    if (existingVideo === null) {
      throw new NotFoundException("Video not found.");
    }

    const data: VideoAssetUpdateInput = {};
    let shouldCleanupOldThumbnail = false;

    if (dto.title !== undefined) {
      data.title = dto.title.trim();
    }

    if (dto.description !== undefined) {
      data.description = this.trimNullable(dto.description);
    }

    if (dto.provider !== undefined) {
      data.provider = dto.provider;
    }

    if (dto.providerAssetId !== undefined) {
      data.providerAssetId = this.trimNullable(dto.providerAssetId);
    }

    if (dto.playbackId !== undefined) {
      data.playbackId = this.trimNullable(dto.playbackId);
    }

    if (dto.playbackUrl !== undefined) {
      data.playbackUrl = this.trimNullable(dto.playbackUrl);
      data.sourceType = VideoSourceType.DIRECT_URL;

      if (dto.embedUrl === undefined) {
        data.embedProvider = null;
        data.embedUrl = null;
        data.embedCloudName = null;
        data.embedPublicId = null;
        data.embedAllow = null;
      }
    }

    if (dto.embedUrl !== undefined) {
      const parsedEmbed = this.parseEmbedInput(dto.embedUrl);
      data.sourceType = VideoSourceType.EMBED;
      data.embedProvider = parsedEmbed.provider;
      data.embedUrl = parsedEmbed.embedUrl;
      data.embedCloudName = parsedEmbed.cloudName ?? null;
      data.embedPublicId = parsedEmbed.publicId ?? null;
      data.embedAllow = parsedEmbed.allow;

      if (
        parsedEmbed.provider === EmbedProvider.CLOUDINARY_PLAYER &&
        dto.provider === undefined
      ) {
        data.provider = VideoProvider.CLOUDINARY;
      }

      if (
        parsedEmbed.publicId !== undefined &&
        dto.providerAssetId === undefined
      ) {
        data.providerAssetId = parsedEmbed.publicId;
      }
    }

    if (dto.thumbnailUrl !== undefined) {
      const nextThumbnailUrl = this.trimNullable(dto.thumbnailUrl);
      data.thumbnailUrl = nextThumbnailUrl;

      if (nextThumbnailUrl !== existingVideo.thumbnailUrl) {
        data.metadataJson = this.mergeThumbnailMetadataJson(
          existingVideo.metadataJson,
          null,
        );
        shouldCleanupOldThumbnail = true;
      }
    }

    if (dto.durationSeconds !== undefined) {
      data.durationSeconds = dto.durationSeconds;
    }

    if (dto.viewCount !== undefined) {
      data.viewCount = this.parseViewCount(dto.viewCount);
    }

    if (dto.publishedAt !== undefined) {
      data.publishedAt = this.parseNullableDate(dto.publishedAt);
    }

    if (dto.status !== undefined) {
      data.status = dto.status;
    }

    // `hasOwnProperty` cannot distinguish "field omitted" here: validated DTO
    // instances are class objects whose declared fields are always own
    // properties (`useDefineForClassFields`), so every PATCH without
    // `filterKey` used to clear the column. The DTO transform maps the
    // explicit clear signals (null / empty string) to null, so `undefined`
    // now means "leave unchanged".
    if (dto.filterKey !== undefined) {
      data.filterKey = this.normalizeNullableVideoFilterKey(dto.filterKey);
    }

    if (dto.metadataJson !== undefined) {
      data.metadataJson = this.toJsonInput(dto.metadataJson);
    }

    if (dto.slug !== undefined) {
      data.slug = await this.ensureUniqueSlug(dto.slug, existingVideo.id);
    } else if (
      dto.title !== undefined &&
      (existingVideo.slug === null || existingVideo.slug.trim() === "")
    ) {
      data.slug = await this.ensureUniqueSlug(dto.title, existingVideo.id);
    }

    let disabledShareLinkCount = 0;
    const video = await this.prisma.$transaction(async (tx) => {
      const updatedVideo = await tx.videoAsset.update({
        where: { id },
        data,
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
        },
      });

      if (dto.status === VideoStatus.DISABLED) {
        disabledShareLinkCount = await this.disableActiveShareLinksForVideo(
          tx,
          id,
        );
      }

      return updatedVideo;
    });

    if (shouldCleanupOldThumbnail) {
      await this.deleteOwnedThumbnailBestEffort(
        existingVideo.metadataJson,
        existingVideo.thumbnailUrl,
        existingVideo.id,
      );
    }

    await this.writeAudit(adminId, "VIDEO_UPDATE", video.id, {
      previousStatus: existingVideo.status,
      nextStatus: video.status,
      disabledShareLinkCount,
    });
    this.invalidateAdminVideoCaches();

    return this.toVideoResponse(video);
  }

  async disableVideo(
    id: string,
    adminId: string,
  ): Promise<DisableVideoResponse> {
    const result = await this.prisma.$transaction(async (tx) => {
      const existingVideo = await tx.videoAsset.findUnique({
        where: { id },
        select: { id: true, status: true },
      });

      if (existingVideo === null) {
        throw new NotFoundException("Video not found.");
      }

      const videoStatusChanged = existingVideo.status !== VideoStatus.DISABLED;

      if (videoStatusChanged) {
        await tx.videoAsset.update({
          where: { id },
          data: { status: VideoStatus.DISABLED },
        });
      }

      const disabledShareLinkCount = await this.disableActiveShareLinksForVideo(
        tx,
        id,
      );

      return {
        previousStatus: existingVideo.status,
        videoStatusChanged,
        disabledShareLinkCount,
      };
    });

    if (result.videoStatusChanged || result.disabledShareLinkCount > 0) {
      await this.writeAudit(adminId, "VIDEO_DISABLE", id, {
        previousStatus: result.previousStatus,
        nextStatus: VideoStatus.DISABLED,
        disabledShareLinkCount: result.disabledShareLinkCount,
      });
      this.invalidateAdminVideoCaches();
    }

    return {
      message: "Video disabled successfully.",
    };
  }

  async purgeVideo(
    id: string,
    dto: PurgeVideoDto,
    adminId: string,
  ): Promise<PurgeVideoResponse> {
    if (dto.confirmVideoId !== id) {
      throw new BadRequestException(
        "Permanent delete confirmation does not match the video id.",
      );
    }

    // Purging a video that anchors a canonical provenance URL would orphan a
    // recorded DMCA source link (the FK is Restrict, so the delete would fail
    // at the database anyway) — surface a stable, actionable conflict first.
    const canonicalCount = await this.prisma.canonicalVideoShareLink.count({
      where: { videoId: id },
    });
    if (canonicalCount > 0) {
      throw new ConflictException({
        message:
          "This video anchors a canonical share link used for provenance records. Owner must resolve the canonical mapping before purging.",
        code: "VIDEO_HAS_CANONICAL_SHARE_LINK",
      });
    }

    const deleteRemoteAsset = dto.deleteRemoteAsset ?? false;
    const purgeResult = await this.prisma.$transaction(async (transaction) => {
      const video = await transaction.videoAsset.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          provider: true,
          sourceType: true,
          providerAssetId: true,
          thumbnailUrl: true,
          metadataJson: true,
          localFileAsset: {
            select: {
              storageKey: true,
              sizeBytes: true,
            },
          },
          localThumbnailAsset: {
            select: {
              storageKey: true,
              sizeBytes: true,
            },
          },
        },
      });

      if (video === null) {
        throw new NotFoundException("Video not found.");
      }

      if (video.status !== VideoStatus.DISABLED) {
        throw new BadRequestException(
          "Video must be disabled before it can be permanently deleted.",
        );
      }

      const [activeWebsiteAssignmentCount, shareLinkVideoCount] =
        await Promise.all([
          transaction.websiteVideo.count({
            where: { videoId: id, status: AssignmentStatus.ACTIVE },
          }),
          transaction.shareLinkVideo.count({ where: { videoId: id } }),
        ]);
      const hadWebsiteAssignments = activeWebsiteAssignmentCount > 0;
      const hadShareLinks = shareLinkVideoCount > 0;

      if (hadWebsiteAssignments) {
        throw new BadRequestException(
          "Video cannot be permanently deleted while it is assigned to active websites.",
        );
      }

      const disabledShareLinkCount = await this.disableActiveShareLinksForVideo(
        transaction,
        id,
      );
      const detachedShareLinkVideoCount =
        await this.detachShareLinkVideosForVideo(transaction, id);

      await transaction.videoAsset.delete({ where: { id } });

      await transaction.adminAuditLog.create({
        data: {
          adminId,
          action: "VIDEO_PURGE_COMMIT",
          module: "videos",
          entityType: "VideoAsset",
          entityId: id,
          status: AuditStatus.SUCCESS,
          metadataJson: this.toJsonInput({
            sourceType: video.sourceType,
            disabledShareLinkCount,
            detachedShareLinkVideoCount,
          }),
        },
      });

      return {
        video,
        hadWebsiteAssignments,
        hadShareLinks,
        activeWebsiteAssignmentCount,
        disabledShareLinkCount,
        detachedShareLinkVideoCount,
      };
    });

    const shouldDeleteRemoteAsset =
      deleteRemoteAsset &&
      purgeResult.video.provider === VideoProvider.CLOUDINARY &&
      purgeResult.video.providerAssetId !== null;
    let remoteAssetDeleted = false;

    if (shouldDeleteRemoteAsset && purgeResult.video.providerAssetId !== null) {
      remoteAssetDeleted = await this.deleteRemoteAssetBestEffort(
        purgeResult.video.providerAssetId,
        purgeResult.video.id,
      );
    }

    const ownedCloudinaryThumbnailDeleted =
      await this.deleteOwnedThumbnailBestEffort(
        purgeResult.video.metadataJson,
        purgeResult.video.thumbnailUrl,
        purgeResult.video.id,
      );

    const localVideoDeleteAttempted =
      purgeResult.video.localFileAsset?.storageKey !== undefined;
    const localThumbnailDeleteAttempted =
      purgeResult.video.localThumbnailAsset?.storageKey !== undefined;
    const localVideoDeleted =
      await this.localVideoStorageService.deleteStorageKeyBestEffort(
        purgeResult.video.localFileAsset?.storageKey,
      );
    const localThumbnailDeleted =
      await this.localVideoStorageService.deleteStorageKeyBestEffort(
        purgeResult.video.localThumbnailAsset?.storageKey,
      );
    const bytesReclaimed =
      (localVideoDeleted
        ? (purgeResult.video.localFileAsset?.sizeBytes ?? BigInt(0))
        : BigInt(0)) +
      (localThumbnailDeleted
        ? (purgeResult.video.localThumbnailAsset?.sizeBytes ?? BigInt(0))
        : BigInt(0));
    const orphanCleanupRequired =
      (localVideoDeleteAttempted && !localVideoDeleted) ||
      (localThumbnailDeleteAttempted && !localThumbnailDeleted);

    const storageCleanupFailed =
      orphanCleanupRequired || (shouldDeleteRemoteAsset && !remoteAssetDeleted);
    await this.writeAudit(
      adminId,
      "VIDEO_PURGE_STORAGE",
      id,
      {
        provider: purgeResult.video.provider,
        sourceType: purgeResult.video.sourceType,
        hadWebsiteAssignments: purgeResult.hadWebsiteAssignments,
        hadShareLinks: purgeResult.hadShareLinks,
        activeWebsiteAssignmentCount: purgeResult.activeWebsiteAssignmentCount,
        disabledShareLinkCount: purgeResult.disabledShareLinkCount,
        detachedShareLinkVideoCount: purgeResult.detachedShareLinkVideoCount,
        deleteRemoteAsset,
        remoteAssetDeleteAttempted: shouldDeleteRemoteAsset,
        remoteAssetDeleted,
        ownedCloudinaryThumbnailDeleted,
        localVideoDeleteAttempted,
        localVideoDeleted,
        localThumbnailDeleteAttempted,
        localThumbnailDeleted,
        bytesReclaimed: bytesReclaimed.toString(),
        orphanCleanupRequired,
      },
      storageCleanupFailed ? AuditStatus.FAIL : AuditStatus.SUCCESS,
    );
    this.invalidateAdminVideoCaches();

    return {
      message: "Video permanently deleted successfully.",
      videoId: id,
      sourceType: purgeResult.video.sourceType,
      status: "PURGED",
      safety: {
        hadWebsiteAssignments: purgeResult.hadWebsiteAssignments,
        hadShareLinks: purgeResult.hadShareLinks,
        activeWebsiteAssignmentCount: purgeResult.activeWebsiteAssignmentCount,
        disabledShareLinkCount: purgeResult.disabledShareLinkCount,
        detachedShareLinkVideoCount: purgeResult.detachedShareLinkVideoCount,
      },
      storage: {
        localVideoDeleteAttempted,
        localVideoDeleted,
        localThumbnailDeleteAttempted,
        localThumbnailDeleted,
        bytesReclaimed: bytesReclaimed.toString(),
        orphanCleanupRequired,
      },
      remote: {
        remoteAssetDeleteAttempted: shouldDeleteRemoteAsset,
        remoteAssetDeleted,
      },
    };
  }

  private async getAdminLocalVideoMetadata(
    id: string,
  ): Promise<AdminLocalMediaMetadata> {
    const loader = async (): Promise<AdminLocalMediaMetadata> => {
      const video = await this.prisma.videoAsset.findUnique({
        where: { id },
        select: {
          sourceType: true,
          localFileAsset: {
            select: {
              storageKey: true,
              originalFilename: true,
              mimeType: true,
              sizeBytes: true,
              checksumSha256: true,
              updatedAt: true,
            },
          },
        },
      });

      if (
        video === null ||
        video.sourceType !== VideoSourceType.LOCAL_FILE ||
        video.localFileAsset === null
      ) {
        throw new NotFoundException("Local video file not found.");
      }

      return video.localFileAsset;
    };

    return (
      this.memoryCache?.getOrSet(
        buildCacheKey("media:metadata:admin:local-file", id),
        loader,
        {
          ttlSeconds:
            this.memoryCache.getRuntimeConfig().mediaMetadataTtlSeconds,
        },
      ) ?? loader()
    );
  }

  private async getAdminLocalThumbnailMetadata(
    id: string,
  ): Promise<AdminLocalMediaMetadata> {
    const loader = async (): Promise<AdminLocalMediaMetadata> => {
      const video = await this.prisma.videoAsset.findUnique({
        where: { id },
        select: {
          localThumbnailAsset: {
            select: {
              storageKey: true,
              originalFilename: true,
              mimeType: true,
              sizeBytes: true,
              checksumSha256: true,
              updatedAt: true,
            },
          },
        },
      });

      if (video === null || video.localThumbnailAsset === null) {
        throw new NotFoundException("Local thumbnail not found.");
      }

      return video.localThumbnailAsset;
    };

    return (
      this.memoryCache?.getOrSet(
        buildCacheKey("media:metadata:admin:thumbnail", id),
        loader,
        {
          ttlSeconds:
            this.memoryCache.getRuntimeConfig().mediaMetadataTtlSeconds,
        },
      ) ?? loader()
    );
  }

  private async probeRemoteDurationSeconds(
    playbackUrl: string,
  ): Promise<number | null> {
    const metadata =
      await this.videoMetadataService.probeRemoteVideoUrl(playbackUrl);

    return metadata.durationSeconds;
  }

  private async probeLocalDurationSeconds(
    path: string,
  ): Promise<number | null> {
    const metadata = await this.videoMetadataService.probeLocalVideoFile(path);

    return metadata.durationSeconds;
  }

  private async deleteRemoteAssetBestEffort(
    providerAssetId: string,
    videoId: string,
  ): Promise<boolean> {
    try {
      return await this.cloudinaryService.deleteVideoAsset(providerAssetId);
    } catch (error) {
      this.logger.warn(
        {
          videoId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "Cloudinary remote video asset deletion failed after video purge.",
      );
      return false;
    }
  }

  private resolveVideoListPage(value: number | undefined): number {
    if (value === undefined || !Number.isInteger(value) || value < 1) {
      return 1;
    }

    return value;
  }

  private resolveVideoListLimit(value: number | undefined): number {
    if (value === undefined || !Number.isInteger(value) || value < 1) {
      return 20;
    }

    return Math.min(value, 100);
  }

  private buildEmptyVideoListResponse(
    page: number,
    limit: number,
  ): VideoListResponse {
    return {
      items: [],
      meta: {
        page,
        limit,
        total: 0,
        totalPages: 0,
      },
    };
  }

  private buildAdminVideoListCacheKey(params: {
    page: number;
    limit: number;
    normalizedSearch: string;
    filterKey: string | undefined;
    status: VideoStatus | undefined;
    provider: VideoProvider | undefined;
    sortBy: VideoSortField;
    sortOrder: "asc" | "desc";
  }): string {
    return buildCacheKey(
      "admin:videos:list",
      params.page,
      params.limit,
      params.normalizedSearch,
      params.filterKey ?? "all",
      params.status ?? "all",
      params.provider ?? "all",
      params.sortBy,
      params.sortOrder,
    );
  }

  private invalidateAdminVideoCaches(): void {
    this.memoryCache?.deleteByPrefix("admin:videos:");
    this.memoryCache?.deleteByPrefix("media:metadata:");
    this.memoryCache?.deleteByPrefix("public:watch:");
  }

  private async disableActiveShareLinksForVideo(
    tx: Prisma.TransactionClient,
    videoId: string,
  ): Promise<number> {
    const result = await tx.shareLink.updateMany({
      where: {
        status: ShareLinkStatus.ACTIVE,
        shareLinkVideos: {
          some: { videoId },
        },
      },
      data: {
        status: ShareLinkStatus.DISABLED,
      },
    });

    return result.count;
  }

  private async detachShareLinkVideosForVideo(
    tx: Prisma.TransactionClient,
    videoId: string,
  ): Promise<number> {
    const result = await tx.shareLinkVideo.deleteMany({
      where: { videoId },
    });

    return result.count;
  }

  private buildVideoWhere(
    query: ListVideosQueryDto,
    normalizedSearch: string,
    normalizedFilterKey: string | undefined,
  ): VideoAssetWhereInput {
    const where: VideoAssetWhereInput = {};

    if (query.status !== undefined) {
      where.status = query.status;
    }

    if (query.provider !== undefined) {
      where.provider = query.provider;
    }

    if (normalizedFilterKey !== undefined) {
      where.filterKey = normalizedFilterKey;
    }

    if (normalizedSearch.length > 0) {
      const literalSearch = escapeAdminVideoSearchLike(normalizedSearch);
      where.OR = [
        { title: { contains: literalSearch } },
        { slug: { contains: literalSearch } },
      ];
    }

    return where;
  }

  private resolveVideoSortField(value: unknown): VideoSortField {
    if (
      typeof value === "string" &&
      VIDEO_SORT_FIELDS.includes(value as VideoSortField)
    ) {
      return value as VideoSortField;
    }

    return "createdAt";
  }

  private resolveVideoSortOrder(value: unknown): "asc" | "desc" {
    if (
      typeof value === "string" &&
      SORT_ORDERS.includes(value as "asc" | "desc")
    ) {
      return value as "asc" | "desc";
    }

    return "desc";
  }

  private buildVideoOrderBy(
    sortBy: VideoSortField,
    sortOrder: "asc" | "desc",
  ): VideoAssetOrderByInput {
    return { [sortBy]: sortOrder };
  }

  private resolveProvider(dto: CreateVideoDto): VideoProvider {
    if (dto.provider !== undefined) {
      return dto.provider;
    }

    if (
      dto.playbackUrl !== undefined &&
      this.isCloudinaryUrl(dto.playbackUrl)
    ) {
      return VideoProvider.CLOUDINARY;
    }

    return VideoProvider.MANUAL;
  }

  private validateLocalVideoUploadInit(
    dto: InitLocalVideoUploadDto,
    originalFilename: string,
  ): void {
    const normalizedMimeType = dto.mimeType.trim().toLowerCase();
    if (!this.isSupportedLocalVideoMimeType(normalizedMimeType)) {
      throw new BadRequestException("Video MIME type is not supported.");
    }

    if (!this.isAllowedLocalVideoExtension(originalFilename)) {
      throw new BadRequestException("Video filename extension is not allowed.");
    }

    const maxBytes = this.localVideoStorageService.getUploadMaxBytes();
    if (dto.totalBytes > maxBytes) {
      throw new BadRequestException(
        `Local video file must be ${Math.floor(maxBytes / (1024 * 1024))}MB or smaller.`,
      );
    }

    const maxChunkBytes = this.localVideoStorageService.getChunkSizeBytes();
    if (dto.chunkSizeBytes > maxChunkBytes) {
      throw new BadRequestException(
        `Chunk size must be ${Math.floor(maxChunkBytes / (1024 * 1024))}MB or smaller.`,
      );
    }

    if (dto.totalChunks !== Math.ceil(dto.totalBytes / dto.chunkSizeBytes)) {
      throw new BadRequestException(
        "totalChunks must match totalBytes and chunkSizeBytes.",
      );
    }
  }

  private isAllowedLocalVideoExtension(originalFilename: string): boolean {
    const lower = originalFilename.toLowerCase();
    return [
      ".mp4",
      ".m4v",
      ".mov",
      ".webm",
      ".avi",
      ".mkv",
      ".mpeg",
      ".mpg",
    ].some((extension) => lower.endsWith(extension));
  }

  private isSupportedLocalVideoMimeType(mimeType: string): boolean {
    return new Set([
      "video/mp4",
      "video/x-m4v",
      "video/quicktime",
      "video/webm",
      "video/x-matroska",
      "video/x-msvideo",
      "video/avi",
      "video/mpeg",
    ]).has(mimeType);
  }

  private validateLocalChunkFile(
    file: Express.Multer.File | undefined,
  ): asserts file is Express.Multer.File & { path: string } {
    if (file === undefined) {
      throw new BadRequestException("Chunk file is required.");
    }

    if (typeof file.path !== "string" || file.path.trim() === "") {
      throw new BadRequestException("Chunk temporary file is unavailable.");
    }

    if (file.size <= 0) {
      throw new BadRequestException("Chunk file must not be empty.");
    }

    if (file.size > this.localVideoStorageService.getChunkSizeBytes()) {
      throw new BadRequestException(
        "Chunk file is larger than configured size.",
      );
    }
  }

  private validateLocalChunkRequest(
    upload: LocalUploadSessionWithChunks,
    dto: UploadLocalVideoChunkDto,
    file: Express.Multer.File,
  ): void {
    if (dto.chunkIndex >= upload.totalChunks) {
      throw new BadRequestException("Chunk index is out of range.");
    }

    const expectedSize =
      dto.chunkIndex === upload.totalChunks - 1
        ? Number(upload.totalBytes) - upload.chunkSizeBytes * dto.chunkIndex
        : upload.chunkSizeBytes;

    if (file.size !== expectedSize) {
      throw new BadRequestException("Chunk size does not match expectation.");
    }
  }

  private async getOwnedActiveUploadSession(
    uploadId: string,
    adminId: string,
  ): Promise<LocalUploadSessionWithChunks> {
    const upload = await this.prisma.videoUploadSession.findUnique({
      where: { id: uploadId },
      include: {
        chunks: {
          orderBy: { chunkIndex: "asc" },
        },
      },
    });

    if (upload === null || upload.adminId !== adminId) {
      throw new NotFoundException("Upload session not found.");
    }

    if (upload.status !== VideoUploadSessionStatus.ACTIVE) {
      throw new BadRequestException("Upload session is not active.");
    }

    if (upload.expiresAt <= new Date()) {
      await this.prisma.videoUploadSession.update({
        where: { id: upload.id },
        data: { status: VideoUploadSessionStatus.EXPIRED },
      });
      await this.localVideoStorageService.deleteDirectoryBestEffort(
        upload.tempStorageKey,
      );
      throw new BadRequestException("Upload session has expired.");
    }

    return upload;
  }

  private isPrismaUniqueConstraintError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "P2002"
    );
  }

  private ensureAllUploadChunksPresent(
    upload: LocalUploadSessionWithChunks,
  ): void {
    if (upload.chunks.length !== upload.totalChunks) {
      throw new BadRequestException("Upload is missing one or more chunks.");
    }

    const indexes = new Set(upload.chunks.map((chunk) => chunk.chunkIndex));
    for (let index = 0; index < upload.totalChunks; index += 1) {
      if (!indexes.has(index)) {
        throw new BadRequestException("Upload is missing one or more chunks.");
      }
    }
  }

  private async cleanupStaleLocalUploadSessions(): Promise<void> {
    const cutoff = new Date(
      Date.now() -
        this.localVideoStorageService.getStaleUploadMaxAgeHours() * 60 * 60_000,
    );
    const now = new Date();
    const cleanupStatuses = [
      VideoUploadSessionStatus.ACTIVE,
      VideoUploadSessionStatus.FAILED,
    ];
    const [expiredSessions, oldSessions] = await Promise.all([
      this.prisma.videoUploadSession.findMany({
        where: {
          status: { in: cleanupStatuses },
          expiresAt: { lt: now },
        },
        take: 20,
      }),
      this.prisma.videoUploadSession.findMany({
        where: {
          status: { in: cleanupStatuses },
          createdAt: { lt: cutoff },
        },
        take: 20,
      }),
    ]);
    const staleSessions = Array.from(
      new Map(
        [...expiredSessions, ...oldSessions].map((session) => [
          session.id,
          session,
        ]),
      ).values(),
    ).slice(0, 20);

    for (const session of staleSessions) {
      await this.prisma.videoUploadSession.updateMany({
        where: {
          id: session.id,
          status: {
            in: [
              VideoUploadSessionStatus.ACTIVE,
              VideoUploadSessionStatus.FAILED,
            ],
          },
        },
        data: {
          status: VideoUploadSessionStatus.EXPIRED,
        },
      });
      await this.localVideoStorageService.deleteDirectoryBestEffort(
        session.tempStorageKey,
      );
    }
  }

  private async validateFinalLocalVideoFile(
    storageKey: string,
    mimeType: string,
  ): Promise<void> {
    const magicBytes = await this.localVideoStorageService.readMagicBytes(
      storageKey,
      16,
    );
    const normalizedMimeType = mimeType.toLowerCase();

    if (
      (normalizedMimeType.includes("mp4") ||
        normalizedMimeType.includes("quicktime") ||
        normalizedMimeType.includes("x-m4v")) &&
      magicBytes.subarray(4, 8).toString("ascii") !== "ftyp"
    ) {
      throw new BadRequestException(
        "Uploaded video content is not valid MP4/MOV.",
      );
    }

    if (
      normalizedMimeType.includes("webm") &&
      !magicBytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    ) {
      throw new BadRequestException(
        "Uploaded video content is not valid WebM.",
      );
    }

    if (
      normalizedMimeType.includes("matroska") &&
      !magicBytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    ) {
      throw new BadRequestException("Uploaded video content is not valid MKV.");
    }

    if (
      (normalizedMimeType.includes("msvideo") ||
        normalizedMimeType === "video/avi") &&
      !(
        magicBytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        magicBytes.subarray(8, 12).toString("ascii") === "AVI "
      )
    ) {
      throw new BadRequestException("Uploaded video content is not valid AVI.");
    }

    if (
      normalizedMimeType === "video/mpeg" &&
      !(
        magicBytes[0] === 0 &&
        magicBytes[1] === 0 &&
        magicBytes[2] === 1 &&
        (magicBytes[3] === 0xba || magicBytes[3] === 0xb3)
      )
    ) {
      throw new BadRequestException(
        "Uploaded video content is not valid MPEG.",
      );
    }
  }

  private async storeLocalThumbnailForVideo(
    videoId: string,
    thumbnailFile: Express.Multer.File | undefined,
  ): Promise<{
    storageKey: string;
    originalFilename: string;
    mimeType: string;
    sizeBytes: bigint;
    checksumSha256: string;
  } | null> {
    const file = this.validateLocalThumbnailFile(thumbnailFile);
    if (file === undefined) {
      return null;
    }

    const originalFilename =
      this.localVideoStorageService.sanitizeOriginalFilename(file.originalname);
    const storageKey = this.localVideoStorageService.buildThumbnailKey(
      videoId,
      originalFilename,
    );
    const storedFile = await this.localVideoStorageService.storeThumbnailFile({
      temporaryPath: file.path,
      storageKey,
    });
    try {
      await this.validateLocalThumbnailMagicBytes(storageKey, file.mimetype);
    } catch (error) {
      await this.localVideoStorageService.deleteStorageKeyBestEffort(
        storageKey,
      );
      throw error;
    }

    return {
      storageKey: storedFile.storageKey,
      originalFilename,
      mimeType: file.mimetype,
      sizeBytes: storedFile.sizeBytes,
      checksumSha256: storedFile.checksumSha256,
    };
  }

  private validateLocalThumbnailFile(
    file: Express.Multer.File | undefined,
  ): (Express.Multer.File & { path: string }) | undefined {
    if (file === undefined) {
      return undefined;
    }

    if (
      !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
        file.mimetype.toLowerCase(),
      )
    ) {
      throw new BadRequestException("Thumbnail image type is not supported.");
    }

    if (typeof file.path !== "string" || file.path.trim() === "") {
      throw new BadRequestException("Thumbnail temporary file is unavailable.");
    }

    if (file.size > this.localVideoStorageService.getThumbnailMaxBytes()) {
      throw new BadRequestException("Thumbnail image file is too large.");
    }

    return file as Express.Multer.File & { path: string };
  }

  private async validateLocalThumbnailMagicBytes(
    storageKey: string,
    mimeType: string,
  ): Promise<void> {
    const bytes = await this.localVideoStorageService.readMagicBytes(
      storageKey,
      16,
    );
    const normalized = mimeType.toLowerCase();
    const valid =
      (normalized === "image/jpeg" &&
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff) ||
      (normalized === "image/png" &&
        bytes
          .subarray(0, 8)
          .equals(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          )) ||
      (normalized === "image/gif" &&
        ["GIF87a", "GIF89a"].includes(
          bytes.subarray(0, 6).toString("ascii"),
        )) ||
      (normalized === "image/webp" &&
        bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP");

    if (!valid) {
      throw new BadRequestException(
        "Thumbnail content does not match its MIME type.",
      );
    }
  }

  private parseVideoStatusFromMetadata(
    metadata: Record<string, unknown>,
  ): VideoStatus {
    const rawStatus = metadata.status;
    if (
      typeof rawStatus === "string" &&
      Object.values(VideoStatus).includes(rawStatus as VideoStatus)
    ) {
      return rawStatus as VideoStatus;
    }

    return VideoStatus.READY;
  }

  private toUploadSessionResponse(upload: {
    id: string;
    status: VideoUploadSessionStatus;
    totalBytes: bigint;
    totalChunks: number;
    chunkSizeBytes: number;
    expiresAt: Date;
    chunks: Array<{ chunkIndex: number }>;
  }): VideoUploadSessionResponse {
    return {
      id: upload.id,
      status: upload.status,
      totalBytes: Number(upload.totalBytes),
      totalChunks: upload.totalChunks,
      chunkSizeBytes: upload.chunkSizeBytes,
      uploadedChunks: upload.chunks.length,
      uploadedChunkIndexes: upload.chunks.map((chunk) => chunk.chunkIndex),
      expiresAt: upload.expiresAt,
    };
  }

  private isCloudinaryUrl(value: string): boolean {
    try {
      const url = new URL(value);
      return url.hostname.endsWith("cloudinary.com");
    } catch {
      return false;
    }
  }

  private async ensureUniqueSlug(
    value: string,
    currentVideoId?: string,
  ): Promise<string> {
    const baseSlug = createVideoSlug(value);
    let candidate = baseSlug;
    let suffix = 2;

    while (true) {
      const existing = await this.prisma.videoAsset.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });

      if (existing === null || existing.id === currentVideoId) {
        return candidate;
      }

      const suffixText = `-${suffix}`;
      candidate = `${baseSlug.slice(0, 160 - suffixText.length)}${suffixText}`;
      suffix += 1;

      if (suffix > 1000) {
        throw new ConflictException("Video slug is already in use.");
      }
    }
  }

  private validateUploadFile(
    file: Express.Multer.File | undefined,
  ): asserts file is Express.Multer.File & { path: string } {
    if (file === undefined) {
      throw new BadRequestException("Video file is required.");
    }

    if (!file.mimetype.startsWith("video/")) {
      throw new BadRequestException("Uploaded file must be a video.");
    }

    if (typeof file.path !== "string" || file.path.trim() === "") {
      throw new BadRequestException("Video temporary file is unavailable.");
    }

    const maxBytes = this.getUploadMaxBytes();
    if (file.size > maxBytes) {
      throw new BadRequestException(
        `Video file must be ${this.getUploadMaxMegabytes()}MB or smaller.`,
      );
    }
  }

  private getUploadMaxMegabytes(): number {
    const rawValue = this.configService.get<string>("VIDEO_UPLOAD_MAX_MB");
    if (rawValue === undefined || rawValue.trim() === "") {
      return 500;
    }

    const value = Number(rawValue);
    if (!Number.isInteger(value) || value <= 0) {
      return 500;
    }

    return value;
  }

  private getUploadMaxBytes(): number {
    return this.getUploadMaxMegabytes() * 1024 * 1024;
  }

  private validateThumbnailFile(
    file: Express.Multer.File | undefined,
  ): Express.Multer.File | undefined {
    if (file === undefined) {
      return undefined;
    }

    if (!file.mimetype.startsWith("image/")) {
      throw new BadRequestException("Thumbnail file must be an image.");
    }

    if (file.mimetype === "image/svg+xml") {
      throw new BadRequestException("SVG thumbnails are not allowed.");
    }

    const maxBytes = this.getThumbnailUploadMaxBytes();
    if (file.size > maxBytes) {
      throw new BadRequestException(
        `Thumbnail image file must be ${this.getThumbnailUploadMaxMegabytes()}MB or smaller.`,
      );
    }

    return file;
  }

  private getThumbnailUploadMaxMegabytes(): number {
    const rawValue = this.configService.get<string>(
      "VIDEO_THUMBNAIL_UPLOAD_MAX_MB",
    );
    if (rawValue === undefined || rawValue.trim() === "") {
      return DEFAULT_THUMBNAIL_UPLOAD_MAX_MB;
    }

    const value = Number(rawValue);
    if (!Number.isInteger(value) || value <= 0) {
      return DEFAULT_THUMBNAIL_UPLOAD_MAX_MB;
    }

    return Math.min(value, MAX_THUMBNAIL_UPLOAD_MAX_MB);
  }

  private getThumbnailUploadMaxBytes(): number {
    return this.getThumbnailUploadMaxMegabytes() * 1024 * 1024;
  }

  private async resolveThumbnailUrl(params: {
    thumbnailUrl?: string | undefined;
    thumbnailFile?: Express.Multer.File | undefined;
    tags?: string[] | undefined;
  }): Promise<ResolvedThumbnail> {
    const thumbnailFile = this.validateThumbnailFile(params.thumbnailFile);

    if (thumbnailFile !== undefined) {
      const fileBuffer = await this.readMulterFileBuffer(thumbnailFile);
      const uploadResult = await this.cloudinaryService.uploadImage({
        fileBuffer,
        originalFilename: thumbnailFile.originalname,
        tags: params.tags,
      });

      return {
        thumbnailUrl: uploadResult.secureUrl,
        thumbnailMetadata: this.removeUndefinedValues({
          provider: "CLOUDINARY",
          public_id: uploadResult.publicId,
          secure_url: uploadResult.secureUrl,
          asset_id: uploadResult.assetId,
          version: uploadResult.version,
          format: uploadResult.format,
          resource_type: uploadResult.resourceType,
          bytes: uploadResult.bytes,
          width: uploadResult.width,
          height: uploadResult.height,
        }),
      };
    }

    const thumbnailUrl = this.trimNullable(params.thumbnailUrl);

    return {
      thumbnailUrl:
        thumbnailUrl === null
          ? null
          : this.validatePersistedThumbnailUrl(thumbnailUrl),
      thumbnailMetadata: null,
    };
  }

  private async readMulterFileBuffer(
    file: Express.Multer.File,
  ): Promise<Buffer> {
    if (file.buffer !== undefined && file.buffer.length > 0) {
      return file.buffer;
    }

    if (typeof file.path === "string" && file.path.trim() !== "") {
      return readFile(file.path);
    }

    throw new BadRequestException(
      "Thumbnail upload temporary file is unavailable.",
    );
  }

  private validatePersistedThumbnailUrl(value: string): string {
    try {
      const url = new URL(value);

      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Unsupported thumbnail URL protocol.");
      }

      return value;
    } catch {
      throw new BadRequestException("Thumbnail URL must use http or https.");
    }
  }

  private ensureDatabaseVideoStorageEnabled(): void {
    if (!this.isDatabaseVideoStorageEnabled()) {
      throw new BadRequestException("Database video storage is disabled.");
    }
  }

  private isDatabaseVideoStorageEnabled(): boolean {
    const rawValue = this.configService.get<boolean | string>(
      "VIDEO_DB_STORAGE_ENABLED",
    );
    if (typeof rawValue === "boolean") {
      return rawValue;
    }

    if (rawValue === undefined || rawValue.trim() === "") {
      return false;
    }

    const value = rawValue.trim().toLowerCase();
    return value === "true" || value === "1";
  }

  private validateDatabaseUploadFile(
    file: Express.Multer.File | undefined,
  ): asserts file is Express.Multer.File & { path: string } {
    if (file === undefined) {
      throw new BadRequestException("Video file is required.");
    }

    if (!file.mimetype.startsWith("video/")) {
      throw new BadRequestException("Uploaded file must be a video.");
    }

    if (typeof file.path !== "string" || file.path.trim() === "") {
      throw new BadRequestException(
        "Database upload temporary file is unavailable.",
      );
    }

    const maxBytes = this.getDatabaseUploadMaxBytes();
    if (file.size > maxBytes) {
      throw new BadRequestException(
        `Database video file must be ${this.getDatabaseUploadMaxMegabytes()}MB or smaller.`,
      );
    }
  }

  private getDatabaseUploadMaxMegabytes(): number {
    const rawValue = this.configService.get<string>("VIDEO_DB_UPLOAD_MAX_MB");
    if (rawValue === undefined || rawValue.trim() === "") {
      return DEFAULT_DB_UPLOAD_MAX_MB;
    }

    const value = Number(rawValue);
    if (!Number.isInteger(value) || value <= 0) {
      return DEFAULT_DB_UPLOAD_MAX_MB;
    }

    return Math.min(value, MAX_DB_UPLOAD_MAX_MB);
  }

  private getDatabaseUploadMaxBytes(): number {
    return this.getDatabaseUploadMaxMegabytes() * 1024 * 1024;
  }

  private async ensureDatabaseCanAcceptBlob(
    fileSizeBytes: number,
  ): Promise<void> {
    const maxAllowedPacketBytes = await this.getDatabaseMaxAllowedPacketBytes();

    if (maxAllowedPacketBytes === null) {
      this.logger.warn(
        {
          fileSizeBytes,
        },
        "Could not verify database max_allowed_packet before DB video upload.",
      );
      return;
    }

    const requiredPacketBytes = this.estimateDatabasePacketBytes(fileSizeBytes);

    if (requiredPacketBytes > maxAllowedPacketBytes) {
      throw this.createDatabasePacketLimitException({
        maxAllowedPacketBytes,
        requiredPacketBytes,
      });
    }
  }

  private async getDatabaseMaxAllowedPacketBytes(): Promise<number | null> {
    try {
      const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(
        Prisma.sql`SHOW VARIABLES LIKE 'max_allowed_packet'`,
      );
      const firstRow = rows[0];

      if (firstRow === undefined) {
        return null;
      }

      const rawValue = this.readRawDatabaseVariableValue(firstRow);
      const value =
        typeof rawValue === "bigint"
          ? Number(rawValue)
          : Number(String(rawValue));

      if (!Number.isSafeInteger(value) || value <= 0) {
        return null;
      }

      return value;
    } catch (error) {
      this.logger.warn(
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "Failed to read database max_allowed_packet before DB video upload.",
      );
      return null;
    }
  }

  private readRawDatabaseVariableValue(row: Record<string, unknown>): unknown {
    for (const [key, value] of Object.entries(row)) {
      if (key.toLowerCase() === "value") {
        return value;
      }
    }

    return undefined;
  }

  private estimateDatabasePacketBytes(fileSizeBytes: number): number {
    const ratioOverhead = Math.ceil(
      fileSizeBytes * DATABASE_PACKET_OVERHEAD_RATIO,
    );
    const overhead = Math.max(
      DATABASE_PACKET_MIN_OVERHEAD_BYTES,
      ratioOverhead,
    );

    return fileSizeBytes + overhead;
  }

  private createDatabasePacketLimitException(details?: {
    maxAllowedPacketBytes?: number;
    requiredPacketBytes?: number;
  }): BadRequestException {
    if (
      details?.maxAllowedPacketBytes !== undefined &&
      details.requiredPacketBytes !== undefined
    ) {
      return new BadRequestException(
        `Database max_allowed_packet is too small for this video. Current limit is ${this.formatMegabytes(
          details.maxAllowedPacketBytes,
        )}, but this upload needs about ${this.formatMegabytes(
          details.requiredPacketBytes,
        )}. Increase Docker DB max_allowed_packet to ${RECOMMENDED_DATABASE_PACKET_MB}M and restart the database container.`,
      );
    }

    return new BadRequestException(
      `Database packet limit is too small for this video. Increase max_allowed_packet to ${RECOMMENDED_DATABASE_PACKET_MB}M and restart the database container.`,
    );
  }

  private formatMegabytes(bytes: number): string {
    return `${Math.ceil(bytes / (1024 * 1024))}MB`;
  }

  private isDatabasePacketTooLargeError(error: unknown): boolean {
    const message = this.collectErrorMessages(error).join("\n").toLowerCase();

    return (
      message.includes("max_allowed_packet") ||
      message.includes("packet bigger")
    );
  }

  private collectErrorMessages(
    error: unknown,
    messages: string[] = [],
    seen = new Set<object>(),
  ): string[] {
    if (typeof error === "string") {
      messages.push(error);
      return messages;
    }

    if (error instanceof Error) {
      messages.push(error.message);

      if (error.cause !== undefined) {
        this.collectErrorMessages(error.cause, messages, seen);
      }
    }

    if (typeof error !== "object" || error === null) {
      return messages;
    }

    if (seen.has(error)) {
      return messages;
    }

    seen.add(error);

    const record = error as Record<string, unknown>;
    for (const key of ["message", "cause", "error", "reason", "details"]) {
      const value = record[key];

      if (typeof value === "string") {
        messages.push(value);
      } else if (typeof value === "object" && value !== null) {
        this.collectErrorMessages(value, messages, seen);
      }
    }

    return messages;
  }

  private async deleteTempUploadFile(
    file: Express.Multer.File | undefined,
  ): Promise<void> {
    if (
      file === undefined ||
      typeof file.path !== "string" ||
      file.path.trim() === ""
    ) {
      return;
    }

    try {
      await unlink(file.path);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return;
      }

      this.logger.warn(
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "Temporary database video upload cleanup failed.",
      );
    }
  }

  private parseEmbedInput(input: string): ParsedVideoEmbed {
    return parseVideoEmbedInput({
      input,
      allowedHosts: this.getEmbedAllowedHosts(),
      defaultAllow: this.getEmbedDefaultAllow(),
    });
  }

  private getEmbedAllowedHosts(): string[] {
    const rawValue = this.configService.get<string>(
      "VIDEO_EMBED_ALLOWED_HOSTS",
    );

    if (rawValue === undefined || rawValue.trim() === "") {
      return DEFAULT_VIDEO_EMBED_ALLOWED_HOSTS;
    }

    const hosts = rawValue
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host.length > 0);

    return hosts.length > 0 ? hosts : DEFAULT_VIDEO_EMBED_ALLOWED_HOSTS;
  }

  private getEmbedDefaultAllow(): string {
    const rawValue = this.configService.get<string>(
      "VIDEO_EMBED_DEFAULT_ALLOW",
    );

    if (rawValue === undefined || rawValue.trim() === "") {
      return DEFAULT_VIDEO_EMBED_ALLOW;
    }

    return rawValue.trim();
  }

  private buildEmbedThumbnailUrl(embed: ParsedVideoEmbed): string | null {
    if (
      embed.provider !== EmbedProvider.CLOUDINARY_PLAYER ||
      embed.cloudName === undefined ||
      embed.publicId === undefined
    ) {
      return null;
    }

    return this.safeBuildCloudinaryThumbnailUrl(
      embed.cloudName,
      embed.publicId,
    );
  }

  private parseViewCount(value: string | undefined): bigint {
    if (value === undefined || value.trim() === "") {
      return BigInt(0);
    }

    return BigInt(value);
  }

  private parseNullableDate(value: string | undefined): Date | null {
    if (value === undefined || value.trim() === "") {
      return null;
    }

    return new Date(value);
  }

  private normalizeOptionalVideoFilterKey(value: unknown): string | undefined {
    const normalizedFilterKey = normalizeVideoFilterKey(value);

    if (normalizedFilterKey === undefined) {
      return undefined;
    }

    if (!isValidVideoFilterKey(normalizedFilterKey)) {
      throw new BadRequestException(
        "filterKey must contain only lowercase letters, numbers, and underscores.",
      );
    }

    return normalizedFilterKey;
  }

  private normalizeNullableVideoFilterKey(value: unknown): string | null {
    return this.normalizeOptionalVideoFilterKey(value) ?? null;
  }

  private toJsonInput(value: Record<string, unknown>): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
  }

  private buildMetadataJson(
    baseMetadata: Record<string, unknown> | undefined,
    thumbnailMetadata: Record<string, unknown> | null,
  ) {
    const metadata = this.removeUndefinedValues({
      ...(baseMetadata ?? {}),
      ...(thumbnailMetadata === null
        ? {}
        : {
            thumbnail: thumbnailMetadata,
          }),
    });

    if (Object.keys(metadata).length === 0) {
      return Prisma.JsonNull;
    }

    return this.toJsonInput(metadata);
  }

  private mergeThumbnailMetadataJson(
    baseMetadataJson: Prisma.JsonValue | null,
    thumbnailMetadata: Record<string, unknown> | null,
  ) {
    const metadata = this.metadataJsonToRecord(baseMetadataJson);

    if (thumbnailMetadata === null) {
      delete metadata.thumbnail;
    } else {
      metadata.thumbnail = thumbnailMetadata;
    }

    if (Object.keys(metadata).length === 0) {
      return Prisma.JsonNull;
    }

    return this.toJsonInput(metadata);
  }

  private metadataJsonToRecord(
    value: Prisma.JsonValue | null,
  ): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }

    return { ...(value as Record<string, unknown>) };
  }

  private async deleteOwnedThumbnailBestEffort(
    metadataJson: Prisma.JsonValue | null,
    currentThumbnailUrl: string | null,
    videoId: string,
  ): Promise<boolean> {
    const thumbnail = this.readOwnedCloudinaryThumbnailMetadata(
      metadataJson,
      currentThumbnailUrl,
    );

    if (thumbnail === null) {
      return false;
    }

    try {
      const deleted = await this.cloudinaryService.deleteImage(
        thumbnail.publicId,
      );

      if (!deleted) {
        this.logger.warn(
          {
            videoId,
            publicId: thumbnail.publicId,
          },
          "Cloudinary thumbnail deletion did not confirm success.",
        );
      }

      return deleted;
    } catch (error) {
      this.logger.warn(
        {
          videoId,
          publicId: thumbnail.publicId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "Owned thumbnail cleanup failed.",
      );
      return false;
    }
  }

  private readOwnedCloudinaryThumbnailMetadata(
    metadataJson: Prisma.JsonValue | null,
    currentThumbnailUrl: string | null,
  ): { publicId: string } | null {
    const metadata = this.metadataJsonToRecord(metadataJson);
    const thumbnail = metadata.thumbnail;

    if (
      thumbnail === null ||
      thumbnail === undefined ||
      typeof thumbnail !== "object" ||
      Array.isArray(thumbnail)
    ) {
      return null;
    }

    const thumbnailRecord = thumbnail as Record<string, unknown>;
    const provider = String(thumbnailRecord.provider ?? "").toUpperCase();
    const publicId =
      typeof thumbnailRecord.public_id === "string"
        ? thumbnailRecord.public_id.trim()
        : "";
    const secureUrl =
      typeof thumbnailRecord.secure_url === "string"
        ? thumbnailRecord.secure_url.trim()
        : "";

    if (
      provider !== "CLOUDINARY" ||
      publicId === "" ||
      secureUrl === "" ||
      currentThumbnailUrl === null ||
      secureUrl !== currentThumbnailUrl.trim()
    ) {
      return null;
    }

    const folder = this.getConfiguredThumbnailUploadFolder();
    if (!this.isCloudinaryPublicIdInsideFolder(publicId, folder)) {
      return null;
    }

    return { publicId };
  }

  private getConfiguredThumbnailUploadFolder(): string {
    const explicitFolder = this.configService
      .get<string>("CLOUDINARY_THUMBNAIL_UPLOAD_FOLDER")
      ?.trim();

    if (explicitFolder) {
      return explicitFolder.replace(/^\/+|\/+$/g, "");
    }

    const uploadFolder =
      this.configService.get<string>("CLOUDINARY_UPLOAD_FOLDER") ??
      "video-share-cms/videos";

    return `${uploadFolder.replace(/^\/+|\/+$/g, "")}/thumbnails`;
  }

  private isCloudinaryPublicIdInsideFolder(
    publicId: string,
    folder: string,
  ): boolean {
    const normalizedFolder = folder.replace(/^\/+|\/+$/g, "");
    const normalizedPublicId = publicId.replace(/^\/+/g, "");

    return (
      normalizedPublicId === normalizedFolder ||
      normalizedPublicId.startsWith(`${normalizedFolder}/`)
    );
  }

  private trimOptional(value: string | undefined): string | undefined {
    if (value === undefined) {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private trimNullable(value: string | undefined): string | null {
    return this.trimOptional(value) ?? null;
  }

  private removeUndefinedValues(
    value: Record<string, unknown>,
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(value).filter(
        ([, entryValue]) => entryValue !== undefined,
      ),
    );
  }

  private parseTags(value: string | undefined): string[] {
    if (value === undefined || value.trim() === "") {
      return [];
    }

    return value
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
  }

  private safeBuildCloudinaryThumbnailUrl(
    cloudName: string,
    publicId: string,
  ): string | null {
    try {
      return buildCloudinaryVideoThumbnailUrl(cloudName, publicId);
    } catch {
      return null;
    }
  }

  private async writeAudit(
    adminId: string,
    action: VideoMutationAction,
    videoId: string,
    metadata: Record<string, unknown>,
    status: AuditStatus = AuditStatus.SUCCESS,
  ): Promise<void> {
    try {
      await this.prisma.adminAuditLog.create({
        data: {
          adminId,
          action,
          module: "videos",
          entityType: "VideoAsset",
          entityId: videoId,
          status,
          metadataJson: this.toJsonInput(metadata),
        },
      });
    } catch (error) {
      this.logger.warn(
        {
          action,
          videoId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "Admin video audit log write failed.",
      );
    }
  }

  private buildBinaryPlaybackUrl(videoId: string): string {
    const rawPrefix = this.configService.get<string>("API_PREFIX") ?? "api/v1";
    const prefix = rawPrefix.replace(/^\/+|\/+$/g, "") || "api/v1";

    return `/${prefix}/admin/videos/${videoId}/binary`;
  }

  private buildLocalPlaybackUrl(videoId: string): string {
    const rawPrefix = this.configService.get<string>("API_PREFIX") ?? "api/v1";
    const prefix = rawPrefix.replace(/^\/+|\/+$/g, "") || "api/v1";

    return `/${prefix}/admin/videos/${videoId}/local-file`;
  }

  private buildLocalThumbnailUrl(videoId: string): string {
    const rawPrefix = this.configService.get<string>("API_PREFIX") ?? "api/v1";
    const prefix = rawPrefix.replace(/^\/+|\/+$/g, "") || "api/v1";

    return `/${prefix}/admin/videos/${videoId}/thumbnail`;
  }

  private toLocalFileAssetResponse(
    asset: {
      mimeType: string;
      sizeBytes: bigint;
      checksumSha256: string | null;
      originalFilename: string;
    } | null,
  ) {
    if (asset === null) {
      return null;
    }

    return {
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes.toString(),
      checksumSha256: asset.checksumSha256,
      originalFilename: asset.originalFilename,
    };
  }

  private toVideoResponse(video: VideoAssetWithBinaryMetadata): VideoResponse {
    const binaryAsset = video.binaryAsset ?? null;
    const localFileAsset = video.localFileAsset ?? null;
    const localThumbnailAsset = video.localThumbnailAsset ?? null;

    return {
      id: video.id,
      title: video.title,
      slug: video.slug,
      description: video.description,
      provider: video.provider,
      sourceType: video.sourceType,
      providerAssetId: video.providerAssetId,
      playbackId: video.playbackId,
      playbackUrl: video.playbackUrl,
      embedProvider: video.embedProvider,
      embedUrl: video.embedUrl,
      embedCloudName: video.embedCloudName,
      embedPublicId: video.embedPublicId,
      embedAllow: video.embedAllow,
      thumbnailUrl:
        localThumbnailAsset === null
          ? video.thumbnailUrl
          : this.buildLocalThumbnailUrl(video.id),
      durationSeconds: video.durationSeconds,
      viewCount: video.viewCount.toString(),
      publishedAt: video.publishedAt,
      status: video.status,
      filterKey: video.filterKey,
      metadataJson: video.metadataJson,
      binaryAsset:
        binaryAsset === null
          ? null
          : {
              mimeType: binaryAsset.mimeType,
              sizeBytes: binaryAsset.sizeBytes.toString(),
            },
      localFileAsset: this.toLocalFileAssetResponse(localFileAsset),
      localThumbnailAsset: this.toLocalFileAssetResponse(localThumbnailAsset),
      binaryPlaybackUrl:
        binaryAsset === null ? null : this.buildBinaryPlaybackUrl(video.id),
      localPlaybackUrl:
        localFileAsset === null ? null : this.buildLocalPlaybackUrl(video.id),
      createdAt: video.createdAt,
      updatedAt: video.updatedAt,
    };
  }
}

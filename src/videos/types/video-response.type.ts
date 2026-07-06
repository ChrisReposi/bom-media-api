import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  EmbedProvider,
  VideoProvider,
  VideoSourceType,
  VideoStatus,
} from "../../generated/prisma/client";

export class VideoBinaryAssetResponse {
  @ApiProperty({ example: "video/mp4" })
  mimeType!: string;

  @ApiProperty({
    example: "1048576",
    description: "String because Prisma BigInt cannot be JSON serialized.",
  })
  sizeBytes!: string;
}

export class VideoLocalFileAssetResponse {
  @ApiProperty({
    example: "video/mp4",
  })
  mimeType!: string;

  @ApiProperty({
    example: "104857600",
    description: "String because Prisma BigInt cannot be JSON serialized.",
  })
  sizeBytes!: string;

  @ApiPropertyOptional({
    example: "f2ca1bb6c7e907d06dafe4687e579fcecf6b48bda4a02d610f9dc98ea441f4ab",
    nullable: true,
  })
  checksumSha256!: string | null;

  @ApiProperty({
    example: "training-video.mp4",
  })
  originalFilename!: string;
}

export class VideoUploadSessionResponse {
  @ApiProperty({ example: "cm_upload_123" })
  id!: string;

  @ApiProperty({ example: "ACTIVE" })
  status!: string;

  @ApiProperty({ example: 104857600 })
  totalBytes!: number;

  @ApiProperty({ example: 4 })
  totalChunks!: number;

  @ApiProperty({ example: 52428800 })
  chunkSizeBytes!: number;

  @ApiProperty({ example: 2 })
  uploadedChunks!: number;

  @ApiProperty({ example: [0, 1] })
  uploadedChunkIndexes!: number[];

  @ApiProperty({ example: "2026-06-14T12:00:00.000Z" })
  expiresAt!: Date;
}

export class InitLocalVideoUploadResponse {
  @ApiProperty({ example: "Local video upload initialized." })
  message!: string;

  @ApiProperty({ type: VideoUploadSessionResponse })
  upload!: VideoUploadSessionResponse;
}

export class LocalVideoChunkUploadResponse {
  @ApiProperty({ example: "Chunk uploaded successfully." })
  message!: string;

  @ApiProperty({ type: VideoUploadSessionResponse })
  upload!: VideoUploadSessionResponse;
}

export class CancelLocalVideoUploadResponse {
  @ApiProperty({ example: "Upload canceled successfully." })
  message!: string;
}

export class VideoResponse {
  @ApiProperty({ example: "cm_video_123" })
  id!: string;

  @ApiProperty({ example: "Demo video" })
  title!: string;

  @ApiPropertyOptional({ example: "demo-video", nullable: true })
  slug!: string | null;

  @ApiPropertyOptional({ example: "Optional description.", nullable: true })
  description!: string | null;

  @ApiProperty({ enum: VideoProvider, example: VideoProvider.CLOUDINARY })
  provider!: VideoProvider;

  @ApiProperty({ enum: VideoSourceType, example: VideoSourceType.UPLOAD })
  sourceType!: VideoSourceType;

  @ApiPropertyOptional({
    example: "video-share-cms/videos/demo",
    nullable: true,
  })
  providerAssetId!: string | null;

  @ApiPropertyOptional({
    example: "video-share-cms/videos/demo",
    nullable: true,
  })
  playbackId!: string | null;

  @ApiPropertyOptional({
    example: "https://res.cloudinary.com/demo/video/upload/demo.mp4",
    nullable: true,
  })
  playbackUrl!: string | null;

  @ApiPropertyOptional({ enum: EmbedProvider, nullable: true })
  embedProvider!: EmbedProvider | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  embedUrl!: string | null;

  @ApiPropertyOptional({ example: "demo", nullable: true })
  embedCloudName!: string | null;

  @ApiPropertyOptional({
    example: "video-share-cms/videos/demo",
    nullable: true,
  })
  embedPublicId!: string | null;

  @ApiPropertyOptional({
    example: "autoplay; fullscreen; encrypted-media; picture-in-picture",
    nullable: true,
  })
  embedAllow!: string | null;

  @ApiPropertyOptional({
    example: "https://res.cloudinary.com/demo/video/upload/so_1/demo.jpg",
    nullable: true,
  })
  thumbnailUrl!: string | null;

  @ApiPropertyOptional({ example: 2045, nullable: true })
  durationSeconds!: number | null;

  @ApiProperty({
    example: "360000",
    description: "String because Prisma BigInt cannot be JSON serialized.",
  })
  viewCount!: string;

  @ApiPropertyOptional({
    example: "2026-05-30T00:00:00.000Z",
    nullable: true,
  })
  publishedAt!: Date | null;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.READY })
  status!: VideoStatus;

  @ApiPropertyOptional({
    example: "sml",
    nullable: true,
    description: "Optional short grouping key used for admin filtering.",
  })
  filterKey!: string | null;

  @ApiPropertyOptional({ example: { source: "cloudinary" }, nullable: true })
  metadataJson!: unknown;

  @ApiPropertyOptional({
    type: VideoBinaryAssetResponse,
    example: {
      mimeType: "video/mp4",
      sizeBytes: "1048576",
    },
    nullable: true,
    description:
      "Small database-upload metadata only. Binary bytes are never returned in JSON.",
  })
  binaryAsset!: VideoBinaryAssetResponse | null;

  @ApiPropertyOptional({
    type: VideoLocalFileAssetResponse,
    nullable: true,
    description:
      "Private local-file metadata. The API never returns absolute filesystem paths.",
  })
  localFileAsset!: VideoLocalFileAssetResponse | null;

  @ApiPropertyOptional({
    type: VideoLocalFileAssetResponse,
    nullable: true,
    description:
      "Private local-thumbnail metadata. The API never returns absolute filesystem paths.",
  })
  localThumbnailAsset!: VideoLocalFileAssetResponse | null;

  @ApiPropertyOptional({
    example: "/api/v1/admin/videos/cm_video_123/binary",
    nullable: true,
    description:
      "Admin-authenticated DB blob endpoint for small MVP previews. Public playback is not exposed here.",
  })
  binaryPlaybackUrl!: string | null;

  @ApiPropertyOptional({
    example: "/api/v1/admin/videos/cm_video_123/local-file",
    nullable: true,
    description:
      "Admin-authenticated local-file preview endpoint for LOCAL_FILE videos.",
  })
  localPlaybackUrl!: string | null;

  @ApiProperty({ example: "2026-05-30T00:00:00.000Z" })
  createdAt!: Date;

  @ApiProperty({ example: "2026-05-30T00:00:00.000Z" })
  updatedAt!: Date;
}

export class VideoListMetaResponse {
  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 0 })
  total!: number;

  @ApiProperty({ example: 0 })
  totalPages!: number;
}

export class VideoListResponse {
  @ApiProperty({ type: [VideoResponse] })
  items!: VideoResponse[];

  @ApiProperty({ type: VideoListMetaResponse })
  meta!: VideoListMetaResponse;
}

export class DisableVideoResponse {
  @ApiProperty({ example: "Video disabled successfully." })
  message!: string;
}

export class PurgeVideoResponse {
  @ApiProperty({ example: "Video permanently deleted successfully." })
  message!: string;

  @ApiProperty({ example: "cm_video_123" })
  videoId!: string;

  @ApiProperty({ enum: VideoSourceType, example: VideoSourceType.LOCAL_FILE })
  sourceType!: VideoSourceType;

  @ApiProperty({ example: "PURGED" })
  status!: "PURGED";

  @ApiProperty({
    example: {
      hadWebsiteAssignments: false,
      hadShareLinks: false,
      activeWebsiteAssignmentCount: 0,
      disabledShareLinkCount: 0,
      detachedShareLinkVideoCount: 0,
    },
  })
  safety!: {
    hadWebsiteAssignments: boolean;
    hadShareLinks: boolean;
    activeWebsiteAssignmentCount: number;
    disabledShareLinkCount: number;
    detachedShareLinkVideoCount: number;
  };

  @ApiProperty({
    example: {
      localVideoDeleteAttempted: true,
      localVideoDeleted: true,
      localThumbnailDeleteAttempted: true,
      localThumbnailDeleted: true,
      bytesReclaimed: "524298240",
      orphanCleanupRequired: false,
    },
  })
  storage!: {
    localVideoDeleteAttempted: boolean;
    localVideoDeleted: boolean;
    localThumbnailDeleteAttempted: boolean;
    localThumbnailDeleted: boolean;
    bytesReclaimed: string;
    orphanCleanupRequired: boolean;
  };

  @ApiProperty({
    example: {
      remoteAssetDeleteAttempted: false,
      remoteAssetDeleted: false,
    },
  })
  remote!: {
    remoteAssetDeleteAttempted: boolean;
    remoteAssetDeleted: boolean;
  };
}

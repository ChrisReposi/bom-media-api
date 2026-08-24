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
      detachedWebsiteAssignmentCount: 0,
    },
    description:
      "What the purge actually cleaned up. `activeWebsiteAssignmentCount` is the number of ACTIVE website assignments the video still had - it is reported, not a blocker, because a DISABLED video is already unavailable. `detachedWebsiteAssignmentCount` is how many assignment rows of any status were removed.",
  })
  safety!: {
    hadWebsiteAssignments: boolean;
    hadShareLinks: boolean;
    activeWebsiteAssignmentCount: number;
    disabledShareLinkCount: number;
    detachedShareLinkVideoCount: number;
    detachedWebsiteAssignmentCount: number;
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

export class BunnyTusUploadCredentialsResponse {
  @ApiProperty({ example: "8f2c0e46-2b0a-4b8b-9d2e-1f3a4c5b6d7e" })
  videoId!: string;

  @ApiProperty({ example: "123456" })
  libraryId!: string;

  @ApiProperty({
    example: 1781000000,
    description: "UNIX seconds after which the signature stops being accepted.",
  })
  expirationTime!: number;

  @ApiProperty({
    example: "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0",
    description:
      "SHA-256 hex of libraryId + apiKey + expirationTime + videoId. The API key itself is never returned.",
  })
  signature!: string;

  @ApiProperty({ example: "https://video.bunnycdn.com/tusupload" })
  tusEndpoint!: string;
}

export class InitBunnyVideoUploadResponse {
  @ApiProperty({ example: "Bunny Stream upload initialized." })
  message!: string;

  @ApiProperty({ type: VideoResponse })
  video!: VideoResponse;

  @ApiProperty({ type: BunnyTusUploadCredentialsResponse })
  upload!: BunnyTusUploadCredentialsResponse;
}

export class SyncBunnyVideoStatusResponse {
  @ApiProperty({ example: "Bunny Stream status synchronized." })
  message!: string;

  @ApiProperty({ type: VideoResponse })
  video!: VideoResponse;

  @ApiProperty({
    example: 4,
    nullable: true,
    description: "Raw Bunny status code. 4 is Finished; 5 and 6 are failures.",
  })
  bunnyStatus!: number | null;

  @ApiProperty({
    example: 100,
    nullable: true,
    description: "Bunny encode progress, 0-100. Transient; never persisted.",
  })
  encodeProgress!: number | null;

  @ApiProperty({ example: false })
  statusChanged!: boolean;

  /**
   * True when Bunny answered an authoritative 404 for this video id.
   *
   * A structured field rather than an exception string, so the admin can react
   * without parsing a message. When it is true the local record was PRESERVED
   * and marked remote-missing, `bunnyStatus` and `encodeProgress` are null, and
   * the asset is no longer publicly playable.
   *
   * A transient Bunny failure - timeout, network error, 401/403, 429, 5xx -
   * never produces this. It surfaces as an error instead, leaving the local
   * record untouched.
   */
  @ApiProperty({
    example: false,
    description:
      "True when Bunny returned an authoritative 404. The local record is preserved and marked remote-missing; it is no longer publicly playable.",
  })
  remoteMissing!: boolean;
}

/**
 * Short-lived signed Bunny embed URL for the authenticated Admin preview.
 *
 * NEVER PERSISTED. Minted per request by `BunnyStreamService.createSignedEmbedUrl()`
 * and returned only to an authenticated admin. The token security key and the
 * Stream API key are inputs to the signature and never appear in this response.
 * The Admin console must render this URL rather than the stored unsigned
 * `embedUrl`, which Bunny rejects with 403 while the library has Embed View
 * Token Authentication enabled.
 */
export class BunnyVideoPreviewResponse {
  @ApiProperty({
    example:
      "https://iframe.mediadelivery.net/embed/123456/11111111-2222-3333-4444-555555555555?token=<64 hex>&expires=1756000000",
    description:
      "Signed, short-lived Bunny embed URL. Expires on the configured embed token TTL.",
  })
  embedUrl!: string;

  @ApiProperty({
    example: 1756000000,
    description:
      "Unix seconds at which the signed embed URL stops being valid.",
  })
  expires!: number;
}

/**
 * Result of uploading a custom thumbnail to Bunny Stream.
 *
 * `thumbnailUrl` is null when Bunny accepted the image but has not yet exposed
 * a `thumbnailFileName` for it. That is a transient, non-fatal state: the video
 * is unaffected and the next status sync backfills the poster. It is reported
 * honestly rather than guessed at.
 */
export class BunnyVideoThumbnailResponse {
  @ApiProperty({ example: "Bunny Stream thumbnail updated." })
  message!: string;

  @ApiProperty({ type: VideoResponse })
  video!: VideoResponse;

  @ApiProperty({
    example: "https://vz-xxxxxxxx.b-cdn.net/<guid>/thumbnail_ab12cd34.jpg",
    nullable: true,
    description:
      "CDN poster URL built from the pull-zone hostname, the Bunny GUID and the thumbnailFileName Bunny reported. Null when Bunny has not exposed a file name yet.",
  })
  thumbnailUrl!: string | null;

  @ApiProperty({
    example: true,
    description:
      "Whether the poster URL was resolved and persisted during this request. False means a later sync must backfill it.",
  })
  thumbnailPersisted!: boolean;
}

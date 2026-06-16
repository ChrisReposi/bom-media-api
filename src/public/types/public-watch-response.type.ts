import { ApiProperty } from "@nestjs/swagger";
import type {
  EmbedProvider,
  VideoSourceType,
} from "../../generated/prisma/client";

export type PublicWatchReasonCode =
  | "OK"
  | "MISSING_HOST"
  | "MISSING_TOKEN"
  | "INVALID_LINK"
  | "EXPIRED_LINK"
  | "VIEW_LIMIT_REACHED"
  | "NO_VIDEOS"
  | "SERVER_ERROR";

export type PublicWatchWebsiteResponse = {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
};

export type PublicWatchVideoResponse = {
  id: string;
  title: string;
  description: string | null;
  sourceType: VideoSourceType;
  playbackUrl: string | null;
  binaryPlaybackUrl?: string | null;
  publicPlaybackUrl?: string | null;
  binaryAsset?: {
    mimeType: string;
    sizeBytes: string;
  } | null;
  localFileAsset?: {
    mimeType: string;
    sizeBytes: string;
  } | null;
  embedUrl: string | null;
  embedProvider: EmbedProvider | null;
  embedAllow: string | null;
  thumbnailUrl: string | null;
  publicThumbnailUrl?: string | null;
  durationSeconds: number | null;
  viewCount: string;
  publishedAt: string | null;
};

export class PublicWatchResponse {
  @ApiProperty({ example: true })
  valid!: boolean;

  @ApiProperty({ example: "OK" })
  reasonCode!: PublicWatchReasonCode;

  @ApiProperty({ nullable: true })
  website!: PublicWatchWebsiteResponse | null;

  @ApiProperty({ isArray: true })
  videos!: PublicWatchVideoResponse[];
}

export class PublicVideoViewResponse {
  @ApiProperty({ example: true })
  valid!: boolean;

  @ApiProperty({ example: "cm_video_123", nullable: true })
  videoId!: string | null;

  @ApiProperty({
    example: "1231132",
    nullable: true,
    description: "String because Prisma BigInt cannot be JSON serialized.",
  })
  viewCount!: string | null;

  @ApiProperty({
    example: "2026-06-14T00:00:00.000Z",
    nullable: true,
  })
  publishedAt!: string | null;
}

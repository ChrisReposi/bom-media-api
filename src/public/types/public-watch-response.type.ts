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
  embedUrl: string | null;
  embedProvider: EmbedProvider | null;
  embedAllow: string | null;
  thumbnailUrl: string | null;
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

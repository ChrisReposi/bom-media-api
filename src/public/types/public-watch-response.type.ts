import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
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

/**
 * `resumeGrant` IS OPTIONAL, AND ITS ABSENCE IS PART OF THE CONTRACT.
 *
 * It was briefly unconditional, on an anti-enumeration argument: a field
 * present only on success would let the SHAPE of a reply reveal its outcome.
 * That argument does not survive contact with the body, which already
 * announces its outcome in `valid` — so the field disclosed nothing new, and
 * the cost was real. It changed the `#k` success body, the legacy `GET` body
 * and every denial body away from the exact property set every deployed client
 * and the release-blocking compatibility manifest were written against.
 *
 * The property set is now, and must stay:
 *
 *   #k success / legacy GET   { valid, reasonCode, website, videos }
 *   EVERY denial              { valid, reasonCode, website, videos }
 *   compat success            { valid, reasonCode, website, videos, resumeGrant }
 *   resume success            { valid, reasonCode, website, videos }
 *
 * Pinned by `test/public-watch-golden-contract.test.ts` against the
 * PRE-FEATURE bodies byte for byte, rather than by fixtures updated to accept
 * whatever the code now emits.
 */
export class PublicWatchResponse {
  @ApiProperty({ example: true })
  valid!: boolean;

  @ApiProperty({ example: "OK" })
  reasonCode!: PublicWatchReasonCode;

  @ApiProperty({ nullable: true })
  website!: PublicWatchWebsiteResponse | null;

  @ApiProperty({ isArray: true })
  videos!: PublicWatchVideoResponse[];

  @ApiPropertyOptional({
    description:
      "OPTIONAL, and ABSENT unless the new protocol requires it. A " +
      "short-lived, host-bound grant that lets the SAME browser tab restore " +
      "this review session after a refresh, without keeping any share " +
      "credential in the URL. Emitted ONLY on a successful email-safe " +
      "exchange, which is the only flow that scrubs its own carrier. The #k " +
      "success body, the legacy GET body and every denial body omit the " +
      "property entirely.",
  })
  resumeGrant?: string;
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

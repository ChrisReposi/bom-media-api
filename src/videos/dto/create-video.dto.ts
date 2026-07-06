import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  NotEquals,
} from "class-validator";
import { VideoProvider, VideoStatus } from "../../generated/prisma/client";
import {
  VIDEO_FILTER_KEY_MAX_LENGTH,
  normalizeVideoFilterKey,
} from "../utils/video-filter-key.util";

function toOptionalNumericString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  if (typeof value === "string") {
    return value.trim();
  }

  return String(value);
}

function toOptionalInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    return Number(value.trim());
  }

  return Number(value);
}

export class CreateVideoDto {
  @ApiProperty({
    example: "Demo video",
    minLength: 1,
    maxLength: 200,
  })
  @IsString()
  @MaxLength(200)
  @Matches(/\S/, { message: "title must not be empty" })
  title!: string;

  @ApiPropertyOptional({
    example: "Optional video description.",
    maxLength: 5000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({
    enum: VideoProvider,
    example: VideoProvider.MANUAL,
  })
  @IsOptional()
  @IsEnum(VideoProvider)
  provider?: VideoProvider;

  @ApiPropertyOptional({
    example: "my-provider-asset-id",
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  providerAssetId?: string;

  @ApiPropertyOptional({
    example: "my-playback-id",
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  playbackId?: string;

  @ApiPropertyOptional({
    example: "https://res.cloudinary.com/demo/video/upload/sample.mp4",
    maxLength: 2048,
  })
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(2048)
  playbackUrl?: string;

  @ApiPropertyOptional({
    example: "https://example.com/embed/video",
    maxLength: 2048,
  })
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(2048)
  embedUrl?: string;

  @ApiPropertyOptional({
    example: "https://example.com/thumb.jpg",
    maxLength: 2048,
  })
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(2048)
  thumbnailUrl?: string;

  @ApiPropertyOptional({
    example: 120,
    minimum: 0,
  })
  @IsOptional()
  @Transform(({ value }) => toOptionalInteger(value))
  @IsInt()
  @Min(0)
  @Max(2147483647)
  durationSeconds?: number;

  @ApiPropertyOptional({
    example: "360000",
    description: "Non-negative integer. Returned as a string by the API.",
  })
  @IsOptional()
  @Transform(({ value }) => toOptionalNumericString(value))
  @Matches(/^\d+$/, { message: "viewCount must be a non-negative integer" })
  viewCount?: string;

  @ApiPropertyOptional({
    example: "2026-05-30T00:00:00.000Z",
  })
  @IsOptional()
  @IsISO8601()
  publishedAt?: string;

  @ApiPropertyOptional({
    example: "demo-video",
    maxLength: 160,
  })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  slug?: string;

  @ApiPropertyOptional({
    enum: VideoStatus,
    example: VideoStatus.READY,
  })
  @IsOptional()
  @IsEnum(VideoStatus)
  status?: VideoStatus;

  @ApiPropertyOptional({
    example: "sml",
    description:
      "Optional short grouping key used for admin filtering, e.g. sml, msa, judge_judy.",
    maxLength: VIDEO_FILTER_KEY_MAX_LENGTH,
  })
  @IsOptional()
  @Transform(({ value }) => normalizeVideoFilterKey(value))
  @IsString()
  @MaxLength(VIDEO_FILTER_KEY_MAX_LENGTH)
  @NotEquals("all", {
    message: "filterKey must not be the reserved value all.",
  })
  @Matches(/^[a-z0-9]+(?:_[a-z0-9]+)*$/, {
    message:
      "filterKey must contain only lowercase letters, numbers, and underscores.",
  })
  filterKey?: string;

  @ApiPropertyOptional({
    example: { source: "manual-import" },
    type: Object,
  })
  @IsOptional()
  @IsObject()
  metadataJson?: Record<string, unknown>;
}

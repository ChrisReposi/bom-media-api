import { ApiPropertyOptional } from "@nestjs/swagger";
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
} from "class-validator";
import { VideoProvider, VideoStatus } from "../../generated/prisma/client";

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

export class UpdateVideoDto {
  @ApiPropertyOptional({ example: "Updated demo video", maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/\S/, { message: "title must not be empty" })
  title?: string;

  @ApiPropertyOptional({ example: "Updated description.", maxLength: 5000 })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ enum: VideoProvider, example: VideoProvider.MANUAL })
  @IsOptional()
  @IsEnum(VideoProvider)
  provider?: VideoProvider;

  @ApiPropertyOptional({ example: "provider-asset-id", maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  providerAssetId?: string;

  @ApiPropertyOptional({ example: "playback-id", maxLength: 255 })
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

  @ApiPropertyOptional({ example: "https://example.com/embed/video" })
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(2048)
  embedUrl?: string;

  @ApiPropertyOptional({ example: "https://example.com/thumb.jpg" })
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(2048)
  thumbnailUrl?: string;

  @ApiPropertyOptional({ example: 120, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  durationSeconds?: number;

  @ApiPropertyOptional({ example: "360000" })
  @IsOptional()
  @Transform(({ value }) => toOptionalNumericString(value))
  @Matches(/^\d+$/, { message: "viewCount must be a non-negative integer" })
  viewCount?: string;

  @ApiPropertyOptional({ example: "2026-05-30T00:00:00.000Z" })
  @IsOptional()
  @IsISO8601()
  publishedAt?: string;

  @ApiPropertyOptional({ example: "updated-demo-video", maxLength: 160 })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  slug?: string;

  @ApiPropertyOptional({ enum: VideoStatus, example: VideoStatus.READY })
  @IsOptional()
  @IsEnum(VideoStatus)
  status?: VideoStatus;

  @ApiPropertyOptional({ example: { source: "manual-edit" }, type: Object })
  @IsOptional()
  @IsObject()
  metadataJson?: Record<string, unknown>;
}

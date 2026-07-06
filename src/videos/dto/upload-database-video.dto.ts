import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  Allow,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  NotEquals,
} from "class-validator";
import { VideoStatus } from "../../generated/prisma/client";
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

export class UploadDatabaseVideoDto {
  @ApiProperty({
    type: "string",
    format: "binary",
    description:
      "Video file binary. Multer consumes this field; the service validates the real @UploadedFile value.",
  })
  @Allow()
  file?: unknown;

  @ApiPropertyOptional({
    type: "string",
    format: "binary",
    description: "Optional thumbnail image file uploaded to Cloudinary.",
  })
  @Allow()
  thumbnailFile?: unknown;

  @ApiProperty({ example: "Database fallback demo video", maxLength: 200 })
  @IsString()
  @MaxLength(200)
  @Matches(/\S/, { message: "title must not be empty" })
  title!: string;

  @ApiPropertyOptional({ example: "Optional description.", maxLength: 5000 })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({
    example: "https://example.com/thumb.jpg",
    maxLength: 2048,
  })
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(2048)
  thumbnailUrl?: string;

  @ApiPropertyOptional({ example: 120, minimum: 0 })
  @IsOptional()
  @Transform(({ value }) => toOptionalInteger(value))
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

  @ApiPropertyOptional({ example: "database-fallback-demo", maxLength: 160 })
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
}

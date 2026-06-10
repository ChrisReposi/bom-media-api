import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
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
} from "class-validator";
import { VideoStatus } from "../../generated/prisma/client";

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

export class CreateEmbedVideoDto {
  @ApiProperty({
    example: "Cloudinary player video",
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

  @ApiProperty({
    description: "A full iframe embed code or iframe src URL.",
    example:
      '<iframe src="https://player.cloudinary.com/embed/?cloud_name=dekft3yz7&public_id=demo"></iframe>',
    maxLength: 6000,
  })
  @IsString()
  @MaxLength(6000)
  @Matches(/\S/, { message: "embedCodeOrUrl must not be empty" })
  embedCodeOrUrl!: string;

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
    example: "2026-06-01T00:00:00.000Z",
  })
  @IsOptional()
  @IsISO8601()
  publishedAt?: string;

  @ApiPropertyOptional({
    example: "cloudinary-player-video",
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
}

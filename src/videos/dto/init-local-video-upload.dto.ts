import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
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

export class InitLocalVideoUploadDto {
  @ApiProperty({ example: "Local training video", maxLength: 200 })
  @IsString()
  @MaxLength(200)
  @Matches(/\S/, { message: "title must not be empty" })
  title!: string;

  @ApiPropertyOptional({ example: "Optional description.", maxLength: 5000 })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiProperty({ example: "training-video.mp4", maxLength: 255 })
  @IsString()
  @MaxLength(255)
  @Matches(/\S/, { message: "originalFilename must not be empty" })
  originalFilename!: string;

  @ApiProperty({ example: "video/mp4", maxLength: 120 })
  @IsString()
  @MaxLength(120)
  @Matches(/^video\/[-+.\w]+$/i, {
    message: "mimeType must be a video MIME type",
  })
  mimeType!: string;

  @ApiProperty({ example: 104857600, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1073741824)
  totalBytes!: number;

  @ApiProperty({ example: 4, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  totalChunks!: number;

  @ApiProperty({ example: 52428800, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1073741824)
  chunkSizeBytes!: number;

  @ApiPropertyOptional({ example: "local-training-video", maxLength: 160 })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  slug?: string;

  @ApiPropertyOptional({ example: "360000" })
  @IsOptional()
  @Transform(({ value }) => toOptionalNumericString(value))
  @Matches(/^\d+$/, { message: "viewCount must be a non-negative integer" })
  viewCount?: string;

  @ApiPropertyOptional({ example: "2026-06-01T00:00:00.000Z" })
  @IsOptional()
  @IsISO8601()
  publishedAt?: string;

  @ApiPropertyOptional({ enum: VideoStatus, example: VideoStatus.READY })
  @IsOptional()
  @IsEnum(VideoStatus)
  status?: VideoStatus;

  @ApiPropertyOptional({
    example: "f2ca1bb6c7e907d06dafe4687e579fcecf6b48bda4a02d610f9dc98ea441f4ab",
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i, {
    message: "checksumSha256 must be a SHA-256 hex digest",
  })
  checksumSha256?: string;
}

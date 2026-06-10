import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  Allow,
  IsEnum,
  IsInt,
  IsOptional,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { VideoStatus } from "../../generated/prisma/client";

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

export class ReplaceDatabaseVideoBinaryDto {
  @ApiProperty({
    type: "string",
    format: "binary",
    description:
      "Replacement DB_BLOB video file. Multer consumes this field; the service validates @UploadedFile.",
  })
  @Allow()
  file?: unknown;

  @ApiPropertyOptional({
    type: "string",
    format: "binary",
    description: "Optional replacement thumbnail image uploaded to Cloudinary.",
  })
  @Allow()
  thumbnailFile?: unknown;

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

  @ApiPropertyOptional({
    enum: VideoStatus,
    example: VideoStatus.READY,
  })
  @IsOptional()
  @IsEnum(VideoStatus)
  status?: VideoStatus;
}

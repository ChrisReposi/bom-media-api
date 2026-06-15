import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  Allow,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
} from "class-validator";

function emptyToUndefined(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export class UploadLocalVideoChunkDto {
  @ApiProperty({
    type: "string",
    format: "binary",
    description: "One video upload chunk.",
  })
  @Allow()
  chunk?: unknown;

  @ApiProperty({ example: 0, minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  chunkIndex!: number;

  @ApiPropertyOptional({
    example: "f2ca1bb6c7e907d06dafe4687e579fcecf6b48bda4a02d610f9dc98ea441f4ab",
  })
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsString()
  @Matches(/^[a-f0-9]{64}$/i, {
    message: "checksumSha256 must be a SHA-256 hex digest",
  })
  checksumSha256?: string;
}

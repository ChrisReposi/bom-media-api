import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { Allow, IsOptional, IsString, Matches } from "class-validator";

function emptyToUndefined(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export class CompleteLocalVideoUploadDto {
  @ApiPropertyOptional({
    type: "string",
    format: "binary",
    description: "Optional local thumbnail image stored on private NVMe.",
  })
  @Allow()
  thumbnailFile?: unknown;

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

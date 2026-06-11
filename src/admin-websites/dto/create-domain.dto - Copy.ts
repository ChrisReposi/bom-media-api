import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import { DomainStatus } from "../../generated/prisma/client";

function emptyStringToUndefined(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export class CreateDomainDto {
  @ApiProperty({ example: "127.0.0.1:5500", maxLength: 253 })
  @IsString()
  @MaxLength(253)
  domain!: string;

  @ApiPropertyOptional({ example: "sml", maxLength: 80 })
  @Transform(({ value }) => emptyStringToUndefined(value))
  @IsOptional()
  @IsString()
  @MaxLength(80)
  domainGroupKey?: string;

  @ApiPropertyOptional()
  @Transform(({ value }) => emptyStringToUndefined(value))
  @IsOptional()
  @IsString()
  domainGroupId?: string | null;

  @ApiPropertyOptional({ enum: DomainStatus })
  @IsOptional()
  @IsEnum(DomainStatus)
  status?: DomainStatus;
}

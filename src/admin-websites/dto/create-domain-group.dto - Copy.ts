import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";
import { DomainGroupStatus } from "../../generated/prisma/client";

export class CreateDomainGroupDto {
  @ApiProperty({ example: "sml", maxLength: 80 })
  @IsString()
  @MaxLength(80)
  @Matches(/^[a-z0-9-]+$/, {
    message: "key must contain only lowercase letters, numbers, and hyphens",
  })
  key!: string;

  @ApiProperty({ example: "SML", maxLength: 160 })
  @IsString()
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional({ maxLength: 5000 })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ enum: DomainGroupStatus })
  @IsOptional()
  @IsEnum(DomainGroupStatus)
  status?: DomainGroupStatus;
}

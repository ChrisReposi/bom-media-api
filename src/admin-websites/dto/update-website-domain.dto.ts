import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import { DomainStatus } from "../../generated/prisma/client";

export class UpdateWebsiteDomainDto {
  @ApiPropertyOptional({ example: "gau-bong-demo.com", maxLength: 253 })
  @IsOptional()
  @IsString()
  @MaxLength(253)
  domain?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @ApiPropertyOptional({ enum: DomainStatus })
  @IsOptional()
  @IsEnum(DomainStatus)
  status?: DomainStatus;
}

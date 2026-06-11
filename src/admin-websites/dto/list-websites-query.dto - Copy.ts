import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { WebsiteStatus } from "../../generated/prisma/client";

export class ListWebsitesQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ example: "gau-bong-demo.com", maxLength: 253 })
  @IsOptional()
  @IsString()
  @MaxLength(253)
  domain?: string;

  @ApiPropertyOptional({ example: "sml", maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^[a-z0-9-]+$/, {
    message:
      "domainGroupKey must contain only lowercase letters, numbers, and hyphens",
  })
  domainGroupKey?: string;

  @ApiPropertyOptional({ enum: WebsiteStatus })
  @IsOptional()
  @IsEnum(WebsiteStatus)
  status?: WebsiteStatus;
}

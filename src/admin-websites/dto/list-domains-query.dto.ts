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
import { DomainStatus } from "../../generated/prisma/client";
import { AdminDomainUsageStatus } from "../types/admin-website-response.type";
import {
  ADMIN_WEBSITE_SEARCH_MAX_LENGTH,
  normalizeAdminWebsiteSearch,
} from "../utils/admin-website-search.util";

export class ListDomainsQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => normalizeAdminWebsiteSearch(value))
  @IsString()
  @MaxLength(ADMIN_WEBSITE_SEARCH_MAX_LENGTH)
  search?: string;

  @ApiPropertyOptional({ enum: DomainStatus })
  @IsOptional()
  @IsEnum(DomainStatus)
  status?: DomainStatus;

  @ApiPropertyOptional({ enum: AdminDomainUsageStatus })
  @IsOptional()
  @IsEnum(AdminDomainUsageStatus)
  usageStatus?: AdminDomainUsageStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^[a-z0-9-]+$/)
  domainGroupKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(191)
  websiteId?: string;
}

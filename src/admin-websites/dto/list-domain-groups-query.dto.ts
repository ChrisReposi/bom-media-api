import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { DomainGroupStatus } from "../../generated/prisma/client";
import {
  ADMIN_WEBSITE_SEARCH_MAX_LENGTH,
  normalizeAdminWebsiteSearch,
} from "../utils/admin-website-search.util";

export class ListDomainGroupsQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 100, minimum: 1, maximum: 100 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 100;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => normalizeAdminWebsiteSearch(value))
  @IsString()
  @MaxLength(ADMIN_WEBSITE_SEARCH_MAX_LENGTH)
  search?: string;

  @ApiPropertyOptional({ enum: DomainGroupStatus })
  @IsOptional()
  @IsEnum(DomainGroupStatus)
  status?: DomainGroupStatus;
}

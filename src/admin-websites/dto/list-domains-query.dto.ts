import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { DomainStatus } from "../../generated/prisma/client";
import { AdminDomainUsageStatus } from "../types/admin-website-response.type";

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
  @IsString()
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
  domainGroupKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  websiteId?: string;
}

import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  NotEquals,
  Matches,
  IsEnum,
} from "class-validator";
import { VideoSourceType } from "../../generated/prisma/client";
import {
  VIDEO_FILTER_KEY_MAX_LENGTH,
  normalizeVideoFilterKey,
} from "../../videos/utils/video-filter-key.util";
import {
  ADMIN_VIDEO_SEARCH_MAX_LENGTH,
  normalizeAdminVideoSearch,
} from "../../videos/utils/video-search.util";

export const WEBSITE_VIDEO_ASSIGNMENT_OPTION_SORT_FIELDS = [
  "createdAt",
  "updatedAt",
  "publishedAt",
  "title",
] as const;

export const WEBSITE_VIDEO_ASSIGNMENT_OPTION_SORT_ORDERS = [
  "asc",
  "desc",
] as const;

export type WebsiteVideoAssignmentOptionSortField =
  (typeof WEBSITE_VIDEO_ASSIGNMENT_OPTION_SORT_FIELDS)[number];
export type WebsiteVideoAssignmentOptionSortOrder =
  (typeof WEBSITE_VIDEO_ASSIGNMENT_OPTION_SORT_ORDERS)[number];

export class ListWebsiteVideoAssignmentOptionsQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 24, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 24;

  @ApiPropertyOptional({ maxLength: ADMIN_VIDEO_SEARCH_MAX_LENGTH })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === "string" ? normalizeAdminVideoSearch(value) : value,
  )
  @IsString()
  @MaxLength(ADMIN_VIDEO_SEARCH_MAX_LENGTH)
  search?: string;

  @ApiPropertyOptional({ maxLength: VIDEO_FILTER_KEY_MAX_LENGTH })
  @IsOptional()
  @Transform(({ value }) => normalizeVideoFilterKey(value))
  @IsString()
  @MaxLength(VIDEO_FILTER_KEY_MAX_LENGTH)
  @NotEquals("all")
  @Matches(/^[a-z0-9]+(?:_[a-z0-9]+)*$/)
  filterKey?: string;

  @ApiPropertyOptional({ enum: VideoSourceType })
  @IsOptional()
  @IsEnum(VideoSourceType)
  sourceType?: VideoSourceType;

  @ApiPropertyOptional({
    enum: WEBSITE_VIDEO_ASSIGNMENT_OPTION_SORT_FIELDS,
    default: "createdAt",
  })
  @IsOptional()
  @IsIn(WEBSITE_VIDEO_ASSIGNMENT_OPTION_SORT_FIELDS)
  sortBy?: WebsiteVideoAssignmentOptionSortField = "createdAt";

  @ApiPropertyOptional({
    enum: WEBSITE_VIDEO_ASSIGNMENT_OPTION_SORT_ORDERS,
    default: "desc",
  })
  @IsOptional()
  @IsIn(WEBSITE_VIDEO_ASSIGNMENT_OPTION_SORT_ORDERS)
  sortOrder?: WebsiteVideoAssignmentOptionSortOrder = "desc";
}

import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  NotEquals,
} from "class-validator";
import {
  AssignmentStatus,
  VideoProvider,
  VideoSourceType,
  VideoStatus,
} from "../../generated/prisma/client";
import {
  VIDEO_FILTER_KEY_MAX_LENGTH,
  normalizeVideoFilterKey,
} from "../../videos/utils/video-filter-key.util";
import {
  ADMIN_VIDEO_SEARCH_MAX_LENGTH,
  normalizeAdminVideoSearch,
} from "../../videos/utils/video-search.util";

export const WEBSITE_VIDEO_SORT_FIELDS = [
  "sortOrder",
  "createdAt",
  "updatedAt",
  "publishedAt",
  "title",
] as const;

export const WEBSITE_VIDEO_SORT_ORDERS = ["asc", "desc"] as const;

export type WebsiteVideoSortField = (typeof WEBSITE_VIDEO_SORT_FIELDS)[number];
export type WebsiteVideoSortOrder = (typeof WEBSITE_VIDEO_SORT_ORDERS)[number];

export class ListWebsiteVideosQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;

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

  @ApiPropertyOptional({ enum: VideoStatus })
  @IsOptional()
  @IsEnum(VideoStatus)
  status?: VideoStatus;

  @ApiPropertyOptional({ enum: VideoProvider })
  @IsOptional()
  @IsEnum(VideoProvider)
  provider?: VideoProvider;

  @ApiPropertyOptional({ enum: VideoSourceType })
  @IsOptional()
  @IsEnum(VideoSourceType)
  sourceType?: VideoSourceType;

  @ApiPropertyOptional({ enum: AssignmentStatus })
  @IsOptional()
  @IsEnum(AssignmentStatus)
  assignmentStatus?: AssignmentStatus;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === true || value === "true") return true;
    if (value === false || value === "false") return false;
    return value;
  })
  @IsBoolean()
  eligibleForShareLink?: boolean = false;

  @ApiPropertyOptional({
    enum: WEBSITE_VIDEO_SORT_FIELDS,
    default: "sortOrder",
  })
  @IsOptional()
  @IsIn(WEBSITE_VIDEO_SORT_FIELDS)
  sortBy?: WebsiteVideoSortField = "sortOrder";

  @ApiPropertyOptional({
    enum: WEBSITE_VIDEO_SORT_ORDERS,
    default: "asc",
  })
  @IsOptional()
  @IsIn(WEBSITE_VIDEO_SORT_ORDERS)
  sortOrder?: WebsiteVideoSortOrder = "asc";
}

import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
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
import { VideoProvider, VideoStatus } from "../../generated/prisma/client";
import {
  VIDEO_FILTER_KEY_MAX_LENGTH,
  normalizeVideoFilterKey,
} from "../utils/video-filter-key.util";
import {
  ADMIN_VIDEO_SEARCH_MAX_LENGTH,
  normalizeAdminVideoSearch,
} from "../utils/video-search.util";

export const VIDEO_SORT_FIELDS = [
  "createdAt",
  "updatedAt",
  "publishedAt",
  "title",
] as const;

export const SORT_ORDERS = ["asc", "desc"] as const;

export type VideoSortField = (typeof VIDEO_SORT_FIELDS)[number];
export type SortOrder = (typeof SORT_ORDERS)[number];

export class ListVideosQueryDto {
  @ApiPropertyOptional({ example: 1, default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20, default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ example: "demo" })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === "string" ? normalizeAdminVideoSearch(value) : value,
  )
  @IsString()
  @MaxLength(ADMIN_VIDEO_SEARCH_MAX_LENGTH)
  search?: string;

  @ApiPropertyOptional({ enum: VideoStatus, example: VideoStatus.READY })
  @IsOptional()
  @IsEnum(VideoStatus)
  status?: VideoStatus;

  @ApiPropertyOptional({
    enum: VideoProvider,
    example: VideoProvider.CLOUDINARY,
  })
  @IsOptional()
  @IsEnum(VideoProvider)
  provider?: VideoProvider;

  @ApiPropertyOptional({
    example: "sml",
    description:
      "Optional short grouping key used for admin filtering. Omit this query param to list all videos.",
    maxLength: VIDEO_FILTER_KEY_MAX_LENGTH,
  })
  @IsOptional()
  @Transform(({ value }) => normalizeVideoFilterKey(value))
  @IsString()
  @MaxLength(VIDEO_FILTER_KEY_MAX_LENGTH)
  @NotEquals("all", {
    message: "filterKey must not be the reserved value all.",
  })
  @Matches(/^[a-z0-9]+(?:_[a-z0-9]+)*$/, {
    message:
      "filterKey must contain only lowercase letters, numbers, and underscores.",
  })
  filterKey?: string;

  @ApiPropertyOptional({
    enum: VIDEO_SORT_FIELDS,
    default: "createdAt",
    example: "createdAt",
  })
  @IsOptional()
  @IsIn(VIDEO_SORT_FIELDS)
  sortBy?: VideoSortField = "createdAt";

  @ApiPropertyOptional({ enum: SORT_ORDERS, default: "desc", example: "desc" })
  @IsOptional()
  @IsIn(SORT_ORDERS)
  sortOrder?: SortOrder = "desc";
}

import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";
import { VideoProvider, VideoStatus } from "../../generated/prisma/client";

export const VIDEO_SORT_FIELDS = [
  "createdAt",
  "publishedAt",
  "title",
  "viewCount",
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
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
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

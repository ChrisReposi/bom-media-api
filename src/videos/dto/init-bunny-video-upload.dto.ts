import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  NotEquals,
} from "class-validator";
import {
  VIDEO_FILTER_KEY_MAX_LENGTH,
  normalizeVideoFilterKey,
} from "../utils/video-filter-key.util";
import {
  IsCanonicalViewCount,
  normalizeCanonicalViewCount,
} from "../utils/view-count.util";

/**
 * Metadata for a Bunny Stream upload initiation.
 *
 * Deliberately has no `status` field: the local lifecycle of a Bunny asset is
 * driven by Bunny's own encoding state through the sync endpoint, not by the
 * client that started the upload.
 */
export class InitBunnyVideoUploadDto {
  @ApiProperty({ example: "Bunny training video", maxLength: 200 })
  @IsString()
  @MaxLength(200)
  @Matches(/\S/, { message: "title must not be empty" })
  title!: string;

  @ApiPropertyOptional({ example: "Optional description.", maxLength: 5000 })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ example: "bunny-training-video", maxLength: 160 })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  slug?: string;

  @ApiPropertyOptional({
    type: String,
    example: "360000",
    description:
      "Non-negative integer as a DECIMAL DIGIT STRING. A JSON number is rejected.",
  })
  @IsOptional()
  @Transform(({ value }) => normalizeCanonicalViewCount(value))
  @IsCanonicalViewCount()
  viewCount?: string;

  @ApiPropertyOptional({ example: "2026-06-01T00:00:00.000Z" })
  @IsOptional()
  @IsISO8601()
  publishedAt?: string;

  @ApiPropertyOptional({
    example: "sml",
    description:
      "Optional short grouping key used for admin filtering, e.g. sml, msa, judge_judy.",
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
}

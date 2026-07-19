import { ApiProperty } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsString,
  MaxLength,
} from "class-validator";

export const WEBSITE_VIDEO_ASSIGNMENT_BATCH_MAX_IDS = 100;

export class UpdateWebsiteVideoAssignmentsDto {
  @ApiProperty({
    type: [String],
    maxItems: WEBSITE_VIDEO_ASSIGNMENT_BATCH_MAX_IDS,
  })
  @IsArray()
  @ArrayMaxSize(WEBSITE_VIDEO_ASSIGNMENT_BATCH_MAX_IDS)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(191, { each: true })
  assignVideoIds!: string[];

  @ApiProperty({
    type: [String],
    maxItems: WEBSITE_VIDEO_ASSIGNMENT_BATCH_MAX_IDS,
  })
  @IsArray()
  @ArrayMaxSize(WEBSITE_VIDEO_ASSIGNMENT_BATCH_MAX_IDS)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(191, { each: true })
  unassignVideoIds!: string[];
}

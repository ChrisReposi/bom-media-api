import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
} from "class-validator";

export class AssignWebsiteVideosDto {
  @ApiProperty({ type: [String], maxItems: 50 })
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsString({ each: true })
  videoIds!: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  featuredVideoId?: string;
}

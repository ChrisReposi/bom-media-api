import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from "class-validator";

export class CreateShareLinkDto {
  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  label?: string;

  @ApiPropertyOptional({ type: [String], maxItems: 50 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsString({ each: true })
  videoIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxViews?: number;
}

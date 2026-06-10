import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";
import { WebsiteStatus } from "../../generated/prisma/client";

export class CreateWebsiteDto {
  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MaxLength(255)
  name!: string;

  @ApiProperty({ example: "gau-bong", maxLength: 120 })
  @IsString()
  @MaxLength(120)
  @Matches(/^[a-z0-9-]+$/, {
    message: "slug must contain only lowercase letters, numbers, and hyphens",
  })
  slug!: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  defaultTitle?: string;

  @ApiPropertyOptional({ maxLength: 5000 })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  defaultDescription?: string;

  @ApiPropertyOptional({
    maxLength: 5000,
    description:
      "Backward-compatible alias for defaultDescription used by simpler clients.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ example: "sml", maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^[a-z0-9-]+$/, {
    message:
      "domainGroupKey must contain only lowercase letters, numbers, and hyphens",
  })
  domainGroupKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  domainGroupId?: string;

  @ApiPropertyOptional({ enum: WebsiteStatus })
  @IsOptional()
  @IsEnum(WebsiteStatus)
  status?: WebsiteStatus;
}

import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import { DomainStatus } from "../../generated/prisma/client";

export class CreateWebsiteDomainDto {
  @ApiProperty({ example: "gau-bong-demo.com", maxLength: 253 })
  @IsString()
  @MaxLength(253)
  domain!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @ApiPropertyOptional({ enum: DomainStatus })
  @IsOptional()
  @IsEnum(DomainStatus)
  status?: DomainStatus;
}

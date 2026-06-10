import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";

export class ClaimCurrentWebsiteDomainDto {
  @ApiProperty({ example: "gau-bong-demo.com", maxLength: 253 })
  @IsString()
  @MaxLength(253)
  host!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

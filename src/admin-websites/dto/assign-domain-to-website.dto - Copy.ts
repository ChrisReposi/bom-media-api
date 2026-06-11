import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsOptional, IsString } from "class-validator";

export class AssignDomainToWebsiteDto {
  @ApiProperty()
  @IsString()
  websiteId!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  replaceExisting?: boolean;
}

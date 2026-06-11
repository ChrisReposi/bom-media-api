import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsOptional } from "class-validator";

export class ActivateWebsiteDomainDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

export class PublicWatchQueryDto {
  @ApiProperty({
    example: "gau-bong-demo.com",
    maxLength: 253,
  })
  @IsString()
  @MaxLength(253)
  host!: string;

  @ApiPropertyOptional({
    example: "s_abc123",
    maxLength: 256,
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  token?: string;
}

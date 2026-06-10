import { ApiProperty } from "@nestjs/swagger";
import { IsString, MaxLength, MinLength } from "class-validator";

export class RefreshAdminTokenDto {
  @ApiProperty({
    example: "opaque-refresh-token-value",
    minLength: 16,
    maxLength: 512,
  })
  @IsString()
  @MinLength(16)
  @MaxLength(512)
  refreshToken!: string;
}

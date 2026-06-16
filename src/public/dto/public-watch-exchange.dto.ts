import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class PublicWatchExchangeDto {
  @ApiProperty({
    example: "gau-bong-demo.com",
    maxLength: 253,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(253)
  host!: string;

  @ApiProperty({
    example: "s_abc123",
    maxLength: 256,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  token!: string;
}

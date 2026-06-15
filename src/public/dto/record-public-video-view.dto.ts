import { ApiProperty } from "@nestjs/swagger";
import { IsString, MaxLength } from "class-validator";

export class RecordPublicVideoViewDto {
  @ApiProperty({
    example: "example.com",
    maxLength: 253,
  })
  @IsString()
  @MaxLength(253)
  host!: string;
}

import { ApiProperty } from "@nestjs/swagger";
import { IsString, MaxLength } from "class-validator";

export class AssignSingleWebsiteVideoDto {
  @ApiProperty()
  @IsString()
  @MaxLength(191)
  videoId!: string;
}

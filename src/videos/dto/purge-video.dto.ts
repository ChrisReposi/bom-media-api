import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";

export class PurgeVideoDto {
  @ApiProperty({
    example: "cm_video_123",
    description:
      "Must exactly match the route video id before permanent deletion is allowed.",
    maxLength: 191,
  })
  @IsString()
  @MaxLength(191)
  confirmVideoId!: string;

  @ApiPropertyOptional({
    example: false,
    default: false,
    description:
      "When true, attempts to delete the Cloudinary remote video asset only for Cloudinary videos with a provider asset id.",
  })
  @IsOptional()
  @IsBoolean()
  deleteRemoteAsset?: boolean;
}

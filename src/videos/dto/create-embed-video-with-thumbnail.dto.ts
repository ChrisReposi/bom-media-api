import { ApiPropertyOptional } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { CreateEmbedVideoDto } from "./create-embed-video.dto";

export class CreateEmbedVideoWithThumbnailDto extends CreateEmbedVideoDto {
  @ApiPropertyOptional({
    type: "string",
    format: "binary",
    description: "Optional thumbnail image file uploaded to Cloudinary.",
  })
  @Allow()
  thumbnailFile?: unknown;
}

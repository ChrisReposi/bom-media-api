import { ApiPropertyOptional } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { CreateVideoDto } from "./create-video.dto";

export class CreateManualVideoWithThumbnailDto extends CreateVideoDto {
  @ApiPropertyOptional({
    type: "string",
    format: "binary",
    description: "Optional thumbnail image file uploaded to Cloudinary.",
  })
  @Allow()
  thumbnailFile?: unknown;
}

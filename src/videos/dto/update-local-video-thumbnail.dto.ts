import { ApiProperty } from "@nestjs/swagger";
import { Allow } from "class-validator";

export class UpdateLocalVideoThumbnailDto {
  @ApiProperty({
    type: "string",
    format: "binary",
    description: "Replacement local thumbnail image stored on private NVMe.",
  })
  @Allow()
  thumbnailFile?: unknown;
}

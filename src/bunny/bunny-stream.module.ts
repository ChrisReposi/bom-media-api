import { Module } from "@nestjs/common";
import { BunnyStreamService } from "./bunny-stream.service";
import { BunnyThumbnailProxyService } from "./bunny-thumbnail-proxy.service";

@Module({
  providers: [BunnyStreamService, BunnyThumbnailProxyService],
  exports: [BunnyStreamService, BunnyThumbnailProxyService],
})
export class BunnyStreamModule {}

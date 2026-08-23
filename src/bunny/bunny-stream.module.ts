import { Module } from "@nestjs/common";
import { BunnyStreamService } from "./bunny-stream.service";

@Module({
  providers: [BunnyStreamService],
  exports: [BunnyStreamService],
})
export class BunnyStreamModule {}

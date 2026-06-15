import { Module } from "@nestjs/common";
import { LocalVideoStorageService } from "./local-video-storage.service";

@Module({
  providers: [LocalVideoStorageService],
  exports: [LocalVideoStorageService],
})
export class LocalVideoStorageModule {}

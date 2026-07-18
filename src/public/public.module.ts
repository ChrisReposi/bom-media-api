import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { VideoViewGrowthService } from "../videos/video-view-growth.service";
import { LocalVideoStorageModule } from "../videos/storage/local-video-storage.module";
import { PublicController } from "./public.controller";
import { PublicMediaGrantService } from "./public-media-grant.service";
import { PublicService } from "./public.service";

@Module({
  imports: [DatabaseModule, LocalVideoStorageModule],
  controllers: [PublicController],
  providers: [PublicService, PublicMediaGrantService, VideoViewGrowthService],
})
export class PublicModule {}

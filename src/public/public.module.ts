import { Module } from "@nestjs/common";
import { BunnyStreamModule } from "../bunny/bunny-stream.module";
import { DatabaseModule } from "../database/database.module";
import { VideoViewGrowthService } from "../videos/video-view-growth.service";
import { LocalVideoStorageModule } from "../videos/storage/local-video-storage.module";
import { PublicController } from "./public.controller";
import { PublicMediaGrantService } from "./public-media-grant.service";
import { PublicReviewResumeService } from "./public-review-resume.service";
import { PublicService } from "./public.service";

@Module({
  imports: [BunnyStreamModule, DatabaseModule, LocalVideoStorageModule],
  controllers: [PublicController],
  providers: [
    PublicService,
    PublicMediaGrantService,
    PublicReviewResumeService,
    VideoViewGrowthService,
  ],
})
export class PublicModule {}

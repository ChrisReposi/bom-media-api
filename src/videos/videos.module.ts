import { Module } from "@nestjs/common";
import { BunnyStreamModule } from "../bunny/bunny-stream.module";
import { CloudinaryModule } from "../cloudinary/cloudinary.module";
import { DatabaseModule } from "../database/database.module";
import { AdminAuthModule } from "../admin-auth/admin-auth.module";
import { VideoMetadataService } from "./metadata/video-metadata.service";
import { LocalVideoStorageModule } from "./storage/local-video-storage.module";
import { VideosController } from "./videos.controller";
import { VideosService } from "./videos.service";

@Module({
  imports: [
    DatabaseModule,
    AdminAuthModule,
    BunnyStreamModule,
    CloudinaryModule,
    LocalVideoStorageModule,
  ],
  controllers: [VideosController],
  providers: [VideosService, VideoMetadataService],
})
export class VideosModule {}

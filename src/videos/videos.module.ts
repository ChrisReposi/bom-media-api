import { Module } from "@nestjs/common";
import { CloudinaryModule } from "../cloudinary/cloudinary.module";
import { DatabaseModule } from "../database/database.module";
import { AdminAuthModule } from "../admin-auth/admin-auth.module";
import { VideoMetadataService } from "./metadata/video-metadata.service";
import { VideosController } from "./videos.controller";
import { VideosService } from "./videos.service";

@Module({
  imports: [DatabaseModule, AdminAuthModule, CloudinaryModule],
  controllers: [VideosController],
  providers: [VideosService, VideoMetadataService],
})
export class VideosModule {}

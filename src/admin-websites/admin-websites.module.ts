import { Module } from "@nestjs/common";
import { AdminAuthModule } from "../admin-auth/admin-auth.module";
import { DatabaseModule } from "../database/database.module";
import { AdminWebsitesController } from "./admin-websites.controller";
import { AdminWebsitesService } from "./admin-websites.service";

@Module({
  imports: [DatabaseModule, AdminAuthModule],
  controllers: [AdminWebsitesController],
  providers: [AdminWebsitesService],
})
export class AdminWebsitesModule {}

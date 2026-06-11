import { Module } from "@nestjs/common";
import { AdminAuthModule } from "../admin-auth/admin-auth.module";
import { DatabaseModule } from "../database/database.module";
import { SecurityModule } from "../security/security.module";
import { AdminWebsitesController } from "./admin-websites.controller";
import { AdminWebsitesService } from "./admin-websites.service";

@Module({
  imports: [DatabaseModule, AdminAuthModule, SecurityModule],
  controllers: [AdminWebsitesController],
  providers: [AdminWebsitesService],
})
export class AdminWebsitesModule {}

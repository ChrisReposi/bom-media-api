import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { DatabaseModule } from "../database/database.module";
import { AdminAuthController } from "./admin-auth.controller";
import { AdminAuthService } from "./admin-auth.service";
import { AdminAccessTokenGuard } from "./guards/admin-access-token.guard";

@Module({
  imports: [DatabaseModule, JwtModule.register({})],
  controllers: [AdminAuthController],
  providers: [AdminAuthService, AdminAccessTokenGuard],
  exports: [AdminAccessTokenGuard, JwtModule],
})
export class AdminAuthModule {}

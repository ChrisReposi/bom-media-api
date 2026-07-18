import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { DatabaseModule } from "../database/database.module";
import { AdminAuthController } from "./admin-auth.controller";
import { AdminAuthService } from "./admin-auth.service";
import { AdminCredentialService } from "./admin-credential.service";
import { AdminAccessTokenGuard } from "./guards/admin-access-token.guard";
import { AdminRolesGuard } from "./guards/admin-roles.guard";

@Module({
  imports: [DatabaseModule, JwtModule.register({})],
  controllers: [AdminAuthController],
  providers: [
    AdminAuthService,
    AdminCredentialService,
    AdminAccessTokenGuard,
    AdminRolesGuard,
  ],
  exports: [
    AdminAccessTokenGuard,
    AdminRolesGuard,
    AdminCredentialService,
    JwtModule,
  ],
})
export class AdminAuthModule {}

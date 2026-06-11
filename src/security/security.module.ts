import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DatabaseModule } from "../database/database.module";
import { CorsOriginService } from "./cors-origin.service";

@Global()
@Module({
  imports: [ConfigModule, DatabaseModule],
  providers: [CorsOriginService],
  exports: [CorsOriginService],
})
export class SecurityModule {}

import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { MemoryCacheService } from "./memory-cache.service";

@Global()
@Module({
  imports: [ConfigModule],
  providers: [MemoryCacheService],
  exports: [MemoryCacheService],
})
export class MemoryCacheModule {}

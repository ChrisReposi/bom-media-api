import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { PublicController } from "./public.controller";
import { PublicService } from "./public.service";

@Module({
  imports: [DatabaseModule],
  controllers: [PublicController],
  providers: [PublicService],
})
export class PublicModule {}

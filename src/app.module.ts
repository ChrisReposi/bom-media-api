import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { LoggerModule } from "nestjs-pino";
import { AdminAuthModule } from "./admin-auth/admin-auth.module";
import { AdminAccountsModule } from "./admin-accounts/admin-accounts.module";
import { AdminWebsitesModule } from "./admin-websites/admin-websites.module";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { apiConfig } from "./config/env.config";
import { validateEnv } from "./config/env.validation";
import { loadApiEnv } from "./config/load-env";
import { MemoryCacheModule } from "./cache/memory-cache.module";
import { DatabaseModule } from "./database/database.module";
import { HealthModule } from "./health/health.module";
import { PublicModule } from "./public/public.module";
import { SecurityModule } from "./security/security.module";
import { buildThrottlerOptions } from "./security/throttle.config";
import { VideosModule } from "./videos/videos.module";
import { safeRequestRoute } from "./common/http/safe-request-route.util";
import { MariaDbCollationProbeService } from "./common/diagnostics/mariadb-collation-probe.service";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Request } from "express";

loadApiEnv();

export function serializeRequestForLogs(
  request: Record<string, unknown>,
): Record<string, unknown> {
  const rawRequest =
    request.raw !== null && typeof request.raw === "object"
      ? (request.raw as Record<string, unknown>)
      : request;
  const route = safeRequestRoute(rawRequest as unknown as Request);

  return {
    id: request.id ?? rawRequest.id,
    method: request.method ?? rawRequest.method,
    ...(route ? { route } : {}),
  };
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      load: [apiConfig],
      validate: validateEnv,
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === "production" ? "info" : "debug",
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            "req.headers.proxy-authorization",
            "req.headers.x-api-key",
            "res.headers.set-cookie",
            "req.query.token",
            "req.query.grant",
          ],
          censor: "[Redacted]",
        },
        serializers: {
          req: serializeRequestForLogs,
        },
        genReqId(request: IncomingMessage, response: ServerResponse): string {
          const candidate = request.headers["x-request-id"];
          const requestId =
            typeof candidate === "string" &&
            /^[a-zA-Z0-9._:-]{1,64}$/.test(candidate)
              ? candidate
              : randomUUID();
          response.setHeader("X-Request-Id", requestId);
          return requestId;
        },
      },
    }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: buildThrottlerOptions,
    }),
    MemoryCacheModule,
    DatabaseModule,
    SecurityModule,
    HealthModule,
    AdminAuthModule,
    AdminAccountsModule,
    VideosModule,
    PublicModule,
    AdminWebsitesModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    MariaDbCollationProbeService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}

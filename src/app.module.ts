import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { LoggerModule } from "nestjs-pino";
import { AdminAuthModule } from "./admin-auth/admin-auth.module";
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

loadApiEnv();

function redactTokenFromUrl(value: string): string {
  const [rawPath, queryString] = value.split("?");
  const path = rawPath ?? "";

  if (queryString === undefined) {
    return value;
  }

  const searchParams = new URLSearchParams(queryString);
  if (searchParams.has("token")) {
    searchParams.set("token", "[Redacted]");
  }

  const nextQueryString = searchParams.toString();

  return nextQueryString ? `${path}?${nextQueryString}` : path;
}

function redactQueryToken(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const query = value as Record<string, unknown>;

  return {
    ...query,
    ...(Object.prototype.hasOwnProperty.call(query, "token")
      ? { token: "[Redacted]" }
      : {}),
  };
}

function serializeRequestForLogs(
  request: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: request.id,
    method: request.method,
    url:
      typeof request.url === "string"
        ? redactTokenFromUrl(request.url)
        : request.url,
    query: redactQueryToken(request.query),
    params: request.params,
    headers: request.headers,
    remoteAddress: request.remoteAddress,
    remotePort: request.remotePort,
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
            "res.headers.set-cookie",
            "req.query.token",
          ],
          censor: "[Redacted]",
        },
        serializers: {
          req: serializeRequestForLogs,
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
    VideosModule,
    PublicModule,
    AdminWebsitesModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}

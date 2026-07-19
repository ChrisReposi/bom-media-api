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
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

loadApiEnv();

export function redactTokenFromUrl(value: string): string {
  const [rawPath, queryString] = value.split("?");
  const path = (rawPath ?? "").replace(
    /(\/public\/watch\/)[^/?#]+/i,
    "$1[Redacted]",
  );

  if (queryString === undefined) {
    return path;
  }

  const searchParams = new URLSearchParams(queryString);
  if (searchParams.has("token")) {
    searchParams.set("token", "[Redacted]");
  }
  if (searchParams.has("grant")) {
    searchParams.set("grant", "[Redacted]");
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
    ...(Object.prototype.hasOwnProperty.call(query, "grant")
      ? { grant: "[Redacted]" }
      : {}),
  };
}

export function serializeRequestForLogs(
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
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}

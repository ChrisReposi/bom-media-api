import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import proxyaddr from "proxy-addr";
import { Logger } from "nestjs-pino";
import type { NextFunction, Request, Response } from "express";
import { SWAGGER_PATH } from "./common/constants/api.constants";
import { MARIADB_COLLATION_PROBE_EVENT } from "./common/diagnostics/mariadb-collation-probe.constants";
import { launchMariaDbCollationProbeAfterListen } from "./common/diagnostics/launch-mariadb-collation-probe";
import { MariaDbCollationProbeService } from "./common/diagnostics/mariadb-collation-probe.service";
import { GlobalExceptionFilter } from "./common/filters/global-exception.filter";
import type { ApiEnvironmentConfig } from "./config/env.config";
import { AppModule } from "./app.module";
import { CorsOriginService } from "./security/cors-origin.service";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  const logger = app.get(Logger);
  app.useLogger(logger);

  const configService = app.get(ConfigService);
  const apiEnvironment = configService.getOrThrow<ApiEnvironmentConfig>("api");

  if (apiEnvironment.trustProxyEnabled) {
    const expressInstance = app.getHttpAdapter().getInstance() as {
      set(name: string, value: number | ((address: string) => boolean)): void;
    };

    if (apiEnvironment.trustedProxyCidrs.length > 0) {
      const trustedProxy = proxyaddr.compile(apiEnvironment.trustedProxyCidrs);
      expressInstance.set("trust proxy", (address: string): boolean =>
        trustedProxy(address, 0),
      );
    } else {
      expressInstance.set("trust proxy", apiEnvironment.trustProxyHops);
    }
  }

  app.use(helmet());
  app.use(createPublicMediaHeaderMiddleware(apiEnvironment.prefix));

  const corsOriginService = app.get(CorsOriginService);

  app.enableCors({
    origin(
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ): void {
      void corsOriginService
        .isOriginAllowed(origin)
        .then((allowed) => callback(null, allowed))
        .catch(() => callback(null, false));
    },
    credentials: false,
    exposedHeaders: [
      "Accept-Ranges",
      "Content-Range",
      "Content-Length",
      "Content-Type",
    ],
  });

  app.setGlobalPrefix(apiEnvironment.prefix);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.enableShutdownHooks();

  if (apiEnvironment.docsEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle("Video Share CMS API")
      .setDescription(
        "Central API for admin video management and public token-based video sharing.",
      )
      .setVersion("0.1.0")
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup(SWAGGER_PATH, app, document);
  }

  await app.listen(apiEnvironment.port, apiEnvironment.host);
  launchMariaDbCollationProbeAfterListen(
    app.get(MariaDbCollationProbeService),
    () =>
      logger.error(
        {
          event: MARIADB_COLLATION_PROBE_EVENT,
          status: "FAILED",
        },
        MARIADB_COLLATION_PROBE_EVENT,
      ),
  );
}

void bootstrap();

function createPublicMediaHeaderMiddleware(prefix: string) {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mediaPathPattern = new RegExp(
    `^/${escapedPrefix}/public/watch/[^/]+/videos/[^/]+/(?:binary|local-file|thumbnail)$`,
  );

  return (request: Request, response: Response, next: NextFunction): void => {
    if (mediaPathPattern.test(request.path)) {
      response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      response.vary("Origin");
    }

    next();
  };
}

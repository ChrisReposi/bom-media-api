import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import { Logger } from "nestjs-pino";
import { SWAGGER_PATH } from "./common/constants/api.constants";
import type { ApiEnvironmentConfig } from "./config/env.config";
import { AppModule } from "./app.module";
import { CorsOriginService } from "./security/cors-origin.service";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));

  const configService = app.get(ConfigService);
  const apiEnvironment = configService.getOrThrow<ApiEnvironmentConfig>("api");

  app.use(helmet());

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
}

void bootstrap();

"use strict";

require("reflect-metadata");

const { ValidationPipe } = require("@nestjs/common");
const { ConfigService } = require("@nestjs/config");
const { NestFactory } = require("@nestjs/core");
const { Logger } = require("nestjs-pino");
const { loadApiEnv } = require("../../dist/config/load-env.js");

const CONFIRMATION = "I_UNDERSTAND_THIS_DELETES_FIXTURES";
const EXPECTED_DATABASE = "video_share_cms_mariadb_test";

function assertExactTestDatabase() {
  const rawUrl = process.env.DATABASE_URL?.trim().replace(/^"|"$/g, "");
  if (!rawUrl) throw new Error("MariaDB proof child has no database target.");
  const url = new URL(rawUrl);
  const database = url.pathname.replace(/^\//, "");
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "mysql"]);
  if (
    process.env.APP_ENV !== "test" ||
    !localHosts.has(url.hostname) ||
    database !== EXPECTED_DATABASE ||
    process.env.ALLOW_DESTRUCTIVE_DB_TESTS !== CONFIRMATION
  ) {
    throw new Error("MariaDB proof child refused the effective database.");
  }
}

async function bootstrap() {
  loadApiEnv();
  assertExactTestDatabase();
  const { AppModule } = require("../../dist/app.module.js");
  const {
    GlobalExceptionFilter,
  } = require("../../dist/common/filters/global-exception.filter.js");
  assertExactTestDatabase();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const config = app.get(ConfigService).getOrThrow("api");
  app.setGlobalPrefix(config.prefix);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());
  await app.listen(Number(process.env.API_PORT), "127.0.0.1");
}

void bootstrap().catch((error) => {
  const label = error instanceof Error ? error.name : "UnknownError";
  process.stderr.write(`MariaDB proof child startup failed: ${label}\n`);
  process.exit(1);
});

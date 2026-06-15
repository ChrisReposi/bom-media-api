import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import type { ApiEnvironmentConfig } from "../config/env.config";
import { PrismaClient } from "../generated/prisma/client";

function createMariaDbAdapter(
  databaseUrl: string,
  databaseConfig: ApiEnvironmentConfig["database"],
): PrismaMariaDb {
  const url = new URL(databaseUrl);

  const database = url.pathname.replace(/^\//, "");
  if (!database) {
    throw new Error("DATABASE_URL must include a database name.");
  }

  return new PrismaMariaDb({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    connectionLimit: databaseConfig.connectionLimit,
    connectTimeout: databaseConfig.connectTimeoutMs,
    acquireTimeout: databaseConfig.acquireTimeoutMs,
    idleTimeout: databaseConfig.idleTimeoutSeconds,
    allowPublicKeyRetrieval: true,
  });
}

function formatDatabaseTarget(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    const database = url.pathname.replace(/^\//, "");
    const port = url.port || "3306";

    return `${url.hostname}:${port}/${database}`;
  } catch {
    return "unavailable";
  }
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private readonly databaseUrl: string;
  private readonly shouldLogDatabaseTarget: boolean;

  constructor(configService: ConfigService) {
    const databaseUrl = configService.getOrThrow<string>("DATABASE_URL");
    const apiEnvironment =
      configService.getOrThrow<ApiEnvironmentConfig>("api");

    super({
      adapter: createMariaDbAdapter(databaseUrl, apiEnvironment.database),
    });

    this.databaseUrl = databaseUrl;
    this.shouldLogDatabaseTarget =
      configService.get<string>("NODE_ENV") !== "production" ||
      configService.get<string>("APP_ENV") === "local";
  }

  async onModuleInit(): Promise<void> {
    if (this.shouldLogDatabaseTarget) {
      this.logger.log(
        `Database target: ${formatDatabaseTarget(this.databaseUrl)}`,
      );
    }

    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

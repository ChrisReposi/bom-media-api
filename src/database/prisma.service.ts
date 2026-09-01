import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import type { ApiEnvironmentConfig } from "../config/env.config";
import { PrismaClient } from "../generated/prisma/client";

/**
 * The character set and collation every migration declares
 * (`DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`). Derived from
 * the schema contract in `prisma/migrations/`, never from a host default.
 */
const SCHEMA_CHARSET = "utf8mb4";
const SCHEMA_COLLATION = "utf8mb4_unicode_ci";

/**
 * Bind the session charset AND collation explicitly on every pooled connection.
 *
 * Without this the driver never issues a `SET NAMES ... COLLATE ...`: it sends
 * collation id 224 in the handshake and then takes MariaDB's session-tracking
 * shortcut, which leaves `character_set_client`'s default collation and
 * `collation_connection` disagreeing whenever the server sets
 * `@@character_set_collations` (MariaDB 11.4+ maps `utf8mb4` to
 * `utf8mb4_uca1400_ai_ci`, which Hostinger's MariaDB 11.8.8 does).
 *
 * SQL-text literals then take `collation_connection` while bound parameters
 * take the character set's default collation. Prisma compiles `contains` to
 * `col LIKE CONCAT('%', ?, '%')`, so those two disagreeing collations get
 * aggregated: same charset, different collation, equal derivation, which
 * MariaDB resolves to `utf8mb4_bin` with DERIVATION_NONE. NONE outranks the
 * column's IMPLICIT, so the comparison cannot be coerced and the server raises
 * 1267 "Illegal mix of collations ... for operation 'like'" - on every admin
 * `contains`/`startsWith` query, whatever the search term.
 *
 * `SET collation_connection = ...` alone does NOT fix it (verified against
 * production): only the combined `SET NAMES <charset> COLLATE <collation>`
 * rebinds both sides. Pinning the driver's `collation` option does not fix it
 * either - the driver applies it via the handshake byte, not a statement.
 */
const SESSION_COLLATION_INIT_SQL = `SET NAMES ${SCHEMA_CHARSET} COLLATE ${SCHEMA_COLLATION}`;

function createMariaDbAdapter(
  databaseUrl: string,
  databaseConfig: ApiEnvironmentConfig["database"],
): PrismaMariaDb {
  const url = new URL(databaseUrl);

  const database = url.pathname.replace(/^\//, "");
  if (!database) {
    throw new Error("DATABASE_URL must include a database name.");
  }

  return new PrismaMariaDb(
    {
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
      initSql: SESSION_COLLATION_INIT_SQL,
    },
    { useTextProtocol: databaseConfig.mariaDbUseTextProtocol },
  );
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(configService: ConfigService) {
    const databaseUrl = configService.getOrThrow<string>("DATABASE_URL");
    const apiEnvironment =
      configService.getOrThrow<ApiEnvironmentConfig>("api");

    super({
      adapter: createMariaDbAdapter(databaseUrl, apiEnvironment.database),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

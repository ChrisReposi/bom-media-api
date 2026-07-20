import { Injectable } from "@nestjs/common";
// Runtime imports are required for Nest constructor-injection metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ConfigService } from "@nestjs/config";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PinoLogger } from "nestjs-pino";
import type { ApiEnvironmentConfig } from "../../config/env.config";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../database/prisma.service";
import { toSafeDatabaseErrorContext } from "../errors/safe-database-error-context.util";
import {
  parseMariaDbCollationConflict,
  type MariaDbCollationConflict,
} from "../errors/parse-mariadb-collation-conflict.util";
import { MARIADB_COLLATION_PROBE_EVENT } from "./mariadb-collation-probe.constants";

const DIAGNOSTIC_VALUE = "diagnostic";
const DEFAULT_TIMEOUT_MS = 4000;
const MAX_METADATA_TOKEN_LENGTH = 64;
const MAX_COLLATION_MAP_LENGTH = 512;

type SessionMetadataRow = {
  characterSetClient: unknown;
  characterSetConnection: unknown;
  collationConnection: unknown;
  characterSetResults: unknown;
  characterSetServer: unknown;
  collationServer: unknown;
  collationDatabase: unknown;
  characterSetCollations: unknown;
};

type ParameterMetadataRow = {
  paramCharset: unknown;
  paramCollation: unknown;
  paramCoercibility: unknown;
  literalCharset: unknown;
  literalCollation: unknown;
  literalCoercibility: unknown;
};

type ConcatMetadataRow = {
  concatCharset: unknown;
  concatCollation: unknown;
  concatCoercibility: unknown;
};

type SafeExpressionMetadata = {
  charset?: string;
  collation?: string;
  coercibility?: number;
};

type SafeSessionMetadata = {
  characterSetClient?: string;
  characterSetConnection?: string;
  collationConnection?: string;
  characterSetResults?: string;
  characterSetServer?: string;
  collationServer?: string;
  collationDatabase?: string;
  characterSetCollations?: string;
};

type SafeDriverMetadata = {
  code?: string | number;
  sqlState?: string;
};

type ProbeExecutionState = {
  timedOut: boolean;
};

export type MariaDbCollationProbeResult =
  | {
      event: typeof MARIADB_COLLATION_PROBE_EVENT;
      status: "COMPLETED";
      session: SafeSessionMetadata;
      parameter: SafeExpressionMetadata;
      literal: SafeExpressionMetadata;
      concat: SafeExpressionMetadata & { status: "PASS" };
    }
  | {
      event: typeof MARIADB_COLLATION_PROBE_EVENT;
      status: "CONCAT_FAILED";
      session: SafeSessionMetadata;
      parameter: SafeExpressionMetadata;
      literal: SafeExpressionMetadata;
      driver: SafeDriverMetadata;
      conflict?: MariaDbCollationConflict;
    }
  | {
      event: typeof MARIADB_COLLATION_PROBE_EVENT;
      status: "FAILED";
      driver: SafeDriverMetadata;
    }
  | {
      event: typeof MARIADB_COLLATION_PROBE_EVENT;
      status: "TIMEOUT";
    };

class MariaDbCollationProbeTimeoutError extends Error {}

function readMetadataToken(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_METADATA_TOKEN_LENGTH &&
    /^[A-Za-z0-9_]+$/.test(value)
    ? value.toLowerCase()
    : undefined;
}

function readCollationMap(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^[A-Za-z0-9_,=]+$/.test(value)
  ) {
    return undefined;
  }

  return value.length <= MAX_COLLATION_MAP_LENGTH
    ? value
    : `${value.slice(0, MAX_COLLATION_MAP_LENGTH - 3)}...`;
}

function readCoercibility(value: unknown): number | undefined {
  const numberValue =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "string" && /^\d{1,2}$/.test(value)
        ? Number(value)
        : value;

  return typeof numberValue === "number" &&
    Number.isInteger(numberValue) &&
    numberValue >= 0 &&
    numberValue <= 10
    ? numberValue
    : undefined;
}

function toSafeDriverMetadata(error: unknown): SafeDriverMetadata {
  const context = toSafeDatabaseErrorContext(error);
  const rawCode =
    context.cause?.code ?? context.cause?.originalCode ?? context.driverCode;
  const code =
    typeof rawCode === "number" && Number.isSafeInteger(rawCode)
      ? rawCode
      : typeof rawCode === "string" && /^\d{1,10}$/.test(rawCode)
        ? rawCode
        : undefined;
  const sqlState = context.cause?.sqlState ?? context.sqlState;

  return {
    ...(code !== undefined ? { code } : {}),
    ...(sqlState !== undefined ? { sqlState } : {}),
  };
}

function toSafeSessionMetadata(row: SessionMetadataRow): SafeSessionMetadata {
  const characterSetClient = readMetadataToken(row.characterSetClient);
  const characterSetConnection = readMetadataToken(row.characterSetConnection);
  const collationConnection = readMetadataToken(row.collationConnection);
  const characterSetResults = readMetadataToken(row.characterSetResults);
  const characterSetServer = readMetadataToken(row.characterSetServer);
  const collationServer = readMetadataToken(row.collationServer);
  const collationDatabase = readMetadataToken(row.collationDatabase);
  const characterSetCollations = readCollationMap(row.characterSetCollations);

  return {
    ...(characterSetClient ? { characterSetClient } : {}),
    ...(characterSetConnection ? { characterSetConnection } : {}),
    ...(collationConnection ? { collationConnection } : {}),
    ...(characterSetResults ? { characterSetResults } : {}),
    ...(characterSetServer ? { characterSetServer } : {}),
    ...(collationServer ? { collationServer } : {}),
    ...(collationDatabase ? { collationDatabase } : {}),
    ...(characterSetCollations ? { characterSetCollations } : {}),
  };
}

function toSafeExpressionMetadata(params: {
  charset: unknown;
  collation: unknown;
  coercibility: unknown;
}): SafeExpressionMetadata {
  const charset = readMetadataToken(params.charset);
  const collation = readMetadataToken(params.collation);
  const coercibility = readCoercibility(params.coercibility);
  return {
    ...(charset ? { charset } : {}),
    ...(collation ? { collation } : {}),
    ...(coercibility !== undefined ? { coercibility } : {}),
  };
}

function requireSingleRow<T>(rows: T[]): T {
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new Error(
      "MariaDB collation probe returned an unexpected row count.",
    );
  }
  return rows[0];
}

@Injectable()
export class MariaDbCollationProbeService {
  private readonly enabled: boolean;
  private started = false;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    const apiEnvironment =
      configService.getOrThrow<ApiEnvironmentConfig>("api");
    this.enabled = apiEnvironment.diagnostics.mariaDbCollationProbeEnabled;
    this.logger.setContext(MariaDbCollationProbeService.name);
  }

  async runOnceAfterListen(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    if (!this.enabled || this.started) {
      return;
    }
    this.started = true;

    const result = await this.runBounded(timeoutMs);
    this.logger.info(result, MARIADB_COLLATION_PROBE_EVENT);
  }

  private async runBounded(
    timeoutMs: number,
  ): Promise<MariaDbCollationProbeResult> {
    let timeout: NodeJS.Timeout | undefined;
    const state: ProbeExecutionState = { timedOut: false };
    const probe = this.collectMetadata(state);
    try {
      return await Promise.race([
        probe,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => {
              state.timedOut = true;
              reject(new MariaDbCollationProbeTimeoutError());
            },
            Math.min(Math.max(timeoutMs, 1), DEFAULT_TIMEOUT_MS),
          );
        }),
      ]);
    } catch (error) {
      if (error instanceof MariaDbCollationProbeTimeoutError) {
        return { event: MARIADB_COLLATION_PROBE_EVENT, status: "TIMEOUT" };
      }
      return {
        event: MARIADB_COLLATION_PROBE_EVENT,
        status: "FAILED",
        driver: toSafeDriverMetadata(error),
      };
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  private assertNotTimedOut(state: ProbeExecutionState): void {
    if (state.timedOut) {
      throw new MariaDbCollationProbeTimeoutError();
    }
  }

  private async collectMetadata(
    state: ProbeExecutionState,
  ): Promise<MariaDbCollationProbeResult> {
    const sessionRow = requireSingleRow(
      await this.prisma.$queryRaw<SessionMetadataRow[]>`
        SELECT
          @@character_set_client AS characterSetClient,
          @@character_set_connection AS characterSetConnection,
          @@collation_connection AS collationConnection,
          @@character_set_results AS characterSetResults,
          @@character_set_server AS characterSetServer,
          @@collation_server AS collationServer,
          @@collation_database AS collationDatabase,
          @@character_set_collations AS characterSetCollations
      `,
    );
    this.assertNotTimedOut(state);
    const session = toSafeSessionMetadata(sessionRow);

    const parameterRow = requireSingleRow(
      await this.prisma.$queryRaw<ParameterMetadataRow[]>`
        SELECT
          CHARSET(${DIAGNOSTIC_VALUE}) AS paramCharset,
          COLLATION(${DIAGNOSTIC_VALUE}) AS paramCollation,
          COERCIBILITY(${DIAGNOSTIC_VALUE}) AS paramCoercibility,
          CHARSET('%') AS literalCharset,
          COLLATION('%') AS literalCollation,
          COERCIBILITY('%') AS literalCoercibility
      `,
    );
    this.assertNotTimedOut(state);
    const parameter = toSafeExpressionMetadata({
      charset: parameterRow.paramCharset,
      collation: parameterRow.paramCollation,
      coercibility: parameterRow.paramCoercibility,
    });
    const literal = toSafeExpressionMetadata({
      charset: parameterRow.literalCharset,
      collation: parameterRow.literalCollation,
      coercibility: parameterRow.literalCoercibility,
    });

    try {
      const concatRow = requireSingleRow(
        await this.prisma.$queryRaw<ConcatMetadataRow[]>`
          SELECT
            CHARSET(CONCAT('%', ${DIAGNOSTIC_VALUE}, '%')) AS concatCharset,
            COLLATION(CONCAT('%', ${DIAGNOSTIC_VALUE}, '%')) AS concatCollation,
            COERCIBILITY(CONCAT('%', ${DIAGNOSTIC_VALUE}, '%')) AS concatCoercibility
        `,
      );
      this.assertNotTimedOut(state);
      return {
        event: MARIADB_COLLATION_PROBE_EVENT,
        status: "COMPLETED",
        session,
        parameter,
        literal,
        concat: {
          status: "PASS",
          ...toSafeExpressionMetadata({
            charset: concatRow.concatCharset,
            collation: concatRow.concatCollation,
            coercibility: concatRow.concatCoercibility,
          }),
        },
      };
    } catch (error) {
      const conflict = parseMariaDbCollationConflict(error);
      return {
        event: MARIADB_COLLATION_PROBE_EVENT,
        status: "CONCAT_FAILED",
        session,
        parameter,
        literal,
        driver: toSafeDriverMetadata(error),
        ...(conflict ? { conflict } : {}),
      };
    }
  }
}

import { Prisma } from "../../generated/prisma/client";

/**
 * Allowlisted, secret-free context extracted from a database/Prisma error for
 * structured logging. Built to close the production observability gap where a
 * 500 only logged `errorName`, making P2022 (missing column/table) and P2024
 * (connection-pool timeout) indistinguishable.
 *
 * NEVER include: raw/unredacted error message, SQL text, query arguments,
 * DATABASE_URL, host, username, password, tokens, or request body. Only
 * structural identifiers (error code, model name, offending field/constraint
 * names, driver code, SQLSTATE, and a coarse category) are exposed.
 */
export type SafeDatabaseErrorContext = {
  errorName: string;
  errorCode?: string;
  modelName?: string;
  fields?: string;
  driverCode?: string;
  sqlState?: string;
  databaseCategory?: string;
};

const CATEGORY_BY_PRISMA_CODE: Record<string, string> = {
  P1001: "DATABASE_UNREACHABLE",
  P1002: "DATABASE_UNREACHABLE",
  P1008: "OPERATION_TIMEOUT",
  P1017: "CONNECTION_CLOSED",
  P2021: "MISSING_TABLE",
  P2022: "MISSING_COLUMN",
  P2024: "CONNECTION_POOL_TIMEOUT",
  P2025: "RECORD_NOT_FOUND",
};

function stringifyFieldTarget(target: unknown): string | undefined {
  if (typeof target === "string") {
    return target;
  }
  if (Array.isArray(target)) {
    return target.map(String).join(",");
  }
  return undefined;
}

/**
 * Reads the @prisma/adapter-mariadb driver error shape without exposing the
 * original (potentially value-bearing) message. Only the driver kind, numeric
 * driver code and constraint/index name are surfaced.
 */
function extractDriverContext(meta: unknown): {
  driverCode?: string;
  sqlState?: string;
  fields?: string;
} {
  if (meta === null || typeof meta !== "object") {
    return {};
  }
  const cause = (
    meta as { driverAdapterError?: { cause?: Record<string, unknown> } }
  ).driverAdapterError?.cause;
  if (cause === undefined || cause === null) {
    return {};
  }

  const driverCode =
    typeof cause.originalCode === "string"
      ? cause.originalCode
      : typeof cause.code === "string"
        ? cause.code
        : undefined;
  const sqlState =
    typeof cause.sqlState === "string" ? cause.sqlState : undefined;
  const constraint = (cause.constraint ?? {}) as {
    index?: unknown;
    fields?: unknown;
  };
  const fields =
    typeof constraint.index === "string"
      ? constraint.index
      : stringifyFieldTarget(constraint.fields);

  return { driverCode, sqlState, fields };
}

export function toSafeDatabaseErrorContext(
  error: unknown,
): SafeDatabaseErrorContext {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = error.meta as
      | { modelName?: unknown; target?: unknown; column?: unknown }
      | undefined;
    const driver = extractDriverContext(error.meta);
    return {
      errorName: error.name,
      errorCode: error.code,
      ...(typeof meta?.modelName === "string"
        ? { modelName: meta.modelName }
        : {}),
      ...(() => {
        const fields =
          stringifyFieldTarget(meta?.target) ??
          (typeof meta?.column === "string" ? meta.column : undefined) ??
          driver.fields;
        return fields ? { fields } : {};
      })(),
      ...(driver.driverCode ? { driverCode: driver.driverCode } : {}),
      ...(driver.sqlState ? { sqlState: driver.sqlState } : {}),
      ...(CATEGORY_BY_PRISMA_CODE[error.code]
        ? { databaseCategory: CATEGORY_BY_PRISMA_CODE[error.code] }
        : {}),
    };
  }

  if (error instanceof Prisma.PrismaClientInitializationError) {
    return {
      errorName: error.name,
      ...(error.errorCode ? { errorCode: error.errorCode } : {}),
      databaseCategory: "INITIALIZATION",
    };
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    return { errorName: error.name, databaseCategory: "QUERY_VALIDATION" };
  }

  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return { errorName: error.name, databaseCategory: "UNKNOWN_REQUEST" };
  }

  if (error instanceof Prisma.PrismaClientRustPanicError) {
    return { errorName: error.name, databaseCategory: "ENGINE_PANIC" };
  }

  if (error instanceof Error) {
    return { errorName: error.name };
  }

  return { errorName: "UnknownError" };
}

/**
 * True when the error is any Prisma client error — used to decide whether the
 * safe database context is worth attaching to a log line.
 */
export function isPrismaError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientInitializationError ||
    error instanceof Prisma.PrismaClientValidationError ||
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientRustPanicError
  );
}

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
  cause?: SafeDriverAdapterCause;
  databaseCategory?: string;
};

export type SafeDriverAdapterCause = {
  kind?: string;
  originalCode?: string;
  code?: string | number;
  sqlState?: string;
  constraint?: {
    index?: string;
    fields?: string[];
  };
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

const CATEGORY_BY_DRIVER_KIND: Record<string, string> = {
  AuthenticationFailed: "DATABASE_ACCESS_DENIED",
  ColumnNotFound: "MISSING_COLUMN",
  ConnectionClosed: "CONNECTION_CLOSED",
  DatabaseAccessDenied: "DATABASE_ACCESS_DENIED",
  DatabaseDoesNotExist: "DATABASE_NOT_FOUND",
  DatabaseNotReachable: "DATABASE_UNREACHABLE",
  ForeignKeyConstraintViolation: "CONSTRAINT_VIOLATION",
  InconsistentColumnData: "DATA_CONVERSION",
  InvalidInputValue: "DATA_CONVERSION",
  LengthMismatch: "DATA_CONVERSION",
  NullConstraintViolation: "CONSTRAINT_VIOLATION",
  SocketTimeout: "OPERATION_TIMEOUT",
  TableDoesNotExist: "MISSING_TABLE",
  TooManyConnections: "CONNECTION_LIMIT",
  TransactionWriteConflict: "TRANSACTION_CONFLICT",
  UniqueConstraintViolation: "CONSTRAINT_VIOLATION",
  ValueOutOfRange: "DATA_CONVERSION",
};

const CATEGORY_BY_MYSQL_CODE: Record<string, string> = {
  "1040": "CONNECTION_LIMIT",
  "1054": "MISSING_COLUMN",
  "1146": "MISSING_TABLE",
  "1203": "CONNECTION_LIMIT",
  "1205": "OPERATION_TIMEOUT",
  "1213": "TRANSACTION_CONFLICT",
};

const MAX_DRIVER_KIND_LENGTH = 64;
const MAX_DRIVER_CODE_LENGTH = 32;
const MAX_SQL_STATE_LENGTH = 16;
const MAX_CONSTRAINT_IDENTIFIER_LENGTH = 191;
const MAX_CONSTRAINT_FIELDS = 16;

function readBoundedString(
  value: unknown,
  maximumLength: number,
): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength
    ? value
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractSafeDriverCause(value: unknown): SafeDriverAdapterCause {
  const cause = asRecord(value);
  if (cause === undefined) {
    return {};
  }

  const kind = readBoundedString(cause.kind, MAX_DRIVER_KIND_LENGTH);
  const originalCode = readBoundedString(
    cause.originalCode,
    MAX_DRIVER_CODE_LENGTH,
  );
  const code =
    typeof cause.code === "number" && Number.isSafeInteger(cause.code)
      ? cause.code
      : readBoundedString(cause.code, MAX_DRIVER_CODE_LENGTH);
  // Adapter 7.8 exposes MariaDB's SQLSTATE as `state` for its generic
  // `kind: "mysql"` payload. Normalize it to the only public allowlisted key,
  // `sqlState`, without copying the surrounding driver payload.
  const sqlState = readBoundedString(
    cause.sqlState ?? cause.state,
    MAX_SQL_STATE_LENGTH,
  );
  const rawConstraint = asRecord(cause.constraint);
  const index = readBoundedString(
    rawConstraint?.index,
    MAX_CONSTRAINT_IDENTIFIER_LENGTH,
  );
  const fields = Array.isArray(rawConstraint?.fields)
    ? rawConstraint.fields
        .map((field) =>
          readBoundedString(field, MAX_CONSTRAINT_IDENTIFIER_LENGTH),
        )
        .filter((field): field is string => field !== undefined)
        .slice(0, MAX_CONSTRAINT_FIELDS)
    : undefined;

  return {
    ...(kind ? { kind } : {}),
    ...(originalCode ? { originalCode } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(sqlState ? { sqlState } : {}),
    ...(index || (fields !== undefined && fields.length > 0)
      ? {
          constraint: {
            ...(index ? { index } : {}),
            ...(fields !== undefined && fields.length > 0 ? { fields } : {}),
          },
        }
      : {}),
  };
}

function categoryForDriverCause(cause: SafeDriverAdapterCause): string {
  if (cause.kind && CATEGORY_BY_DRIVER_KIND[cause.kind]) {
    return CATEGORY_BY_DRIVER_KIND[cause.kind];
  }

  const code =
    cause.originalCode ??
    (cause.code === undefined ? undefined : String(cause.code));
  return (code && CATEGORY_BY_MYSQL_CODE[code]) ?? "DRIVER_ADAPTER";
}

function isTopLevelDriverAdapterError(error: unknown): boolean {
  const record = asRecord(error);
  const cause = asRecord(record?.cause);
  return (
    error instanceof Error &&
    error.name === "DriverAdapterError" &&
    typeof cause?.kind === "string"
  );
}

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
  cause?: SafeDriverAdapterCause;
} {
  if (meta === null || typeof meta !== "object") {
    return {};
  }
  const rawCause = (
    meta as { driverAdapterError?: { cause?: Record<string, unknown> } }
  ).driverAdapterError?.cause;
  if (rawCause === undefined || rawCause === null) {
    return {};
  }
  const cause = extractSafeDriverCause(rawCause);
  const driverCode =
    cause.originalCode ??
    (cause.code === undefined ? undefined : String(cause.code));
  const fields =
    cause.constraint?.index ?? stringifyFieldTarget(cause.constraint?.fields);

  return { driverCode, sqlState: cause.sqlState, fields, cause };
}

export function toSafeDatabaseErrorContext(
  error: unknown,
): SafeDatabaseErrorContext {
  if (isTopLevelDriverAdapterError(error)) {
    const cause = extractSafeDriverCause(
      (error as Error & { cause: unknown }).cause,
    );
    return {
      errorName: "DriverAdapterError",
      cause,
      databaseCategory: categoryForDriverCause(cause),
    };
  }

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
      ...(driver.cause && Object.keys(driver.cause).length > 0
        ? { cause: driver.cause }
        : {}),
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

// Non-enumerable, module-private tag so the failing service stage can be
// carried on the (unchanged) error object to the GlobalExceptionFilter, which
// emits a single request-correlated log. It never enumerates/serializes and
// never alters the error's prototype, so Prisma error identity and `.code`
// are preserved.
const DATABASE_STAGE = Symbol("databaseStage");

export function tagDatabaseStage<T>(error: T, stage: string): T {
  if (typeof error === "object" && error !== null) {
    try {
      Object.defineProperty(error, DATABASE_STAGE, {
        value: stage,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    } catch {
      // Frozen/sealed error — leave it untagged rather than throw.
    }
  }
  return error;
}

export function readDatabaseStage(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null) {
    const value = (error as Record<symbol, unknown>)[DATABASE_STAGE];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

/**
 * `.catch()` handler that tags the rejection with a query stage and rethrows
 * unchanged. Returns `never`, so the awaited promise keeps its exact inferred
 * (Prisma) result type — no annotations or casts needed at the call site.
 */
export function rethrowWithDatabaseStage(
  stage: string,
): (error: unknown) => never {
  return (error: unknown): never => {
    throw tagDatabaseStage(error, stage);
  };
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

/** True for Prisma client errors and direct driver-adapter failures. */
export function isDatabaseError(error: unknown): boolean {
  return isPrismaError(error) || isTopLevelDriverAdapterError(error);
}

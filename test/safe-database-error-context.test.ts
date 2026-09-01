import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "../src/generated/prisma/client";
import {
  isDatabaseError,
  isPrismaError,
  toSafeDatabaseErrorContext,
} from "../src/common/errors/safe-database-error-context.util";

const SECRETS = [
  "mysql://user:s3cret@db.example.com:3306/prod",
  "s3cret",
  "Bearer abc.def.ghi",
  "SELECT * FROM VideoAsset WHERE title = 'private value'",
];

function assertNoSecrets(context: Record<string, unknown>): void {
  const serialized = JSON.stringify(context);
  for (const secret of SECRETS) {
    assert.ok(!serialized.includes(secret), `leaked: ${secret}`);
  }
}

describe("safe database error context", () => {
  it("surfaces P2022 (missing column) as MISSING_COLUMN with model/field, no message", () => {
    const error = new Prisma.PrismaClientKnownRequestError(
      `Do not know how to handle column. ${SECRETS[3]}`,
      {
        code: "P2022",
        clientVersion: "7.8.0",
        meta: { modelName: "VideoAsset", column: "checksumSha256" },
      },
    );
    const context = toSafeDatabaseErrorContext(error);
    assert.equal(context.errorCode, "P2022");
    assert.equal(context.modelName, "VideoAsset");
    assert.equal(context.fields, "checksumSha256");
    assert.equal(context.databaseCategory, "MISSING_COLUMN");
    assert.ok(!("message" in context));
    assertNoSecrets(context);
  });

  it("surfaces P2024 as CONNECTION_POOL_TIMEOUT", () => {
    const error = new Prisma.PrismaClientKnownRequestError("Timed out", {
      code: "P2024",
      clientVersion: "7.8.0",
      meta: {},
    });
    const context = toSafeDatabaseErrorContext(error);
    assert.equal(context.errorCode, "P2024");
    assert.equal(context.databaseCategory, "CONNECTION_POOL_TIMEOUT");
  });

  it("reads the @prisma/adapter-mariadb driver shape (no meta.target)", () => {
    const error = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "7.8.0",
      meta: {
        modelName: "VideoAsset",
        driverAdapterError: {
          cause: {
            kind: "UniqueConstraintViolation",
            originalCode: "1062",
            constraint: { index: "VideoAsset_slug_key" },
          },
        },
      },
    });
    const context = toSafeDatabaseErrorContext(error);
    assert.equal(context.errorCode, "P2002");
    assert.equal(context.modelName, "VideoAsset");
    assert.equal(context.driverCode, "1062");
    assert.equal(context.fields, "VideoAsset_slug_key");
    assert.deepEqual(context.cause, {
      kind: "UniqueConstraintViolation",
      originalCode: "1062",
      constraint: { index: "VideoAsset_slug_key" },
    });
    assertNoSecrets(context);
  });

  it("extracts a top-level DriverAdapterError using a strict structural allowlist", () => {
    const error = Object.assign(new Error(SECRETS.join(" ")), {
      name: "DriverAdapterError",
      cause: {
        kind: "mysql",
        originalCode: "42000",
        originalMessage: `${SECRETS[3]} ${SECRETS[0]}`,
        code: 1064,
        state: "42000",
        message: `${SECRETS[3]} ${SECRETS[1]}`,
        sql: SECRETS[3],
        parameters: ["private value"],
        host: "db.example.com",
        user: "private-user",
        password: SECRETS[1],
      },
    });

    const context = toSafeDatabaseErrorContext(error);
    assert.deepEqual(context, {
      errorName: "DriverAdapterError",
      cause: {
        kind: "mysql",
        originalCode: "42000",
        code: 1064,
        sqlState: "42000",
      },
      databaseCategory: "DRIVER_ADAPTER",
    });
    assert.equal(isDatabaseError(error), true);
    assertNoSecrets(context);
  });

  it("classifies direct adapter causes without reading raw driver messages", () => {
    const missingColumn = Object.assign(new Error(SECRETS[3]), {
      name: "DriverAdapterError",
      cause: {
        kind: "ColumnNotFound",
        originalCode: "1054",
        originalMessage: SECRETS[3],
        column: "private_column_from_message",
      },
    });
    const constraint = Object.assign(new Error(SECRETS[3]), {
      name: "DriverAdapterError",
      cause: {
        kind: "UniqueConstraintViolation",
        originalCode: "1062",
        constraint: { fields: ["websiteId", "videoId"] },
        message: SECRETS[3],
      },
    });

    assert.deepEqual(toSafeDatabaseErrorContext(missingColumn), {
      errorName: "DriverAdapterError",
      cause: { kind: "ColumnNotFound", originalCode: "1054" },
      databaseCategory: "MISSING_COLUMN",
    });
    assert.deepEqual(toSafeDatabaseErrorContext(constraint), {
      errorName: "DriverAdapterError",
      cause: {
        kind: "UniqueConstraintViolation",
        originalCode: "1062",
        constraint: { fields: ["websiteId", "videoId"] },
      },
      databaseCategory: "CONSTRAINT_VIOLATION",
    });
    assertNoSecrets(toSafeDatabaseErrorContext(missingColumn));
    assertNoSecrets(toSafeDatabaseErrorContext(constraint));
  });

  it("handles array meta.target", () => {
    const error = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "7.8.0",
      meta: { target: ["websiteId", "videoId"] },
    });
    assert.equal(toSafeDatabaseErrorContext(error).fields, "websiteId,videoId");
  });

  it("classifies initialization errors without leaking the URL", () => {
    const error = new Prisma.PrismaClientInitializationError(
      `Can't reach database server at ${SECRETS[0]}`,
      "7.8.0",
      "P1001",
    );
    const context = toSafeDatabaseErrorContext(error);
    assert.equal(context.errorName, "PrismaClientInitializationError");
    assert.equal(context.databaseCategory, "INITIALIZATION");
    assertNoSecrets(context);
  });

  it("degrades gracefully for plain and non-error values", () => {
    assert.deepEqual(toSafeDatabaseErrorContext(new Error("boom")), {
      errorName: "Error",
    });
    assert.deepEqual(toSafeDatabaseErrorContext("nope"), {
      errorName: "UnknownError",
    });
  });

  // SEARCH-17: production 1267 observability. The bounded collation pair is the
  // one piece of evidence that identifies which column/connection collations
  // actually conflict; before this it was parsed only by the opt-in boot probe
  // and discarded on the request path.
  it("surfaces MariaDB 1267 as COLLATION_CONFLICT with the bounded collation pair", () => {
    const error = Object.assign(new Error("wrapper"), {
      name: "DriverAdapterError",
      cause: {
        kind: "mysql",
        originalCode: "1267",
        code: 1267,
        state: "HY000",
        originalMessage:
          "Illegal mix of collations (utf8mb3_general_ci,IMPLICIT) and (utf8mb4_unicode_ci,COERCIBLE) for operation 'like'",
        sql: SECRETS[3],
        parameters: ["private value"],
        host: "private-host",
        user: "private-user",
        password: SECRETS[1],
      },
    });

    const context = toSafeDatabaseErrorContext(error);
    assert.equal(context.errorName, "DriverAdapterError");
    assert.equal(context.databaseCategory, "COLLATION_CONFLICT");
    assert.deepEqual(context.collationConflict, {
      leftCollation: "utf8mb3_general_ci",
      leftCoercibility: "IMPLICIT",
      rightCollation: "utf8mb4_unicode_ci",
      rightCoercibility: "COERCIBLE",
      operation: "like",
    });
    assert.equal(context.cause?.sqlState, "HY000");
    assertNoSecrets(context);
    const serialized = JSON.stringify(context);
    for (const forbidden of [
      "private-host",
      "private-user",
      "private value",
      '"parameters"',
      '"sql"',
    ]) {
      assert.ok(!serialized.includes(forbidden), `leaked: ${forbidden}`);
    }
  });

  it("surfaces 1267 through the Prisma meta.driverAdapterError shape", () => {
    const error = new Prisma.PrismaClientKnownRequestError("query failed", {
      code: "P2010",
      clientVersion: "7.8.0",
      meta: {
        modelName: "VideoAsset",
        driverAdapterError: {
          cause: {
            kind: "mysql",
            originalCode: "1267",
            code: 1267,
            state: "HY000",
            originalMessage:
              "Illegal mix of collations (latin1_swedish_ci,IMPLICIT) and (utf8mb4_unicode_ci,COERCIBLE) for operation 'like'",
          },
        },
      },
    });

    const context = toSafeDatabaseErrorContext(error);
    assert.equal(context.databaseCategory, "COLLATION_CONFLICT");
    assert.equal(context.collationConflict?.leftCollation, "latin1_swedish_ci");
    assert.equal(context.collationConflict?.operation, "like");
    assertNoSecrets(context);
  });

  it("omits collationConflict for non-1267 drivers and unparseable 1267 messages", () => {
    const otherCode = Object.assign(new Error("wrapper"), {
      name: "DriverAdapterError",
      cause: {
        kind: "mysql",
        originalCode: "1146",
        code: 1146,
        state: "42S02",
        originalMessage:
          "Illegal mix of collations (a_ci,IMPLICIT) and (b_ci,COERCIBLE) for operation 'like'",
      },
    });
    const otherContext = toSafeDatabaseErrorContext(otherCode);
    assert.equal(otherContext.databaseCategory, "MISSING_TABLE");
    assert.equal(otherContext.collationConflict, undefined);

    const unparseable = Object.assign(new Error("wrapper"), {
      name: "DriverAdapterError",
      cause: {
        kind: "mysql",
        originalCode: "1267",
        code: 1267,
        state: "HY000",
        originalMessage: `Illegal mix of collations ${SECRETS[3]}`,
      },
    });
    const unparseableContext = toSafeDatabaseErrorContext(unparseable);
    assert.equal(unparseableContext.databaseCategory, "COLLATION_CONFLICT");
    assert.equal(unparseableContext.collationConflict, undefined);
    assertNoSecrets(unparseableContext);
  });

  it("isPrismaError distinguishes Prisma errors from generic errors", () => {
    assert.equal(
      isPrismaError(
        new Prisma.PrismaClientKnownRequestError("x", {
          code: "P2024",
          clientVersion: "7.8.0",
          meta: {},
        }),
      ),
      true,
    );
    assert.equal(isPrismaError(new Error("x")), false);
    assert.equal(isPrismaError("x"), false);
    assert.equal(isDatabaseError(new Error("x")), false);
  });
});

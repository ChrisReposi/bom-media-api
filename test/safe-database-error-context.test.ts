import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "../src/generated/prisma/client";
import {
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
    assertNoSecrets(context);
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
  });
});

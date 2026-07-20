import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Logger } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { safeRequestRoute } from "../src/common/http/safe-request-route.util";
import {
  readDatabaseStage,
  tagDatabaseStage,
} from "../src/common/errors/safe-database-error-context.util";
import { Prisma } from "../src/generated/prisma/client";

type CapturedLog = { payload: Record<string, unknown>; message: string };

function runFilter(
  exception: unknown,
  request: Record<string, unknown>,
): { log: CapturedLog | null; status: number; body: unknown } {
  const captured: CapturedLog[] = [];
  const originalError = Logger.prototype.error;
  (Logger.prototype as { error: unknown }).error = function (
    payload: Record<string, unknown>,
    message: string,
  ): void {
    captured.push({ payload, message });
  };

  let status = 0;
  let body: unknown;
  const response = {
    headersSent: false,
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
    end() {},
  };

  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  try {
    new GlobalExceptionFilter().catch(exception, host);
  } finally {
    (Logger.prototype as { error: unknown }).error = originalError;
  }

  return { log: captured[0] ?? null, status, body };
}

afterEach(() => {
  // Logger prototype is restored inside runFilter's finally.
});

describe("safeRequestRoute", () => {
  it("returns the route template, never the raw URL", () => {
    assert.equal(
      safeRequestRoute({
        route: { path: "/api/v1/admin/videos" },
        baseUrl: "",
        originalUrl: "/api/v1/admin/videos?search=private-value",
      } as never),
      "/api/v1/admin/videos",
    );
  });

  it("omits the route when no matched template is available", () => {
    assert.equal(
      safeRequestRoute({
        baseUrl: "",
        originalUrl: "/api/v1/admin/videos?search=private-value",
      } as never),
      undefined,
    );
    assert.equal(
      safeRequestRoute({ route: { path: 42 }, baseUrl: "" } as never),
      undefined,
    );
  });
});

describe("GlobalExceptionFilter diagnostic logging", () => {
  it("logs an admin route template without the query string or its values", () => {
    const { log, status, body } = runFilter(new Error("boom"), {
      id: "req-admin",
      method: "GET",
      route: { path: "/api/v1/admin/videos" },
      baseUrl: "",
      originalUrl: "/api/v1/admin/videos?page=1&limit=20&search=private-value",
      headers: {
        authorization: "Bearer super.secret.jwt",
        cookie: "session=RAW_COOKIE",
      },
    });

    assert.ok(log);
    assert.equal(status, 500);
    assert.deepEqual(body, {
      statusCode: 500,
      message: "Internal server error",
      error: "Internal Server Error",
    });
    assert.equal(log.payload.route, "/api/v1/admin/videos");
    assert.equal(log.payload.requestId, "req-admin");

    const serialized = JSON.stringify(log.payload);
    for (const forbidden of [
      "search=",
      "private-value",
      "super.secret.jwt",
      "RAW_COOKIE",
      "?page=1",
    ]) {
      assert.ok(!serialized.includes(forbidden), `leaked: ${forbidden}`);
    }
  });

  it("never logs raw share tokens, video ids, or media grants from a public URL", () => {
    const { log } = runFilter(new Error("boom"), {
      id: "req-public",
      method: "GET",
      route: { path: "/api/v1/public/watch/:token/videos/:videoId/binary" },
      baseUrl: "",
      originalUrl:
        "/api/v1/public/watch/RAW_SHARE_TOKEN/videos/VIDEO_ID/binary?grant=RAW_MEDIA_GRANT",
      headers: {},
    });

    assert.ok(log);
    assert.equal(
      log.payload.route,
      "/api/v1/public/watch/:token/videos/:videoId/binary",
    );
    const serialized = JSON.stringify(log.payload);
    for (const forbidden of [
      "RAW_SHARE_TOKEN",
      "VIDEO_ID",
      "RAW_MEDIA_GRANT",
      "grant=",
    ]) {
      assert.ok(!serialized.includes(forbidden), `leaked: ${forbidden}`);
    }
  });

  it("correlates requestId + stage + Prisma database context in one log line", () => {
    const error = tagDatabaseStage(
      new Prisma.PrismaClientKnownRequestError("missing column", {
        code: "P2022",
        clientVersion: "7.8.0",
        meta: { modelName: "VideoAsset", column: "checksumSha256" },
      }),
      "ADMIN_VIDEO_LIST_QUERY",
    );

    const { log } = runFilter(error, {
      id: "req-corr",
      method: "GET",
      route: { path: "/api/v1/admin/videos" },
      baseUrl: "",
      headers: {},
    });

    assert.ok(log);
    assert.equal(log.payload.requestId, "req-corr");
    assert.equal(log.payload.method, "GET");
    assert.equal(log.payload.route, "/api/v1/admin/videos");
    assert.equal(log.payload.status, 500);
    assert.equal(log.payload.stage, "ADMIN_VIDEO_LIST_QUERY");
    assert.equal(log.payload.errorName, "PrismaClientKnownRequestError");
    const database = log.payload.database as Record<string, unknown>;
    assert.equal(database.errorCode, "P2022");
    assert.equal(database.databaseCategory, "MISSING_COLUMN");
    assert.equal(database.modelName, "VideoAsset");
  });

  it("omits stage/database for non-database errors", () => {
    const { log } = runFilter(new Error("plain"), {
      id: "req-plain",
      method: "GET",
      route: { path: "/api/v1/admin/videos" },
      baseUrl: "",
      headers: {},
    });
    assert.ok(log);
    assert.ok(!("stage" in log.payload));
    assert.ok(!("database" in log.payload));
  });
});

describe("database stage tagging preserves error identity", () => {
  it("keeps Prisma instanceof and code after tagging, non-enumerable", () => {
    const error = new Prisma.PrismaClientKnownRequestError("x", {
      code: "P2024",
      clientVersion: "7.8.0",
      meta: {},
    });
    const tagged = tagDatabaseStage(error, "WEBSITE_ASSIGNMENT_OPTIONS_QUERY");
    assert.ok(tagged instanceof Prisma.PrismaClientKnownRequestError);
    assert.equal(tagged.code, "P2024");
    assert.equal(readDatabaseStage(tagged), "WEBSITE_ASSIGNMENT_OPTIONS_QUERY");
    // stage must not appear in enumerable/serialized form
    assert.ok(!JSON.stringify(Object.keys(tagged)).includes("databaseStage"));
  });

  it("is a no-op for non-object rejections", () => {
    assert.equal(tagDatabaseStage("nope", "X"), "nope");
    assert.equal(readDatabaseStage("nope"), undefined);
  });
});

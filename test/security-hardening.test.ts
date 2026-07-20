import "reflect-metadata";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { ArgumentsHost, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AdminRolesGuard } from "../src/admin-auth/guards/admin-roles.guard";
import { ADMIN_ROLES_METADATA } from "../src/admin-auth/decorators/admin-roles.decorator";
import { AdminWebsitesController } from "../src/admin-websites/admin-websites.controller";
import { AdminAccountsController } from "../src/admin-accounts/admin-accounts.controller";
import { serializeRequestForLogs } from "../src/app.module";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter";
import { getClientIpFromRequest } from "../src/common/utils/request-security.util";
import { apiConfig, type ApiEnvironmentConfig } from "../src/config/env.config";
import { validateEnv } from "../src/config/env.validation";
import { AccountStatus, AdminRole } from "../src/generated/prisma/client";
import { HealthService } from "../src/health/health.service";
import { PublicMediaGrantService } from "../src/public/public-media-grant.service";
import { CorsOriginService } from "../src/security/cors-origin.service";
import { VideosController } from "../src/videos/videos.controller";
import {
  isShortAdminWebsiteSearch,
  normalizeAdminWebsiteSearch,
} from "../src/admin-websites/utils/admin-website-search.util";

const productionEnv = {
  NODE_ENV: "production",
  APP_ENV: "production",
  ADMIN_WEB_ORIGIN: "https://admin.example.com",
  DATABASE_URL: "mysql://user:pass@localhost:3306/db",
  JWT_ACCESS_SECRET: "test-jwt-secret",
  REFRESH_TOKEN_PEPPER: "test-refresh-pepper",
  SHARE_TOKEN_PEPPER: "test-share-pepper",
  PUBLIC_MEDIA_GRANT_SECRET: "test-public-media-grant-secret-at-least-32-bytes",
  ACCESS_LOG_IP_PEPPER: "test-ip-pepper",
  ADMIN_CHANGE_PASSWORD_SECRET: "test-password-change-secret",
  VIDEO_DB_STORAGE_ENABLED: "false",
} as const;

class GrantConfigService {
  get<T = string>(key: string): T | undefined {
    if (key === "PUBLIC_MEDIA_GRANT_SECRET") {
      return productionEnv.PUBLIC_MEDIA_GRANT_SECRET as T;
    }
    if (key === "PUBLIC_MEDIA_GRANT_TTL_SECONDS") {
      return "300" as T;
    }
    return undefined;
  }

  getOrThrow<T = string>(key: string): T {
    const value = this.get<T>(key);
    if (value === undefined) {
      throw new Error(`${key} missing`);
    }
    return value;
  }
}

describe("public media grants", () => {
  it("binds signed grants to share link, video, host, and expiry", () => {
    const service = new PublicMediaGrantService(
      new GrantConfigService() as never,
    );
    const issuedAt = new Date("2026-07-14T00:00:00.000Z");
    const grant = service.issue({
      shareLinkId: "share-1",
      videoId: "video-1",
      host: "media.example.com",
      shareLinkExpiresAt: null,
      now: issuedAt,
    });

    assert.equal(
      service.verify(grant, {
        shareLinkId: "share-1",
        videoId: "video-1",
        host: "media.example.com",
        now: new Date("2026-07-14T00:04:59.000Z"),
      }),
      true,
    );
    assert.equal(
      service.verify(grant, {
        shareLinkId: "share-1",
        videoId: "video-2",
        host: "media.example.com",
        now: issuedAt,
      }),
      false,
    );
    assert.equal(
      service.verify(grant, {
        shareLinkId: "share-1",
        videoId: "video-1",
        host: "other.example.com",
        now: issuedAt,
      }),
      false,
    );
    assert.equal(
      service.verify(`${grant}tampered`, {
        shareLinkId: "share-1",
        videoId: "video-1",
        host: "media.example.com",
        now: issuedAt,
      }),
      false,
    );
    assert.equal(
      service.verify(grant, {
        shareLinkId: "share-1",
        videoId: "video-1",
        host: "media.example.com",
        now: new Date("2026-07-14T00:05:01.000Z"),
      }),
      false,
    );
  });

  it("rejects signed but non-canonical base64url payloads", () => {
    const service = new PublicMediaGrantService(
      new GrantConfigService() as never,
    );
    const grant = service.issue({
      shareLinkId: "share-1",
      videoId: "video-1",
      host: "media.example.com",
      shareLinkExpiresAt: null,
      now: new Date("2026-07-14T00:00:00.000Z"),
    });
    const [payload] = grant.split(".");
    assert.ok(payload);
    const nonCanonicalPayload = `${payload}=`;
    const signature = createHmac(
      "sha256",
      productionEnv.PUBLIC_MEDIA_GRANT_SECRET,
    )
      .update(nonCanonicalPayload)
      .digest("base64url");

    assert.equal(
      service.verify(`${nonCanonicalPayload}.${signature}`, {
        shareLinkId: "share-1",
        videoId: "video-1",
        host: "media.example.com",
        now: new Date("2026-07-14T00:00:00.000Z"),
      }),
      false,
    );
  });
});

function roleContext(
  role: AdminRole,
  method: string,
  handler: () => void = () => undefined,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => class TestController {},
    switchToHttp: () => ({
      getRequest: () => ({
        method,
        admin: {
          id: "admin-1",
          username: "admin",
          role,
          status: AccountStatus.ACTIVE,
          createdAt: new Date(),
          lastLoginAt: null,
        },
      }),
    }),
  } as unknown as ExecutionContext;
}

describe("admin role guard", () => {
  it("denies routes without explicit role metadata", () => {
    const guard = new AdminRolesGuard(new Reflector());

    assert.throws(
      () => guard.canActivate(roleContext(AdminRole.OWNER, "GET")),
      ForbiddenException,
    );
  });

  it("keeps STAFF read-only and allows ADMIN mutations with explicit roles", () => {
    const guard = new AdminRolesGuard(new Reflector());
    const readHandler = (): void => undefined;
    const writeHandler = (): void => undefined;
    Reflect.defineMetadata(
      ADMIN_ROLES_METADATA,
      [AdminRole.OWNER, AdminRole.ADMIN, AdminRole.STAFF],
      readHandler,
    );
    Reflect.defineMetadata(
      ADMIN_ROLES_METADATA,
      [AdminRole.OWNER, AdminRole.ADMIN],
      writeHandler,
    );

    assert.equal(
      guard.canActivate(roleContext(AdminRole.STAFF, "GET", readHandler)),
      true,
    );
    assert.throws(
      () =>
        guard.canActivate(roleContext(AdminRole.STAFF, "POST", writeHandler)),
      ForbiddenException,
    );
    assert.equal(
      guard.canActivate(roleContext(AdminRole.ADMIN, "POST", writeHandler)),
      true,
    );
  });

  it("enforces explicit OWNER-only metadata for purge", () => {
    const guard = new AdminRolesGuard(new Reflector());
    const handler = (): void => undefined;
    Reflect.defineMetadata(ADMIN_ROLES_METADATA, [AdminRole.OWNER], handler);

    assert.throws(
      () => guard.canActivate(roleContext(AdminRole.ADMIN, "DELETE", handler)),
      ForbiddenException,
    );
    assert.equal(
      guard.canActivate(roleContext(AdminRole.OWNER, "DELETE", handler)),
      true,
    );
  });

  it("requires explicit role metadata on every guarded admin resource route", () => {
    for (const controller of [
      AdminAccountsController,
      AdminWebsitesController,
      VideosController,
    ]) {
      for (const propertyName of Object.getOwnPropertyNames(
        controller.prototype,
      )) {
        if (propertyName === "constructor") {
          continue;
        }
        const handler = Object.getOwnPropertyDescriptor(
          controller.prototype,
          propertyName,
        )?.value as unknown;
        if (typeof handler !== "function") {
          continue;
        }
        const requestMethod = Reflect.getMetadata("method", handler) as
          | number
          | undefined;
        if (requestMethod === undefined) {
          continue;
        }

        const roles = Reflect.getMetadata(ADMIN_ROLES_METADATA, handler) as
          | AdminRole[]
          | undefined;
        assert.ok(
          roles !== undefined && roles.length > 0,
          `${controller.name}.${propertyName} is missing explicit admin roles`,
        );
      }
    }
  });
});

function proxyRequest(params: {
  remoteAddress: string;
  requestIp?: string;
  cloudflareIp?: string;
}): never {
  return {
    ip: params.requestIp ?? params.remoteAddress,
    socket: { remoteAddress: params.remoteAddress },
    headers: {
      ...(params.cloudflareIp === undefined
        ? {}
        : { "cf-connecting-ip": params.cloudflareIp }),
    },
  } as never;
}

describe("trusted proxy client IP", () => {
  const options = {
    trustProxyEnabled: true,
    trustProxyCloudflareOnly: true,
    trustedProxyCidrs: ["203.0.113.0/24"],
  };

  it("accepts CF-Connecting-IP only from a trusted immediate peer", () => {
    assert.equal(
      getClientIpFromRequest(
        proxyRequest({
          remoteAddress: "203.0.113.10",
          cloudflareIp: "198.51.100.20",
        }),
        options,
      ),
      "198.51.100.20",
    );
    assert.equal(
      getClientIpFromRequest(
        proxyRequest({
          remoteAddress: "192.0.2.10",
          cloudflareIp: "198.51.100.20",
        }),
        options,
      ),
      "192.0.2.10",
    );
  });

  it("rejects malformed forwarded client IP values", () => {
    assert.equal(
      getClientIpFromRequest(
        proxyRequest({
          remoteAddress: "203.0.113.10",
          cloudflareIp: "spoofed-client",
        }),
        options,
      ),
      "203.0.113.10",
    );
  });
});

describe("request log redaction", () => {
  it("serializes only request id, method and the matched route template", () => {
    const rawUrl =
      "/api/v1/public/watch/raw-secret/videos/video-1/local-file?host=example.com&grant=raw-grant";
    const serialized = serializeRequestForLogs({
      id: "request-1",
      method: "GET",
      url: rawUrl,
      params: { token: "raw-secret", grant: "raw-grant" },
      query: { host: "example.com", grant: "raw-grant" },
      headers: {
        authorization: "Bearer raw-jwt",
        cookie: "session=raw-cookie",
        "x-forwarded-for": "203.0.113.9",
      },
      remoteAddress: "10.0.0.5",
      remotePort: 44321,
      raw: {
        id: "request-1",
        method: "GET",
        route: {
          path: "/api/v1/public/watch/:token/videos/:videoId/local-file",
        },
        baseUrl: "",
      },
    });
    assert.deepEqual(serialized, {
      id: "request-1",
      method: "GET",
      route: "/api/v1/public/watch/:token/videos/:videoId/local-file",
    });
    const json = JSON.stringify(serialized);
    for (const forbidden of [
      "raw-secret",
      "raw-grant",
      "raw-jwt",
      "raw-cookie",
      "203.0.113.9",
      "10.0.0.5",
      "host=",
      "url",
      "query",
      "headers",
      "remoteAddress",
    ]) {
      assert.equal(json.includes(forbidden), false, `leaked: ${forbidden}`);
    }
  });

  it("omits route instead of falling back to raw request values", () => {
    assert.deepEqual(
      serializeRequestForLogs({
        id: "request-2",
        method: "GET",
        url: "/not-found?token=raw-token",
        headers: { "x-forwarded-for": "198.51.100.5" },
      }),
      { id: "request-2", method: "GET" },
    );
  });

  it("does not log a database host or database name during Prisma startup", () => {
    const source = readFileSync("src/database/prisma.service.ts", "utf8");
    assert.ok(!source.includes("Database target:"));
    assert.ok(!source.includes("formatDatabaseTarget"));
  });
});

type ResponseState = {
  statusCode?: number;
  body?: unknown;
  ended: boolean;
};

function exceptionHost(state: ResponseState): ArgumentsHost {
  const response = {
    headersSent: false,
    status(statusCode: number) {
      state.statusCode = statusCode;
      return this;
    },
    json(body: unknown) {
      state.body = body;
      return this;
    },
    end() {
      state.ended = true;
    },
  };
  return {
    switchToHttp: () => ({
      getRequest: () => ({ id: "request-1", method: "GET" }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
}

describe("global exception filter", () => {
  it("hides unexpected internal messages and preserves client errors", () => {
    const filter = new GlobalExceptionFilter();
    const internalState: ResponseState = { ended: false };
    filter.catch(
      new Error("database hostname and internal path"),
      exceptionHost(internalState),
    );
    assert.equal(internalState.statusCode, 500);
    assert.equal(
      JSON.stringify(internalState.body).includes("database hostname"),
      false,
    );

    const clientState: ResponseState = { ended: false };
    filter.catch(
      new NotFoundException("Video not found."),
      exceptionHost(clientState),
    );
    assert.equal(clientState.statusCode, 404);
    assert.equal(
      JSON.stringify(clientState.body).includes("Video not found."),
      true,
    );
  });
});

describe("readiness", () => {
  it("checks the database and caches only successful readiness", async () => {
    let queryCount = 0;
    const prisma = {
      $queryRaw: async () => {
        queryCount += 1;
        return [{ ok: 1 }];
      },
    };
    const config = {
      getOrThrow: () => ({
        localFileStorage: { enabled: false, root: null },
      }),
    };
    const service = new HealthService(prisma as never, config as never);

    assert.equal((await service.getReadiness()).checks.database, "ok");
    assert.equal((await service.getReadiness()).checks.storage, "disabled");
    assert.equal(queryCount, 1);
  });

  it("returns a generic 503 when the database check fails", async () => {
    const service = new HealthService(
      {
        $queryRaw: async () => Promise.reject(new Error("db details")),
      } as never,
      { getOrThrow: () => ({}) } as never,
    );

    await assert.rejects(
      service.getReadiness(),
      (error: unknown) =>
        error instanceof ServiceUnavailableException &&
        error.message === "Service is not ready.",
    );
  });
});

describe("production configuration hardening", () => {
  it("defaults bootstrap registration off and requires proxy CIDRs", () => {
    const previousEnv = { ...process.env };
    try {
      const validated = validateEnv(productionEnv);
      assert.equal(validated.ADMIN_REGISTER_ENABLED, "false");

      assert.throws(
        () =>
          validateEnv({
            ...productionEnv,
            TRUST_PROXY_ENABLED: "true",
          }),
        /TRUSTED_PROXY_CIDRS/,
      );
    } finally {
      process.env = previousEnv;
    }
  });

  it("defaults MariaDB to binary protocol and validates the text-protocol switch", () => {
    const previousEnv = { ...process.env };
    try {
      const defaults = validateEnv(productionEnv);
      assert.equal(defaults.DB_MARIADB_USE_TEXT_PROTOCOL, "false");
      assert.equal(apiConfig().database.mariaDbUseTextProtocol, false);

      const textProtocol = validateEnv({
        ...productionEnv,
        DB_MARIADB_USE_TEXT_PROTOCOL: "true",
      });
      assert.equal(textProtocol.DB_MARIADB_USE_TEXT_PROTOCOL, "true");
      assert.equal(apiConfig().database.mariaDbUseTextProtocol, true);

      assert.throws(
        () =>
          validateEnv({
            ...productionEnv,
            DB_MARIADB_USE_TEXT_PROTOCOL: "yes",
          }),
        /DB_MARIADB_USE_TEXT_PROTOCOL must be a boolean value/,
      );
    } finally {
      process.env = previousEnv;
    }
  });

  it("rejects local or insecure production admin origins", () => {
    const previousEnv = { ...process.env };
    try {
      assert.throws(
        () =>
          validateEnv({
            ...productionEnv,
            ADMIN_WEB_ORIGIN: "http://localhost:5173",
          }),
        /non-local HTTPS origin/,
      );
    } finally {
      process.env = previousEnv;
    }
  });
});

describe("production CORS", () => {
  it("does not auto-allow localhost", async () => {
    const apiConfig = {
      isProduction: true,
      port: 3000,
      host: "0.0.0.0",
      corsAllowedOrigins: ["https://admin.example.com"],
      corsAllowDbDomains: false,
    } as ApiEnvironmentConfig;
    const service = new CorsOriginService(
      { getOrThrow: () => apiConfig } as never,
      {} as never,
    );

    assert.equal(await service.isOriginAllowed("http://localhost:3000"), false);
    assert.equal(
      await service.isOriginAllowed("https://admin.example.com"),
      true,
    );
  });
});

describe("admin website search normalization", () => {
  it("normalizes NFC and whitespace and flags one-character searches", () => {
    const decomposed = "  Cafe\u0301   demo  ";
    assert.equal(normalizeAdminWebsiteSearch(decomposed), "Café demo");
    assert.equal(isShortAdminWebsiteSearch("x"), true);
  });
});

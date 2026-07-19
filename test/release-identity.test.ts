import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ApiEnvironmentConfig } from "../src/config/env.config";
import { validateEnv } from "../src/config/env.validation";
import { HealthService } from "../src/health/health.service";

const baseEnv = {
  DATABASE_URL: "mysql://user:pass@localhost:3306/db",
  JWT_ACCESS_SECRET: "test-only-jwt-access-secret-0123456789abcdef",
  REFRESH_TOKEN_PEPPER: "test-only-refresh-token-pepper-0123456789abcdef",
  SHARE_TOKEN_PEPPER: "test-only-share-token-pepper-0123456789abcdef",
  ACCESS_LOG_IP_PEPPER: "test-only-access-log-ip-pepper-0123456789abcdef",
};

function createHealthService(
  release?: Partial<ApiEnvironmentConfig["release"]>,
): HealthService {
  const config =
    release === undefined
      ? {}
      : { release: { version: null, commit: null, builtAt: null, ...release } };

  return new HealthService({} as never, { getOrThrow: () => config } as never);
}

describe("release identity env validation", () => {
  it("accepts absent release metadata everywhere", () => {
    const validated = validateEnv({ ...baseEnv });
    assert.equal(validated.APP_RELEASE_VERSION, undefined);
    assert.equal(validated.APP_BUILD_SHA, undefined);
    assert.equal(validated.APP_BUILD_TIME, undefined);
  });

  it("trims and keeps valid metadata", () => {
    const validated = validateEnv({
      ...baseEnv,
      APP_RELEASE_VERSION: "  2026.07.18  ",
      APP_BUILD_SHA: " 210b9af ",
      APP_BUILD_TIME: "2026-07-18T00:00:00.000Z",
    });
    assert.equal(validated.APP_RELEASE_VERSION, "2026.07.18");
    assert.equal(validated.APP_BUILD_SHA, "210b9af");
    assert.equal(validated.APP_BUILD_TIME, "2026-07-18T00:00:00.000Z");
  });

  it("rejects malformed injected values at boot", () => {
    assert.throws(
      () => validateEnv({ ...baseEnv, APP_BUILD_SHA: "not-a-sha!" }),
      /hexadecimal commit SHA/,
    );
    assert.throws(
      () => validateEnv({ ...baseEnv, APP_BUILD_TIME: "18/07/2026" }),
      /ISO 8601/,
    );
    assert.throws(
      () => validateEnv({ ...baseEnv, APP_RELEASE_VERSION: "x".repeat(65) }),
      /64 characters/,
    );
  });
});

describe("health release identity payload", () => {
  it("keeps the legacy shape when metadata is absent", () => {
    const health = createHealthService().getHealth();
    assert.equal(health.status, "ok");
    assert.equal(health.service, "api");
    assert.equal(typeof health.timestamp, "string");
    assert.equal("release" in health, false);
  });

  it("omits release when all fields are null", () => {
    const health = createHealthService({}).getHealth();
    assert.equal("release" in health, false);
  });

  it("returns only the injected safe fields", () => {
    const health = createHealthService({
      commit: "210b9af",
      builtAt: "2026-07-18T00:00:00.000Z",
    }).getHealth();

    assert.deepEqual(health.release, {
      commit: "210b9af",
      builtAt: "2026-07-18T00:00:00.000Z",
    });
    assert.deepEqual(Object.keys(health).sort(), [
      "release",
      "service",
      "status",
      "timestamp",
    ]);
  });
});

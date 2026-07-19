import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DESTRUCTIVE_CONFIRMATION,
  assertDestructiveTestDatabase,
  evaluateDestructiveTestDatabase,
} from "../scripts/safety/assert-destructive-test-database";

const allowedEnv = {
  APP_ENV: "test",
  DATABASE_URL:
    "mysql://test_user:test_password@127.0.0.1:3307/video_share_cms_test",
  ALLOW_DESTRUCTIVE_DB_TESTS: DESTRUCTIVE_CONFIRMATION,
};

describe("destructive database guard", () => {
  it("allows a confirmed local _test database (and _scratch, and APP_ENV=local)", () => {
    assert.equal(evaluateDestructiveTestDatabase(allowedEnv).allowed, true);
    assert.equal(
      evaluateDestructiveTestDatabase({
        ...allowedEnv,
        APP_ENV: "local",
        DATABASE_URL: "mysql://u:p@localhost:3307/anything_scratch",
      }).allowed,
      true,
    );
    const passed = assertDestructiveTestDatabase(
      allowedEnv as NodeJS.ProcessEnv,
    );
    assert.deepEqual(passed, {
      host: "127.0.0.1",
      database: "video_share_cms_test",
    });
  });

  it("rejects the shared dev database even with confirmation", () => {
    const decision = evaluateDestructiveTestDatabase({
      ...allowedEnv,
      DATABASE_URL: "mysql://u:p@127.0.0.1:3307/video_share_cms_dev",
    });
    assert.equal(decision.allowed, false);
    assert.match(
      decision.allowed ? "" : decision.reason,
      /must end with _test or _scratch/,
    );
  });

  it("rejects remote and unknown hosts", () => {
    for (const url of [
      "mysql://u:p@db.example.com:3306/video_share_cms_test",
      "mysql://u:p@10.0.0.5:3306/video_share_cms_test",
    ]) {
      const decision = evaluateDestructiveTestDatabase({
        ...allowedEnv,
        DATABASE_URL: url,
      });
      assert.equal(decision.allowed, false);
      assert.match(
        decision.allowed ? "" : decision.reason,
        /not a repository-owned local database host/,
      );
    }
  });

  it("rejects wrong APP_ENV, missing confirmation, malformed and missing URL", () => {
    assert.equal(
      evaluateDestructiveTestDatabase({ ...allowedEnv, APP_ENV: "production" })
        .allowed,
      false,
    );
    assert.equal(
      evaluateDestructiveTestDatabase({ ...allowedEnv, APP_ENV: undefined })
        .allowed,
      false,
    );
    assert.equal(
      evaluateDestructiveTestDatabase({
        ...allowedEnv,
        ALLOW_DESTRUCTIVE_DB_TESTS: "yes",
      }).allowed,
      false,
    );
    assert.equal(
      evaluateDestructiveTestDatabase({
        ...allowedEnv,
        ALLOW_DESTRUCTIVE_DB_TESTS: undefined,
      }).allowed,
      false,
    );
    assert.equal(
      evaluateDestructiveTestDatabase({
        ...allowedEnv,
        DATABASE_URL: "not-a-url",
      }).allowed,
      false,
    );
    assert.equal(
      evaluateDestructiveTestDatabase({
        ...allowedEnv,
        DATABASE_URL: undefined,
      }).allowed,
      false,
    );
    assert.equal(
      evaluateDestructiveTestDatabase({
        ...allowedEnv,
        DATABASE_URL: "mysql://u:p@127.0.0.1:3307/",
      }).allowed,
      false,
    );
  });

  it("never leaks credentials in refusal reasons", () => {
    const decision = evaluateDestructiveTestDatabase({
      APP_ENV: "test",
      DATABASE_URL:
        "mysql://supersecretuser:supersecretpass@db.example.com:3306/video_share_cms_test",
      ALLOW_DESTRUCTIVE_DB_TESTS: DESTRUCTIVE_CONFIRMATION,
    });
    assert.equal(decision.allowed, false);
    const reason = decision.allowed ? "" : decision.reason;
    assert.ok(!reason.includes("supersecretuser"));
    assert.ok(!reason.includes("supersecretpass"));
    assert.throws(
      () =>
        assertDestructiveTestDatabase({
          APP_ENV: "test",
          DATABASE_URL:
            "mysql://supersecretuser:supersecretpass@db.example.com:3306/x_test",
          ALLOW_DESTRUCTIVE_DB_TESTS: DESTRUCTIVE_CONFIRMATION,
        } as NodeJS.ProcessEnv),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes("supersecret"));
        return true;
      },
    );
  });

  it("strips surrounding quotes from env-file style URLs", () => {
    assert.equal(
      evaluateDestructiveTestDatabase({
        ...allowedEnv,
        DATABASE_URL: '"mysql://u:p@127.0.0.1:3307/video_share_cms_test"',
      }).allowed,
      true,
    );
  });
});

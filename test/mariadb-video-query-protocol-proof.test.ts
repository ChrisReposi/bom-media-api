import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DESTRUCTIVE_CONFIRMATION } from "../scripts/safety/assert-destructive-test-database";
import {
  assertMariaDbVideoQueryProofDatabase,
  buildMariaDbProofIdentity,
  MARIADB_VIDEO_QUERY_PROOF_DATABASE,
  protocolLabel,
} from "../scripts/test/mariadb-video-query-protocol-proof-core";

describe("MariaDB video-query protocol proof safety", () => {
  const allowedEnv = {
    APP_ENV: "test",
    DATABASE_URL: `mysql://test:test@127.0.0.1:3308/${MARIADB_VIDEO_QUERY_PROOF_DATABASE}`,
    ALLOW_DESTRUCTIVE_DB_TESTS: DESTRUCTIVE_CONFIRMATION,
  } as NodeJS.ProcessEnv;

  it("requires the exact local isolated database and destructive confirmation", () => {
    assert.deepEqual(assertMariaDbVideoQueryProofDatabase(allowedEnv), {
      host: "127.0.0.1",
      database: MARIADB_VIDEO_QUERY_PROOF_DATABASE,
    });
    assert.throws(() =>
      assertMariaDbVideoQueryProofDatabase({
        ...allowedEnv,
        DATABASE_URL: "mysql://test:test@127.0.0.1:3307/video_share_cms_dev",
      }),
    );
    assert.throws(() =>
      assertMariaDbVideoQueryProofDatabase({
        ...allowedEnv,
        ALLOW_DESTRUCTIVE_DB_TESTS: "",
      }),
    );
  });

  it("generates bounded run-scoped fixture identifiers", () => {
    const identity = buildMariaDbProofIdentity(1720000000000, "a1b2c3d4");
    assert.match(identity.runId, /^mariadbq_[0-9]+_[a-f0-9]{8}$/);
    assert.ok(identity.websiteId.startsWith(identity.runId));
    assert.ok(identity.adminId.startsWith(identity.runId));
    assert.ok(identity.videoIdPrefix.startsWith(identity.runId));
  });

  it("defines both protocol labels and keeps output/source free of raw diagnostics", () => {
    assert.equal(protocolLabel(false), "binary");
    assert.equal(protocolLabel(true), "text");
    const source = readFileSync(
      "scripts/test/mariadb-video-query-protocol-proof.ts",
      "utf8",
    );
    const packageSource = readFileSync("package.json", "utf8");
    assert.ok(source.includes("useTextProtocol: false"));
    assert.ok(source.includes("useTextProtocol: true"));
    assert.ok(source.includes("globalNoSearch"));
    assert.ok(source.includes("globalSearch"));
    assert.ok(source.includes("assignmentOptionsTotal"));
    for (const forbidden of [
      "console.log",
      "error.message",
      "error.stack",
      "process.env.DATABASE_URL)",
      "SELECT *",
    ]) {
      assert.ok(!source.includes(forbidden), `unsafe source: ${forbidden}`);
    }
    assert.ok(!packageSource.includes("DATABASE_URL=mysql://"));
  });
});

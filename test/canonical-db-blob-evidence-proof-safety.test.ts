import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  DESTRUCTIVE_CONFIRMATION,
  evaluateDestructiveTestDatabase,
} from "../scripts/safety/assert-destructive-test-database";
import {
  GATE3C1_DATABASE,
  assertGate3c1Database,
  assertGate3c1RunId,
  buildGate3c1CleanupScope,
  buildGate3c1FixtureIdentity,
  safeProofMessage,
} from "../scripts/test/canonical-db-blob-evidence-proof-core";

const validRunId = "gate3c1_1760000000000_a1b2c3";

describe("Gate 3C-1 integration proof safety contract", () => {
  it("refuses the shared development database and missing confirmation", () => {
    const base = {
      APP_ENV: "test",
      DATABASE_URL: "mysql://test:test@127.0.0.1:3307/video_share_cms_test",
      ALLOW_DESTRUCTIVE_DB_TESTS: DESTRUCTIVE_CONFIRMATION,
    };

    assert.equal(
      evaluateDestructiveTestDatabase({
        ...base,
        DATABASE_URL: "mysql://test:test@127.0.0.1:3307/video_share_cms_dev",
      }).allowed,
      false,
    );
    assert.equal(
      evaluateDestructiveTestDatabase({
        ...base,
        ALLOW_DESTRUCTIVE_DB_TESTS: undefined,
      }).allowed,
      false,
    );
    assert.throws(() => assertGate3c1Database("anything_scratch"));
    assert.doesNotThrow(() => assertGate3c1Database(GATE3C1_DATABASE));
  });

  it("requires a unique run id and derives cleanup targets only from it", () => {
    assert.throws(() => assertGate3c1RunId(""));
    assert.throws(() => assertGate3c1RunId("gate3c1_missing_parts"));
    const identity = buildGate3c1FixtureIdentity(validRunId);
    const cleanup = buildGate3c1CleanupScope(identity);

    assert.equal(cleanup.adminId, `${validRunId}_admin`);
    assert.deepEqual(cleanup.websiteIds, [
      `${validRunId}_website`,
      `${validRunId}_legacy_website`,
    ]);
    assert.deepEqual(cleanup.domainIds, [
      `${validRunId}_domain`,
      `${validRunId}_legacy_domain`,
    ]);
    assert.equal(cleanup.legacyVideoId, `${validRunId}_legacy_video`);

    const contaminated = {
      ...identity,
      legacyVideoId: "unrelated-video",
    };
    assert.throws(() => buildGate3c1CleanupScope(contaminated));
  });

  it("guards before bootstrapping Nest and never formats credential or checksum values", () => {
    const root = join(__dirname, "..");
    const script = readFileSync(
      join(root, "scripts/test/canonical-db-blob-evidence-proof.ts"),
      "utf8",
    );
    const packageJson = readFileSync(join(root, "package.json"), "utf8");
    const childBootstrap = readFileSync(
      join(root, "scripts/test/canonical-db-blob-evidence-proof-api.cjs"),
      "utf8",
    );
    const proofSources = `${script}\n${childBootstrap}`;

    assert.ok(
      script.indexOf("assertDestructiveTestDatabase()") <
        script.indexOf("apiProcess = await startTestApi(port)"),
    );
    assert.ok(
      childBootstrap.indexOf("  assertExactTestDatabase();") <
        childBootstrap.indexOf('require("../../dist/app.module.js")'),
    );
    assert.match(
      packageJson,
      /test:integration:canonical-db-evidence[^\n]+APP_ENV=test[^\n]+DOTENV_CONFIG_PATH=\.env\.test/,
    );
    assert.doesNotMatch(
      proofSources,
      /console\.(?:log|error|debug)\(\s*(?:accessToken|refreshToken|rawToken|tokenHash|checksumSha256|data)\b/,
    );
    assert.doesNotMatch(
      proofSources,
      /\$\{(?:accessToken|refreshToken|rawToken|tokenHash|checksumSha256)\b/,
    );
    assert.doesNotMatch(script, /deleteMany\(\{\s*\}\)/);
    assert.equal(
      safeProofMessage("checksum matched", "PROVEN"),
      "PROVEN: checksum matched",
    );
  });
});

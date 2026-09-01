import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DESTRUCTIVE_CONFIRMATION } from "../scripts/safety/assert-destructive-test-database";
import {
  assertMariaDbCollationProofDatabase,
  buildCollationProofIdentity,
  MARIADB_COLLATION_PROOF_DATABASE,
  SCHEMA_CHARSET,
  SCHEMA_COLLATION,
  SEARCH_CASES,
} from "../scripts/test/mariadb-collation-search-proof-core";

describe("MariaDB collation search proof safety", () => {
  const allowedEnv = {
    APP_ENV: "test",
    DATABASE_URL: `mysql://test:test@127.0.0.1:3312/${MARIADB_COLLATION_PROOF_DATABASE}`,
    ALLOW_DESTRUCTIVE_DB_TESTS: DESTRUCTIVE_CONFIRMATION,
  } as NodeJS.ProcessEnv;

  it("requires the exact disposable database and destructive confirmation", () => {
    assert.deepEqual(assertMariaDbCollationProofDatabase(allowedEnv), {
      host: "127.0.0.1",
      database: MARIADB_COLLATION_PROOF_DATABASE,
    });
    // The other MariaDB proof database must not be accepted by this one.
    assert.throws(() =>
      assertMariaDbCollationProofDatabase({
        ...allowedEnv,
        DATABASE_URL:
          "mysql://test:test@127.0.0.1:3308/video_share_cms_mariadb_test",
      }),
    );
    assert.throws(() =>
      assertMariaDbCollationProofDatabase({
        ...allowedEnv,
        DATABASE_URL: "mysql://test:test@127.0.0.1:3307/video_share_cms_dev",
      }),
    );
    assert.throws(() =>
      assertMariaDbCollationProofDatabase({
        ...allowedEnv,
        ALLOW_DESTRUCTIVE_DB_TESTS: "",
      }),
    );
  });

  it("generates bounded run-scoped fixture identifiers", () => {
    const identity = buildCollationProofIdentity(1720000000000, "a1b2c3d4");
    assert.match(identity.runId, /^collq_[0-9]+_[a-f0-9]{8}$/);
    assert.ok(identity.videoIdPrefix.startsWith(identity.runId));
    assert.ok(identity.videoSlugPrefix.startsWith(identity.runId));
  });

  it("pins the schema contract to the value the migrations declare", () => {
    // Derived from prisma/migrations, never from a host default: every
    // CREATE TABLE ends with `DEFAULT CHARACTER SET utf8mb4 COLLATE
    // utf8mb4_unicode_ci`. Stock MariaDB 11.8 defaults to
    // utf8mb4_uca1400_ai_ci, which is exactly the drift the proof detects.
    assert.equal(SCHEMA_CHARSET, "utf8mb4");
    assert.equal(SCHEMA_COLLATION, "utf8mb4_unicode_ci");
    const initMigration = readFileSync(
      "prisma/migrations/20260529163942_init/migration.sql",
      "utf8",
    );
    assert.ok(
      initMigration.includes(
        `DEFAULT CHARACTER SET ${SCHEMA_CHARSET} COLLATE ${SCHEMA_COLLATION}`,
      ),
    );
  });

  it("covers the literal LIKE metacharacters and Unicode the incident named", () => {
    const terms = SEARCH_CASES.map(([, term]) => term);
    assert.ok(terms.includes("100%"), "literal % case missing");
    assert.ok(terms.includes("a_b"), "literal _ case missing");
    assert.ok(
      terms.some((term) => term.includes("\\")),
      "literal backslash case missing",
    );
    assert.ok(
      terms.some((term) =>
        [...term].some((ch) => (ch.codePointAt(0) ?? 0) > 127),
      ),
      "Vietnamese Unicode case missing",
    );
    // A no-result term proves an empty result is a real empty result and not a
    // swallowed database error.
    assert.ok(SEARCH_CASES.some(([, , expected]) => expected.length === 0));
  });

  it("keeps the proof read-only about secrets and both protocols covered", () => {
    const source = readFileSync(
      "scripts/test/mariadb-collation-search-proof.ts",
      "utf8",
    );
    assert.ok(source.includes("useTextProtocol"));
    assert.ok(source.includes("for (const useTextProtocol of [false, true])"));
    assert.ok(source.includes("COLLATION_CONFLICT"));
    for (const forbidden of [
      "console.log",
      "error.message",
      "error.stack",
      "process.env.DATABASE_URL)",
      "SELECT *",
      "migrate reset",
      "db push",
    ]) {
      assert.ok(!source.includes(forbidden), `unsafe source: ${forbidden}`);
    }
    // The proof must clean up after itself and must never drop the schema.
    assert.ok(source.includes("deleteMany"));
    assert.ok(!source.includes("DROP TABLE"));
    assert.ok(!source.includes("DROP DATABASE"));
  });
});

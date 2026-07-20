import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Prisma } from "../src/generated/prisma/client";
import {
  PRODUCTION_DIAGNOSTIC_CONFIRMATION,
  readAdminVideoDiagnosticOptions,
  toSafeDiagnosticFailure,
} from "../scripts/diagnostics/admin-video-query-isolation-core";

describe("admin video query diagnostic safety", () => {
  it("requires explicit Production confirmation, website scope and no concurrency", () => {
    assert.throws(() =>
      readAdminVideoDiagnosticOptions({ APP_ENV: "production" }, [
        "node",
        "diagnostic",
      ]),
    );
    assert.throws(() =>
      readAdminVideoDiagnosticOptions(
        {
          APP_ENV: "production",
          ALLOW_READ_ONLY_PRODUCTION_DIAGNOSTICS:
            PRODUCTION_DIAGNOSTIC_CONFIRMATION,
          ADMIN_VIDEO_DIAGNOSTIC_WEBSITE_ID: "website-id",
        },
        ["node", "diagnostic", "--include-concurrency"],
      ),
    );
    assert.deepEqual(
      readAdminVideoDiagnosticOptions(
        {
          APP_ENV: "production",
          ALLOW_READ_ONLY_PRODUCTION_DIAGNOSTICS:
            PRODUCTION_DIAGNOSTIC_CONFIRMATION,
          ADMIN_VIDEO_DIAGNOSTIC_WEBSITE_ID: "website-id",
          ADMIN_VIDEO_DIAGNOSTIC_SEARCH: "sml",
        },
        ["node", "diagnostic"],
      ),
      {
        isProduction: true,
        websiteId: "website-id",
        search: "sml",
        includeConcurrencyComparison: false,
      },
    );
  });

  it("serializes only allowlisted database context and stage", () => {
    const secretMessage =
      "SELECT private FROM VideoAsset WHERE title='raw-search-value' mysql://user:password@host/database";
    const error = new Prisma.PrismaClientKnownRequestError(secretMessage, {
      code: "P2022",
      clientVersion: "7.8.0",
      meta: { modelName: "VideoAsset", column: "filterKey" },
    });
    const safe = toSafeDiagnosticFailure(error);
    assert.equal(safe.error.errorCode, "P2022");
    assert.equal(safe.error.databaseCategory, "MISSING_COLUMN");
    assert.equal(safe.error.fields, "filterKey");
    const serialized = JSON.stringify(safe);
    for (const forbidden of [
      secretMessage,
      "raw-search-value",
      "user:password",
      "SELECT private",
    ]) {
      assert.ok(!serialized.includes(forbidden), `leaked: ${forbidden}`);
    }
  });

  it("keeps the executable probe read-only by source contract", () => {
    const source = readFileSync(
      "scripts/diagnostics/admin-video-query-isolation.ts",
      "utf8",
    );
    for (const forbidden of [
      ".create(",
      ".createMany(",
      ".update(",
      ".updateMany(",
      ".upsert(",
      ".delete(",
      ".deleteMany(",
      ".$executeRaw",
      ".$queryRawUnsafe",
      "INSERT INTO",
      "UPDATE Video",
      "DELETE FROM",
      "ALTER TABLE",
      "DROP TABLE",
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `mutation primitive: ${forbidden}`,
      );
    }
    assert.ok(source.includes("inputValuesRedacted: true"));
    assert.ok(!source.includes("writeSafeResult({ DATABASE_URL"));
    assert.ok(!source.includes("console.log(process.env"));
  });

  it("tags the assigned-list query and mapping stages without changing its contract", () => {
    const source = readFileSync(
      "src/admin-websites/admin-websites.service.ts",
      "utf8",
    );
    assert.ok(source.includes("WEBSITE_ASSIGNED_VIDEO_LIST_QUERY"));
    assert.ok(source.includes("WEBSITE_ASSIGNED_VIDEO_LIST_MAPPING"));
  });
});

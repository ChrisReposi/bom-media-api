import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  analyzeShareLinkAssignments,
  formatAuditWorksheet,
  maskAlias,
  type ShareLinkAuditInput,
} from "../scripts/audit/share-link-assignment-audit-core";

describe("share-link assignment audit", () => {
  it("finds affected and partially valid active links without exposing identifiers", () => {
    const links: ShareLinkAuditInput[] = [
      {
        id: "share-link-sensitive-id",
        alias: "SecretAlias",
        status: "ACTIVE",
        expiresAt: null,
        website: {
          id: "website-sensitive-id",
          status: "ACTIVE",
          activeDomainCount: 1,
        },
        videos: [
          {
            id: "video-missing-assignment",
            status: "READY",
            sourceType: "LOCAL_FILE",
            playbackUrlPresent: false,
            embedUrlPresent: false,
            binaryAssetPlayable: false,
            localFileAssetPlayable: true,
            assignments: [],
          },
          {
            id: "video-valid-assignment",
            status: "READY",
            sourceType: "DIRECT_URL",
            playbackUrlPresent: true,
            embedUrlPresent: false,
            binaryAssetPlayable: false,
            localFileAssetPlayable: false,
            assignments: [
              { websiteId: "website-sensitive-id", status: "ACTIVE" },
            ],
          },
        ],
      },
    ];

    const result = analyzeShareLinkAssignments(
      links,
      new Date("2026-07-14T00:00:00.000Z"),
    );
    const worksheet = formatAuditWorksheet(result);

    assert.equal(result.counts.missingSameSiteAssignments, 1);
    assert.equal(result.counts.activeLinksWithPartialValidity, 1);
    assert.equal(result.counts.affectedActiveLinks, 1);
    assert.equal(
      result.cases[0]?.recommendation,
      "REVIEW — likely create/activate assignment",
    );
    assert.equal(worksheet.includes("share-link-sensitive-id"), false);
    assert.equal(worksheet.includes("SecretAlias"), false);
    assert.equal(worksheet.includes("Sec***as"), true);
  });

  it("masks short and normal aliases", () => {
    assert.equal(maskAlias("abc"), "a***c");
    assert.equal(maskAlias("abcdefghi"), "abc***hi");
    assert.equal(maskAlias(null), "none");
  });

  it("keeps the production audit runner free of Prisma mutations", async () => {
    const source = await readFile(
      resolve(process.cwd(), "scripts/audit/share-link-assignment-audit.ts"),
      "utf8",
    );

    assert.doesNotMatch(
      source,
      /prisma\.[a-zA-Z]+\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/,
    );
    assert.equal(source.includes("tokenHash"), false);
  });
});

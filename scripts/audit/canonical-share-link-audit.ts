/**
 * Read-only canonical share-link audit.
 *
 * Classifies every website+video pair that has share links so the OWNER can
 * decide which legacy link (if any) becomes canonical. Never selects
 * tokenHash, never prints raw tokens, masks ids and aliases, and bounds all
 * sample output.
 *
 * Usage:
 *   yarn audit:canonical-share-links               # full worksheet (masked)
 *   yarn audit:canonical-share-links --counts-only # summary counts only
 *
 * Production use requires an explicitly read-only DATABASE_URL and operator
 * confirmation via AUDIT_CONFIRM_READ_ONLY=yes.
 */
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../../src/generated/prisma/client";
import { loadApiEnv } from "../../src/config/load-env";
import {
  classifyPair,
  mask,
  summarize,
  type AuditShareLinkRow,
  type PairAuditResult,
} from "./canonical-share-link-audit-core";

const BATCH_SIZE = 200;
const SAMPLE_LIMIT = 15;

function requireDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) {
    throw new Error("DATABASE_URL is required for the read-only audit.");
  }
  return value;
}

function ensureReadOnlyConfirmed(): void {
  const appEnv = process.env.APP_ENV ?? process.env.NODE_ENV ?? "development";
  if (
    appEnv === "production" &&
    process.env.AUDIT_CONFIRM_READ_ONLY !== "yes"
  ) {
    throw new Error(
      "Production audit requires AUDIT_CONFIRM_READ_ONLY=yes with a read-only connection.",
    );
  }
}

function createAuditClient(databaseUrl: string): PrismaClient {
  const url = new URL(databaseUrl);
  return new PrismaClient({
    adapter: new PrismaMariaDb({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ""),
      connectionLimit: 2,
    }),
  });
}

async function loadShareLinkRows(
  prisma: PrismaClient,
): Promise<AuditShareLinkRow[]> {
  const rows: AuditShareLinkRow[] = [];
  let cursorId: string | undefined;

  for (;;) {
    const links = await prisma.shareLink.findMany({
      take: BATCH_SIZE,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
      orderBy: { id: "asc" },
      select: {
        id: true,
        websiteId: true,
        alias: true,
        status: true,
        expiresAt: true,
        maxViews: true,
        createdAt: true,
        lastViewedAt: true,
        currentViews: true,
        shareLinkVideos: { select: { videoId: true } },
      },
    });
    if (links.length === 0) {
      break;
    }
    for (const link of links) {
      rows.push({
        id: link.id,
        websiteId: link.websiteId,
        alias: link.alias,
        status: link.status,
        expiresAt: link.expiresAt,
        maxViews: link.maxViews,
        createdAt: link.createdAt,
        lastViewedAt: link.lastViewedAt,
        currentViews: link.currentViews,
        videoIds: link.shareLinkVideos.map((v) => v.videoId),
      });
    }
    cursorId = links[links.length - 1].id;
  }

  return rows;
}

async function main(): Promise<void> {
  loadApiEnv();
  ensureReadOnlyConfirmed();
  const countsOnly = process.argv.includes("--counts-only");
  const prisma = createAuditClient(requireDatabaseUrl());

  try {
    const [links, canonicalMappings, activeAssignments] = await Promise.all([
      loadShareLinkRows(prisma),
      prisma.canonicalVideoShareLink.findMany({
        select: { websiteId: true, videoId: true, shareLinkId: true },
      }),
      prisma.websiteVideo.findMany({
        where: { status: "ACTIVE" },
        select: { websiteId: true, videoId: true },
      }),
    ]);

    const canonicalPairs = new Set(
      canonicalMappings.map((m) => `${m.websiteId}:${m.videoId}`),
    );
    const results: PairAuditResult[] = [];
    for (const assignment of activeAssignments) {
      results.push(
        classifyPair(assignment.websiteId, assignment.videoId, links),
      );
    }

    const summary = summarize(results);
    console.log("=== Canonical share-link audit ===");
    console.log(`Active website-video pairs: ${results.length}`);
    console.log(`Existing canonical mappings: ${canonicalMappings.length}`);
    console.log("Pair classification counts:");
    for (const [classification, count] of Object.entries(summary).sort()) {
      console.log(`  ${classification}: ${count}`);
    }

    if (countsOnly) {
      return;
    }

    console.log("\n=== Owner-review worksheet (masked, bounded) ===");
    console.log(
      "Decision required per pair: adopt an existing link (the one already cited in DMCA records when known), or create a fresh canonical link. Nothing is auto-selected.",
    );
    const needsReview = results.filter(
      (r) =>
        r.classification !== "NO_LINKS" &&
        !canonicalPairs.has(`${r.websiteId}:${r.videoId}`),
    );
    for (const result of needsReview.slice(0, SAMPLE_LIMIT)) {
      console.log(
        [
          `pair website=${mask(result.websiteId)} video=${mask(result.videoId)}`,
          `class=${result.classification}`,
          `activeSingle=${result.activeSingleVideoLinkCount}`,
          `revoked=${result.revokedLinkCount}`,
          `multiVideo=${result.multiVideoLinkCount}`,
          `withLimits=${result.linksWithLimits}`,
          `missingAlias=${result.linksMissingAlias}`,
          `candidates=[${result.candidateLinkIds.map(mask).join(", ")}]`,
        ].join("  "),
      );
    }
    if (needsReview.length > SAMPLE_LIMIT) {
      console.log(
        `... ${needsReview.length - SAMPLE_LIMIT} more pairs (rerun with --counts-only for totals)`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Canonical audit failed.",
    );
    process.exitCode = 1;
  });
}

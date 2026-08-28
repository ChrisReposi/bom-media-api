/**
 * Read-only canonical share-link audit.
 *
 * Reports, for every ACTIVE website+video pair, what
 * `POST /admin/websites/:id/share-links` will do the next time it is called:
 * return the pair's existing mapping, adopt a named historical link, or mint a
 * fresh canonical link. The prediction is computed by the SAME
 * `selectCanonicalHistoricalWinner()` the request path uses, so it cannot drift
 * from the real decision.
 *
 * It also classifies the mappings that ALREADY EXIST, so residue left by an
 * earlier implementation is visible. That half is classification only: nothing
 * is repointed or repaired.
 *
 * DRY RUN BY DEFAULT, AND ONLY. There is deliberately no `--apply`. The request
 * path already adopts lazily and correctly on its own, so a bulk writer would
 * add a second way to create permanent, `onDelete: Restrict` provenance rows
 * without adding any capability. This script exists so an operator can SEE what
 * that path will do before it does it.
 *
 * Never selects tokenHash, never prints raw tokens, masks ids and aliases, and
 * bounds all sample output.
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
  summarizeResolutions,
  classifyExistingCanonical,
  summarizeExistingCanonical,
  type AuditShareLinkRow,
  type ExistingCanonicalAudit,
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
        select: {
          websiteId: true,
          videoId: true,
          shareLinkId: true,
          createdAt: true,
        },
      }),
      prisma.websiteVideo.findMany({
        where: { status: "ACTIVE" },
        select: { websiteId: true, videoId: true },
      }),
    ]);

    // Attach each link's existing anchor, exactly as the request path SELECTS
    // it. It is deliberately NOT used to filter the candidate set: removing an
    // anchored row would make an older link silently win, and would hide the
    // integrity fault the request path refuses on.
    const anchoredByShareLinkId = new Map(
      canonicalMappings.map((mapping) => [
        mapping.shareLinkId,
        { websiteId: mapping.websiteId, videoId: mapping.videoId },
      ]),
    );
    for (const link of links) {
      link.anchoredCanonicalPair = anchoredByShareLinkId.get(link.id);
    }
    const canonicalByPair = new Map(
      canonicalMappings.map((mapping) => [
        `${mapping.websiteId}:${mapping.videoId}`,
        { shareLinkId: mapping.shareLinkId, createdAt: mapping.createdAt },
      ]),
    );

    const results: PairAuditResult[] = [];
    for (const assignment of activeAssignments) {
      const canonical = canonicalByPair.get(
        `${assignment.websiteId}:${assignment.videoId}`,
      );
      results.push(
        classifyPair(assignment.websiteId, assignment.videoId, links, {
          ...(canonical === undefined ? {} : { canonical }),
        }),
      );
    }

    const summary = summarize(results);
    console.log(
      "=== Canonical share-link audit (READ ONLY, writes nothing) ===",
    );
    console.log(`Active website-video pairs: ${results.length}`);
    console.log(`Existing canonical mappings: ${canonicalMappings.length}`);
    console.log("Pair classification counts:");
    for (const [classification, count] of Object.entries(summary).sort()) {
      console.log(`  ${classification}: ${count}`);
    }

    console.log("\nPredicted resolution on the next single-video create:");
    for (const [resolution, count] of Object.entries(
      summarizeResolutions(results),
    ).sort()) {
      console.log(`  ${resolution}: ${count}`);
    }

    // EXISTING mappings, classified read-only. This is the only part of the
    // report that looks BACKWARDS at what the previous implementation wrote.
    const existing: ExistingCanonicalAudit[] = canonicalMappings.map(
      (mapping) => classifyExistingCanonical(mapping, links),
    );
    const unresolvable = existing.filter((row) => row.unresolvable);

    console.log("\nExisting canonical mappings, by finding:");
    for (const [finding, count] of Object.entries(
      summarizeExistingCanonical(existing),
    ).sort()) {
      console.log(`  ${finding}: ${count}`);
    }
    console.log(
      `Mappings with NO resolvable canonical URL (manual remediation): ${unresolvable.length}`,
    );

    const suspicious = results.filter(
      (row) => row.postCanonicalDuplicateCount > 0,
    );
    console.log(
      `Pairs holding a duplicate created AFTER their canonical mapping: ${suspicious.length}`,
    );

    if (countsOnly) {
      return;
    }

    console.log("\n=== Worksheet (masked, bounded) ===");
    console.log(
      [
        "'winner' is the NEWEST exact single-video link for the pair - its status is not a selection input, so an owner's revoke can never be routed around.",
        "  ADOPT_HISTORICAL            the winner is pinned and works.",
        "  ADOPT_HISTORICAL_THEN_DENY  the winner is pinned and then DENIES, because it is revoked/disabled/expired. Intended: the alternative would restore access an owner removed. No replacement is ever minted.",
        "  BLOCKED_OWNER_REVIEW        a structural fault blocks the pin (see pinBlocker). NOTHING is written and no older link is selected.",
        "  MINT_NEW                    the pair has NO history at all. This is the only case that mints.",
        "Legacy rows are never deleted, revoked or rewritten by any outcome.",
      ].join("\n"),
    );
    const needsReview = results.filter(
      (row) =>
        row.classification !== "NO_LINKS" &&
        row.resolution !== "ALREADY_CANONICAL",
    );
    for (const result of needsReview.slice(0, SAMPLE_LIMIT)) {
      console.log(
        [
          `pair website=${mask(result.websiteId)} video=${mask(result.videoId)}`,
          `class=${result.classification}`,
          `resolution=${result.resolution}`,
          `historical=${result.historicalCandidateCount}`,
          `winner=${mask(result.deterministicWinnerId)}`,
          `winnerStatus=${result.deterministicWinnerStatus ?? "-"}`,
          `pinBlocker=${result.pinBlocker ?? "-"}`,
          `multiVideo=${result.multiVideoLinkCount}`,
        ].join("  "),
      );
    }
    if (needsReview.length > SAMPLE_LIMIT) {
      console.log(
        `... ${needsReview.length - SAMPLE_LIMIT} more pairs (rerun with --counts-only for totals)`,
      );
    }

    if (unresolvable.length > 0) {
      console.log(
        "\n=== Existing mappings that cannot resolve (masked, bounded) ===",
      );
      console.log(
        "READ ONLY. Nothing was repointed or repaired: canonical identity is provenance, and moving it is an explicit owner decision made after a backup. ALIAS_MISSING rows are residue of the defect fixed on 2026-08-28 (KNOWN_ISSUES KI-022).",
      );
      for (const row of unresolvable.slice(0, SAMPLE_LIMIT)) {
        console.log(
          `pair website=${mask(row.websiteId)} video=${mask(row.videoId)}  shareLink=${mask(row.shareLinkId)}  finding=${row.finding}`,
        );
      }
      if (unresolvable.length > SAMPLE_LIMIT) {
        console.log(`... ${unresolvable.length - SAMPLE_LIMIT} more`);
      }
    }

    const limited = existing.filter(
      (row) => row.finding === "HAS_EXPIRY" || row.finding === "HAS_MAX_VIEWS",
    );
    if (limited.length > 0) {
      console.log(
        "\n=== Existing mappings anchored to a link carrying a legacy access control ===",
      );
      console.log(
        "Public resolution still enforces expiresAt and maxViews independently (PublicService.getDeniedReason / incrementShareLinkView), so NOTHING is bypassed. What is wrong is that the admin side reports a 'permanent' canonical URL that will stop working once the link lapses.",
      );
      for (const row of limited.slice(0, SAMPLE_LIMIT)) {
        console.log(
          `pair website=${mask(row.websiteId)} video=${mask(row.videoId)}  shareLink=${mask(row.shareLinkId)}  finding=${row.finding}`,
        );
      }
    }

    if (suspicious.length > 0) {
      console.log(
        "\n=== Pinned pairs that later gained another exact single-video link ===",
      );
      console.log(
        "Canonical identity is NOT at risk here: an existing mapping always wins and is never repointed. Each row is simply a second circulating URL for a video that should have one.",
      );
      for (const result of suspicious.slice(0, SAMPLE_LIMIT)) {
        console.log(
          `pair website=${mask(result.websiteId)} video=${mask(result.videoId)}  canonical=${mask(result.deterministicWinnerId)}  newerDuplicates=${result.postCanonicalDuplicateCount}`,
        );
      }
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

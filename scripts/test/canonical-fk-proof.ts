/**
 * Opt-in destructive integration proof: canonical delete policy (all four
 * CanonicalVideoShareLink parents are ON DELETE RESTRICT) plus revoke
 * retention — executed ONLY against a disposable local test database.
 *
 * Safety contract (in order, hard-stop on any deviation):
 *   1. destructive-database guard (test host, *_test/_scratch name, typed
 *      confirmation) on the EFFECTIVE env;
 *   2. migration completeness verified against prisma/migrations;
 *   3. unique run-scoped fixture ids; every row created via Prisma and
 *      count-verified before any destructive statement;
 *   4. each parent delete must fail with Prisma P2003 (MySQL 1451) and the
 *      row must survive;
 *   5. revoke (status update) must succeed with the mapping retained;
 *   6. cleanup in dependency order; zero fixture leftovers verified.
 *
 * Usage:
 *   yarn test:integration:canonical-fk
 * (requires .env.test copied from .env.test.example and
 *  ALLOW_DESTRUCTIVE_DB_TESTS=I_UNDERSTAND_THIS_DELETES_FIXTURES)
 */
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { loadApiEnv } from "../../src/config/load-env";
import { Prisma, PrismaClient } from "../../src/generated/prisma/client";
import { assertDestructiveTestDatabase } from "../safety/assert-destructive-test-database";

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function expectP2003(error: unknown, label: string): void {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2003"
  ) {
    console.log(`  ok  ${label} → blocked (P2003 / MySQL 1451)`);
    return;
  }
  fail(`${label}: expected P2003 foreign-key block, got ${String(error)}`);
}

async function main(): Promise<void> {
  // DOTENV_CONFIG_PATH=.env.test → loadApiEnv loads it with override:true,
  // which is the only deterministic path past the .env→.env.local chain.
  loadApiEnv();
  const { host, database } = assertDestructiveTestDatabase();
  console.log(`Guard passed: ${host}/${database}`);

  const url = new URL(process.env.DATABASE_URL!.trim().replace(/^"|"$/g, ""));
  const prisma = new PrismaClient({
    adapter: new PrismaMariaDb({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database,
      connectionLimit: 2,
      allowPublicKeyRetrieval: true,
    }),
  });

  try {
    // 2. Migration completeness — never run proofs on a drifted schema.
    const migrationsOnDisk = readdirSync(
      join(__dirname, "../../prisma/migrations"),
      { withFileTypes: true },
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const applied = await prisma.$queryRaw<
      { migration_name: string }[]
    >`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
    const appliedNames = new Set(applied.map((row) => row.migration_name));
    const missing = migrationsOnDisk.filter((name) => !appliedNames.has(name));
    if (missing.length > 0) {
      fail(
        `test database is missing ${missing.length} migration(s) — run: DOTENV_CONFIG_PATH=.env.test APP_ENV=test yarn prisma migrate deploy`,
      );
    }
    console.log(`Migrations verified: ${migrationsOnDisk.length} applied`);

    // 3. Run-scoped fixtures, created via Prisma, count-verified.
    const run = `fkproof_${Date.now()}_${randomBytes(3).toString("hex")}`;
    const ids = {
      website: `${run}_w`,
      video: `${run}_v`,
      domain: `${run}_d`,
      link: `${run}_l`,
      slv: `${run}_s`,
      canonical: `${run}_c`,
    };

    await prisma.website.create({
      data: {
        id: ids.website,
        name: `FK Proof ${run}`,
        slug: `${run}-w`,
        status: "ACTIVE",
      },
    });
    await prisma.videoAsset.create({
      data: { id: ids.video, title: `FK Proof Video ${run}`, status: "READY" },
    });
    await prisma.websiteDomain.create({
      data: {
        id: ids.domain,
        websiteId: ids.website,
        domain: `${run}.example`,
        status: "ACTIVE",
      },
    });
    await prisma.shareLink.create({
      data: {
        id: ids.link,
        websiteId: ids.website,
        tokenHash: `${run}-tokenhash`,
        alias: run.slice(-16),
        status: "ACTIVE",
      },
    });
    await prisma.shareLinkVideo.create({
      data: {
        id: ids.slv,
        shareLinkId: ids.link,
        videoId: ids.video,
        sortOrder: 0,
      },
    });
    await prisma.canonicalVideoShareLink.create({
      data: {
        id: ids.canonical,
        websiteId: ids.website,
        videoId: ids.video,
        shareLinkId: ids.link,
        canonicalDomainId: ids.domain,
        canonicalHostSnapshot: `${run}.example`,
        canonicalProtocol: "https",
      },
    });

    const fixtureCounts = await prisma.$transaction([
      prisma.website.count({ where: { id: ids.website } }),
      prisma.videoAsset.count({ where: { id: ids.video } }),
      prisma.websiteDomain.count({ where: { id: ids.domain } }),
      prisma.shareLink.count({ where: { id: ids.link } }),
      prisma.shareLinkVideo.count({ where: { id: ids.slv } }),
      prisma.canonicalVideoShareLink.count({ where: { id: ids.canonical } }),
    ]);
    if (fixtureCounts.some((count) => count !== 1)) {
      fail(`fixture verification failed: counts=${fixtureCounts.join(",")}`);
    }
    console.log(`Fixtures verified: 6/6 rows for run ${run}`);

    // 4. Restrict proofs — each parent delete must be blocked and survive.
    const parents: Array<
      [string, () => Promise<unknown>, () => Promise<number>]
    > = [
      [
        "DELETE Website",
        () => prisma.website.delete({ where: { id: ids.website } }),
        () => prisma.website.count({ where: { id: ids.website } }),
      ],
      [
        "DELETE ShareLink",
        () => prisma.shareLink.delete({ where: { id: ids.link } }),
        () => prisma.shareLink.count({ where: { id: ids.link } }),
      ],
      [
        "DELETE VideoAsset",
        () => prisma.videoAsset.delete({ where: { id: ids.video } }),
        () => prisma.videoAsset.count({ where: { id: ids.video } }),
      ],
      [
        "DELETE WebsiteDomain",
        () => prisma.websiteDomain.delete({ where: { id: ids.domain } }),
        () => prisma.websiteDomain.count({ where: { id: ids.domain } }),
      ],
    ];
    for (const [label, attempt, survives] of parents) {
      try {
        await attempt();
        fail(`${label}: delete unexpectedly succeeded`);
      } catch (error) {
        expectP2003(error, label);
      }
      if ((await survives()) !== 1) {
        fail(`${label}: parent row did not survive`);
      }
    }

    // 5. Revoke is status-only and retains the mapping.
    await prisma.shareLink.update({
      where: { id: ids.link },
      data: { status: "REVOKED" },
    });
    const retained = await prisma.canonicalVideoShareLink.count({
      where: { id: ids.canonical },
    });
    if (retained !== 1) {
      fail("canonical mapping lost after revoke");
    }
    console.log("  ok  revoke allowed; canonical mapping retained");

    // 6. Deliberate cleanup in dependency order + zero-leftover check.
    await prisma.canonicalVideoShareLink.delete({
      where: { id: ids.canonical },
    });
    await prisma.shareLinkVideo.delete({ where: { id: ids.slv } });
    await prisma.shareLink.delete({ where: { id: ids.link } });
    await prisma.websiteDomain.delete({ where: { id: ids.domain } });
    await prisma.videoAsset.delete({ where: { id: ids.video } });
    await prisma.website.delete({ where: { id: ids.website } });

    const leftovers = (
      await prisma.$transaction([
        prisma.website.count({ where: { id: ids.website } }),
        prisma.videoAsset.count({ where: { id: ids.video } }),
        prisma.websiteDomain.count({ where: { id: ids.domain } }),
        prisma.shareLink.count({ where: { id: ids.link } }),
        prisma.shareLinkVideo.count({ where: { id: ids.slv } }),
        prisma.canonicalVideoShareLink.count({ where: { id: ids.canonical } }),
      ])
    ).reduce((sum, count) => sum + count, 0);
    if (leftovers !== 0) {
      fail(`cleanup left ${leftovers} fixture row(s)`);
    }
    console.log("Cleanup verified: zero fixture leftovers");
    console.log("CANONICAL FK PROOF PASSED");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(
    "FAIL:",
    error instanceof Error ? error.message : "unknown error",
  );
  process.exit(1);
});

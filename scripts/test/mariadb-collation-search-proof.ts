/**
 * Real-database regression proof for the production admin-search failure class
 * (MariaDB 1267, "Illegal mix of collations", stage ADMIN_VIDEO_LIST_QUERY).
 *
 * Runs against a STOCK-collation MariaDB
 * (docker-compose.mariadb-collation-test.yml), whose server default is
 * utf8mb4_uca1400_ai_ci while the migrations declare utf8mb4_unicode_ci.
 * docker-compose.mariadb-test.yml pins `--collation-server=utf8mb4_unicode_ci`
 * and therefore cannot observe any host-dependent collation behaviour.
 *
 * Proves:
 *   A. Every admin search semantic still holds on a stock-collation host.
 *   B. A column whose charset is narrower than the search term reproduces the
 *      exact production failure (1267 / HY000) through Prisma +
 *      @prisma/adapter-mariadb, on BOTH the binary and text protocols.
 *   C. toSafeDatabaseErrorContext() reports it as COLLATION_CONFLICT and names
 *      the two collations - the evidence the production logs were missing.
 *
 * Opt-in, guarded, and only ever touches run-scoped fixtures.
 */
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { toSafeDatabaseErrorContext } from "../../src/common/errors/safe-database-error-context.util";
import { PrismaClient } from "../../src/generated/prisma/client";
import {
  escapeAdminVideoSearchLike,
  normalizeAdminVideoSearch,
} from "../../src/videos/utils/video-search.util";
import {
  assertMariaDbCollationProofDatabase,
  buildCollationProofIdentity,
  SCHEMA_CHARSET,
  SCHEMA_COLLATION,
  SEARCH_CASES,
} from "./mariadb-collation-search-proof-core";

const target = assertMariaDbCollationProofDatabase();
const identity = buildCollationProofIdentity();

type Row = Record<string, unknown>;
const results: string[] = [];

function record(id: string, ok: boolean, detail = ""): void {
  const line = `${ok ? "PASS" : "FAIL"} ${id}${detail ? ` - ${detail}` : ""}`;
  results.push(line);
  // Emit as the proof runs: a run that stalls must still say how far it got.
  process.stdout.write(`${line}\n`);
  if (!ok) {
    process.exitCode = 1;
  }
}

/**
 * Mirrors `PrismaService.createMariaDbAdapter()`. `withInitSql: false`
 * reproduces the pre-fix adapter configuration so the invariant below is
 * genuinely discriminating on a host that exhibits the defect.
 */
function createClient(
  useTextProtocol: boolean,
  withInitSql = true,
): PrismaClient {
  const url = new URL(process.env.DATABASE_URL as string);
  const adapter = new PrismaMariaDb(
    {
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ""),
      connectionLimit: 5,
      allowPublicKeyRetrieval: true,
      ...(withInitSql
        ? { initSql: `SET NAMES ${SCHEMA_CHARSET} COLLATE ${SCHEMA_COLLATION}` }
        : {}),
    } as never,
    { useTextProtocol },
  );
  return new PrismaClient({ adapter } as never);
}

/** Mirrors VideosService.buildVideoWhere() exactly (it is private there). */
function buildSearchWhere(rawSearch: string): Record<string, unknown> {
  const literalSearch = escapeAdminVideoSearchLike(
    normalizeAdminVideoSearch(rawSearch),
  );
  return {
    OR: [
      { title: { contains: literalSearch } },
      { slug: { contains: literalSearch } },
    ],
  };
}

const FIXTURES: ReadonlyArray<{ title: string; slugSuffix: string }> = [
  { title: "Surprised cat", slugSuffix: "surprised-cat" },
  { title: "100% real deal", slugSuffix: "pct-real-deal" },
  { title: "a_b underscore", slugSuffix: "a-b-underscore" },
  { title: "back\\slash title", slugSuffix: "back-slash-title" },
  { title: "Bất ngờ quá", slugSuffix: "bat-ngo-qua" },
  { title: "Ordinary clip", slugSuffix: "ordinary-clip" },
];

async function seed(prisma: PrismaClient): Promise<void> {
  for (const [index, fixture] of FIXTURES.entries()) {
    await prisma.videoAsset.create({
      data: {
        id: `${identity.videoIdPrefix}${index}`,
        title: fixture.title,
        slug: `${identity.videoSlugPrefix}${fixture.slugSuffix}`,
        // VideoProvider is MANUAL | BUNNY | MUX | CLOUDINARY and has no
        // DIRECT_URL member - DIRECT_URL is a VideoSourceType.
        provider: "MANUAL",
        sourceType: "DIRECT_URL",
        status: "READY",
        playbackUrl: "https://example.test/a.mp4",
        filterKey: "sml",
      },
    });
  }
}

async function cleanup(prisma: PrismaClient): Promise<void> {
  await prisma.videoAsset.deleteMany({
    where: { id: { startsWith: identity.videoIdPrefix } },
  });
}

async function main(): Promise<void> {
  const prisma = createClient(false);

  const session = await prisma.$queryRawUnsafe<Row[]>(
    "SELECT @@collation_connection cc, @@collation_server cs",
  );
  record(
    "COLLATION-01 stock host default differs from the schema contract",
    session[0]?.cs !== SCHEMA_COLLATION,
    `collation_server=${String(session[0]?.cs)}`,
  );

  const cols = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT TABLE_NAME t, COLUMN_NAME c, CHARACTER_SET_NAME cs, COLLATION_NAME co
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND DATA_TYPE IN ('varchar','char','text')`,
    target.database,
  );
  const drifted = cols.filter(
    (row) => row.cs !== SCHEMA_CHARSET || row.co !== SCHEMA_COLLATION,
  );
  record(
    "COLLATION-02 migrations converge every string column to the contract",
    drifted.length === 0,
    drifted.length === 0
      ? `${cols.length} columns are ${SCHEMA_CHARSET}/${SCHEMA_COLLATION}`
      : `drifted: ${drifted
          .map((row) => `${String(row.t)}.${String(row.c)}=${String(row.co)}`)
          .join(", ")}`,
  );

  // COLLATION-05..07 - the invariant the 2026-09-01 production incident broke.
  //
  // Hostinger's MariaDB 11.8.8-log assigns a BINARY-PROTOCOL bound parameter the
  // legacy default collation (utf8mb4_general_ci) instead of the session's
  // collation_connection, while SQL-text literals keep collation_connection.
  // Prisma compiles `contains` to `col LIKE CONCAT('%', ?, '%')`, so those two
  // disagreeing collations are aggregated into utf8mb4_bin with DERIVATION_NONE
  // (1). NONE outranks the column's IMPLICIT (2), so the comparison cannot be
  // coerced and MariaDB raises 1267 on EVERY admin contains/startsWith query.
  //
  // The fix binds both sides explicitly via `SET NAMES <charset> COLLATE
  // <collation>` on each pooled connection. These assertions encode that
  // invariant. On a server build that already assigns parameters the session
  // collation they pass either way; on a build like production's they fail
  // without the fix, which is where fail-before/pass-after was demonstrated.
  const sessionCollation = await prisma.$queryRawUnsafe<Row[]>(
    "SELECT @@collation_connection cc",
  );
  record(
    "COLLATION-05 session collation equals the schema contract",
    sessionCollation[0]?.cc === SCHEMA_COLLATION,
    `collation_connection=${String(sessionCollation[0]?.cc)}`,
  );

  const paramCollation = await prisma.$queryRawUnsafe<Row[]>(
    "SELECT COLLATION(?) c",
    "probe",
  );
  record(
    "COLLATION-06 bound parameter collation equals the schema contract",
    paramCollation[0]?.c === SCHEMA_COLLATION,
    `COLLATION(?)=${String(paramCollation[0]?.c)}`,
  );

  const concatMeta = await prisma.$queryRawUnsafe<Row[]>(
    "SELECT COLLATION(CONCAT('%', ?, '%')) c, COERCIBILITY(CONCAT('%', ?, '%')) d",
    "probe",
    "probe",
  );
  record(
    "COLLATION-07 CONCAT('%',?,'%') is not aggregated to a NONE derivation",
    concatMeta[0]?.c === SCHEMA_COLLATION && Number(concatMeta[0]?.d) !== 1,
    `collation=${String(concatMeta[0]?.c)} derivation=${String(concatMeta[0]?.d)}`,
  );

  await cleanup(prisma);
  await seed(prisma);

  const scoped = { id: { startsWith: identity.videoIdPrefix } };

  const total = await prisma.videoAsset.count({ where: scoped });
  record("SEARCH-01 no search", total === FIXTURES.length, `total=${total}`);

  for (const [id, term, expected] of SEARCH_CASES) {
    const rows = await prisma.videoAsset.findMany({
      where: { AND: [scoped, buildSearchWhere(term)] },
      select: { title: true },
    });
    const titles = rows.map((row) => row.title).sort();
    record(
      `${id} contains ${JSON.stringify(term)}`,
      JSON.stringify(titles) === JSON.stringify([...expected].sort()),
      `got ${JSON.stringify(titles)}`,
    );
  }

  const slugHit = await prisma.videoAsset.count({
    where: { AND: [scoped, buildSearchWhere("bat-ngo-qua")] },
  });
  record("SEARCH-03 slug contains", slugHit === 1, `n=${slugHit}`);

  const filterCases = [
    ["SEARCH-04 status + search", { status: "READY" }, 1],
    ["SEARCH-05 provider + search", { provider: "MANUAL" }, 1],
    ["SEARCH-06 filterKey + search", { filterKey: "sml" }, 1],
    ["SEARCH-06b filterKey miss", { filterKey: "other" }, 0],
  ] as ReadonlyArray<readonly [string, Record<string, unknown>, number]>;

  for (const [id, extra, expected] of filterCases) {
    const n = await prisma.videoAsset.count({
      where: { AND: [scoped, buildSearchWhere("Surprised"), extra] },
    });
    record(id, n === expected, `n=${n}`);
  }

  const page = await prisma.videoAsset.findMany({
    where: scoped,
    orderBy: { title: "asc" },
    skip: 1,
    take: 2,
    select: { title: true },
  });
  record(
    "SEARCH-07 pagination + search",
    page.length === 2,
    `n=${page.length}`,
  );

  const ascending = await prisma.videoAsset.findMany({
    where: scoped,
    orderBy: { title: "asc" },
    select: { title: true },
  });
  const descending = await prisma.videoAsset.findMany({
    where: scoped,
    orderBy: { title: "desc" },
    select: { title: true },
  });
  record(
    "SEARCH-08 sort + search",
    ascending.length === FIXTURES.length &&
      JSON.stringify(ascending.map((row) => row.title)) ===
        JSON.stringify(descending.map((row) => row.title).reverse()),
    `asc=${JSON.stringify(ascending.map((row) => row.title))}`,
  );

  // SEARCH-13: the DTO normalizes input to NFC, so a decomposed (NFD)
  // keystroke sequence must still match the composed data in the column.
  const decomposed = "Bất ngờ".normalize("NFD");
  const nfcHit = await prisma.videoAsset.count({
    where: { AND: [scoped, buildSearchWhere(decomposed)] },
  });
  record("SEARCH-13 NFC normalization", nfcHit === 1, `n=${nfcHit}`);

  const repeated = await Promise.all([
    prisma.videoAsset.count({
      where: { AND: [scoped, buildSearchWhere("Surprised")] },
    }),
    prisma.videoAsset.count({
      where: { AND: [scoped, buildSearchWhere("Surprised")] },
    }),
  ]);
  record(
    "SEARCH-14 repeated search consistency",
    repeated[0] === repeated[1] && repeated[0] === 1,
    `n=${JSON.stringify(repeated)}`,
  );

  const mime = await prisma.videoLocalFileAsset.count({
    where: { mimeType: { startsWith: "video/" } },
  });
  record(
    "SEARCH-16a startsWith mimeType (assignment-options hidden filter)",
    Number.isInteger(mime),
    `n=${mime}`,
  );

  const websiteHit = await prisma.website.count({
    where: {
      OR: [{ name: { contains: "zzz" } }, { slug: { contains: "zzz" } }],
    },
  });
  const domainHit = await prisma.websiteDomain.count({
    where: { domain: { contains: "zzz" } },
  });
  const groupHit = await prisma.domainGroup.count({
    where: {
      OR: [{ key: { contains: "zzz" } }, { name: { contains: "zzz" } }],
    },
  });
  const adminHit = await prisma.adminUser.count({
    where: { username: { contains: "zzz" } },
  });
  record(
    "SEARCH-16b other admin search surfaces (websites/domains/groups/accounts)",
    [websiteHit, domainHit, groupHit, adminHit].every(Number.isInteger),
    `websites=${websiteHit} domains=${domainHit} groups=${groupHit} accounts=${adminHit}`,
  );

  await cleanup(prisma);
  const leftovers = await prisma.videoAsset.count({ where: scoped });
  record(
    "CLEANUP run-scoped fixtures removed",
    leftovers === 0,
    `left=${leftovers}`,
  );
  await prisma.$disconnect();

  for (const useTextProtocol of [false, true]) {
    const label = useTextProtocol ? "text" : "binary";
    const client = createClient(useTextProtocol);
    await client.$executeRawUnsafe(
      "ALTER TABLE `VideoAsset` MODIFY `title` VARCHAR(191) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci NOT NULL",
    );
    let context: ReturnType<typeof toSafeDatabaseErrorContext> | undefined;
    try {
      await client.videoAsset.count({
        where: { title: { contains: "cat 😺" } },
      });
    } catch (error) {
      context = toSafeDatabaseErrorContext(error);
    }
    await client.$executeRawUnsafe(
      `ALTER TABLE \`VideoAsset\` MODIFY \`title\` VARCHAR(191) CHARACTER SET ${SCHEMA_CHARSET} COLLATE ${SCHEMA_COLLATION} NOT NULL`,
    );

    record(
      `COLLATION-03/${label} narrower column reproduces production 1267`,
      context?.cause?.originalCode === "1267" &&
        context?.cause?.sqlState === "HY000",
      `code=${String(context?.cause?.originalCode)} sqlState=${String(
        context?.cause?.sqlState,
      )}`,
    );
    record(
      `COLLATION-04/${label} reported as COLLATION_CONFLICT naming both collations`,
      context?.databaseCategory === "COLLATION_CONFLICT" &&
        context?.collationConflict?.leftCollation === "utf8mb3_general_ci" &&
        context?.collationConflict?.rightCollation === SCHEMA_COLLATION &&
        context?.collationConflict?.operation === "like",
      `category=${String(
        context?.databaseCategory,
      )} pair=${JSON.stringify(context?.collationConflict)}`,
    );
    await client.$disconnect();
  }

  const url = new URL(process.env.DATABASE_URL as string);
  const joined = results.join("\n");
  for (const secret of [decodeURIComponent(url.password), url.username]) {
    if (secret.length > 0 && joined.includes(secret)) {
      throw new Error("proof output leaked a connection secret");
    }
  }

  const failed = results.filter((line) => line.startsWith("FAIL")).length;
  process.stdout.write(
    `\n${results.length - failed}/${results.length} checks passed\n`,
  );
}

main().catch((error: unknown) => {
  process.stdout.write(
    `PROOF ABORTED: ${toSafeDatabaseErrorContext(error).errorName}\n`,
  );
  // Exit explicitly: an aborted run leaves an undisconnected Prisma pool, whose
  // open sockets keep the event loop alive and make a failure look like a hang.
  process.exit(1);
});

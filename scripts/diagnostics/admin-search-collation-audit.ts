/**
 * READ-ONLY audit of the character sets behind every Admin search surface.
 *
 * Why this exists: `contains` / `startsWith` compile to
 * `col LIKE CONCAT('%', ?, '%')`. MariaDB raises 1267 ("Illegal mix of
 * collations") on that expression when the bound term's character repertoire
 * cannot be converted into the COLUMN's character set - for example a
 * Vietnamese term against a latin1 column, or an emoji against utf8mb3. The
 * connection collation is NOT the trigger, and neither is the protocol: both
 * were eliminated experimentally. What matters is the column.
 *
 * This script reports, for every column the Admin actually searches, whether it
 * still matches the collation the migrations declare
 * (utf8mb4 / utf8mb4_unicode_ci).
 *
 * SAFETY: issues only `SELECT` against `information_schema` and session
 * variables. It reads no row data, writes nothing, and prints no credential,
 * hostname, user or DATABASE_URL. Safe to run against production.
 */
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../../src/generated/prisma/client";

const SCHEMA_CHARSET = "utf8mb4";
const SCHEMA_COLLATION = "utf8mb4_unicode_ci";

/** Every column reachable from an Admin search/filter input. */
const SEARCHED_COLUMNS: ReadonlyArray<readonly [string, string, string]> = [
  ["VideoAsset", "title", "admin videos search (contains)"],
  ["VideoAsset", "slug", "admin videos search (contains)"],
  ["VideoAsset", "filterKey", "admin videos filterKey (equals)"],
  ["Website", "name", "websites search (contains)"],
  ["Website", "slug", "websites search (contains)"],
  ["WebsiteDomain", "domain", "domains search (contains)"],
  ["DomainGroup", "key", "domain-group search (contains)"],
  ["DomainGroup", "name", "domain-group search (contains)"],
  ["AdminUser", "username", "admin accounts search (contains)"],
  ["VideoBinaryAsset", "mimeType", "assignment options (startsWith 'video/')"],
  [
    "VideoLocalFileAsset",
    "mimeType",
    "assignment options (startsWith 'video/')",
  ],
];

type Row = Record<string, unknown>;

function createClient(): PrismaClient {
  const url = new URL(process.env.DATABASE_URL as string);
  const database = url.pathname.replace(/^\//, "");
  if (!database) {
    throw new Error("DATABASE_URL must include a database name.");
  }
  const adapter = new PrismaMariaDb(
    {
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database,
      connectionLimit: 2,
      allowPublicKeyRetrieval: true,
    } as never,
    { useTextProtocol: false },
  );
  return new PrismaClient({ adapter } as never);
}

function line(text: string): void {
  process.stdout.write(`${text}\n`);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set.");
  }
  const prisma = createClient();
  let drifted = 0;

  try {
    const session = await prisma.$queryRawUnsafe<Row[]>(
      `SELECT @@character_set_client csClient,
              @@character_set_connection csConn,
              @@collation_connection collConn,
              @@character_set_database csDb,
              @@collation_database collDb,
              @@collation_server collServer,
              VERSION() version`,
    );
    const s = session[0] ?? {};
    line("=== SESSION (no host, user or credential is read) ===");
    line(`  server version        : ${String(s.version)}`);
    line(`  character_set_client  : ${String(s.csClient)}`);
    line(`  character_set_conn    : ${String(s.csConn)}`);
    line(`  collation_connection  : ${String(s.collConn)}`);
    line(`  character_set_database: ${String(s.csDb)}`);
    line(`  collation_database    : ${String(s.collDb)}`);
    line(`  collation_server      : ${String(s.collServer)}`);
    line("");
    line(`  schema contract       : ${SCHEMA_CHARSET} / ${SCHEMA_COLLATION}`);
    line(
      "  NOTE: a connection collation different from the contract is NOT by",
    );
    line(
      "        itself a cause of 1267 - it was ruled out experimentally. The",
    );
    line("        column character sets below are what matter.");
    line("");

    line("=== SEARCHED COLUMNS ===");
    for (const [table, column, surface] of SEARCHED_COLUMNS) {
      const rows = await prisma.$queryRawUnsafe<Row[]>(
        `SELECT DATA_TYPE dataType, CHARACTER_SET_NAME cs, COLLATION_NAME co
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        table,
        column,
      );
      const row = rows[0];
      if (row === undefined) {
        line(`  MISSING  ${table}.${column}  (${surface})`);
        drifted += 1;
        continue;
      }
      const ok = row.cs === SCHEMA_CHARSET && row.co === SCHEMA_COLLATION;
      if (!ok) {
        drifted += 1;
      }
      line(
        `  ${ok ? "OK      " : "DRIFTED "} ${table}.${column} = ${String(
          row.cs,
        )}/${String(row.co)}  (${surface})`,
      );
    }
    line("");

    line("=== ALL OTHER TEXT COLUMNS NOT MATCHING THE CONTRACT ===");
    const others = await prisma.$queryRawUnsafe<Row[]>(
      `SELECT TABLE_NAME t, COLUMN_NAME c, CHARACTER_SET_NAME cs, COLLATION_NAME co
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND DATA_TYPE IN ('varchar','char','text')
          AND (CHARACTER_SET_NAME <> ? OR COLLATION_NAME <> ?)
        ORDER BY TABLE_NAME, COLUMN_NAME`,
      SCHEMA_CHARSET,
      SCHEMA_COLLATION,
    );
    if (others.length === 0) {
      line("  none");
    } else {
      for (const row of others) {
        line(
          `  ${String(row.t)}.${String(row.c)} = ${String(row.cs)}/${String(
            row.co,
          )}`,
        );
      }
    }
    line("");
    line(
      `VERDICT: ${
        drifted === 0
          ? "every searched column matches the schema contract."
          : `${drifted} searched column(s) drifted - these are the 1267 candidates.`
      }`,
    );
    line(
      "Prisma `Json` columns are LONGTEXT/utf8mb4_bin by design and are never",
    );
    line("searched; they are excluded above and are not drift.");
  } finally {
    await prisma.$disconnect();
  }

  process.exitCode = drifted === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  // Never print the raw error: it can carry the connection URL.
  line(`AUDIT FAILED: ${error instanceof Error ? error.name : "UnknownError"}`);
  process.exit(2);
});

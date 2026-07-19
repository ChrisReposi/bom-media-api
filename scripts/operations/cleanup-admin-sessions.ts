import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { loadApiEnv } from "../../src/config/load-env";
import { PrismaClient } from "../../src/generated/prisma/client";

export type CleanupOptions = {
  apply: boolean;
  retentionDays: number;
  batchSize: number;
  maxBatches: number;
  confirmEnvironment?: string;
};

export function parseCleanupOptions(args: string[]): CleanupOptions {
  const readInt = (
    name: string,
    fallback: number,
    min: number,
    max: number,
  ) => {
    const raw = args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`--${name} must be ${min}-${max}.`);
    return value;
  };
  const known = [
    "--apply",
    "--retention-days=",
    "--batch-size=",
    "--max-batches=",
    "--confirm-env=",
  ];
  if (
    args.some(
      (arg) =>
        !known.some((item) =>
          item.endsWith("=") ? arg.startsWith(item) : arg === item,
        ),
    )
  ) {
    throw new Error("Unknown cleanup argument.");
  }
  return {
    apply: args.includes("--apply"),
    retentionDays: readInt("retention-days", 90, 1, 3650),
    batchSize: readInt("batch-size", 100, 1, 1000),
    maxBatches: readInt("max-batches", 10, 1, 100),
    confirmEnvironment: args
      .find((arg) => arg.startsWith("--confirm-env="))
      ?.split("=")[1],
  };
}

function createClient(): PrismaClient {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) throw new Error("DATABASE_URL is required.");
  const url = new URL(raw);
  return new PrismaClient({
    adapter: new PrismaMariaDb({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ""),
      connectionLimit: 1,
    }),
  });
}

async function run(): Promise<void> {
  const options = parseCleanupOptions(process.argv.slice(2));
  loadApiEnv();
  const environment =
    process.env.APP_ENV?.trim() || process.env.NODE_ENV?.trim() || "unknown";
  if (
    options.apply &&
    (!options.confirmEnvironment || options.confirmEnvironment !== environment)
  ) {
    throw new Error(
      "--apply requires --confirm-env matching APP_ENV/NODE_ENV exactly.",
    );
  }
  const cutoff = new Date(Date.now() - options.retentionDays * 86_400_000);
  const prisma = createClient();
  let deletedTokens = 0;
  let deletedSessions = 0;
  try {
    const eligibility = {
      OR: [
        { expiresAt: { lt: cutoff } },
        { revokedAt: { not: null, lt: cutoff } },
      ],
    } as const;
    const [tokenCount, sessionCount] = await Promise.all([
      prisma.adminRefreshToken.count({ where: eligibility }),
      prisma.adminSession.count({ where: eligibility }),
    ]);
    console.info(
      JSON.stringify({
        mode: options.apply ? "apply" : "dry-run",
        environment,
        retentionDays: options.retentionDays,
        eligibleRefreshTokens: tokenCount,
        eligibleSessions: sessionCount,
        batchSize: options.batchSize,
        maxBatches: options.maxBatches,
      }),
    );
    if (!options.apply) return;

    for (let batch = 0; batch < options.maxBatches; batch += 1) {
      const tokenIds = (
        await prisma.adminRefreshToken.findMany({
          where: eligibility,
          orderBy: { id: "asc" },
          take: options.batchSize,
          select: { id: true },
        })
      ).map((row) => row.id);
      if (tokenIds.length === 0) break;
      deletedTokens += (
        await prisma.adminRefreshToken.deleteMany({
          where: { id: { in: tokenIds }, ...eligibility },
        })
      ).count;
    }
    for (let batch = 0; batch < options.maxBatches; batch += 1) {
      const sessionIds = (
        await prisma.adminSession.findMany({
          where: eligibility,
          orderBy: { id: "asc" },
          take: options.batchSize,
          select: { id: true },
        })
      ).map((row) => row.id);
      if (sessionIds.length === 0) break;
      deletedSessions += (
        await prisma.adminSession.deleteMany({
          where: { id: { in: sessionIds }, ...eligibility },
        })
      ).count;
    }
    console.info(
      JSON.stringify({ deletedRefreshTokens: deletedTokens, deletedSessions }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  run().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Session cleanup failed.",
    );
    process.exitCode = 1;
  });
}

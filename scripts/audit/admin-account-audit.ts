import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { loadApiEnv } from "../../src/config/load-env";
import { PrismaClient } from "../../src/generated/prisma/client";

type SafeAdminAuditRow = {
  id: string;
  username: string;
  role: string;
  status: string;
  deletedAt: Date | null;
};

function mask(value: string): string {
  return value.length <= 8
    ? `${value.slice(0, 2)}***`
    : `${value.slice(0, 8)}***`;
}

function createClient(): PrismaClient {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw)
    throw new Error("DATABASE_URL is required for the read-only audit.");
  const url = new URL(raw);
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

export function findNormalizedUsernameConflicts(rows: SafeAdminAuditRow[]) {
  const groups = new Map<string, SafeAdminAuditRow[]>();
  for (const row of rows) {
    const normalized = row.username
      .normalize("NFC")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
    groups.set(normalized, [...(groups.get(normalized) ?? []), row]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

export async function runAdminAccountAudit(): Promise<number> {
  loadApiEnv();
  const prisma = createClient();
  const now = new Date();
  try {
    const [
      accounts,
      sessionCounts,
      tokenCounts,
      uploadsByStatus,
      deletedRelationCounts,
    ] = await Promise.all([
      prisma.adminUser.findMany({
        orderBy: { id: "asc" },
        select: {
          id: true,
          username: true,
          role: true,
          status: true,
          deletedAt: true,
        },
      }),
      Promise.all([
        prisma.adminSession.count({
          where: { revokedAt: null, expiresAt: { gt: now } },
        }),
        prisma.adminSession.count({ where: { revokedAt: { not: null } } }),
        prisma.adminSession.count({
          where: { revokedAt: null, expiresAt: { lte: now } },
        }),
      ]),
      Promise.all([
        prisma.adminRefreshToken.count({
          where: { revokedAt: null, expiresAt: { gt: now } },
        }),
        prisma.adminRefreshToken.count({
          where: { revokedAt: { not: null } },
        }),
        prisma.adminRefreshToken.count({
          where: { revokedAt: null, expiresAt: { lte: now } },
        }),
      ]),
      prisma.videoUploadSession.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
      Promise.all([
        prisma.adminSession.count({
          where: {
            admin: { deletedAt: { not: null } },
            revokedAt: null,
            expiresAt: { gt: now },
          },
        }),
        prisma.adminRefreshToken.count({
          where: {
            admin: { deletedAt: { not: null } },
            revokedAt: null,
            expiresAt: { gt: now },
          },
        }),
        prisma.videoUploadSession.count({
          where: {
            admin: { deletedAt: { not: null } },
            status: { in: ["ACTIVE", "COMPLETING"] },
          },
        }),
      ]),
    ]);

    const conflicts = findNormalizedUsernameConflicts(accounts);
    const ownerCount = accounts.filter(
      (row) => row.role === "OWNER" && row.deletedAt === null,
    ).length;
    const deletedActive = accounts.filter(
      (row) => row.deletedAt !== null && row.status === "ACTIVE",
    );
    const roleStatusDeleted = Object.fromEntries(
      ["OWNER", "ADMIN", "STAFF"].map((role) => [
        role,
        {
          active: accounts.filter(
            (row) =>
              row.role === role &&
              row.status === "ACTIVE" &&
              row.deletedAt === null,
          ).length,
          disabled: accounts.filter(
            (row) =>
              row.role === role &&
              row.status === "DISABLED" &&
              row.deletedAt === null,
          ).length,
          deleted: accounts.filter(
            (row) => row.role === role && row.deletedAt !== null,
          ).length,
        },
      ]),
    );
    const bootstrapRegistrationEnabled = ["1", "true", "yes", "on"].includes(
      String(process.env.ADMIN_REGISTER_ENABLED ?? "").toLowerCase(),
    );
    const production =
      process.env.APP_ENV === "production" ||
      process.env.NODE_ENV === "production";
    const anomalies =
      ownerCount !== 1 ||
      conflicts.length > 0 ||
      deletedActive.length > 0 ||
      deletedRelationCounts.some((count) => count > 0) ||
      (production && bootstrapRegistrationEnabled);
    console.info(
      "Admin account audit (read-only; no password/token hashes selected)",
    );
    console.info(
      JSON.stringify(
        {
          accountCounts: roleStatusDeleted,
          ownerCount,
          normalizedUsernameConflictCount: conflicts.length,
          deletedActiveCount: deletedActive.length,
          sessions: {
            active: sessionCounts[0],
            revoked: sessionCounts[1],
            expired: sessionCounts[2],
          },
          refreshTokens: {
            active: tokenCounts[0],
            revoked: tokenCounts[1],
            expired: tokenCounts[2],
          },
          uploads: uploadsByStatus.map((row) => ({
            status: row.status,
            count: row._count._all,
          })),
          deletedAccountRelations: {
            activeSessions: deletedRelationCounts[0],
            activeRefreshTokens: deletedRelationCounts[1],
            activeOrCompletingUploads: deletedRelationCounts[2],
          },
          bootstrapRegistrationEnabled,
          maskedSamples: {
            usernameConflicts: conflicts.slice(0, 10).map((group) =>
              group.map((row) => ({
                admin: mask(row.id),
                username: mask(row.username),
              })),
            ),
            deletedActive: deletedActive.slice(0, 10).map((row) => ({
              admin: mask(row.id),
              username: mask(row.username),
            })),
          },
        },
        null,
        2,
      ),
    );
    return anomalies ? 2 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  runAdminAccountAudit()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(
        error instanceof Error ? error.message : "Account audit failed.",
      );
      process.exitCode = 1;
    });
}

import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { AdminAccountsService } from "../../src/admin-accounts/admin-accounts.service";
import { AdminAuthService } from "../../src/admin-auth/admin-auth.service";
import { AdminCredentialService } from "../../src/admin-auth/admin-credential.service";
import { apiConfig } from "../../src/config/env.config";
import { loadApiEnv } from "../../src/config/load-env";
import { PrismaService } from "../../src/database/prisma.service";
import { AccountStatus, AdminRole } from "../../src/generated/prisma/client";

async function run(): Promise<void> {
  loadApiEnv();
  if (process.env.APP_ENV !== "local") {
    throw new Error("This fixture smoke is restricted to APP_ENV=local.");
  }
  const ownerUsername = (
    process.env.ADMIN_USERNAME ?? process.env.ADMIN_BOOTSTRAP_USERNAME
  )?.trim();
  const ownerPassword =
    process.env.ADMIN_PASSWORD ?? process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!ownerUsername || !ownerPassword) {
    throw new Error(
      "Local OWNER credential variables are required; no fixture was created.",
    );
  }

  const config = new ConfigService({ ...process.env, api: apiConfig() });
  const credentials = new AdminCredentialService();
  const prisma = new PrismaService(config);
  await prisma.onModuleInit();
  const accounts = new AdminAccountsService(prisma, config, credentials);
  const auth = new AdminAuthService(
    prisma,
    config,
    new JwtService(),
    credentials,
  );
  const prefix = `smoke_${randomBytes(4).toString("hex")}`;
  const actor = await prisma.adminUser.findUnique({
    where: { username: credentials.normalizeUsername(ownerUsername) },
    select: { id: true, role: true, status: true, deletedAt: true },
  });
  if (
    !actor ||
    actor.role !== AdminRole.OWNER ||
    actor.status !== AccountStatus.ACTIVE ||
    actor.deletedAt
  ) {
    await prisma.onModuleDestroy();
    throw new Error("Configured local actor is not an active OWNER.");
  }

  const createdIds: string[] = [];
  try {
    const adminResult = await accounts.create(actor.id, {
      username: `${prefix}_admin`,
      role: AdminRole.ADMIN,
      currentPassword: ownerPassword,
    });
    createdIds.push(adminResult.account.id);
    const staffResult = await accounts.create(actor.id, {
      username: `${prefix}_staff`,
      role: AdminRole.STAFF,
      currentPassword: ownerPassword,
    });
    createdIds.push(staffResult.account.id);

    await auth.login({
      username: adminResult.account.username,
      password: adminResult.temporaryPassword,
    });
    const permanentAdminPassword = credentials.generateTemporaryPassword();
    await auth.changeOwnPassword(adminResult.account.id, {
      currentPassword: adminResult.temporaryPassword,
      newPassword: permanentAdminPassword,
    });
    await auth.login({
      username: staffResult.account.username,
      password: staffResult.temporaryPassword,
    });
    const loginDurations: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const startedAt = performance.now();
      await auth.login({
        username: adminResult.account.username,
        password: permanentAdminPassword,
      });
      loginDurations.push(performance.now() - startedAt);
    }
    loginDurations.sort((left, right) => left - right);
    const staffSessionsBefore = await prisma.adminSession.count({
      where: { adminId: staffResult.account.id, revokedAt: null },
    });
    await accounts.revokeSessions(actor.id, adminResult.account.id, {
      currentPassword: ownerPassword,
    });
    const [adminSessionsAfter, staffSessionsAfter] = await Promise.all([
      prisma.adminSession.count({
        where: { adminId: adminResult.account.id, revokedAt: null },
      }),
      prisma.adminSession.count({
        where: { adminId: staffResult.account.id, revokedAt: null },
      }),
    ]);
    if (
      adminSessionsAfter !== 0 ||
      staffSessionsBefore < 1 ||
      staffSessionsAfter !== staffSessionsBefore
    ) {
      throw new Error("Target-scoped session isolation smoke failed.");
    }
    console.info(
      JSON.stringify({
        status: "pass",
        createdFixtureCount: createdIds.length,
        sessionIsolationVerified: true,
        loginBenchmark: {
          sampleSize: loginDurations.length,
          p50Ms: Number(percentile(loginDurations, 0.5).toFixed(2)),
          p95Ms: Number(percentile(loginDurations, 0.95).toFixed(2)),
        },
        credentialsPrinted: false,
      }),
    );
  } finally {
    for (const id of createdIds) {
      const current = await prisma.adminUser.findUnique({
        where: { id },
        select: {
          username: true,
          status: true,
          updatedAt: true,
          deletedAt: true,
        },
      });
      if (!current || current.deletedAt) continue;
      if (current.status !== AccountStatus.DISABLED) {
        await accounts.changeStatus(actor.id, id, {
          status: AccountStatus.DISABLED,
          currentPassword: ownerPassword,
          expectedUpdatedAt: current.updatedAt.toISOString(),
        });
      }
      const disabled = await prisma.adminUser.findUniqueOrThrow({
        where: { id },
        select: { username: true, updatedAt: true },
      });
      await accounts.delete(actor.id, id, {
        currentPassword: ownerPassword,
        confirmUsername: disabled.username,
        expectedUpdatedAt: disabled.updatedAt.toISOString(),
      });
    }
    await prisma.onModuleDestroy();
  }
}

function percentile(sortedValues: number[], fraction: number): number {
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * fraction) - 1),
  );
  return sortedValues[index] ?? 0;
}

run().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Admin account smoke failed.",
  );
  process.exitCode = 1;
});

import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hash } from "bcryptjs";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { AdminAccountsController } from "../src/admin-accounts/admin-accounts.controller";
import { AdminAccountsService } from "../src/admin-accounts/admin-accounts.service";
import { CreateAdminAccountDto } from "../src/admin-accounts/dto/admin-account.dto";
import { AdminCredentialService } from "../src/admin-auth/admin-credential.service";
import { ADMIN_ROLES_METADATA } from "../src/admin-auth/decorators/admin-roles.decorator";
import {
  AccountStatus,
  AdminRole,
  VideoUploadSessionStatus,
} from "../src/generated/prisma/client";
import { findNormalizedUsernameConflicts } from "../scripts/audit/admin-account-audit";
import { parseCleanupOptions } from "../scripts/operations/cleanup-admin-sessions";
import { readFile } from "node:fs/promises";

type Account = {
  id: string;
  username: string;
  passwordHash: string;
  role: AdminRole;
  status: AccountStatus;
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: Date | null;
  deletedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

class FakeConfig {
  get<T>(key: string): T | undefined {
    if (key === "ACCESS_LOG_IP_PEPPER") return "test-pepper" as T;
    return undefined;
  }
  getOrThrow<T>(key: string): T {
    if (key === "api") {
      return {
        adminAccountManagementEnabled: true,
        adminTemporaryPasswordTtlHours: 24,
      } as T;
    }
    throw new Error(`${key} missing`);
  }
}

class FakeAccountPrisma {
  accounts = new Map<string, Account>();
  sessions = new Map<
    string,
    { id: string; adminId: string; revokedAt: Date | null }
  >();
  tokens = new Map<
    string,
    { id: string; adminId: string; revokedAt: Date | null }
  >();
  uploads = new Map<
    string,
    { adminId: string; status: VideoUploadSessionStatus }
  >();
  audits: Array<{
    action: string;
    adminId: string | null;
    metadataJson?: unknown;
  }> = [];
  listQueryCount = 0;
  private transactionQueue: Promise<void> = Promise.resolve();

  adminUser: Record<string, unknown> = {};

  constructor() {
    this.adminUser = {
      findUnique: async ({ where }: { where: { id?: string } }) =>
        where.id ? (this.accounts.get(where.id) ?? null) : null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const row = this.accounts.get(where.id);
        if (!row) throw new Error("not found");
        return row;
      },
      count: async ({ where }: { where?: Record<string, unknown> }) => {
        this.listQueryCount += 1;
        return this.filterAccounts(where).length;
      },
      findMany: async ({
        where,
        skip = 0,
        take = 20,
      }: {
        where?: Record<string, unknown>;
        skip?: number;
        take?: number;
      }) => {
        this.listQueryCount += 1;
        return this.filterAccounts(where)
          .slice(skip, skip + take)
          .map((row) => ({
            ...row,
            _count: {
              sessions: [...this.sessions.values()].filter(
                (session) =>
                  session.adminId === row.id && session.revokedAt === null,
              ).length,
            },
          }));
      },
      create: async ({
        data,
      }: {
        data: Partial<Account> &
          Pick<Account, "username" | "passwordHash" | "role" | "status">;
      }) => {
        if (
          [...this.accounts.values()].some(
            (row) => row.username === data.username,
          )
        ) {
          throw Object.assign(new Error("duplicate"), { code: "P2002" });
        }
        const now = new Date();
        const row: Account = {
          id: `account-${this.accounts.size + 1}`,
          username: data.username,
          passwordHash: data.passwordHash,
          role: data.role,
          status: data.status,
          mustChangePassword: data.mustChangePassword ?? false,
          temporaryPasswordExpiresAt: data.temporaryPasswordExpiresAt ?? null,
          deletedAt: null,
          lastLoginAt: null,
          createdAt: now,
          updatedAt: now,
        };
        this.accounts.set(row.id, row);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; updatedAt?: Date; deletedAt?: null };
        data: Partial<Account>;
      }) => {
        const row = this.accounts.get(where.id);
        if (
          !row ||
          (where.deletedAt === null && row.deletedAt !== null) ||
          (where.updatedAt &&
            row.updatedAt.getTime() !== where.updatedAt.getTime())
        )
          return { count: 0 };
        const updated = {
          ...row,
          ...data,
          updatedAt: new Date(row.updatedAt.getTime() + 1),
        };
        this.accounts.set(row.id, updated);
        return { count: 1 };
      },
    };
  }

  adminSession: Record<string, unknown> = {};
  adminRefreshToken: Record<string, unknown> = {};
  videoUploadSession: Record<string, unknown> = {};
  adminAuditLog: Record<string, unknown> = {};

  initializeDelegates() {
    this.adminSession = {
      updateMany: async ({
        where,
        data,
      }: {
        where: { adminId: string; revokedAt: null };
        data: { revokedAt: Date };
      }) => {
        let count = 0;
        for (const row of this.sessions.values()) {
          if (row.adminId === where.adminId && row.revokedAt === null) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      },
    };
    this.adminRefreshToken = {
      updateMany: async ({
        where,
        data,
      }: {
        where: { adminId: string; revokedAt: null };
        data: { revokedAt: Date };
      }) => {
        let count = 0;
        for (const row of this.tokens.values()) {
          if (row.adminId === where.adminId && row.revokedAt === null) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      },
    };
    this.videoUploadSession = {
      count: async ({
        where,
      }: {
        where: { adminId: string; status: { in: VideoUploadSessionStatus[] } };
      }) =>
        [...this.uploads.values()].filter(
          (row) =>
            row.adminId === where.adminId &&
            where.status.in.includes(row.status),
        ).length,
    };
    this.adminAuditLog = {
      create: async ({
        data,
      }: {
        data: {
          action: string;
          adminId: string | null;
          metadataJson?: unknown;
        };
      }) => {
        this.audits.push(data);
        return data;
      },
    };
  }

  async $transaction<T>(
    input: Promise<unknown>[] | ((tx: this) => Promise<T>),
  ): Promise<T> {
    if (Array.isArray(input)) return (await Promise.all(input)) as T;
    const previous = this.transactionQueue;
    let release!: () => void;
    this.transactionQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await input(this);
    } finally {
      release();
    }
  }

  private filterAccounts(where?: Record<string, unknown>): Account[] {
    return [...this.accounts.values()].filter((row) => {
      if (where?.deletedAt === null && row.deletedAt !== null) return false;
      if (where?.role && row.role !== where.role) return false;
      if (where?.status && row.status !== where.status) return false;
      const username = where?.username as { contains?: string } | undefined;
      return !username?.contains || row.username.includes(username.contains);
    });
  }
}

async function setup() {
  const prisma = new FakeAccountPrisma();
  prisma.initializeDelegates();
  const credentials = new AdminCredentialService();
  const now = new Date("2026-07-16T00:00:00.000Z");
  prisma.accounts.set("owner", {
    id: "owner",
    username: "owner",
    passwordHash: await hash("owner-password-123", 12),
    role: AdminRole.OWNER,
    status: AccountStatus.ACTIVE,
    mustChangePassword: false,
    temporaryPasswordExpiresAt: null,
    deletedAt: null,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
  });
  prisma.accounts.set("target", {
    id: "target",
    username: "target_admin",
    passwordHash: await hash("target-password-123", 12),
    role: AdminRole.ADMIN,
    status: AccountStatus.ACTIVE,
    mustChangePassword: false,
    temporaryPasswordExpiresAt: null,
    deletedAt: null,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
  });
  prisma.accounts.set("other", {
    id: "other",
    username: "other_staff",
    passwordHash: await hash("other-password-123", 12),
    role: AdminRole.STAFF,
    status: AccountStatus.ACTIVE,
    mustChangePassword: false,
    temporaryPasswordExpiresAt: null,
    deletedAt: null,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
  });
  return {
    prisma,
    credentials,
    service: new AdminAccountsService(
      prisma as never,
      new FakeConfig() as never,
      credentials,
    ),
  };
}

describe("admin account management", () => {
  it("requires explicit OWNER metadata on every account route", () => {
    for (const name of Object.getOwnPropertyNames(
      AdminAccountsController.prototype,
    )) {
      if (name === "constructor") continue;
      const handler = Object.getOwnPropertyDescriptor(
        AdminAccountsController.prototype,
        name,
      )?.value;
      if (
        typeof handler !== "function" ||
        Reflect.getMetadata("method", handler) === undefined
      )
        continue;
      assert.deepEqual(Reflect.getMetadata(ADMIN_ROLES_METADATA, handler), [
        AdminRole.OWNER,
      ]);
    }
  });

  it("normalizes credentials and rejects OWNER in create DTO", async () => {
    const credentials = new AdminCredentialService();
    assert.equal(credentials.normalizeUsername("  O\u0308WNER  "), "öwner");
    assert.equal(credentials.generateTemporaryPassword().length, 24);
    const dto = plainToInstance(CreateAdminAccountDto, {
      username: "new_admin",
      role: "OWNER",
      currentPassword: "x",
    });
    assert.ok((await validate(dto)).some((error) => error.property === "role"));
    const { service } = await setup();
    await assert.rejects(
      service.create("owner", {
        username: "forbidden_owner",
        role: AdminRole.OWNER,
        currentPassword: "owner-password-123",
      }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        JSON.stringify(
          (error as { getResponse?: () => unknown }).getResponse?.(),
        ).includes("ADMIN_ROLE_NOT_ALLOWED"),
    );
  });

  it("keeps audit selection read-only and cleanup dry-run by default", async () => {
    const rows = [
      {
        id: "one",
        username: "A\u0308dmin",
        role: "ADMIN",
        status: "ACTIVE",
        deletedAt: null,
      },
      {
        id: "two",
        username: "Ädmin",
        role: "STAFF",
        status: "DISABLED",
        deletedAt: null,
      },
    ];
    assert.equal(findNormalizedUsernameConflicts(rows).length, 1);
    assert.deepEqual(parseCleanupOptions([]), {
      apply: false,
      retentionDays: 90,
      batchSize: 100,
      maxBatches: 10,
      confirmEnvironment: undefined,
    });
    const auditSource = await readFile(
      new URL("../scripts/audit/admin-account-audit.ts", import.meta.url),
      "utf8",
    );
    assert.equal(/passwordHash|tokenHash/.test(auditSource), false);
    assert.equal(
      /\.(create|update|upsert|delete|executeRaw)\s*\(/.test(auditSource),
      false,
    );
  });

  it("allows exactly one concurrent duplicate create and never audits plaintext", async () => {
    const { service, prisma } = await setup();
    const outcomes = await Promise.allSettled([
      service.create("owner", {
        username: "new_staff",
        role: AdminRole.STAFF,
        currentPassword: "owner-password-123",
      }),
      service.create("owner", {
        username: "new_staff",
        role: AdminRole.STAFF,
        currentPassword: "owner-password-123",
      }),
    ]);
    assert.equal(
      outcomes.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const success = outcomes.find((result) => result.status === "fulfilled");
    assert.ok(success && success.status === "fulfilled");
    assert.equal(success.value.temporaryPassword.length, 24);
    const auditJson = JSON.stringify(prisma.audits);
    assert.equal(auditJson.includes(success.value.temporaryPassword), false);
    assert.equal("passwordHash" in success.value.account, false);
  });

  it("uses two list queries independent of page size", async () => {
    const { service, prisma } = await setup();
    prisma.listQueryCount = 0;
    const result = await service.list({ page: 1, limit: 100 });
    assert.equal(result.items.length, 3);
    assert.equal(prisma.listQueryCount, 2);
  });

  it("disables and revokes only the target account sessions", async () => {
    const { service, prisma } = await setup();
    prisma.sessions.set("target-session", {
      id: "target-session",
      adminId: "target",
      revokedAt: null,
    });
    prisma.sessions.set("other-session", {
      id: "other-session",
      adminId: "other",
      revokedAt: null,
    });
    prisma.tokens.set("target-token", {
      id: "target-token",
      adminId: "target",
      revokedAt: null,
    });
    prisma.tokens.set("other-token", {
      id: "other-token",
      adminId: "other",
      revokedAt: null,
    });
    const expectedUpdatedAt = prisma.accounts
      .get("target")!
      .updatedAt.toISOString();
    await service.changeStatus("owner", "target", {
      status: AccountStatus.DISABLED,
      currentPassword: "owner-password-123",
      expectedUpdatedAt,
    });
    assert.ok(prisma.sessions.get("target-session")?.revokedAt);
    assert.equal(prisma.sessions.get("other-session")?.revokedAt, null);
    assert.ok(prisma.tokens.get("target-token")?.revokedAt);
    assert.equal(prisma.tokens.get("other-token")?.revokedAt, null);
  });

  it("blocks logical delete with an active upload and preserves terminal relations", async () => {
    const { service, prisma } = await setup();
    const target = prisma.accounts.get("target")!;
    target.status = AccountStatus.DISABLED;
    prisma.uploads.set("upload-active", {
      adminId: "target",
      status: VideoUploadSessionStatus.ACTIVE,
    });
    await assert.rejects(
      service.delete("owner", "target", {
        currentPassword: "owner-password-123",
        confirmUsername: "target_admin",
        expectedUpdatedAt: target.updatedAt.toISOString(),
      }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        JSON.stringify(
          (error as { getResponse?: () => unknown }).getResponse?.(),
        ).includes("ADMIN_ACTIVE_UPLOAD_BLOCKS_DELETE"),
    );
    prisma.uploads.set("upload-active", {
      adminId: "target",
      status: VideoUploadSessionStatus.COMPLETED,
    });
    await service.delete("owner", "target", {
      currentPassword: "owner-password-123",
      confirmUsername: "target_admin",
      expectedUpdatedAt: target.updatedAt.toISOString(),
    });
    assert.ok(prisma.accounts.get("target")?.deletedAt);
    assert.equal(prisma.uploads.has("upload-active"), true);
    assert.ok(
      prisma.audits.some(
        (audit) => audit.action === "ADMIN_ACCOUNT_LOGICAL_DELETE",
      ),
    );
  });
});

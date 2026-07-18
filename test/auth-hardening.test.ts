import "reflect-metadata";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import {
  ThrottlerException,
  ThrottlerGuard,
  ThrottlerStorageService,
} from "@nestjs/throttler";
import { hash } from "bcryptjs";
import {
  AccountStatus,
  AdminRole,
  AuditStatus,
} from "../src/generated/prisma/client";
import { AdminAuthService } from "../src/admin-auth/admin-auth.service";
import { AdminCredentialService } from "../src/admin-auth/admin-credential.service";
import { ALLOW_PASSWORD_CHANGE_REQUIRED_METADATA } from "../src/admin-auth/decorators/allow-password-change-required.decorator";
import { AdminAccessTokenGuard } from "../src/admin-auth/guards/admin-access-token.guard";
import { apiConfig } from "../src/config/env.config";
import { validateEnv } from "../src/config/env.validation";
import { THROTTLE_PROFILES } from "../src/security/throttle-profile.decorator";

type AdminRecord = {
  id: string;
  username: string;
  passwordHash: string;
  role: AdminRole;
  status: AccountStatus;
  createdAt: Date;
  lastLoginAt: Date | null;
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: Date | null;
  deletedAt: Date | null;
};

type SessionRecord = {
  id: string;
  adminId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  lastUsedAt: Date | null;
  ipHash: string | null;
  userAgentHash: string | null;
  userAgent: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type RefreshTokenRecord = {
  id: string;
  adminId: string;
  sessionId: string | null;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type AuditRecord = {
  adminId: string | null;
  action: string;
  status: AuditStatus;
  metadataJson?: unknown;
};

const PRODUCTION_ENV_BASE = {
  NODE_ENV: "production",
  APP_ENV: "production",
  ADMIN_WEB_ORIGIN: "https://admin.example.com",
  DATABASE_URL: "mysql://user:pass@localhost:3306/db",
  JWT_ACCESS_SECRET: "secret",
  REFRESH_TOKEN_PEPPER: "pepper",
  SHARE_TOKEN_PEPPER: "share-pepper",
  PUBLIC_MEDIA_GRANT_SECRET: "test-public-media-grant-secret-at-least-32-bytes",
  ACCESS_LOG_IP_PEPPER: "ip-pepper",
  ADMIN_CHANGE_PASSWORD_SECRET: "change-secret",
} as const;

class FakeConfigService {
  private readonly values = new Map<string, string>([
    ["JWT_ACCESS_SECRET", "test-access-secret"],
    ["JWT_ACCESS_EXPIRES_IN", "15m"],
    ["REFRESH_TOKEN_BYTES", "32"],
    ["REFRESH_TOKEN_PEPPER", "test-refresh-pepper"],
    ["REFRESH_TOKEN_EXPIRES_DAYS", "30"],
    ["ADMIN_REGISTER_ENABLED", "true"],
    ["ADMIN_REGISTER_SECRET", "test-register-secret"],
    ["ADMIN_CHANGE_PASSWORD_SECRET", "test-change-secret"],
    ["ACCESS_LOG_IP_PEPPER", "test-ip-pepper"],
  ]);

  get<T = string>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  getOrThrow<T = string>(key: string): T {
    const value = this.get<T>(key);

    if (value === undefined) {
      throw new Error(`${key} missing`);
    }

    return value;
  }
}

class FakePrismaService {
  readonly admins = new Map<string, AdminRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly refreshTokens = new Map<string, RefreshTokenRecord>();
  readonly audits: AuditRecord[] = [];

  private nextSession = 1;
  private nextRefresh = 1;
  failTransactions = false;
  private serialTransactionQueue: Promise<void> = Promise.resolve();

  adminUser = {
    count: async (): Promise<number> => this.admins.size,
    findUnique: async (args: { where: { username?: string; id?: string } }) => {
      if (args.where.username !== undefined) {
        return (
          Array.from(this.admins.values()).find(
            (admin) => admin.username === args.where.username,
          ) ?? null
        );
      }

      if (args.where.id !== undefined) {
        return this.admins.get(args.where.id) ?? null;
      }

      return null;
    },
    update: async (args: {
      where: { id: string };
      data: Partial<AdminRecord>;
    }): Promise<AdminRecord> => {
      const admin = this.admins.get(args.where.id);

      assert.ok(admin);

      const updated = {
        ...admin,
        ...args.data,
      };
      this.admins.set(updated.id, updated);

      return updated;
    },
    create: async (args: {
      data: Pick<AdminRecord, "username" | "passwordHash" | "role" | "status"> &
        Partial<AdminRecord>;
    }): Promise<AdminRecord> => {
      const admin: AdminRecord = {
        id: args.data.id ?? `admin-${this.admins.size + 1}`,
        createdAt: args.data.createdAt ?? new Date(),
        lastLoginAt: args.data.lastLoginAt ?? null,
        mustChangePassword: args.data.mustChangePassword ?? false,
        temporaryPasswordExpiresAt:
          args.data.temporaryPasswordExpiresAt ?? null,
        deletedAt: args.data.deletedAt ?? null,
        username: args.data.username,
        passwordHash: args.data.passwordHash,
        role: args.data.role,
        status: args.data.status,
      };
      this.admins.set(admin.id, admin);

      return admin;
    },
  };

  adminSession = {
    create: async (args: {
      data: Omit<
        SessionRecord,
        "id" | "createdAt" | "updatedAt" | "revokedAt" | "revokedReason"
      >;
    }): Promise<SessionRecord> => {
      const now = new Date();
      const session: SessionRecord = {
        id: `session-${this.nextSession++}`,
        revokedAt: null,
        revokedReason: null,
        createdAt: now,
        updatedAt: now,
        ...args.data,
      };
      this.sessions.set(session.id, session);

      return session;
    },
    findUnique: async (args: { where: { id: string } }) => {
      const session = this.sessions.get(args.where.id);

      if (session === undefined) {
        return null;
      }

      return {
        ...session,
        admin: this.admins.get(session.adminId),
      };
    },
    update: async (args: {
      where: { id: string };
      data: Partial<SessionRecord>;
    }): Promise<SessionRecord> => {
      const session = this.sessions.get(args.where.id);

      assert.ok(session);

      const updated = {
        ...session,
        ...args.data,
      };
      this.sessions.set(updated.id, updated);

      return updated;
    },
    updateMany: async (args: {
      where: { id?: string; adminId?: string; revokedAt?: null };
      data: Partial<SessionRecord>;
    }): Promise<{ count: number }> => {
      let count = 0;

      for (const session of this.sessions.values()) {
        if (args.where.id !== undefined && session.id !== args.where.id) {
          continue;
        }
        if (
          args.where.adminId !== undefined &&
          session.adminId !== args.where.adminId
        ) {
          continue;
        }
        if (args.where.revokedAt === null && session.revokedAt !== null) {
          continue;
        }

        this.sessions.set(session.id, {
          ...session,
          ...args.data,
        });
        count += 1;
      }

      return { count };
    },
  };

  adminRefreshToken = {
    create: async (args: {
      data: Omit<
        RefreshTokenRecord,
        "id" | "createdAt" | "updatedAt" | "revokedAt"
      >;
    }): Promise<RefreshTokenRecord> => {
      const now = new Date();
      const token: RefreshTokenRecord = {
        id: `refresh-${this.nextRefresh++}`,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
        ...args.data,
      };
      this.refreshTokens.set(token.id, token);

      return token;
    },
    findUnique: async (args: {
      where: { tokenHash?: string; id?: string };
      include?: { admin?: unknown; session?: boolean };
      select?: { adminId?: true; sessionId?: true };
    }) => {
      const token = Array.from(this.refreshTokens.values()).find((item) => {
        return (
          (args.where.tokenHash !== undefined &&
            item.tokenHash === args.where.tokenHash) ||
          (args.where.id !== undefined && item.id === args.where.id)
        );
      });

      if (token === undefined) {
        return null;
      }

      if (args.select !== undefined) {
        return {
          ...(args.select.adminId ? { adminId: token.adminId } : {}),
          ...(args.select.sessionId ? { sessionId: token.sessionId } : {}),
        };
      }

      return {
        ...token,
        admin: this.admins.get(token.adminId),
        session:
          token.sessionId === null
            ? null
            : (this.sessions.get(token.sessionId) ?? null),
      };
    },
    update: async (args: {
      where: { id: string };
      data: Partial<RefreshTokenRecord>;
    }): Promise<RefreshTokenRecord> => {
      const token = this.refreshTokens.get(args.where.id);

      assert.ok(token);

      const updated = {
        ...token,
        ...args.data,
      };
      this.refreshTokens.set(updated.id, updated);

      return updated;
    },
    updateMany: async (args: {
      where: {
        id?: string;
        tokenHash?: string;
        adminId?: string;
        sessionId?: string;
        revokedAt?: null;
      };
      data: Partial<RefreshTokenRecord>;
    }): Promise<{ count: number }> => {
      let count = 0;

      for (const token of this.refreshTokens.values()) {
        if (args.where.id !== undefined && token.id !== args.where.id) {
          continue;
        }
        if (
          args.where.tokenHash !== undefined &&
          token.tokenHash !== args.where.tokenHash
        ) {
          continue;
        }
        if (
          args.where.adminId !== undefined &&
          token.adminId !== args.where.adminId
        ) {
          continue;
        }
        if (
          args.where.sessionId !== undefined &&
          token.sessionId !== args.where.sessionId
        ) {
          continue;
        }
        if (args.where.revokedAt === null && token.revokedAt !== null) {
          continue;
        }

        this.refreshTokens.set(token.id, {
          ...token,
          ...args.data,
        });
        count += 1;
      }

      return { count };
    },
  };

  adminAuditLog = {
    create: async (args: { data: AuditRecord }): Promise<AuditRecord> => {
      this.audits.push(args.data);

      return args.data;
    },
  };

  async $transaction<T>(
    callback: (tx: this) => Promise<T>,
    options?: { isolationLevel?: string },
  ): Promise<T> {
    if (this.failTransactions) {
      throw new Error("database unavailable");
    }

    if (options?.isolationLevel === "Serializable") {
      const previous = this.serialTransactionQueue;
      let release: (() => void) | undefined;
      this.serialTransactionQueue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await callback(this);
      } finally {
        release?.();
      }
    }

    return callback(this);
  }
}

let prisma: FakePrismaService;
let config: FakeConfigService;
let service: AdminAuthService;
let guard: AdminAccessTokenGuard;

describe("admin auth hardening", () => {
  beforeEach(async () => {
    prisma = new FakePrismaService();
    config = new FakeConfigService();
    service = new AdminAuthService(
      prisma as never,
      config as never,
      new JwtService(),
      new AdminCredentialService(),
    );
    guard = new AdminAccessTokenGuard(
      new JwtService(),
      config as never,
      prisma as never,
      new Reflector(),
    );

    prisma.admins.set("admin-1", {
      id: "admin-1",
      username: "admin",
      passwordHash: await hash("old-password", 12),
      role: AdminRole.OWNER,
      status: AccountStatus.ACTIVE,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      lastLoginAt: null,
      mustChangePassword: false,
      temporaryPasswordExpiresAt: null,
      deletedAt: null,
    });
  });

  it("logs in and creates a session-bound token", async () => {
    const response = await service.login(
      { username: "admin", password: "old-password" },
      { ip: "203.0.113.10", userAgent: "test-agent" },
    );

    assert.equal(response.tokens.tokenType, "Bearer");
    assert.equal(prisma.sessions.size, 1);
    assert.equal(prisma.refreshTokens.size, 1);

    const token = Array.from(prisma.refreshTokens.values())[0];
    assert.equal(token.sessionId, Array.from(prisma.sessions.keys())[0]);
    assert.ok(
      prisma.audits.some((audit) => audit.action === "ADMIN_LOGIN_SUCCESS"),
    );
  });

  it("creates only one initial OWNER under concurrent bootstrap requests", async () => {
    prisma.admins.clear();

    const outcomes = await Promise.allSettled([
      service.register({
        username: "owner-one",
        password: "Strong-password-123!",
        secretCode: "test-register-secret",
      }),
      service.register({
        username: "owner-two",
        password: "Strong-password-456!",
        secretCode: "test-register-secret",
      }),
    ]);

    assert.equal(
      outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      1,
    );
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "rejected").length,
      1,
    );
    assert.equal(prisma.admins.size, 1);
    assert.equal(Array.from(prisma.admins.values())[0]?.role, AdminRole.OWNER);
  });

  it("rejects invalid credentials", async () => {
    await assert.rejects(
      service.login({ username: "admin", password: "wrong-password" }),
      UnauthorizedException,
    );
    assert.ok(
      prisma.audits.some((audit) => audit.action === "ADMIN_LOGIN_FAILURE"),
    );
  });

  it("keeps disabled and missing admin login failures generic", async () => {
    const admin = prisma.admins.get("admin-1");
    assert.ok(admin);
    admin.status = AccountStatus.DISABLED;

    await assert.rejects(
      service.login({ username: "admin", password: "old-password" }),
      (error: unknown) =>
        error instanceof UnauthorizedException &&
        error.message === "Invalid username or password.",
    );
    await assert.rejects(
      service.login({ username: "missing", password: "old-password" }),
      (error: unknown) =>
        error instanceof UnauthorizedException &&
        error.message === "Invalid username or password.",
    );
  });

  it("reveals temporary-password expiry only after valid credentials", async () => {
    const admin = prisma.admins.get("admin-1");
    assert.ok(admin);
    admin.mustChangePassword = true;
    admin.temporaryPasswordExpiresAt = new Date(Date.now() - 1000);

    await assert.rejects(
      service.login({ username: "admin", password: "wrong-password" }),
      UnauthorizedException,
    );
    await assert.rejects(
      service.login({ username: "admin", password: "old-password" }),
      (error: unknown) =>
        error instanceof ForbiddenException &&
        (error.getResponse() as { code?: string }).code ===
          "ADMIN_TEMP_PASSWORD_EXPIRED",
    );
    assert.equal(prisma.sessions.size, 0);
  });

  it("blocks business routes until a temporary password is changed", async () => {
    const admin = prisma.admins.get("admin-1");
    assert.ok(admin);
    admin.mustChangePassword = true;
    admin.temporaryPasswordExpiresAt = new Date(Date.now() + 60_000);
    const login = await service.login({
      username: "admin",
      password: "old-password",
    });
    assert.equal(login.admin.mustChangePassword, true);

    await assert.rejects(
      guard.canActivate(createAuthContext(login.tokens.accessToken)),
      (error: unknown) =>
        error instanceof ForbiddenException &&
        (error.getResponse() as { code?: string }).code ===
          "ADMIN_PASSWORD_CHANGE_REQUIRED",
    );

    const allowedHandler = (): void => undefined;
    Reflect.defineMetadata(
      ALLOW_PASSWORD_CHANGE_REQUIRED_METADATA,
      true,
      allowedHandler,
    );
    assert.equal(
      await guard.canActivate(
        createAuthContext(login.tokens.accessToken, allowedHandler),
      ),
      true,
    );
  });

  it("rechecks account state inside the login transaction", async () => {
    const originalFindUnique = prisma.adminUser.findUnique;
    prisma.adminUser.findUnique = async (args) => {
      const result = await originalFindUnique(args);
      if (args.where.id === "admin-1") {
        const current = prisma.admins.get("admin-1");
        assert.ok(current);
        current.status = AccountStatus.DISABLED;
      }
      return result;
    };

    await assert.rejects(
      service.login({ username: "admin", password: "old-password" }),
      UnauthorizedException,
    );
    assert.equal(prisma.sessions.size, 0);
    assert.equal(prisma.refreshTokens.size, 0);
  });

  it("rotates refresh tokens and revokes session on replay", async () => {
    const login = await service.login({
      username: "admin",
      password: "old-password",
    });
    const originalRefreshToken = login.tokens.refreshToken;

    const refreshed = await service.refresh({
      refreshToken: originalRefreshToken,
    });

    assert.notEqual(refreshed.tokens.refreshToken, originalRefreshToken);
    assert.equal(
      Array.from(prisma.refreshTokens.values()).filter(
        (token) => token.revokedAt !== null,
      ).length,
      1,
    );

    await assert.rejects(
      service.refresh({ refreshToken: originalRefreshToken }),
      UnauthorizedException,
    );

    const session = Array.from(prisma.sessions.values())[0];
    assert.equal(session.revokedReason, "REFRESH_REPLAY");
    assert.ok(
      prisma.audits.some((audit) => audit.action === "ADMIN_REFRESH_REPLAY"),
    );
  });

  it("allows only one concurrent refresh claim and revokes the token family", async () => {
    const login = await service.login({
      username: "admin",
      password: "old-password",
    });

    const outcomes = await Promise.allSettled([
      service.refresh({ refreshToken: login.tokens.refreshToken }),
      service.refresh({ refreshToken: login.tokens.refreshToken }),
    ]);

    assert.equal(
      outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      1,
    );
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "rejected").length,
      1,
    );
    assert.equal(
      Array.from(prisma.sessions.values())[0]?.revokedReason,
      "REFRESH_REPLAY",
    );
    assert.equal(
      Array.from(prisma.refreshTokens.values()).every(
        (token) => token.revokedAt !== null,
      ),
      true,
    );
  });

  it("rechecks disabled account state inside refresh rotation", async () => {
    const login = await service.login({
      username: "admin",
      password: "old-password",
    });
    const originalTransaction = prisma.$transaction.bind(prisma);
    let disableOnNextTransaction = true;
    prisma.$transaction = async (callback, options) => {
      if (disableOnNextTransaction) {
        disableOnNextTransaction = false;
        const current = prisma.admins.get("admin-1");
        assert.ok(current);
        current.status = AccountStatus.DISABLED;
      }
      return originalTransaction(callback, options);
    };

    await assert.rejects(
      service.refresh({ refreshToken: login.tokens.refreshToken }),
      UnauthorizedException,
    );
    assert.equal(prisma.refreshTokens.size, 1);
    assert.equal(
      [...prisma.refreshTokens.values()].every(
        (token) => token.revokedAt !== null,
      ),
      true,
    );
    assert.equal(
      [...prisma.sessions.values()][0]?.revokedReason,
      "ACCOUNT_STATE_CHANGED",
    );
  });

  it("logout revokes the current session and makes access token fail", async () => {
    const login = await service.login({
      username: "admin",
      password: "old-password",
    });

    const sessionId = Array.from(prisma.sessions.keys())[0];
    assert.ok(sessionId);
    await service.logout(
      { refreshToken: login.tokens.refreshToken },
      "admin-1",
      sessionId,
    );

    const session = Array.from(prisma.sessions.values())[0];
    assert.equal(session.revokedReason, "LOGOUT");

    await assert.rejects(
      guard.canActivate(createAuthContext(login.tokens.accessToken)),
      UnauthorizedException,
    );
  });

  it("does not report logout success when the revocation transaction fails", async () => {
    const login = await service.login({
      username: "admin",
      password: "old-password",
    });
    const sessionId = Array.from(prisma.sessions.keys())[0];
    assert.ok(sessionId);
    prisma.failTransactions = true;

    await assert.rejects(
      service.logout(
        { refreshToken: login.tokens.refreshToken },
        "admin-1",
        sessionId,
      ),
      /database unavailable/,
    );
    assert.equal(prisma.sessions.get(sessionId)?.revokedAt, null);
    assert.ok(
      prisma.audits.some((audit) => audit.action === "ADMIN_LOGOUT_FAILURE"),
    );
  });

  it("password change revokes active sessions", async () => {
    const login = await service.login({
      username: "admin",
      password: "old-password",
    });

    await service.changePassword("admin-1", {
      oldPassword: "old-password",
      newPassword: "new-password",
      secretCode: "test-change-secret",
    });

    const session = Array.from(prisma.sessions.values())[0];
    assert.equal(session.revokedReason, "PASSWORD_CHANGE");

    await assert.rejects(
      guard.canActivate(createAuthContext(login.tokens.accessToken)),
      UnauthorizedException,
    );
  });
});

describe("production docs gate", () => {
  it("keeps docs off in production unless both flags are true", () => {
    const previousEnv = { ...process.env };

    try {
      validateEnv({
        ...PRODUCTION_ENV_BASE,
        API_INTERNAL_DOCS_ENABLED: "true",
        API_DOCS_ALLOW_IN_PRODUCTION: "false",
        VIDEO_DB_STORAGE_ENABLED: "false",
      });
      assert.equal(apiConfig().docsEnabled, false);

      validateEnv({
        ...PRODUCTION_ENV_BASE,
        API_INTERNAL_DOCS_ENABLED: "true",
        API_DOCS_ALLOW_IN_PRODUCTION: "true",
        VIDEO_DB_STORAGE_ENABLED: "false",
      });
      assert.equal(apiConfig().docsEnabled, true);
    } finally {
      process.env = previousEnv;
    }
  });
});

describe("public media throttle config", () => {
  it("keeps public media throttle separate from strict public watch throttle", () => {
    const previousEnv = { ...process.env };

    try {
      validateEnv({
        NODE_ENV: "development",
        APP_ENV: "local",
        DATABASE_URL: "mysql://user:pass@localhost:3306/db",
        JWT_ACCESS_SECRET: "secret",
        REFRESH_TOKEN_PEPPER: "pepper",
        SHARE_TOKEN_PEPPER: "share-pepper",
        ACCESS_LOG_IP_PEPPER: "ip-pepper",
        PUBLIC_WATCH_THROTTLE_LIMIT: "60",
        PUBLIC_MEDIA_THROTTLE_LIMIT: "1200",
      });

      const config = apiConfig();

      assert.equal(config.throttles.publicWatch.limit, 60);
      assert.equal(config.throttles.publicMedia.limit, 1200);
      assert.ok(
        config.throttles.publicMedia.limit > config.throttles.publicWatch.limit,
      );
    } finally {
      process.env = previousEnv;
    }
  });
});

describe("production DB_BLOB guard", () => {
  it("rejects production DB storage without explicit emergency override", () => {
    assert.throws(() =>
      validateEnv({
        ...PRODUCTION_ENV_BASE,
        VIDEO_DB_STORAGE_ENABLED: "true",
      }),
    );

    assert.doesNotThrow(() =>
      validateEnv({
        ...PRODUCTION_ENV_BASE,
        VIDEO_DB_STORAGE_ENABLED: "true",
        VIDEO_DB_STORAGE_ALLOW_PRODUCTION_OVERRIDE: "true",
      }),
    );
  });
});

describe("throttling", () => {
  it("returns 429 after repeated limited requests", async () => {
    const storage = new ThrottlerStorageService();
    const throttlerGuard = new ThrottlerGuard(
      {
        throttlers: [
          {
            name: THROTTLE_PROFILES.login,
            ttl: 60_000,
            limit: 1,
          },
        ],
      },
      storage,
      new Reflector(),
    );

    try {
      await throttlerGuard.onModuleInit();

      const context = createThrottleContext();

      assert.equal(await throttlerGuard.canActivate(context), true);
      await assert.rejects(
        throttlerGuard.canActivate(context),
        ThrottlerException,
      );
    } finally {
      storage.onApplicationShutdown();
    }
  });
});

function createAuthContext(
  accessToken: string,
  handler: () => void = () => undefined,
): ExecutionContext {
  class TestController {}
  return {
    getHandler: () => handler,
    getClass: () => TestController,
    switchToHttp() {
      return {
        getRequest() {
          return {
            headers: {
              authorization: `Bearer ${accessToken}`,
            },
          };
        },
      };
    },
  } as ExecutionContext;
}

function createThrottleContext(): ExecutionContext {
  class TestController {}

  function testHandler() {
    return undefined;
  }

  const headers = new Map<string, string>();

  return {
    getClass() {
      return TestController;
    },
    getHandler() {
      return testHandler;
    },
    switchToHttp() {
      return {
        getRequest() {
          return {
            ip: "203.0.113.10",
            headers: {
              "user-agent": "test-agent",
            },
          };
        },
        getResponse() {
          return {
            header(name: string, value: string | number) {
              headers.set(name, String(value));
            },
          };
        },
      };
    },
  } as ExecutionContext;
}

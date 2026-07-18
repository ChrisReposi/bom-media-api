import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AccountStatus,
  AdminRole,
  AuditStatus,
  Prisma,
  VideoUploadSessionStatus,
} from "../generated/prisma/client";
import { AdminCredentialService } from "../admin-auth/admin-credential.service";
import {
  hashSensitiveValue,
  truncateRequestValue,
  type RequestSecurityMeta,
} from "../common/utils/request-security.util";
import type { ApiEnvironmentConfig } from "../config/env.config";
import { PrismaService } from "../database/prisma.service";
import type {
  ChangeAdminAccountRoleDto,
  ChangeAdminAccountStatusDto,
  CreateAdminAccountDto,
  DeleteAdminAccountDto,
  ListAdminAccountsQueryDto,
  ResetAdminAccountPasswordDto,
  RevokeAdminAccountSessionsDto,
} from "./dto/admin-account.dto";
import type {
  AdminAccountMutationResponse,
  ManagedAdminAccountListResponse,
  ManagedAdminAccountResponse,
  TemporaryAdminPasswordResponse,
} from "./types/admin-account-response.type";

type ActorSnapshot = {
  id: string;
  passwordHash: string;
};

type AccountProjection = {
  id: string;
  username: string;
  role: AdminRole;
  status: AccountStatus;
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: Date | null;
  deletedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { sessions: number };
};

@Injectable()
export class AdminAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly credentials: AdminCredentialService,
  ) {}

  async list(
    query: ListAdminAccountsQueryDto,
  ): Promise<ManagedAdminAccountListResponse> {
    this.ensureEnabled();
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const search = query.search ?? "";
    if (search.length === 1) {
      return {
        items: [],
        meta: { page, limit, total: 0, totalPages: 0 },
      };
    }
    const now = new Date();
    const where: Prisma.AdminUserWhereInput = {
      ...(query.includeDeleted ? {} : { deletedAt: null }),
      ...(query.role ? { role: query.role } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(search ? { username: { contains: search } } : {}),
    };
    const sortBy = query.sortBy ?? "createdAt";
    const sortOrder = query.sortOrder ?? "desc";
    const [total, accounts] = await this.prisma.$transaction([
      this.prisma.adminUser.count({ where }),
      this.prisma.adminUser.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ [sortBy]: sortOrder }, { id: sortOrder }],
        select: {
          ...this.accountSelect(),
          _count: {
            select: {
              sessions: {
                where: { revokedAt: null, expiresAt: { gt: now } },
              },
            },
          },
        },
      }),
    ]);
    return {
      items: accounts.map((account) => this.toResponse(account)),
      meta: {
        page,
        limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      },
    };
  }

  async create(
    actorId: string,
    dto: CreateAdminAccountDto,
    requestMeta?: RequestSecurityMeta,
  ): Promise<TemporaryAdminPasswordResponse> {
    this.ensureEnabled();
    this.ensureManagedRole(dto.role);
    const actor = await this.verifyOwner(
      actorId,
      dto.currentPassword,
      requestMeta,
    );
    const username = this.credentials.normalizeUsername(dto.username);
    const temporaryPassword = this.credentials.generateTemporaryPassword();
    const passwordHash = await this.credentials.hashPassword(temporaryPassword);
    const expiresAt = this.getTemporaryPasswordExpiresAt();

    try {
      const account = await this.runSerializable(async (tx) => {
        await this.recheckOwner(tx, actor);
        const created = await tx.adminUser.create({
          data: {
            username,
            role: dto.role,
            status: AccountStatus.ACTIVE,
            passwordHash,
            mustChangePassword: true,
            temporaryPasswordExpiresAt: expiresAt,
          },
          select: this.accountSelect(),
        });
        await this.writeAudit(tx, {
          actorId,
          action: "ADMIN_ACCOUNT_CREATE",
          targetId: created.id,
          requestMeta,
          metadata: { role: created.role, status: created.status },
        });
        return created;
      });
      return {
        account: this.toResponse(account),
        temporaryPassword,
      };
    } catch (error) {
      if (this.isPrismaCode(error, "P2002")) {
        this.conflict("ADMIN_USERNAME_TAKEN", "Username is already in use.");
      }
      throw error;
    }
  }

  async changeRole(
    actorId: string,
    targetId: string,
    dto: ChangeAdminAccountRoleDto,
    requestMeta?: RequestSecurityMeta,
  ): Promise<AdminAccountMutationResponse> {
    this.ensureEnabled();
    this.ensureManagedRole(dto.role);
    const actor = await this.verifyOwner(
      actorId,
      dto.currentPassword,
      requestMeta,
    );
    const expectedUpdatedAt = new Date(dto.expectedUpdatedAt);
    const account = await this.runSerializable(async (tx) => {
      await this.recheckOwner(tx, actor);
      const target = await this.loadMutableTarget(tx, actorId, targetId);
      this.ensureVersion(target, expectedUpdatedAt);
      if (target.role === dto.role) {
        this.conflict(
          "ADMIN_CONCURRENT_MUTATION",
          "Account role is already current.",
        );
      }
      const updated = await tx.adminUser.updateMany({
        where: { id: target.id, updatedAt: expectedUpdatedAt, deletedAt: null },
        data: { role: dto.role },
      });
      if (updated.count !== 1) this.concurrentMutation();
      const revokedSessionCount = await this.revokeTargetSessions(
        tx,
        target.id,
        "ROLE_CHANGE",
      );
      const result = await tx.adminUser.findUniqueOrThrow({
        where: { id: target.id },
        select: this.accountSelect(),
      });
      await this.writeAudit(tx, {
        actorId,
        action: "ADMIN_ACCOUNT_ROLE_CHANGE",
        targetId,
        requestMeta,
        metadata: {
          previousRole: target.role,
          role: dto.role,
          revokedSessionCount,
        },
      });
      return result;
    });
    return {
      message: "Account role updated.",
      account: this.toResponse(account),
    };
  }

  async changeStatus(
    actorId: string,
    targetId: string,
    dto: ChangeAdminAccountStatusDto,
    requestMeta?: RequestSecurityMeta,
  ): Promise<AdminAccountMutationResponse> {
    this.ensureEnabled();
    const actor = await this.verifyOwner(
      actorId,
      dto.currentPassword,
      requestMeta,
    );
    const expectedUpdatedAt = new Date(dto.expectedUpdatedAt);
    const result = await this.runSerializable(async (tx) => {
      await this.recheckOwner(tx, actor);
      const target = await this.loadMutableTarget(tx, actorId, targetId);
      this.ensureVersion(target, expectedUpdatedAt);
      if (target.status === dto.status) {
        const code =
          dto.status === AccountStatus.DISABLED
            ? "ADMIN_ACCOUNT_ALREADY_DISABLED"
            : "ADMIN_ACCOUNT_ALREADY_ACTIVE";
        this.conflict(code, "Account already has the requested status.");
      }
      const updated = await tx.adminUser.updateMany({
        where: { id: target.id, updatedAt: expectedUpdatedAt, deletedAt: null },
        data: { status: dto.status },
      });
      if (updated.count !== 1) this.concurrentMutation();
      const revokedSessionCount =
        dto.status === AccountStatus.DISABLED
          ? await this.revokeTargetSessions(tx, target.id, "ACCOUNT_DISABLED")
          : 0;
      const account = await tx.adminUser.findUniqueOrThrow({
        where: { id: target.id },
        select: this.accountSelect(),
      });
      await this.writeAudit(tx, {
        actorId,
        action: "ADMIN_ACCOUNT_STATUS_CHANGE",
        targetId,
        requestMeta,
        metadata: {
          previousStatus: target.status,
          status: dto.status,
          revokedSessionCount,
        },
      });
      return { account, revokedSessionCount };
    });
    return {
      message: "Account status updated.",
      account: this.toResponse(result.account),
      revokedSessionCount: result.revokedSessionCount,
    };
  }

  async revokeSessions(
    actorId: string,
    targetId: string,
    dto: RevokeAdminAccountSessionsDto,
    requestMeta?: RequestSecurityMeta,
  ): Promise<AdminAccountMutationResponse> {
    this.ensureEnabled();
    const actor = await this.verifyOwner(
      actorId,
      dto.currentPassword,
      requestMeta,
    );
    const revokedSessionCount = await this.runSerializable(async (tx) => {
      await this.recheckOwner(tx, actor);
      const target = await this.loadMutableTarget(tx, actorId, targetId);
      const count = await this.revokeTargetSessions(
        tx,
        target.id,
        "OWNER_REVOKE_ALL",
      );
      await this.writeAudit(tx, {
        actorId,
        action: "ADMIN_ACCOUNT_REVOKE_SESSIONS",
        targetId,
        requestMeta,
        metadata: { revokedSessionCount: count },
      });
      return count;
    });
    return {
      message: "Account sessions revoked.",
      revokedSessionCount,
    };
  }

  async resetPassword(
    actorId: string,
    targetId: string,
    dto: ResetAdminAccountPasswordDto,
    requestMeta?: RequestSecurityMeta,
  ): Promise<TemporaryAdminPasswordResponse> {
    this.ensureEnabled();
    const actor = await this.verifyOwner(
      actorId,
      dto.currentPassword,
      requestMeta,
    );
    const temporaryPassword = this.credentials.generateTemporaryPassword();
    const passwordHash = await this.credentials.hashPassword(temporaryPassword);
    const expiresAt = this.getTemporaryPasswordExpiresAt();
    const expectedUpdatedAt = new Date(dto.expectedUpdatedAt);
    const account = await this.runSerializable(async (tx) => {
      await this.recheckOwner(tx, actor);
      const target = await this.loadMutableTarget(tx, actorId, targetId);
      this.ensureVersion(target, expectedUpdatedAt);
      const updated = await tx.adminUser.updateMany({
        where: { id: target.id, updatedAt: expectedUpdatedAt, deletedAt: null },
        data: {
          passwordHash,
          mustChangePassword: true,
          temporaryPasswordExpiresAt: expiresAt,
        },
      });
      if (updated.count !== 1) this.concurrentMutation();
      const revokedSessionCount = await this.revokeTargetSessions(
        tx,
        target.id,
        "PASSWORD_RESET",
      );
      const result = await tx.adminUser.findUniqueOrThrow({
        where: { id: target.id },
        select: this.accountSelect(),
      });
      await this.writeAudit(tx, {
        actorId,
        action: "ADMIN_ACCOUNT_PASSWORD_RESET",
        targetId,
        requestMeta,
        metadata: { revokedSessionCount },
      });
      return result;
    });
    return { account: this.toResponse(account), temporaryPassword };
  }

  async delete(
    actorId: string,
    targetId: string,
    dto: DeleteAdminAccountDto,
    requestMeta?: RequestSecurityMeta,
  ): Promise<AdminAccountMutationResponse> {
    this.ensureEnabled();
    const actor = await this.verifyOwner(
      actorId,
      dto.currentPassword,
      requestMeta,
    );
    const unusableHash = await this.credentials.hashPassword(
      this.credentials.generateUnusablePassword(),
    );
    const expectedUpdatedAt = new Date(dto.expectedUpdatedAt);
    await this.runSerializable(async (tx) => {
      await this.recheckOwner(tx, actor);
      const target = await this.loadMutableTarget(tx, actorId, targetId);
      this.ensureVersion(target, expectedUpdatedAt);
      if (
        this.credentials.normalizeUsername(dto.confirmUsername) !==
        target.username
      ) {
        throw new ForbiddenException({
          statusCode: 403,
          message: "Account confirmation failed.",
          error: "Forbidden",
          code: "ADMIN_SELF_ACTION_FORBIDDEN",
        });
      }
      if (target.status !== AccountStatus.DISABLED) {
        this.conflict(
          "ADMIN_ACCOUNT_ALREADY_ACTIVE",
          "Account must be disabled before deletion.",
        );
      }
      const activeUploads = await tx.videoUploadSession.count({
        where: {
          adminId: target.id,
          status: {
            in: [
              VideoUploadSessionStatus.ACTIVE,
              VideoUploadSessionStatus.COMPLETING,
            ],
          },
        },
      });
      if (activeUploads > 0) {
        this.conflict(
          "ADMIN_ACTIVE_UPLOAD_BLOCKS_DELETE",
          "Active uploads must finish or be cancelled before deletion.",
        );
      }
      const deletedAt = new Date();
      const updated = await tx.adminUser.updateMany({
        where: { id: target.id, updatedAt: expectedUpdatedAt, deletedAt: null },
        data: {
          status: AccountStatus.DISABLED,
          deletedAt,
          passwordHash: unusableHash,
          mustChangePassword: false,
          temporaryPasswordExpiresAt: null,
        },
      });
      if (updated.count !== 1) this.concurrentMutation();
      const revokedSessionCount = await this.revokeTargetSessions(
        tx,
        target.id,
        "ACCOUNT_DELETED",
      );
      await this.writeAudit(tx, {
        actorId,
        action: "ADMIN_ACCOUNT_LOGICAL_DELETE",
        targetId,
        requestMeta,
        metadata: { role: target.role, revokedSessionCount },
      });
    });
    return { message: "Account logically deleted and audit history retained." };
  }

  private ensureEnabled(): void {
    const api = this.configService.getOrThrow<ApiEnvironmentConfig>("api");
    if (!api.adminAccountManagementEnabled) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        message: "Admin account management is disabled.",
        error: "Service Unavailable",
        code: "ADMIN_ACCOUNT_MANAGEMENT_DISABLED",
      });
    }
  }

  private ensureManagedRole(role: AdminRole): void {
    if (role !== AdminRole.ADMIN && role !== AdminRole.STAFF) {
      throw new ForbiddenException({
        statusCode: 403,
        message: "The requested admin role is not allowed.",
        error: "Forbidden",
        code: "ADMIN_ROLE_NOT_ALLOWED",
      });
    }
  }

  private async verifyOwner(
    actorId: string,
    currentPassword: string,
    requestMeta?: RequestSecurityMeta,
  ): Promise<ActorSnapshot> {
    const actor = await this.prisma.adminUser.findUnique({
      where: { id: actorId },
      select: {
        id: true,
        role: true,
        status: true,
        deletedAt: true,
        passwordHash: true,
      },
    });
    const valid =
      actor !== null &&
      actor.role === AdminRole.OWNER &&
      actor.status === AccountStatus.ACTIVE &&
      actor.deletedAt === null &&
      (await this.credentials.comparePassword(
        currentPassword,
        actor.passwordHash,
      ));
    if (!valid || actor === null) {
      await this.writeFailedStepUpAudit(actorId, requestMeta);
      throw new ForbiddenException({
        statusCode: 403,
        message: "Owner reauthentication is required.",
        error: "Forbidden",
        code: "OWNER_REAUTH_REQUIRED",
      });
    }
    return { id: actor.id, passwordHash: actor.passwordHash };
  }

  private async recheckOwner(
    tx: Prisma.TransactionClient,
    actor: ActorSnapshot,
  ): Promise<void> {
    const current = await tx.adminUser.findUnique({
      where: { id: actor.id },
      select: { passwordHash: true, role: true, status: true, deletedAt: true },
    });
    if (
      current === null ||
      current.passwordHash !== actor.passwordHash ||
      current.role !== AdminRole.OWNER ||
      current.status !== AccountStatus.ACTIVE ||
      current.deletedAt !== null
    ) {
      this.concurrentMutation();
    }
  }

  private async loadMutableTarget(
    tx: Prisma.TransactionClient,
    actorId: string,
    targetId: string,
  ) {
    const target = await tx.adminUser.findUnique({
      where: { id: targetId },
      select: { ...this.accountSelect(), passwordHash: true },
    });
    if (target === null) {
      throw new NotFoundException({
        statusCode: 404,
        message: "Admin account not found.",
        error: "Not Found",
        code: "ADMIN_ACCOUNT_NOT_FOUND",
      });
    }
    if (target.id === actorId) {
      throw new ForbiddenException({
        statusCode: 403,
        message: "Self action is forbidden.",
        error: "Forbidden",
        code: "ADMIN_SELF_ACTION_FORBIDDEN",
      });
    }
    if (target.role === AdminRole.OWNER) {
      throw new ForbiddenException({
        statusCode: 403,
        message: "Owner accounts are protected.",
        error: "Forbidden",
        code: "ADMIN_OWNER_PROTECTED",
      });
    }
    if (target.deletedAt !== null) {
      this.conflict("ADMIN_ACCOUNT_DELETED", "Account is already deleted.");
    }
    return target;
  }

  private ensureVersion(target: { updatedAt: Date }, expected: Date): void {
    if (target.updatedAt.getTime() !== expected.getTime()) {
      this.concurrentMutation();
    }
  }

  private async revokeTargetSessions(
    tx: Prisma.TransactionClient,
    adminId: string,
    reason: string,
  ): Promise<number> {
    const revokedAt = new Date();
    await tx.adminRefreshToken.updateMany({
      where: { adminId, revokedAt: null },
      data: { revokedAt },
    });
    const sessions = await tx.adminSession.updateMany({
      where: { adminId, revokedAt: null },
      data: { revokedAt, revokedReason: reason },
    });
    return sessions.count;
  }

  private accountSelect() {
    return {
      id: true,
      username: true,
      role: true,
      status: true,
      mustChangePassword: true,
      temporaryPasswordExpiresAt: true,
      deletedAt: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true,
    } as const;
  }

  private toResponse(account: AccountProjection): ManagedAdminAccountResponse {
    return {
      id: account.id,
      username: account.username,
      role: account.role,
      status: account.status,
      mustChangePassword: account.mustChangePassword,
      activeSessionCount: account._count?.sessions ?? 0,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      lastLoginAt: account.lastLoginAt,
      temporaryPasswordExpiresAt: account.temporaryPasswordExpiresAt,
      deletedAt: account.deletedAt,
    };
  }

  private getTemporaryPasswordExpiresAt(): Date {
    const api = this.configService.getOrThrow<ApiEnvironmentConfig>("api");
    return new Date(
      Date.now() + api.adminTemporaryPasswordTtlHours * 60 * 60 * 1000,
    );
  }

  private async runSerializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: "Serializable",
        });
      } catch (error) {
        if (this.isPrismaCode(error, "P2034") && attempt < 3) continue;
        throw error;
      }
    }
    throw new Error("Serializable account mutation retry exhausted.");
  }

  private async writeAudit(
    tx: Prisma.TransactionClient,
    params: {
      actorId: string;
      action: string;
      targetId: string;
      metadata: Record<string, unknown>;
      requestMeta?: RequestSecurityMeta;
    },
  ): Promise<void> {
    await tx.adminAuditLog.create({
      data: {
        adminId: params.actorId,
        action: params.action,
        module: "admin-accounts",
        entityType: "AdminUser",
        entityId: params.targetId,
        status: AuditStatus.SUCCESS,
        ipHash: hashSensitiveValue({
          value: params.requestMeta?.ip,
          pepper: this.configService.get<string>("ACCESS_LOG_IP_PEPPER"),
        }),
        userAgent: truncateRequestValue(params.requestMeta?.userAgent, 1024),
        metadataJson: params.metadata as Prisma.InputJsonValue,
      },
    });
  }

  private async writeFailedStepUpAudit(
    actorId: string,
    requestMeta?: RequestSecurityMeta,
  ): Promise<void> {
    try {
      await this.prisma.adminAuditLog.create({
        data: {
          adminId: actorId,
          action: "OWNER_REAUTH_FAILURE",
          module: "admin-accounts",
          entityType: "AdminUser",
          entityId: actorId,
          status: AuditStatus.FAIL,
          ipHash: hashSensitiveValue({
            value: requestMeta?.ip,
            pepper: this.configService.get<string>("ACCESS_LOG_IP_PEPPER"),
          }),
          userAgent: truncateRequestValue(requestMeta?.userAgent, 1024),
          metadataJson: { reason: "VERIFICATION_FAILED" },
        },
      });
    } catch {
      // The original authorization failure remains authoritative.
    }
  }

  private conflict(code: string, message: string): never {
    throw new ConflictException({
      statusCode: 409,
      message,
      error: "Conflict",
      code,
    });
  }

  private concurrentMutation(): never {
    return this.conflict(
      "ADMIN_CONCURRENT_MUTATION",
      "Account changed concurrently. Refresh and retry.",
    );
  }

  private isPrismaCode(error: unknown, code: string): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === code
    );
  }
}

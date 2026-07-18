import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { hashSync } from "bcryptjs";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  hashSensitiveValue,
  truncateRequestValue,
  type RequestSecurityMeta,
} from "../common/utils/request-security.util";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import {
  AccountStatus,
  AdminRole,
  AuditStatus,
} from "../generated/prisma/client";
import type { ChangeAdminPasswordDto } from "./dto/change-admin-password.dto";
import type { ChangeOwnAdminPasswordDto } from "./dto/change-own-admin-password.dto";
import type { LoginAdminDto } from "./dto/login-admin.dto";
import type { LogoutAdminDto } from "./dto/logout-admin.dto";
import type { RefreshAdminTokenDto } from "./dto/refresh-admin-token.dto";
import type { RegisterAdminDto } from "./dto/register-admin.dto";
import type {
  AdminTokenResponse,
  ChangeAdminPasswordResponse,
  LoginAdminResponse,
  LogoutAdminResponse,
  MeAdminResponse,
  RefreshAdminTokenResponse,
  RegisterAdminResponse,
  SafeAdminResponse,
  AdminOwnSessionListResponse,
  RevokeOwnAdminSessionResponse,
} from "./types/admin-auth-response.type";
import type { AdminAccessTokenPayload } from "./types/admin-token-payload.type";
import { AdminCredentialService } from "./admin-credential.service";

type AdminAuthRecord = {
  id: string;
  username: string;
  role: AdminRole;
  status: AccountStatus;
  createdAt: Date;
  lastLoginAt: Date | null;
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: Date | null;
  deletedAt: Date | null;
};

type AdminAuthAuditAction =
  | "ADMIN_LOGIN_SUCCESS"
  | "ADMIN_LOGIN_FAILURE"
  | "ADMIN_REFRESH_SUCCESS"
  | "ADMIN_REFRESH_FAILURE"
  | "ADMIN_REFRESH_REPLAY"
  | "ADMIN_LOGOUT_SUCCESS"
  | "ADMIN_LOGOUT_FAILURE"
  | "ADMIN_PASSWORD_CHANGE_SUCCESS"
  | "ADMIN_PASSWORD_CHANGE_FAILURE"
  | "ADMIN_SESSION_REVOKE_SUCCESS";

type InternalAdminTokenResponse = AdminTokenResponse & {
  sessionId: string;
};

const PASSWORD_HASH_ROUNDS = 12;
const DUMMY_PASSWORD_HASH = hashSync(
  "bom-media-invalid-admin-password",
  PASSWORD_HASH_ROUNDS,
);

@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly credentials: AdminCredentialService,
  ) {}

  async register(dto: RegisterAdminDto): Promise<RegisterAdminResponse> {
    if (!this.isRegistrationEnabled()) {
      throw new ForbiddenException("Admin registration is disabled.");
    }

    if (!this.isSecretCodeValid(dto.secretCode)) {
      throw new ForbiddenException("Admin registration is not allowed.");
    }

    const username = this.credentials.normalizeUsername(dto.username);
    const passwordHash = await this.credentials.hashPassword(dto.password);
    const admin = await this.createInitialOwner({ username, passwordHash });

    return {
      message: "Admin registered successfully.",
      admin: this.toSafeAdmin(admin),
    };
  }

  async login(
    dto: LoginAdminDto,
    requestMeta?: RequestSecurityMeta,
  ): Promise<LoginAdminResponse> {
    const username = this.credentials.normalizeUsername(dto.username);
    const admin = await this.prisma.adminUser.findUnique({
      where: { username },
      select: {
        ...this.safeAdminSelect(),
        passwordHash: true,
      },
    });

    const passwordMatches = await this.credentials.comparePassword(
      dto.password,
      admin?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );

    if (
      admin === null ||
      admin.status !== AccountStatus.ACTIVE ||
      admin.deletedAt !== null ||
      !passwordMatches
    ) {
      await this.writeAuthAudit({
        adminId: admin?.id ?? null,
        action: "ADMIN_LOGIN_FAILURE",
        status: AuditStatus.FAIL,
        requestMeta,
        metadata: {
          reason: "INVALID_CREDENTIALS",
          username,
        },
      });
      throw new UnauthorizedException("Invalid username or password.");
    }

    if (
      admin.mustChangePassword &&
      admin.temporaryPasswordExpiresAt !== null &&
      admin.temporaryPasswordExpiresAt <= new Date()
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        message: "Temporary password has expired.",
        error: "Forbidden",
        code: "ADMIN_TEMP_PASSWORD_EXPIRED",
      });
    }

    const { admin: updatedAdmin, tokens } = await this.createLoginTokenResponse(
      admin,
      requestMeta,
    );

    await this.writeAuthAudit({
      adminId: updatedAdmin.id,
      action: "ADMIN_LOGIN_SUCCESS",
      status: AuditStatus.SUCCESS,
      requestMeta,
      metadata: {
        username: updatedAdmin.username,
        sessionId: tokens.sessionId,
      },
    });

    return {
      message: "Admin logged in successfully.",
      admin: this.toSafeAdmin(updatedAdmin),
      tokens: this.toPublicTokenResponse(tokens),
    };
  }

  async refresh(
    dto: RefreshAdminTokenDto,
    requestMeta?: RequestSecurityMeta,
  ): Promise<RefreshAdminTokenResponse> {
    const tokenHash = this.hashRefreshToken(dto.refreshToken);
    const existingToken = await this.prisma.adminRefreshToken.findUnique({
      where: { tokenHash },
      include: {
        session: true,
        admin: {
          select: this.safeAdminSelect(),
        },
      },
    });

    if (existingToken === null) {
      await this.writeAuthAudit({
        adminId: null,
        action: "ADMIN_REFRESH_FAILURE",
        status: AuditStatus.FAIL,
        requestMeta,
        metadata: { reason: "TOKEN_NOT_FOUND" },
      });
      throw new UnauthorizedException("Invalid or expired refresh token.");
    }

    if (existingToken.revokedAt !== null) {
      await this.revokeSessionForRefreshReplay(
        existingToken.adminId,
        existingToken.sessionId,
      );
      await this.writeAuthAudit({
        adminId: existingToken.adminId,
        action: "ADMIN_REFRESH_REPLAY",
        status: AuditStatus.FAIL,
        requestMeta,
        metadata: {
          reason: "REFRESH_TOKEN_REPLAY",
          sessionId: existingToken.sessionId,
        },
      });
      throw new UnauthorizedException("Invalid or expired refresh token.");
    }

    const now = new Date();
    if (
      existingToken.session === null ||
      existingToken.session.revokedAt !== null ||
      existingToken.session.expiresAt <= now ||
      existingToken.expiresAt <= now ||
      existingToken.admin.status !== AccountStatus.ACTIVE ||
      existingToken.admin.deletedAt !== null
    ) {
      await this.writeAuthAudit({
        adminId: existingToken.adminId,
        action: "ADMIN_REFRESH_FAILURE",
        status: AuditStatus.FAIL,
        requestMeta,
        metadata: {
          reason: "INVALID_REFRESH_SESSION",
          sessionId: existingToken.sessionId,
        },
      });
      throw new UnauthorizedException("Invalid or expired refresh token.");
    }

    const session = existingToken.session;
    const rawRefreshToken = this.generateRawRefreshToken();
    const newTokenHash = this.hashRefreshToken(rawRefreshToken);
    const expiresAt = this.getRefreshTokenExpiresAt(now);

    const rotation = await this.prisma.$transaction(
      async (tx) => {
        const claimed = await tx.adminRefreshToken.updateMany({
          where: {
            id: existingToken.id,
            adminId: existingToken.adminId,
            sessionId: session.id,
            revokedAt: null,
          },
          data: { revokedAt: now },
        });
        if (claimed.count !== 1) {
          return { status: "replay" as const, admin: null };
        }

        const [currentAdmin, currentSession] = await Promise.all([
          tx.adminUser.findUnique({
            where: { id: existingToken.adminId },
            select: this.safeAdminSelect(),
          }),
          tx.adminSession.findUnique({ where: { id: session.id } }),
        ]);
        if (
          currentAdmin === null ||
          currentAdmin.status !== AccountStatus.ACTIVE ||
          currentAdmin.deletedAt !== null ||
          currentSession === null ||
          currentSession.adminId !== existingToken.adminId ||
          currentSession.revokedAt !== null ||
          currentSession.expiresAt <= now
        ) {
          await tx.adminRefreshToken.updateMany({
            where: {
              adminId: existingToken.adminId,
              sessionId: session.id,
              revokedAt: null,
            },
            data: { revokedAt: now },
          });
          await tx.adminSession.updateMany({
            where: {
              id: session.id,
              adminId: existingToken.adminId,
              revokedAt: null,
            },
            data: { revokedAt: now, revokedReason: "ACCOUNT_STATE_CHANGED" },
          });
          return { status: "invalid" as const, admin: null };
        }

        await tx.adminSession.updateMany({
          where: {
            id: session.id,
            adminId: existingToken.adminId,
            revokedAt: null,
          },
          data: { lastUsedAt: now, expiresAt },
        });
        await tx.adminRefreshToken.create({
          data: {
            adminId: currentAdmin.id,
            sessionId: session.id,
            tokenHash: newTokenHash,
            expiresAt,
          },
        });
        return { status: "rotated" as const, admin: currentAdmin };
      },
      { isolationLevel: "Serializable" },
    );

    if (rotation.status === "replay") {
      await this.revokeSessionForRefreshReplay(
        existingToken.adminId,
        existingToken.sessionId,
      );
      await this.writeAuthAudit({
        adminId: existingToken.adminId,
        action: "ADMIN_REFRESH_REPLAY",
        status: AuditStatus.FAIL,
        requestMeta,
        metadata: {
          reason: "CONCURRENT_REFRESH_REPLAY",
          sessionId: existingToken.sessionId,
        },
      });
      throw new UnauthorizedException("Invalid or expired refresh token.");
    }

    if (rotation.status === "invalid" || rotation.admin === null) {
      throw new UnauthorizedException("Invalid or expired refresh token.");
    }

    const tokens: AdminTokenResponse = {
      accessToken: await this.createAccessToken(rotation.admin, session.id),
      refreshToken: rawRefreshToken,
      tokenType: "Bearer",
      expiresIn: this.getAccessTokenExpiresInSeconds(),
    };

    await this.writeAuthAudit({
      adminId: rotation.admin.id,
      action: "ADMIN_REFRESH_SUCCESS",
      status: AuditStatus.SUCCESS,
      requestMeta,
      metadata: {
        sessionId: session.id,
      },
    });

    return {
      message: "Admin session refreshed successfully.",
      admin: this.toSafeAdmin(rotation.admin),
      tokens,
    };
  }

  async logout(
    dto: LogoutAdminDto,
    adminId: string,
    sessionId: string,
    requestMeta?: RequestSecurityMeta,
  ): Promise<LogoutAdminResponse> {
    void dto.refreshToken;

    try {
      const revokedAt = new Date();

      await this.prisma.$transaction(async (tx) => {
        await tx.adminRefreshToken.updateMany({
          where: {
            adminId,
            sessionId,
            revokedAt: null,
          },
          data: {
            revokedAt,
          },
        });

        await tx.adminSession.updateMany({
          where: { id: sessionId, adminId, revokedAt: null },
          data: { revokedAt, revokedReason: "LOGOUT" },
        });
      });

      await this.writeAuthAudit({
        adminId,
        action: "ADMIN_LOGOUT_SUCCESS",
        status: AuditStatus.SUCCESS,
        requestMeta,
        metadata: {
          sessionId,
        },
      });
    } catch (error) {
      await this.writeAuthAudit({
        adminId,
        action: "ADMIN_LOGOUT_FAILURE",
        status: AuditStatus.FAIL,
        requestMeta,
        metadata: {
          sessionId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
      });
      throw error;
    }

    return {
      message: "Admin logged out successfully.",
    };
  }

  async changePassword(
    adminId: string,
    dto: ChangeAdminPasswordDto,
    requestMeta?: RequestSecurityMeta,
  ): Promise<ChangeAdminPasswordResponse> {
    if (!this.isChangePasswordSecretValid(dto.secretCode)) {
      await this.writeAuthAudit({
        adminId,
        action: "ADMIN_PASSWORD_CHANGE_FAILURE",
        status: AuditStatus.FAIL,
        requestMeta,
        metadata: { reason: "VERIFICATION_FAILED" },
      });
      throw new UnauthorizedException("Password change is not allowed.");
    }

    return this.changeOwnPasswordInternal(
      adminId,
      dto.oldPassword,
      dto.newPassword,
      requestMeta,
      false,
    );
  }

  async changeOwnPassword(
    adminId: string,
    dto: ChangeOwnAdminPasswordDto,
    requestMeta?: RequestSecurityMeta,
  ): Promise<ChangeAdminPasswordResponse> {
    return this.changeOwnPasswordInternal(
      adminId,
      dto.currentPassword,
      dto.newPassword,
      requestMeta,
      true,
    );
  }

  private async changeOwnPasswordInternal(
    adminId: string,
    currentPassword: string,
    newPassword: string,
    requestMeta?: RequestSecurityMeta,
    useStableCurrentPasswordError = false,
  ): Promise<ChangeAdminPasswordResponse> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminId },
      select: {
        ...this.safeAdminSelect(),
        passwordHash: true,
      },
    });

    if (
      admin === null ||
      admin.status !== AccountStatus.ACTIVE ||
      admin.deletedAt !== null
    ) {
      await this.writeAuthAudit({
        adminId,
        action: "ADMIN_PASSWORD_CHANGE_FAILURE",
        status: AuditStatus.FAIL,
        requestMeta,
        metadata: { reason: "ADMIN_NOT_ACTIVE" },
      });
      throw new UnauthorizedException("Unauthorized.");
    }

    const oldPasswordMatches = await this.credentials.comparePassword(
      currentPassword,
      admin.passwordHash,
    );
    if (!oldPasswordMatches) {
      await this.writeAuthAudit({
        adminId: admin.id,
        action: "ADMIN_PASSWORD_CHANGE_FAILURE",
        status: AuditStatus.FAIL,
        requestMeta,
        metadata: { reason: "VERIFICATION_FAILED" },
      });
      if (useStableCurrentPasswordError) {
        throw new ForbiddenException({
          statusCode: 403,
          message: "Current password is invalid.",
          error: "Forbidden",
          code: "ADMIN_CURRENT_PASSWORD_INVALID",
        });
      }
      throw new UnauthorizedException("Password change is not allowed.");
    }

    this.credentials.validateNewPassword({
      username: admin.username,
      currentPassword,
      newPassword,
    });
    const passwordHash = await this.credentials.hashPassword(newPassword);
    const revokedAt = new Date();

    await this.prisma.$transaction(
      async (tx) => {
        const current = await tx.adminUser.findUnique({
          where: { id: admin.id },
          select: { passwordHash: true, status: true, deletedAt: true },
        });
        if (
          current === null ||
          current.passwordHash !== admin.passwordHash ||
          current.status !== AccountStatus.ACTIVE ||
          current.deletedAt !== null
        ) {
          throw new UnauthorizedException("Unauthorized.");
        }

        await tx.adminUser.update({
          where: { id: admin.id },
          data: {
            passwordHash,
            mustChangePassword: false,
            passwordChangedAt: revokedAt,
            temporaryPasswordExpiresAt: null,
          },
        });

        await tx.adminRefreshToken.updateMany({
          where: { adminId: admin.id, revokedAt: null },
          data: { revokedAt },
        });

        const revokedSessions = await tx.adminSession.updateMany({
          where: { adminId: admin.id, revokedAt: null },
          data: { revokedAt, revokedReason: "PASSWORD_CHANGE" },
        });
        await tx.adminAuditLog.create({
          data: {
            adminId: admin.id,
            action: "ADMIN_PASSWORD_CHANGE_SUCCESS",
            module: "admin-auth",
            entityType: "AdminUser",
            entityId: admin.id,
            status: AuditStatus.SUCCESS,
            ipHash: this.getIpHash(requestMeta),
            userAgent: truncateRequestValue(requestMeta?.userAgent, 1024),
            metadataJson: this.toJsonInput({
              revokedSessionCount: revokedSessions.count,
            }),
          },
        });
      },
      { isolationLevel: "Serializable" },
    );

    return {
      message: "Password changed successfully. Please login again.",
    };
  }

  async listOwnSessions(
    adminId: string,
    currentSessionId: string,
  ): Promise<AdminOwnSessionListResponse> {
    const now = new Date();
    const sessions = await this.prisma.adminSession.findMany({
      where: { adminId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: [{ lastUsedAt: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
    });
    return {
      items: sessions.map((session) => ({
        ...session,
        isCurrent: session.id === currentSessionId,
      })),
    };
  }

  async revokeOwnSession(
    adminId: string,
    currentSessionId: string,
    sessionId: string,
  ): Promise<RevokeOwnAdminSessionResponse> {
    const revokedAt = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const target = await tx.adminSession.findFirst({
        where: { id: sessionId, adminId },
        select: { id: true },
      });
      if (target === null) {
        throw new NotFoundException({
          statusCode: 404,
          message: "Session not found.",
          error: "Not Found",
          code: "ADMIN_SESSION_NOT_FOUND",
        });
      }
      await tx.adminRefreshToken.updateMany({
        where: { adminId, sessionId, revokedAt: null },
        data: { revokedAt },
      });
      await tx.adminSession.updateMany({
        where: { id: sessionId, adminId, revokedAt: null },
        data: { revokedAt, revokedReason: "SELF_REVOKE" },
      });
      await tx.adminAuditLog.create({
        data: {
          adminId,
          action: "ADMIN_SESSION_REVOKE_SUCCESS",
          module: "admin-auth",
          entityType: "AdminSession",
          entityId: sessionId,
          status: AuditStatus.SUCCESS,
          metadataJson: this.toJsonInput({
            currentSession: sessionId === currentSessionId,
          }),
        },
      });
      return sessionId === currentSessionId;
    });
    return {
      message: "Session revoked successfully.",
      currentSessionRevoked: result,
    };
  }

  async getMe(adminId: string): Promise<MeAdminResponse> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminId },
      select: this.safeAdminSelect(),
    });

    if (
      admin === null ||
      admin.status !== AccountStatus.ACTIVE ||
      admin.deletedAt !== null
    ) {
      throw new UnauthorizedException("Unauthorized.");
    }

    return {
      admin: this.toSafeAdmin(admin),
    };
  }

  private isRegistrationEnabled(): boolean {
    const value = this.configService.get<string>("ADMIN_REGISTER_ENABLED");

    if (value === undefined || value.trim() === "") {
      return false;
    }

    return value.toLowerCase() !== "false" && value !== "0";
  }

  private async createInitialOwner(params: {
    username: string;
    passwordHash: string;
  }): Promise<AdminAuthRecord> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            if ((await tx.adminUser.count()) > 0) {
              throw new ConflictException("An admin account already exists.");
            }

            return tx.adminUser.create({
              data: {
                username: params.username,
                passwordHash: params.passwordHash,
                role: AdminRole.OWNER,
                status: AccountStatus.ACTIVE,
              },
              select: this.safeAdminSelect(),
            });
          },
          { isolationLevel: "Serializable" },
        );
      } catch (error) {
        if (this.isPrismaWriteConflict(error) && attempt < 3) {
          continue;
        }
        throw error;
      }
    }

    throw new ConflictException("An admin account already exists.");
  }

  private isPrismaWriteConflict(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "P2034"
    );
  }

  private isSecretCodeValid(secretCode: string): boolean {
    const configuredSecret = this.configService.get<string>(
      "ADMIN_REGISTER_SECRET",
    );

    if (configuredSecret === undefined || configuredSecret.trim() === "") {
      throw new InternalServerErrorException(
        "Admin registration is not configured.",
      );
    }

    const expected = this.digestSecret(configuredSecret.trim());
    const received = this.digestSecret(secretCode);

    return timingSafeEqual(expected, received);
  }

  private isChangePasswordSecretValid(secretCode: string): boolean {
    const configuredSecret = this.configService.get<string>(
      "ADMIN_CHANGE_PASSWORD_SECRET",
    );

    if (configuredSecret === undefined || configuredSecret.trim() === "") {
      throw new InternalServerErrorException(
        "Admin password change is not configured.",
      );
    }

    const expected = this.digestSecret(configuredSecret.trim());
    const received = this.digestSecret(secretCode);

    return timingSafeEqual(expected, received);
  }

  private digestSecret(value: string): Buffer {
    return createHash("sha256").update(value).digest();
  }

  private async createLoginTokenResponse(
    initialAdmin: AdminAuthRecord & { passwordHash: string },
    requestMeta?: RequestSecurityMeta,
  ): Promise<{ admin: AdminAuthRecord; tokens: InternalAdminTokenResponse }> {
    const now = new Date();
    const expiresAt = this.getRefreshTokenExpiresAt(now);
    const sessionId = randomUUID();
    const rawRefreshToken = this.generateRawRefreshToken();
    const tokenHash = this.hashRefreshToken(rawRefreshToken);

    const admin = await this.prisma.$transaction(
      async (tx) => {
        const current = await tx.adminUser.findUnique({
          where: { id: initialAdmin.id },
          select: {
            ...this.safeAdminSelect(),
            passwordHash: true,
          },
        });
        if (
          current === null ||
          current.passwordHash !== initialAdmin.passwordHash ||
          current.status !== AccountStatus.ACTIVE ||
          current.deletedAt !== null
        ) {
          return null;
        }
        if (
          current.mustChangePassword &&
          current.temporaryPasswordExpiresAt !== null &&
          current.temporaryPasswordExpiresAt <= now
        ) {
          throw new ForbiddenException({
            statusCode: 403,
            message: "Temporary password has expired.",
            error: "Forbidden",
            code: "ADMIN_TEMP_PASSWORD_EXPIRED",
          });
        }

        const updated = await tx.adminUser.update({
          where: { id: current.id },
          data: { lastLoginAt: now },
          select: this.safeAdminSelect(),
        });
        await tx.adminSession.create({
          data: {
            id: sessionId,
            adminId: current.id,
            expiresAt,
            lastUsedAt: now,
            ipHash: this.getIpHash(requestMeta),
            userAgentHash: this.getUserAgentHash(requestMeta),
            userAgent: truncateRequestValue(requestMeta?.userAgent, 512),
          },
        });
        await tx.adminRefreshToken.create({
          data: {
            adminId: current.id,
            sessionId,
            tokenHash,
            expiresAt,
          },
        });
        return updated;
      },
      { isolationLevel: "Serializable" },
    );

    if (admin === null) {
      throw new UnauthorizedException("Invalid username or password.");
    }

    let accessToken: string;
    try {
      accessToken = await this.createAccessToken(admin, sessionId);
    } catch (error) {
      await this.revokeSessionByOwner(
        admin.id,
        sessionId,
        "TOKEN_SIGN_FAILURE",
      );
      throw error;
    }

    return {
      admin,
      tokens: {
        accessToken,
        refreshToken: rawRefreshToken,
        tokenType: "Bearer",
        expiresIn: this.getAccessTokenExpiresInSeconds(),
        sessionId,
      },
    };
  }

  private async revokeSessionByOwner(
    adminId: string,
    sessionId: string,
    reason: string,
  ): Promise<void> {
    const revokedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.adminRefreshToken.updateMany({
        where: { adminId, sessionId, revokedAt: null },
        data: { revokedAt },
      }),
      this.prisma.adminSession.updateMany({
        where: { id: sessionId, adminId, revokedAt: null },
        data: { revokedAt, revokedReason: reason },
      }),
    ]);
  }

  private async createAccessToken(
    admin: AdminAuthRecord,
    sessionId: string,
  ): Promise<string> {
    const payload: AdminAccessTokenPayload = {
      sub: admin.id,
      sid: sessionId,
      jti: randomUUID(),
      username: admin.username,
      role: admin.role,
      type: "admin_access",
    };

    return this.jwtService.signAsync(payload, {
      secret: this.configService.getOrThrow<string>("JWT_ACCESS_SECRET"),
      expiresIn: this.getAccessTokenExpiresInSeconds(),
    });
  }

  private generateRawRefreshToken(): string {
    return randomBytes(this.getRefreshTokenBytes()).toString("base64url");
  }

  private hashRefreshToken(rawToken: string): string {
    const pepper = this.configService.getOrThrow<string>(
      "REFRESH_TOKEN_PEPPER",
    );

    return createHash("sha256").update(`${pepper}${rawToken}`).digest("hex");
  }

  private getAccessTokenExpiresInSeconds(): number {
    const value =
      this.configService.get<string>("JWT_ACCESS_EXPIRES_IN") ?? "15m";
    const match = /^(\d+)([smhd])?$/.exec(value.trim());

    if (match === null) {
      return 900;
    }

    const amount = Number(match[1]);
    const unit = match[2] ?? "s";
    const multipliers: Record<"s" | "m" | "h" | "d", number> = {
      s: 1,
      m: 60,
      h: 60 * 60,
      d: 24 * 60 * 60,
    };

    if (unit !== "s" && unit !== "m" && unit !== "h" && unit !== "d") {
      return 900;
    }

    return amount * multipliers[unit];
  }

  private getRefreshTokenBytes(): number {
    const value = Number(
      this.configService.get<string>("REFRESH_TOKEN_BYTES") ?? "32",
    );

    if (!Number.isInteger(value) || value < 32) {
      return 32;
    }

    return value;
  }

  private getRefreshTokenExpiresAt(from: Date = new Date()): Date {
    const value = Number(
      this.configService.get<string>("REFRESH_TOKEN_EXPIRES_DAYS") ?? "30",
    );
    const days = Number.isInteger(value) && value > 0 ? value : 30;
    const expiresAt = new Date(from.getTime());
    expiresAt.setDate(expiresAt.getDate() + days);

    return expiresAt;
  }

  private toPublicTokenResponse(
    tokens: InternalAdminTokenResponse,
  ): AdminTokenResponse {
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenType: tokens.tokenType,
      expiresIn: tokens.expiresIn,
    };
  }

  private safeAdminSelect() {
    return {
      id: true,
      username: true,
      role: true,
      status: true,
      createdAt: true,
      lastLoginAt: true,
      mustChangePassword: true,
      temporaryPasswordExpiresAt: true,
      deletedAt: true,
    } as const;
  }

  private toSafeAdmin(admin: AdminAuthRecord): SafeAdminResponse {
    return {
      id: admin.id,
      username: admin.username,
      role: admin.role,
      status: admin.status,
      createdAt: admin.createdAt,
      lastLoginAt: admin.lastLoginAt,
      mustChangePassword: admin.mustChangePassword,
    };
  }

  private async revokeSessionForRefreshReplay(
    adminId: string,
    sessionId: string | null,
  ): Promise<void> {
    if (sessionId === null) {
      return;
    }

    const revokedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.adminRefreshToken.updateMany({
        where: { adminId, sessionId, revokedAt: null },
        data: { revokedAt },
      });
      await tx.adminSession.updateMany({
        where: { id: sessionId, adminId, revokedAt: null },
        data: { revokedAt, revokedReason: "REFRESH_REPLAY" },
      });
    });
  }

  private async writeAuthAudit(params: {
    adminId: string | null;
    action: AdminAuthAuditAction;
    status: AuditStatus;
    metadata: Record<string, unknown>;
    requestMeta?: RequestSecurityMeta | undefined;
  }): Promise<void> {
    const userAgent = truncateRequestValue(params.requestMeta?.userAgent, 1024);

    try {
      await this.prisma.adminAuditLog.create({
        data: {
          adminId: params.adminId,
          action: params.action,
          module: "admin-auth",
          entityType: params.adminId === null ? null : "AdminUser",
          entityId: params.adminId,
          status: params.status,
          ipHash: this.getIpHash(params.requestMeta),
          userAgent,
          metadataJson: this.toJsonInput(params.metadata),
        },
      });
    } catch (error) {
      this.logger.warn(
        {
          action: params.action,
          adminId: params.adminId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "Admin auth audit log write failed.",
      );
    }
  }

  private getIpHash(meta: RequestSecurityMeta | undefined): string | null {
    return hashSensitiveValue({
      value: meta?.ip,
      pepper: this.configService.get<string>("ACCESS_LOG_IP_PEPPER"),
    });
  }

  private getUserAgentHash(
    meta: RequestSecurityMeta | undefined,
  ): string | null {
    return hashSensitiveValue({
      value: meta?.userAgent,
      pepper: this.configService.get<string>("ACCESS_LOG_IP_PEPPER"),
    });
  }

  private toJsonInput(value: Record<string, unknown>): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
  }
}

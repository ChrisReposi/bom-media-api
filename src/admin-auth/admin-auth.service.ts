import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { compare, hash } from "bcryptjs";
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
  type AdminSession,
  AuditStatus,
} from "../generated/prisma/client";
import type { ChangeAdminPasswordDto } from "./dto/change-admin-password.dto";
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
} from "./types/admin-auth-response.type";
import type { AdminAccessTokenPayload } from "./types/admin-token-payload.type";

type AdminAuthRecord = {
  id: string;
  username: string;
  role: AdminRole;
  status: AccountStatus;
  createdAt: Date;
  lastLoginAt: Date | null;
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
  | "ADMIN_PASSWORD_CHANGE_FAILURE";

type InternalAdminTokenResponse = AdminTokenResponse & {
  sessionId: string;
};

const PASSWORD_HASH_ROUNDS = 12;

@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  async register(dto: RegisterAdminDto): Promise<RegisterAdminResponse> {
    if (!this.isRegistrationEnabled()) {
      throw new ForbiddenException("Admin registration is disabled.");
    }

    if (!this.isSecretCodeValid(dto.secretCode)) {
      throw new ForbiddenException("Admin registration is not allowed.");
    }

    const existingAdminCount = await this.prisma.adminUser.count();
    if (existingAdminCount > 0) {
      throw new ConflictException("An admin account already exists.");
    }

    const username = this.normalizeUsername(dto.username);
    const passwordHash = await hash(dto.password, PASSWORD_HASH_ROUNDS);

    const admin = await this.prisma.adminUser.create({
      data: {
        username,
        passwordHash,
        role: AdminRole.OWNER,
        status: AccountStatus.ACTIVE,
      },
      select: this.safeAdminSelect(),
    });

    return {
      message: "Admin registered successfully.",
      admin: this.toSafeAdmin(admin),
    };
  }

  async login(
    dto: LoginAdminDto,
    requestMeta?: RequestSecurityMeta,
  ): Promise<LoginAdminResponse> {
    const username = this.normalizeUsername(dto.username);
    const admin = await this.prisma.adminUser.findUnique({
      where: { username },
      select: {
        ...this.safeAdminSelect(),
        passwordHash: true,
      },
    });

    if (admin === null || admin.status !== AccountStatus.ACTIVE) {
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

    const passwordMatches = await compare(dto.password, admin.passwordHash);
    if (!passwordMatches) {
      await this.writeAuthAudit({
        adminId: admin.id,
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

    const updatedAdmin = await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
      select: this.safeAdminSelect(),
    });

    const tokens = await this.buildTokenResponse(updatedAdmin, requestMeta);

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
      await this.revokeSessionForRefreshReplay(existingToken.sessionId);
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
      existingToken.admin.status !== AccountStatus.ACTIVE
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

    await this.prisma.$transaction(async (tx) => {
      await tx.adminRefreshToken.update({
        where: { id: existingToken.id },
        data: { revokedAt: now },
      });

      await tx.adminSession.update({
        where: { id: session.id },
        data: {
          lastUsedAt: now,
          expiresAt,
        },
      });

      await tx.adminRefreshToken.create({
        data: {
          adminId: existingToken.admin.id,
          sessionId: session.id,
          tokenHash: newTokenHash,
          expiresAt,
        },
      });
    });

    const tokens: AdminTokenResponse = {
      accessToken: await this.createAccessToken(
        existingToken.admin,
        session.id,
      ),
      refreshToken: rawRefreshToken,
      tokenType: "Bearer",
      expiresIn: this.getAccessTokenExpiresInSeconds(),
    };

    await this.writeAuthAudit({
      adminId: existingToken.admin.id,
      action: "ADMIN_REFRESH_SUCCESS",
      status: AuditStatus.SUCCESS,
      requestMeta,
      metadata: {
        sessionId: session.id,
      },
    });

    return {
      message: "Admin session refreshed successfully.",
      admin: this.toSafeAdmin(existingToken.admin),
      tokens,
    };
  }

  async logout(
    dto: LogoutAdminDto,
    requestMeta?: RequestSecurityMeta,
  ): Promise<LogoutAdminResponse> {
    const tokenHash = this.hashRefreshToken(dto.refreshToken);
    const existingToken = await this.prisma.adminRefreshToken.findUnique({
      where: { tokenHash },
      select: {
        adminId: true,
        sessionId: true,
      },
    });

    try {
      const revokedAt = new Date();

      await this.prisma.$transaction(async (tx) => {
        await tx.adminRefreshToken.updateMany({
          where: {
            tokenHash,
            revokedAt: null,
          },
          data: {
            revokedAt,
          },
        });

        if (existingToken?.sessionId !== null && existingToken?.sessionId) {
          await tx.adminSession.updateMany({
            where: {
              id: existingToken.sessionId,
              revokedAt: null,
            },
            data: {
              revokedAt,
              revokedReason: "LOGOUT",
            },
          });
        }
      });

      await this.writeAuthAudit({
        adminId: existingToken?.adminId ?? null,
        action: "ADMIN_LOGOUT_SUCCESS",
        status: AuditStatus.SUCCESS,
        requestMeta,
        metadata: {
          sessionId: existingToken?.sessionId ?? null,
        },
      });
    } catch (error) {
      await this.writeAuthAudit({
        adminId: existingToken?.adminId ?? null,
        action: "ADMIN_LOGOUT_FAILURE",
        status: AuditStatus.FAIL,
        requestMeta,
        metadata: {
          sessionId: existingToken?.sessionId ?? null,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
      });
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
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminId },
      select: {
        ...this.safeAdminSelect(),
        passwordHash: true,
      },
    });

    if (admin === null || admin.status !== AccountStatus.ACTIVE) {
      await this.writeAuthAudit({
        adminId,
        action: "ADMIN_PASSWORD_CHANGE_FAILURE",
        status: AuditStatus.FAIL,
        requestMeta,
        metadata: { reason: "ADMIN_NOT_ACTIVE" },
      });
      throw new UnauthorizedException("Unauthorized.");
    }

    const oldPasswordMatches = await compare(
      dto.oldPassword,
      admin.passwordHash,
    );
    const secretMatches = this.isChangePasswordSecretValid(dto.secretCode);
    if (!oldPasswordMatches || !secretMatches) {
      await this.writeAuthAudit({
        adminId: admin.id,
        action: "ADMIN_PASSWORD_CHANGE_FAILURE",
        status: AuditStatus.FAIL,
        requestMeta,
        metadata: { reason: "VERIFICATION_FAILED" },
      });
      throw new UnauthorizedException("Password change is not allowed.");
    }

    if (dto.newPassword === dto.oldPassword) {
      await this.writeAuthAudit({
        adminId: admin.id,
        action: "ADMIN_PASSWORD_CHANGE_FAILURE",
        status: AuditStatus.FAIL,
        requestMeta,
        metadata: { reason: "PASSWORD_REUSED" },
      });
      throw new BadRequestException(
        "New password must differ from old password.",
      );
    }

    const passwordHash = await hash(dto.newPassword, PASSWORD_HASH_ROUNDS);
    const revokedAt = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.adminUser.update({
        where: { id: admin.id },
        data: { passwordHash },
      });

      await tx.adminRefreshToken.updateMany({
        where: {
          adminId: admin.id,
          revokedAt: null,
        },
        data: { revokedAt },
      });

      await tx.adminSession.updateMany({
        where: {
          adminId: admin.id,
          revokedAt: null,
        },
        data: {
          revokedAt,
          revokedReason: "PASSWORD_CHANGE",
        },
      });
    });

    await this.writeAuthAudit({
      adminId: admin.id,
      action: "ADMIN_PASSWORD_CHANGE_SUCCESS",
      status: AuditStatus.SUCCESS,
      requestMeta,
      metadata: {
        sessionsRevokedAt: revokedAt.toISOString(),
      },
    });

    return {
      message: "Password changed successfully. Please login again.",
    };
  }

  async getMe(adminId: string): Promise<MeAdminResponse> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminId },
      select: this.safeAdminSelect(),
    });

    if (admin === null || admin.status !== AccountStatus.ACTIVE) {
      throw new UnauthorizedException("Unauthorized.");
    }

    return {
      admin: this.toSafeAdmin(admin),
    };
  }

  private isRegistrationEnabled(): boolean {
    const value = this.configService.get<string>("ADMIN_REGISTER_ENABLED");

    if (value === undefined || value.trim() === "") {
      return true;
    }

    return value.toLowerCase() !== "false" && value !== "0";
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

  private async buildTokenResponse(
    admin: AdminAuthRecord,
    requestMeta?: RequestSecurityMeta,
  ): Promise<InternalAdminTokenResponse> {
    const now = new Date();
    const expiresAt = this.getRefreshTokenExpiresAt(now);
    const session = await this.createAdminSession({
      adminId: admin.id,
      expiresAt,
      requestMeta,
    });

    return {
      accessToken: await this.createAccessToken(admin, session.id),
      refreshToken: await this.createRefreshToken(
        admin.id,
        session.id,
        expiresAt,
      ),
      tokenType: "Bearer",
      expiresIn: this.getAccessTokenExpiresInSeconds(),
      sessionId: session.id,
    };
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

  private async createRefreshToken(
    adminId: string,
    sessionId: string,
    expiresAt: Date,
  ): Promise<string> {
    const rawRefreshToken = this.generateRawRefreshToken();

    await this.prisma.adminRefreshToken.create({
      data: {
        adminId,
        sessionId,
        tokenHash: this.hashRefreshToken(rawRefreshToken),
        expiresAt,
      },
    });

    return rawRefreshToken;
  }

  private async createAdminSession(params: {
    adminId: string;
    expiresAt: Date;
    requestMeta?: RequestSecurityMeta | undefined;
  }): Promise<AdminSession> {
    return this.prisma.adminSession.create({
      data: {
        adminId: params.adminId,
        expiresAt: params.expiresAt,
        lastUsedAt: new Date(),
        ipHash: this.getIpHash(params.requestMeta),
        userAgentHash: this.getUserAgentHash(params.requestMeta),
        userAgent: truncateRequestValue(params.requestMeta?.userAgent, 512),
      },
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

  private normalizeUsername(username: string): string {
    return username.trim().toLowerCase();
  }

  private safeAdminSelect() {
    return {
      id: true,
      username: true,
      role: true,
      status: true,
      createdAt: true,
      lastLoginAt: true,
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
    };
  }

  private async revokeSessionForRefreshReplay(
    sessionId: string | null,
  ): Promise<void> {
    if (sessionId === null) {
      return;
    }

    await this.prisma.adminSession.updateMany({
      where: {
        id: sessionId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
        revokedReason: "REFRESH_REPLAY",
      },
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

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
import { hash, verify } from "argon2";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import {
  AccountStatus,
  AdminRole,
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
    const passwordHash = await hash(dto.password);

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

  async login(dto: LoginAdminDto): Promise<LoginAdminResponse> {
    const username = this.normalizeUsername(dto.username);
    const admin = await this.prisma.adminUser.findUnique({
      where: { username },
      select: {
        ...this.safeAdminSelect(),
        passwordHash: true,
      },
    });

    if (admin === null || admin.status !== AccountStatus.ACTIVE) {
      throw new UnauthorizedException("Invalid username or password.");
    }

    const passwordMatches = await verify(admin.passwordHash, dto.password);
    if (!passwordMatches) {
      throw new UnauthorizedException("Invalid username or password.");
    }

    const updatedAdmin = await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
      select: this.safeAdminSelect(),
    });

    return {
      message: "Admin logged in successfully.",
      admin: this.toSafeAdmin(updatedAdmin),
      tokens: await this.buildTokenResponse(updatedAdmin),
    };
  }

  async refresh(dto: RefreshAdminTokenDto): Promise<RefreshAdminTokenResponse> {
    const tokenHash = this.hashRefreshToken(dto.refreshToken);
    const existingToken = await this.prisma.adminRefreshToken.findUnique({
      where: { tokenHash },
      include: {
        admin: {
          select: this.safeAdminSelect(),
        },
      },
    });

    if (
      existingToken === null ||
      existingToken.revokedAt !== null ||
      existingToken.expiresAt <= new Date() ||
      existingToken.admin.status !== AccountStatus.ACTIVE
    ) {
      throw new UnauthorizedException("Invalid or expired refresh token.");
    }

    const rawRefreshToken = this.generateRawRefreshToken();
    const newTokenHash = this.hashRefreshToken(rawRefreshToken);
    const expiresAt = this.getRefreshTokenExpiresAt();

    await this.prisma.$transaction(async (tx) => {
      await tx.adminRefreshToken.update({
        where: { id: existingToken.id },
        data: { revokedAt: new Date() },
      });

      await tx.adminRefreshToken.create({
        data: {
          adminId: existingToken.admin.id,
          tokenHash: newTokenHash,
          expiresAt,
        },
      });
    });

    return {
      message: "Admin session refreshed successfully.",
      admin: this.toSafeAdmin(existingToken.admin),
      tokens: {
        accessToken: await this.createAccessToken(existingToken.admin),
        refreshToken: rawRefreshToken,
        tokenType: "Bearer",
        expiresIn: this.getAccessTokenExpiresInSeconds(),
      },
    };
  }

  async logout(dto: LogoutAdminDto): Promise<LogoutAdminResponse> {
    const tokenHash = this.hashRefreshToken(dto.refreshToken);

    await this.prisma.adminRefreshToken.updateMany({
      where: {
        tokenHash,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });

    return {
      message: "Admin logged out successfully.",
    };
  }

  async changePassword(
    adminId: string,
    dto: ChangeAdminPasswordDto,
  ): Promise<ChangeAdminPasswordResponse> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminId },
      select: {
        ...this.safeAdminSelect(),
        passwordHash: true,
      },
    });

    if (admin === null || admin.status !== AccountStatus.ACTIVE) {
      throw new UnauthorizedException("Unauthorized.");
    }

    const oldPasswordMatches = await verify(
      admin.passwordHash,
      dto.oldPassword,
    );
    const secretMatches = this.isChangePasswordSecretValid(dto.secretCode);
    if (!oldPasswordMatches || !secretMatches) {
      throw new UnauthorizedException("Password change is not allowed.");
    }

    if (dto.newPassword === dto.oldPassword) {
      throw new BadRequestException(
        "New password must differ from old password.",
      );
    }

    const passwordHash = await hash(dto.newPassword);
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
    });

    await this.writeAudit(admin.id, "ADMIN_PASSWORD_CHANGE", {
      refreshTokensRevokedAt: revokedAt.toISOString(),
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
  ): Promise<AdminTokenResponse> {
    return {
      accessToken: await this.createAccessToken(admin),
      refreshToken: await this.createRefreshToken(admin.id),
      tokenType: "Bearer",
      expiresIn: this.getAccessTokenExpiresInSeconds(),
    };
  }

  private async createAccessToken(admin: AdminAuthRecord): Promise<string> {
    const payload: AdminAccessTokenPayload = {
      sub: admin.id,
      username: admin.username,
      role: admin.role,
      type: "admin_access",
    };

    return this.jwtService.signAsync(payload, {
      secret: this.configService.getOrThrow<string>("JWT_ACCESS_SECRET"),
      expiresIn: this.getAccessTokenExpiresInSeconds(),
    });
  }

  private async createRefreshToken(adminId: string): Promise<string> {
    const rawRefreshToken = this.generateRawRefreshToken();

    await this.prisma.adminRefreshToken.create({
      data: {
        adminId,
        tokenHash: this.hashRefreshToken(rawRefreshToken),
        expiresAt: this.getRefreshTokenExpiresAt(),
      },
    });

    return rawRefreshToken;
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

  private getRefreshTokenExpiresAt(): Date {
    const value = Number(
      this.configService.get<string>("REFRESH_TOKEN_EXPIRES_DAYS") ?? "30",
    );
    const days = Number.isInteger(value) && value > 0 ? value : 30;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);

    return expiresAt;
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

  private async writeAudit(
    adminId: string,
    action: "ADMIN_PASSWORD_CHANGE",
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.adminAuditLog.create({
        data: {
          adminId,
          action,
          module: "admin-auth",
          entityType: "AdminUser",
          entityId: adminId,
          status: AuditStatus.SUCCESS,
          metadataJson: this.toJsonInput(metadata),
        },
      });
    } catch (error) {
      this.logger.warn(
        {
          action,
          adminId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "Admin auth audit log write failed.",
      );
    }
  }

  private toJsonInput(value: Record<string, unknown>): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
  }
}

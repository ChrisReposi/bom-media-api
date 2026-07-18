import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Reflector } from "@nestjs/core";
import { PrismaService } from "../../database/prisma.service";
import { AccountStatus } from "../../generated/prisma/client";
import type { SafeAdminResponse } from "../types/admin-auth-response.type";
import type { AdminAuthRequest } from "../types/admin-auth-request.type";
import type { AdminAccessTokenPayload } from "../types/admin-token-payload.type";
import { ALLOW_PASSWORD_CHANGE_REQUIRED_METADATA } from "../decorators/allow-password-change-required.decorator";
import { ForbiddenException } from "@nestjs/common";

@Injectable()
export class AdminAccessTokenGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminAuthRequest>();
    const token = this.extractBearerToken(request.headers.authorization);

    if (token === null) {
      throw new UnauthorizedException("Unauthorized.");
    }

    const payload = await this.verifyToken(token);
    if (!this.isValidAccessTokenPayload(payload)) {
      throw new UnauthorizedException("Unauthorized.");
    }

    const session = await this.prisma.adminSession.findUnique({
      where: { id: payload.sid },
      include: {
        admin: {
          select: {
            id: true,
            username: true,
            role: true,
            status: true,
            createdAt: true,
            lastLoginAt: true,
            mustChangePassword: true,
            deletedAt: true,
          },
        },
      },
    });

    if (
      session === null ||
      session.adminId !== payload.sub ||
      session.revokedAt !== null ||
      session.expiresAt <= new Date() ||
      session.admin.status !== AccountStatus.ACTIVE ||
      session.admin.deletedAt !== null
    ) {
      throw new UnauthorizedException("Unauthorized.");
    }

    const allowPasswordChangeRequired =
      this.reflector.getAllAndOverride<boolean>(
        ALLOW_PASSWORD_CHANGE_REQUIRED_METADATA,
        [context.getHandler(), context.getClass()],
      ) ?? false;
    if (session.admin.mustChangePassword && !allowPasswordChangeRequired) {
      throw new ForbiddenException({
        statusCode: 403,
        message: "Password change is required before continuing.",
        error: "Forbidden",
        code: "ADMIN_PASSWORD_CHANGE_REQUIRED",
      });
    }

    await this.touchSession(session.id, session.lastUsedAt);

    request.admin = this.toSafeAdmin(session.admin);
    request.adminAccessTokenPayload = payload;

    return true;
  }

  private extractBearerToken(
    authorization: string | string[] | undefined,
  ): string | null {
    if (typeof authorization !== "string") {
      return null;
    }

    const [scheme, token] = authorization.split(" ");
    if (scheme !== "Bearer" || token === undefined || token.trim() === "") {
      return null;
    }

    return token.trim();
  }

  private async verifyToken(token: string): Promise<AdminAccessTokenPayload> {
    try {
      return await this.jwtService.verifyAsync<AdminAccessTokenPayload>(token, {
        secret: this.configService.getOrThrow<string>("JWT_ACCESS_SECRET"),
      });
    } catch {
      throw new UnauthorizedException("Unauthorized.");
    }
  }

  private isValidAccessTokenPayload(payload: AdminAccessTokenPayload): boolean {
    return (
      payload.type === "admin_access" &&
      typeof payload.sub === "string" &&
      payload.sub.trim() !== "" &&
      typeof payload.sid === "string" &&
      payload.sid.trim() !== "" &&
      typeof payload.jti === "string" &&
      payload.jti.trim() !== ""
    );
  }

  private async touchSession(
    sessionId: string,
    lastUsedAt: Date | null,
  ): Promise<void> {
    const now = new Date();
    const lastUsedAtMs = lastUsedAt?.getTime() ?? 0;

    if (now.getTime() - lastUsedAtMs < 60_000) {
      return;
    }

    await this.prisma.adminSession.updateMany({
      where: {
        id: sessionId,
        revokedAt: null,
      },
      data: {
        lastUsedAt: now,
      },
    });
  }

  private toSafeAdmin(admin: SafeAdminResponse): SafeAdminResponse {
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
}

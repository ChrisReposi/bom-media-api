import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../../database/prisma.service";
import { AccountStatus } from "../../generated/prisma/client";
import type { SafeAdminResponse } from "../types/admin-auth-response.type";
import type { AdminAuthRequest } from "../types/admin-auth-request.type";
import type { AdminAccessTokenPayload } from "../types/admin-token-payload.type";

@Injectable()
export class AdminAccessTokenGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminAuthRequest>();
    const token = this.extractBearerToken(request.headers.authorization);

    if (token === null) {
      throw new UnauthorizedException("Unauthorized.");
    }

    const payload = await this.verifyToken(token);
    if (
      payload.type !== "admin_access" ||
      typeof payload.sub !== "string" ||
      payload.sub.trim() === ""
    ) {
      throw new UnauthorizedException("Unauthorized.");
    }

    const admin = await this.prisma.adminUser.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        username: true,
        role: true,
        status: true,
        createdAt: true,
        lastLoginAt: true,
      },
    });

    if (admin === null || admin.status !== AccountStatus.ACTIVE) {
      throw new UnauthorizedException("Unauthorized.");
    }

    request.admin = this.toSafeAdmin(admin);
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

  private toSafeAdmin(admin: SafeAdminResponse): SafeAdminResponse {
    return {
      id: admin.id,
      username: admin.username,
      role: admin.role,
      status: admin.status,
      createdAt: admin.createdAt,
      lastLoginAt: admin.lastLoginAt,
    };
  }
}

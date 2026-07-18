import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "../../generated/prisma/client";
import { ADMIN_ROLES_METADATA } from "../decorators/admin-roles.decorator";
import type { AdminAuthRequest } from "../types/admin-auth-request.type";

@Injectable()
export class AdminRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AdminAuthRequest>();
    const admin = request.admin;
    if (admin === undefined) {
      throw new ForbiddenException("Forbidden.");
    }

    const configuredRoles = this.reflector.getAllAndOverride<AdminRole[]>(
      ADMIN_ROLES_METADATA,
      [context.getHandler(), context.getClass()],
    );
    // Missing role metadata is denied so newly added admin routes cannot gain
    // access accidentally from their HTTP method alone.
    const allowedRoles = configuredRoles ?? [];

    if (!allowedRoles.includes(admin.role)) {
      throw new ForbiddenException("Forbidden.");
    }

    return true;
  }
}

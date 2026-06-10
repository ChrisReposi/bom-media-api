import { createParamDecorator, UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { SafeAdminResponse } from "../types/admin-auth-response.type";
import type { AdminAuthRequest } from "../types/admin-auth-request.type";

export const CurrentAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SafeAdminResponse => {
    const request = context.switchToHttp().getRequest<AdminAuthRequest>();

    if (request.admin === undefined) {
      throw new UnauthorizedException("Unauthorized.");
    }

    return request.admin;
  },
);

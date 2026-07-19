import { createParamDecorator, UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { AdminAuthRequest } from "../types/admin-auth-request.type";

export const CurrentAdminSessionId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<AdminAuthRequest>();
    const sessionId = request.adminAccessTokenPayload?.sid;

    if (typeof sessionId !== "string" || sessionId.trim() === "") {
      throw new UnauthorizedException("Unauthorized.");
    }

    return sessionId;
  },
);

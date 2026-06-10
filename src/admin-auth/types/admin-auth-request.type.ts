import type { Request } from "express";
import type { SafeAdminResponse } from "./admin-auth-response.type";
import type { AdminAccessTokenPayload } from "./admin-token-payload.type";

export type AdminAuthRequest = Request & {
  admin?: SafeAdminResponse;
  adminAccessTokenPayload?: AdminAccessTokenPayload;
};

import type { AdminRole } from "../../generated/prisma/client";

export type AdminAccessTokenPayload = {
  sub: string;
  sid: string;
  jti: string;
  username: string;
  role: AdminRole;
  type: "admin_access";
};

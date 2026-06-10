import type { AdminRole } from "../../generated/prisma/client";

export type AdminAccessTokenPayload = {
  sub: string;
  username: string;
  role: AdminRole;
  type: "admin_access";
};

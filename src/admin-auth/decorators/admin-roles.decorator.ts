import { SetMetadata } from "@nestjs/common";
import { AdminRole } from "../../generated/prisma/client";

export const ADMIN_ROLES_METADATA = "admin_roles";

export const AdminRoles = (
  ...roles: AdminRole[]
): MethodDecorator & ClassDecorator => SetMetadata(ADMIN_ROLES_METADATA, roles);

export const AdminReadRoles = (): MethodDecorator =>
  AdminRoles(AdminRole.OWNER, AdminRole.ADMIN, AdminRole.STAFF);

export const AdminWriteRoles = (): MethodDecorator =>
  AdminRoles(AdminRole.OWNER, AdminRole.ADMIN);

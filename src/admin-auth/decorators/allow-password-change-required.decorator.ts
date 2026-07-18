import { SetMetadata } from "@nestjs/common";

export const ALLOW_PASSWORD_CHANGE_REQUIRED_METADATA =
  "admin_allow_password_change_required";

export const AllowPasswordChangeRequired = (): MethodDecorator =>
  SetMetadata(ALLOW_PASSWORD_CHANGE_REQUIRED_METADATA, true);

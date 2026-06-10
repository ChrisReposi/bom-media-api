import { ApiProperty } from "@nestjs/swagger";
import { AccountStatus, AdminRole } from "../../generated/prisma/client";

export class SafeAdminResponse {
  @ApiProperty({
    example: "cm_admin_123",
  })
  id!: string;

  @ApiProperty({
    example: "adminboss",
  })
  username!: string;

  @ApiProperty({
    enum: AdminRole,
    example: AdminRole.OWNER,
  })
  role!: AdminRole;

  @ApiProperty({
    enum: AccountStatus,
    example: AccountStatus.ACTIVE,
  })
  status!: AccountStatus;

  @ApiProperty({
    example: "2026-05-30T00:00:00.000Z",
  })
  createdAt!: Date;

  @ApiProperty({
    example: "2026-05-30T00:00:00.000Z",
    nullable: true,
  })
  lastLoginAt!: Date | null;
}

export class RegisterAdminResponse {
  @ApiProperty({
    example: "Admin registered successfully.",
  })
  message!: string;

  @ApiProperty({
    type: SafeAdminResponse,
  })
  admin!: SafeAdminResponse;
}

export class AdminTokenResponse {
  @ApiProperty({
    example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  })
  accessToken!: string;

  @ApiProperty({
    example: "opaque-refresh-token-value",
  })
  refreshToken!: string;

  @ApiProperty({
    example: "Bearer",
  })
  tokenType!: "Bearer";

  @ApiProperty({
    example: 900,
  })
  expiresIn!: number;
}

export class LoginAdminResponse {
  @ApiProperty({
    example: "Admin logged in successfully.",
  })
  message!: string;

  @ApiProperty({
    type: SafeAdminResponse,
  })
  admin!: SafeAdminResponse;

  @ApiProperty({
    type: AdminTokenResponse,
  })
  tokens!: AdminTokenResponse;
}

export class RefreshAdminTokenResponse {
  @ApiProperty({
    example: "Admin session refreshed successfully.",
  })
  message!: string;

  @ApiProperty({
    type: SafeAdminResponse,
  })
  admin!: SafeAdminResponse;

  @ApiProperty({
    type: AdminTokenResponse,
  })
  tokens!: AdminTokenResponse;
}

export class LogoutAdminResponse {
  @ApiProperty({
    example: "Admin logged out successfully.",
  })
  message!: string;
}

export class ChangeAdminPasswordResponse {
  @ApiProperty({
    example: "Password changed successfully. Please login again.",
  })
  message!: string;
}

export class MeAdminResponse {
  @ApiProperty({
    type: SafeAdminResponse,
  })
  admin!: SafeAdminResponse;
}

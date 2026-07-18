import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { AccountStatus, AdminRole } from "../../generated/prisma/client";

export class ManagedAdminAccountResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  username!: string;

  @ApiProperty({ enum: AdminRole })
  role!: AdminRole;

  @ApiProperty({ enum: AccountStatus })
  status!: AccountStatus;

  @ApiProperty()
  mustChangePassword!: boolean;

  @ApiProperty()
  activeSessionCount!: number;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;

  @ApiPropertyOptional({ nullable: true })
  lastLoginAt!: Date | null;

  @ApiPropertyOptional({ nullable: true })
  temporaryPasswordExpiresAt!: Date | null;

  @ApiPropertyOptional({ nullable: true })
  deletedAt!: Date | null;
}

export class ManagedAdminAccountListResponse {
  @ApiProperty({ type: [ManagedAdminAccountResponse] })
  items!: ManagedAdminAccountResponse[];

  @ApiProperty()
  meta!: { page: number; limit: number; total: number; totalPages: number };
}

export class TemporaryAdminPasswordResponse {
  @ApiProperty({ type: ManagedAdminAccountResponse })
  account!: ManagedAdminAccountResponse;

  @ApiProperty({ description: "Returned once and never stored as plaintext." })
  temporaryPassword!: string;
}

export class AdminAccountMutationResponse {
  @ApiProperty()
  message!: string;

  @ApiPropertyOptional({ type: ManagedAdminAccountResponse })
  account?: ManagedAdminAccountResponse;

  @ApiPropertyOptional()
  revokedSessionCount?: number;
}

import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { AccountStatus, AdminRole } from "../../generated/prisma/client";

const normalizeSearch = ({ value }: { value: unknown }): unknown =>
  typeof value === "string"
    ? value.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase()
    : value;

export class ListAdminAccountsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @Transform(normalizeSearch)
  @IsString()
  @MaxLength(80)
  search?: string;

  @IsOptional()
  @IsEnum(AdminRole)
  role?: AdminRole;

  @IsOptional()
  @IsEnum(AccountStatus)
  status?: AccountStatus;

  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  includeDeleted?: boolean = false;

  @IsOptional()
  @IsIn(["createdAt", "username", "role", "status", "lastLoginAt"])
  sortBy?: "createdAt" | "username" | "role" | "status" | "lastLoginAt" =
    "createdAt";

  @IsOptional()
  @IsIn(["asc", "desc"])
  sortOrder?: "asc" | "desc" = "desc";
}

class OwnerStepUpDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword!: string;
}

class VersionedOwnerStepUpDto extends OwnerStepUpDto {
  @IsISO8601({ strict: true })
  expectedUpdatedAt!: string;
}

export class CreateAdminAccountDto extends OwnerStepUpDto {
  @Transform(({ value }) =>
    typeof value === "string"
      ? value.normalize("NFC").trim().toLowerCase()
      : value,
  )
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_]+$/)
  username!: string;

  @IsIn([AdminRole.ADMIN, AdminRole.STAFF])
  role!: AdminRole;
}

export class ChangeAdminAccountRoleDto extends VersionedOwnerStepUpDto {
  @IsIn([AdminRole.ADMIN, AdminRole.STAFF])
  role!: AdminRole;
}

export class ChangeAdminAccountStatusDto extends VersionedOwnerStepUpDto {
  @IsEnum(AccountStatus)
  status!: AccountStatus;
}

export class RevokeAdminAccountSessionsDto extends OwnerStepUpDto {}

export class ResetAdminAccountPasswordDto extends VersionedOwnerStepUpDto {}

export class DeleteAdminAccountDto extends VersionedOwnerStepUpDto {
  @Transform(({ value }) =>
    typeof value === "string"
      ? value.normalize("NFC").trim().toLowerCase()
      : value,
  )
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  confirmUsername!: string;
}

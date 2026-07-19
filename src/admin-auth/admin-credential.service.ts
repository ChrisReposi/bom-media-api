import { BadRequestException, Injectable } from "@nestjs/common";
import { compare, hash } from "bcryptjs";
import { randomBytes } from "node:crypto";

const PASSWORD_HASH_ROUNDS = 12;

@Injectable()
export class AdminCredentialService {
  normalizeUsername(value: string): string {
    return value.normalize("NFC").trim().toLowerCase();
  }

  hashPassword(password: string): Promise<string> {
    return hash(password, PASSWORD_HASH_ROUNDS);
  }

  comparePassword(password: string, passwordHash: string): Promise<boolean> {
    return compare(password, passwordHash);
  }

  generateTemporaryPassword(): string {
    return randomBytes(18).toString("base64url");
  }

  generateUnusablePassword(): string {
    return randomBytes(48).toString("base64url");
  }

  validateNewPassword(params: {
    username: string;
    currentPassword: string;
    newPassword: string;
  }): void {
    if (params.newPassword.length < 12 || params.newPassword.length > 128) {
      throw new BadRequestException({
        statusCode: 400,
        message: "New password must be between 12 and 128 characters.",
        error: "Bad Request",
        code: "ADMIN_PASSWORD_POLICY_VIOLATION",
      });
    }
    if (params.newPassword === params.currentPassword) {
      throw new BadRequestException({
        statusCode: 400,
        message: "New password must differ from the current password.",
        error: "Bad Request",
        code: "ADMIN_PASSWORD_REUSED",
      });
    }
    if (
      params.newPassword.normalize("NFC").trim().toLowerCase() ===
      this.normalizeUsername(params.username)
    ) {
      throw new BadRequestException({
        statusCode: 400,
        message: "New password must differ from the username.",
        error: "Bad Request",
        code: "ADMIN_PASSWORD_POLICY_VIOLATION",
      });
    }
  }
}

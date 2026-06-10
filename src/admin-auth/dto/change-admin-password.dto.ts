import { ApiProperty } from "@nestjs/swagger";
import { IsString, MaxLength, MinLength } from "class-validator";

export class ChangeAdminPasswordDto {
  @ApiProperty({
    example: "current-password",
    minLength: 1,
    maxLength: 128,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  oldPassword!: string;

  @ApiProperty({
    example: "new-strong-password",
    minLength: 8,
    maxLength: 128,
  })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword!: string;

  @ApiProperty({
    example: "change-password-secret",
    minLength: 8,
    maxLength: 256,
  })
  @IsString()
  @MinLength(8)
  @MaxLength(256)
  secretCode!: string;
}

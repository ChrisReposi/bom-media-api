import { ApiProperty } from "@nestjs/swagger";
import { IsString, Matches, MaxLength, MinLength } from "class-validator";

export class RegisterAdminDto {
  @ApiProperty({
    example: "admin",
    minLength: 3,
    maxLength: 32,
    description:
      "Admin username. Only letters, numbers, and underscores are allowed.",
  })
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: "username can only contain letters, numbers, and underscores",
  })
  username!: string;

  @ApiProperty({
    example: "12345",
    minLength: 5,
    maxLength: 128,
  })
  @IsString()
  @MinLength(5)
  @MaxLength(128)
  password!: string;

  @ApiProperty({
    example: "ma-bi-mat-ko-ai-biet",
    minLength: 8,
    maxLength: 256,
  })
  @IsString()
  @MinLength(8)
  @MaxLength(256)
  secretCode!: string;
}

import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ShareLinkStatus } from "../../generated/prisma/client";

export class AdminShareLinkVideoResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  videoId!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  sortOrder!: number;
}

export class AdminShareLinkResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  websiteId!: string;

  @ApiPropertyOptional({ nullable: true })
  label!: string | null;

  @ApiProperty({ enum: ShareLinkStatus })
  status!: ShareLinkStatus;

  @ApiPropertyOptional({ nullable: true })
  expiresAt!: Date | null;

  @ApiPropertyOptional({ nullable: true })
  maxViews!: number | null;

  @ApiProperty()
  currentViews!: number;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;

  @ApiPropertyOptional({ nullable: true })
  lastViewedAt!: Date | null;

  @ApiPropertyOptional({ nullable: true })
  publicUrl!: string | null;

  @ApiProperty({ type: [AdminShareLinkVideoResponse] })
  videos!: AdminShareLinkVideoResponse[];
}

export class AdminShareLinkListResponse {
  @ApiProperty({ type: [AdminShareLinkResponse] })
  items!: AdminShareLinkResponse[];
}

export class CreateShareLinkResponse {
  @ApiProperty()
  message!: string;

  @ApiProperty({ type: AdminShareLinkResponse })
  shareLink!: AdminShareLinkResponse;

  @ApiProperty({
    description: "Raw token is returned only once during creation.",
  })
  rawToken!: string;

  @ApiPropertyOptional({ nullable: true })
  publicUrl!: string | null;
}

export class RevokeShareLinkResponse {
  @ApiProperty()
  message!: string;

  @ApiProperty({ type: AdminShareLinkResponse })
  shareLink!: AdminShareLinkResponse;
}

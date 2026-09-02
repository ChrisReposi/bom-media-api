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
  alias!: string | null;

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

  @ApiPropertyOptional({
    nullable: true,
    description:
      "The EMAIL-SAFE reviewer URL, `https://<domain>/watch?r=<transportAlias>`. Carries a separate 128-bit transport identifier in the query string — never the `#k` credential — and resolves to this same ShareLink under every check `publicUrl` is subject to. Null on list and revoke responses, and for a link that has no transport alias yet.",
  })
  compatibilityUrl!: string | null;

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

  @ApiPropertyOptional({
    description:
      "Raw token is returned only once during creation, and only on the multi-video path. It is ABSENT for an exact single-video request, which resolves the canonical link: on reuse no token was minted, and on first creation the canonical contract deliberately does not expose one — the alias in `publicUrl` is the credential.",
  })
  rawToken?: string;

  @ApiPropertyOptional({ nullable: true })
  publicUrl!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      "The email-safe reviewer URL (`/watch?r=<transportAlias>`) for the same link as `publicUrl`. Survives fragment-stripping mail clients; see the security note in docs/features/share-links.md before preferring it.",
  })
  compatibilityUrl!: string | null;

  @ApiProperty({
    enum: ["CREATED", "REUSED"],
    example: "REUSED",
    description:
      "`REUSED` means no row was written: an exact single-video request resolved the canonical link that already existed for this website+video pair. Multi-video requests are always `CREATED`.",
  })
  outcome!: "CREATED" | "REUSED";

  @ApiProperty({
    example: false,
    description:
      "True when this link is the canonical one for a website+video pair, i.e. the request was for exactly one video.",
  })
  isCanonical!: boolean;
}

export class RevokeShareLinkResponse {
  @ApiProperty()
  message!: string;

  @ApiProperty({ type: AdminShareLinkResponse })
  shareLink!: AdminShareLinkResponse;
}

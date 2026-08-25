import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { AdminShareLinkResponse } from "./admin-share-link-response.type";

export class CanonicalShareLinkResponse {
  @ApiProperty({ example: "Canonical share link created." })
  message!: string;

  @ApiProperty({ enum: ["CREATED", "REUSED"], example: "REUSED" })
  outcome!: "CREATED" | "REUSED";

  @ApiProperty({ example: true })
  isCanonical!: true;

  @ApiProperty({
    example: false,
    description:
      "True when the video's evidence-critical identity no longer matches the stored snapshot (read path only; create-or-get returns a conflict instead).",
  })
  evidenceDrift!: boolean;

  @ApiProperty({ type: AdminShareLinkResponse })
  shareLink!: AdminShareLinkResponse;

  @ApiProperty({
    example: "https://plushcomedystudios.com/#/s/G3tqak0/videos",
    description:
      "Byte-for-byte stable canonical URL, built from the snapshotted host — never from the currently preferred domain.",
  })
  publicUrl!: string;

  @ApiProperty({
    example: "https://plushcomedystudios.com/watch#k=G3tqak0",
    description:
      "The V2 reviewer URL an operator copies. Built from the same snapshotted host and the same alias, so it is byte-identical for the pair forever. `publicUrl` above stays in the pinned provenance shape for records already filed.",
  })
  reviewUrl!: string;

  @ApiProperty({ example: "G3tqak0" })
  alias!: string;

  @ApiPropertyOptional({ type: Object, nullable: true })
  evidenceSnapshot!: Record<string, unknown> | null;

  @ApiProperty()
  canonicalCreatedAt!: Date;
}

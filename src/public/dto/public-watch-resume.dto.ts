import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MaxLength } from "class-validator";

/**
 * Body of `POST /public/watch/resume` — restoring a scrubbed review session in
 * the same browser tab.
 *
 * `grant` is a short-lived, host-bound, signed pointer at a ShareLink row. It
 * is NOT a share credential: it carries no alias, no transport alias, no raw
 * token and no media URL, and it authorizes nothing on its own. Every
 * authorization fact is re-read from the database when it is redeemed.
 *
 * It is still a SECRET. Holding one lets its bearer attempt to restore the
 * session, but the restored payload is alias-free: its protected media URLs
 * carry per-video rmv1 tokens and disclose no canonical alias, raw token or
 * token hash. `req.body.grant` is therefore a pino redaction path, and request
 * bodies are not logged at all.
 *
 * Validation here is structural only (present, a string, bounded). A
 * well-typed but wrong value gets the same generic `200 INVALID_LINK` denial
 * every other refusal on this surface gets, rather than a distinguishable
 * `400`.
 */
export class PublicWatchResumeDto {
  @ApiProperty({
    example: "arcwildstudios.com",
    maxLength: 253,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(253)
  host!: string;

  @ApiProperty({
    example: "<base64url payload>.<base64url signature>",
    maxLength: 2048,
    description:
      "The resume grant returned by the email-safe exchange. A signed pointer, not a share credential.",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  grant!: string;
}

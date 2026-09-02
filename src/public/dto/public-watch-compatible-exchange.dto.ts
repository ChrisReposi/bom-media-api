import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MaxLength } from "class-validator";

/**
 * Body of `POST /public/watch/exchange-compatible` — the email-safe reviewer
 * exchange for `https://<domain>/watch?r=<transportAlias>`.
 *
 * `alias` is the TRANSPORT alias: a separate 128-bit identifier, and an
 * ALTERNATE BEARER CREDENTIAL for the same ShareLink, that
 * `PublicService.resolvePublicWatchCompatible()` maps to a ShareLink and then
 * resolves through the unmodified V2 chain. It is never the `#k` credential,
 * and it is never a harmless one: this body carries a secret, which is why
 * `req.body.alias` is a pino redaction path and why request bodies are not
 * logged at all.
 *
 * Validation here is structural only (present, a string, bounded). The exact
 * minted shape is enforced in the service so that every wrong-but-well-typed
 * value receives the same generic `200 INVALID_LINK` denial the `#k` exchange
 * gives, rather than a distinguishable `400`.
 */
export class PublicWatchCompatibleExchangeDto {
  @ApiProperty({
    example: "arcwildstudios.com",
    maxLength: 253,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(253)
  host!: string;

  @ApiProperty({
    example: "cOmPaTtRaNsPoRt_0123ab",
    maxLength: 64,
    description:
      "The 22-character base64url transport alias from the `?r=` query parameter. An alternate bearer credential for the ShareLink; not the `#k` credential.",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  alias!: string;
}

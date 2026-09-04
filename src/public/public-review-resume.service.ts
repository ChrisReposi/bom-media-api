import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "node:crypto";

import {
  decodeGrantPayload,
  encodeGrantPayload,
  RESUME_GRANT_DOMAIN,
  RESUME_MEDIA_GRANT_DOMAIN,
  RESUME_MEDIA_TOKEN_MIN_LENGTH,
  RESUME_MEDIA_TOKEN_PREFIX,
  signGrantPayload,
  verifyFixedWidthGrantSignature,
  verifyGrantSignature,
} from "./utils/grant-signature.util";

/**
 * The claims. Deliberately the SMALLEST set that lets the resume request find
 * the right row and refuse a replay somewhere else.
 *
 *   v     format version
 *   sid   ShareLink id — a DATABASE KEY, not a credential. It is useless on
 *         every public route: nothing accepts a ShareLink id as a token, an
 *         alias or a transport alias.
 *   host  the normalized host the session was established on. A grant minted
 *         on one customer domain is refused on another, matching the host
 *         binding the share link itself has.
 *   iat   issued-at, for forensics
 *   exp   absolute expiry, UNIX seconds
 *   nonce 16 random bytes, so two grants minted in the same second for the
 *         same session are cryptographically distinct without being logged
 *
 * WHAT IS DELIBERATELY ABSENT, and must stay absent:
 *   - `ShareLink.alias`      the canonical bearer credential
 *   - `transportAlias`       the alternate bearer credential
 *   - the raw token, the token hash
 *   - any signed media URL or Bunny embed URL
 *   - the video list, titles, or anything else about the payload
 *
 * The grant is a bearer session credential, but it carries no authority FACT
 * that the resolver trusts. It names a row and a host; every authorization
 * fact is re-read from the database on redemption.
 */
type ReviewResumePayload = {
  v: 1;
  purpose: typeof RESUME_GRANT_DOMAIN;
  sid: string;
  host: string;
  iat: number;
  exp: number;
  nonce: string;
};

/**
 * The claims of an alias-free review media token — what stands in for
 * `ShareLink.alias` in media URLs returned by compatibility and resume.
 *
 *   sid   the ShareLink id, so the media route can find the row without the
 *         reviewer ever holding a credential that names it
 *   vid   the ONE video this token may reach. A media URL ends up in the DOM,
 *         in a `src` attribute, in a `poster`; binding it to one video means a
 *         leaked poster URL is not a key to the rest of the link
 *   exp   absolute expiry, CLAMPED to the session grant that produced it
 *
 * THE HOST IS BOUND, AND IS NOT A FIELD. It goes into the MAC domain instead
 * (`mediaDomain()`), which binds it more strongly than a field comparison
 * would — a token minted for one host does not verify on another at all — and
 * costs the payload nothing. That matters because the whole token has to fit
 * inside 256 characters to satisfy the reviewer client's media-path
 * validator, and a hostname can be 253 of them.
 *
 * ABSENT, and the whole point of the type: `alias`, `transportAlias`, the raw
 * token, the token hash. A holder of this token cannot learn any of them, so
 * it cannot be escalated into a `#k` credential that outlives the session.
 */
type ResumeMediaPayload = {
  v: 1;
  purpose: typeof RESUME_MEDIA_GRANT_DOMAIN;
  sid: string;
  vid: string;
  exp: number;
};

const DEFAULT_TTL_SECONDS = 8 * 60 * 60;

/**
 * The fallback media lifetime, used only when `PUBLIC_MEDIA_GRANT_TTL_SECONDS`
 * is absent from the environment.
 *
 * IT IS NOT THE POLICY. The policy is the configured value, read below and
 * already validated at boot (bounded 300 … 86400, throwing out of range) —
 * hard-coding six hours here meant an operator who tightened
 * `PUBLIC_MEDIA_GRANT_TTL_SECONDS` to five minutes still got six-hour media
 * tokens, which is a setting that silently did not apply.
 */
const FALLBACK_MEDIA_TTL_SECONDS = 6 * 60 * 60;

/**
 * ISSUES AND VERIFIES THE REVIEW-RESUME GRANT.
 *
 * WHAT THIS IS FOR. After a `?r=` reviewer URL is redeemed the carrier is
 * scrubbed from the address bar, so it exists only in one module-scoped
 * variable that dies with the document. A refresh therefore loses the session.
 * This grant restores it — WITHOUT keeping any share credential in the URL or
 * in storage, and WITHOUT spending a second view.
 *
 * WHAT IT IS NOT. It is not a second authorization model, and it must never
 * become one. Redemption re-reads the ShareLink and re-runs every authoritative
 * check; a signed claim is only ever used to LOCATE the row and to bind the
 * host, never to assert that access is allowed. Revocation, expiry, membership
 * loss, un-assignment, a non-READY video and the capability kill switch all
 * still deny a request carrying a perfectly valid grant.
 *
 * STATE THE EXPOSURE HONESTLY. The grant is a bearer session credential stored
 * in `sessionStorage`. Redeeming it returns only alias-free protected media
 * URLs; neither the response nor its rmv1 tokens contain or disclose the
 * canonical alias, raw token or token hash. Its lifetime is bounded, every
 * redemption revalidates the database, and the compatibility capability is an
 * immediate kill switch for both resume and rmv1 media.
 */
@Injectable()
export class PublicReviewResumeService {
  constructor(private readonly configService: ConfigService) {}

  /**
   * Mints a grant for a session that has ALREADY been authorized and has
   * ALREADY consumed its view. Never call this before consumption — a grant
   * for a request that was denied would be a credential for access that was
   * refused.
   */
  issue(params: { shareLinkId: string; host: string; now?: Date }): string {
    const now = params.now ?? new Date();
    const issuedAt = Math.floor(now.getTime() / 1000);
    const payload: ReviewResumePayload = {
      v: 1,
      purpose: RESUME_GRANT_DOMAIN,
      sid: params.shareLinkId,
      host: params.host,
      iat: issuedAt,
      exp: issuedAt + this.getTtlSeconds(),
      nonce: randomBytes(16).toString("base64url"),
    };
    const encodedPayload = encodeGrantPayload(payload);

    return `${encodedPayload}.${this.sign(encodedPayload)}`;
  }

  /**
   * Verifies signature, purpose, version, host binding and expiry — and returns
   * ONLY the ShareLink id.
   *
   * Returning just the id is the point: there is nothing else in the grant a
   * caller could be tempted to trust. Everything the caller needs to make an
   * authorization decision it must read from the database itself.
   *
   * Cheap checks run before expensive ones, and the MAC runs before any field
   * is read, so a forged grant never reaches `JSON.parse` and never causes a
   * query.
   */
  verify(
    grant: string | undefined,
    expected: { host: string; now?: Date },
  ): { shareLinkId: string; expiresAt: number } | null {
    const encodedPayload = verifyGrantSignature({
      grant,
      secret: this.secret(),
      domain: RESUME_GRANT_DOMAIN,
    });
    if (encodedPayload === null) {
      return null;
    }

    const payload =
      decodeGrantPayload<Partial<ReviewResumePayload>>(encodedPayload);
    if (payload === null) {
      return null;
    }

    const nowSeconds = Math.floor(
      (expected.now ?? new Date()).getTime() / 1000,
    );

    const valid =
      payload.v === 1 &&
      payload.purpose === RESUME_GRANT_DOMAIN &&
      typeof payload.sid === "string" &&
      payload.sid.length > 0 &&
      payload.host === expected.host &&
      typeof payload.exp === "number" &&
      Number.isSafeInteger(payload.exp) &&
      payload.exp >= nowSeconds;

    /* `expiresAt` is returned alongside the id, and it is NOT an
       authorization fact — nothing downstream is allowed to conclude "still
       valid" from it. It exists so the media tokens minted for this response
       can be CLAMPED to it: a media token must never outlive the session
       grant that produced it, or a stolen poster URL would keep working after
       the session it came from had expired. */
    return valid
      ? {
          shareLinkId: payload.sid as string,
          expiresAt: payload.exp as number,
        }
      : null;
  }

  /* ---------------------------------------------------------------- *
   * RESUME MEDIA TOKENS
   *
   * The alias-free stand-in for `ShareLink.alias` in a media URL.
   *
   * WHY THIS EXISTS. The resume flow re-enters the unmodified resolver using
   * the row's own alias, and every backend media URL echoes the presented
   * token as a path segment. A reviewer who resumed therefore received the
   * canonical alias in `publicPlaybackUrl`, `thumbnailUrl` and
   * `binaryPlaybackUrl` — so a stolen resume grant could be redeemed once,
   * the alias read out of the response, and `/watch#k=<alias>` used
   * afterwards. That escalation SURVIVED resume-grant expiry, sessionStorage
   * deletion and the compatibility kill switch, which made the 8-hour TTL a
   * bound on nothing.
   *
   * These tokens close it. They are minted for BOTH compatibility and resume
   * responses, name a row rather than disclose a share credential, expire no
   * later than the originating session, and are refused the moment the host
   * stops being compatibility-capable.
   * ---------------------------------------------------------------- */

  /**
   * Is this `:token` path segment a resume media token rather than a share
   * credential?
   *
   * EXACT BY CONSTRUCTION, not probabilistic: all legacy share credentials are
   * shorter than `RESUME_MEDIA_TOKEN_MIN_LENGTH`, while every rmv1 token meets
   * that floor and starts with its version prefix. An ordinary alias may begin
   * with `rmv1`; length keeps it on the legacy path. A malformed long rmv1
   * attempt is refused rather than retried as a share credential.
   */
  isMediaToken(value: string | null | undefined): value is string {
    return (
      typeof value === "string" &&
      value.startsWith(RESUME_MEDIA_TOKEN_PREFIX) &&
      value.length >= RESUME_MEDIA_TOKEN_MIN_LENGTH
    );
  }

  /**
   * Mints the media token for ONE video of an alias-free review session.
   *
   * `notAfter` is the session grant's own expiry. The token is clamped to it,
   * so the whole set of credentials a resume hands out dies together.
   */
  issueMediaToken(params: {
    shareLinkId: string;
    videoId: string;
    host: string;
    notAfter?: number | undefined;
    now?: Date;
  }): string {
    const now = params.now ?? new Date();
    const issuedAt = Math.floor(now.getTime() / 1000);
    const configured = issuedAt + this.getMediaTtlSeconds();
    const payload: ResumeMediaPayload = {
      v: 1,
      purpose: RESUME_MEDIA_GRANT_DOMAIN,
      sid: params.shareLinkId,
      vid: params.videoId,
      exp:
        params.notAfter === undefined
          ? configured
          : Math.min(configured, params.notAfter),
    };
    const encodedPayload = encodeGrantPayload(payload);

    /* NO SEPARATOR. The `.` the other two grants use is not in the alphabet
       the reviewer client accepts in a media path segment, and that alphabet
       is a measured defence against browser path normalisation rather than a
       style choice — so the signature is appended at its fixed width and
       split off by length. */
    return `${RESUME_MEDIA_TOKEN_PREFIX}${encodedPayload}${signGrantPayload(
      this.secret(),
      this.mediaDomain(params.host),
      encodedPayload,
    )}`;
  }

  /**
   * The MAC domain for a media token: the purpose AND the host.
   *
   * The payload carries no `host` field, so this is what binds one. The
   * separator cannot make two different (host, payload) pairs produce the
   * same MAC input: an encoded payload is base64url and therefore contains no
   * `.`, so the LAST `.` always divides host from payload.
   */
  private mediaDomain(host: string): string {
    return `${RESUME_MEDIA_GRANT_DOMAIN}|${host}`;
  }

  /**
   * Verifies a media token and returns ONLY the ShareLink id it names.
   *
   * The video is checked here rather than returned, so a caller cannot
   * accidentally trust the token's idea of which video it is for; and as
   * everywhere else in this subsystem, nothing about whether access is
   * ALLOWED comes from the token. The caller re-reads the row, re-checks
   * status, expiry, membership, assignment and READY, and applies the
   * compatibility kill switch.
   */
  verifyMediaToken(
    token: string | undefined,
    expected: { host: string; videoId: string; now?: Date },
  ): { shareLinkId: string } | null {
    if (!this.isMediaToken(token)) {
      return null;
    }

    const encodedPayload = verifyFixedWidthGrantSignature({
      value: token.slice(RESUME_MEDIA_TOKEN_PREFIX.length),
      secret: this.secret(),
      domain: this.mediaDomain(expected.host),
    });
    if (encodedPayload === null) {
      return null;
    }

    const payload =
      decodeGrantPayload<Partial<ResumeMediaPayload>>(encodedPayload);
    if (payload === null) {
      return null;
    }

    const nowSeconds = Math.floor(
      (expected.now ?? new Date()).getTime() / 1000,
    );

    const valid =
      payload.v === 1 &&
      payload.purpose === RESUME_MEDIA_GRANT_DOMAIN &&
      typeof payload.sid === "string" &&
      payload.sid.length > 0 &&
      payload.vid === expected.videoId &&
      typeof payload.exp === "number" &&
      Number.isSafeInteger(payload.exp) &&
      payload.exp >= nowSeconds;

    return valid ? { shareLinkId: payload.sid as string } : null;
  }

  private sign(encodedPayload: string): string {
    return signGrantPayload(this.secret(), RESUME_GRANT_DOMAIN, encodedPayload);
  }

  /**
   * ITS OWN SECRET, not the media-grant one.
   *
   * MAC domain separation alone would be cryptographically sufficient, and it
   * is still applied on top of this. A separate key is kept because the
   * OPERATIONAL properties differ:
   *
   *   - INDEPENDENT ROTATION. Rotating this ends every resume session and its
   *     rmv1 media at once without invalidating LEGACY media grants or touching
   *     `#k` playback. Rotating the legacy media secret does not invalidate a
   *     resume grant or rmv1 token.
   *   - BLAST RADIUS. A disclosure of one key does not forge the other's
   *     credentials.
   *   - DEFENCE IN DEPTH. Because domain separation is retained, an operator
   *     who sets both variables to the SAME value still gets no confusion
   *     between a media grant, a resume grant and a resume media token.
   *
   * `PUBLIC_MEDIA_GRANT_SECRET` is untouched, and no media-grant byte changes.
   */
  private secret(): string {
    return this.configService.getOrThrow<string>("PUBLIC_WATCH_RESUME_SECRET");
  }

  /**
   * Bounds are enforced at boot by `env.validation.ts`, which THROWS on an
   * out-of-range value rather than clamping — the house convention. This only
   * supplies the default when the variable is absent, so a running process
   * cannot be holding a value the validator would have rejected.
   */
  /**
   * THE MEDIA CEILING, from configuration.
   *
   * The same variable the legacy media grant uses, because it expresses the
   * same policy: how long a per-video credential embedded in a DOM may live.
   * Sharing the number does NOT share the key — an rmv1 token is signed with
   * `PUBLIC_WATCH_RESUME_SECRET` under its own MAC domain, and no legacy
   * media-grant byte changes.
   *
   * The effective expiry is always `min(this, the session grant's expiry)`,
   * so raising the variable can never let a media token outlive the review
   * session it came from.
   */
  private getMediaTtlSeconds(): number {
    const configured = Number(
      this.configService.get<string>("PUBLIC_MEDIA_GRANT_TTL_SECONDS") ??
        FALLBACK_MEDIA_TTL_SECONDS,
    );

    return Number.isInteger(configured) && configured > 0
      ? configured
      : FALLBACK_MEDIA_TTL_SECONDS;
  }

  private getTtlSeconds(): number {
    const configured = Number(
      this.configService.get<string>("PUBLIC_WATCH_RESUME_TTL_SECONDS") ??
        DEFAULT_TTL_SECONDS,
    );

    return Number.isInteger(configured) && configured > 0
      ? configured
      : DEFAULT_TTL_SECONDS;
  }
}

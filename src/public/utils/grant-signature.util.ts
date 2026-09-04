import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * THE ONE SIGNING PRIMITIVE, WITH TWO INDEPENDENT SECRETS.
 *
 *   legacy media grant  PUBLIC_MEDIA_GRANT_SECRET, domain "" (unchanged)
 *   resume grant        PUBLIC_WATCH_RESUME_SECRET, review-resume-v1
 *   rmv1 media token    PUBLIC_WATCH_RESUME_SECRET,
 *                       resume-media-v1|<normalized-host>
 *
 * A domain separator is prepended to the MAC INPUT, so a signature produced for
 * one domain cannot verify under another even if both secrets are configured
 * to the same bytes and every field check were
 * deleted. The `purpose` field inside the payload is the second, independent
 * layer — it is inside the signed bytes and therefore unforgeable too. Either
 * alone would stop cross-purpose confusion; both is cheap.
 *
 * THE EMPTY DOMAIN IS LOAD-BEARING, NOT A DEFAULT. Media grants have been
 * signed as `HMAC(secret, payload)` since they shipped, and live ones sit in
 * reviewers' DOMs for up to their TTL. Giving media a non-empty domain would
 * change its wire bytes and break every outstanding grant the moment a new
 * build started serving — mid-playback, as a generic 404. So `""` reproduces
 * the existing construction exactly, and `test/public-review-resume.test.ts`
 * pins that against an independently computed digest.
 */
export const RESUME_GRANT_DOMAIN = "review-resume-v1";

/**
 * The MAC domain for a RESUME MEDIA TOKEN — the alias-free credential that
 * stands in for `ShareLink.alias` in the `:token` path segment of a media URL
 * returned by a compatibility or resume exchange.
 *
 * A third domain rather than reuse of `RESUME_GRANT_DOMAIN`, so the two halves
 * of the resume subsystem cannot be interchanged either: a session grant
 * cannot be replayed as a media token, and a media token — which is
 * per-video and travels in a URL that ends up in the DOM — cannot be replayed
 * as a session grant to re-open the whole payload.
 */
export const RESUME_MEDIA_GRANT_DOMAIN = "resume-media-v1";

/**
 * The prefix that marks a resume media token in a `:token` path segment.
 *
 * IT IS PURE BASE64URL, AND THAT IS A HARD CONSTRAINT rather than a
 * preference. The shipped reviewer client validates every media URL against
 *
 *     /^\/public\/watch\/[A-Za-z0-9_-]{1,256}\/videos\/[A-Za-z0-9_-]{1,191}\/…
 *
 * before it will fetch one, and that alphabet pin is a MEASURED defence, not
 * decoration: with a looser segment test, Chrome decoded and normalised
 * `/public/watch/%2e%2e/videos/…` into a different path than the one the
 * validator had approved. Widening the client to admit `~` would be
 * cosmetic; widening it to admit `.` would reopen exactly that hole. So the
 * token is shaped to fit the EXISTING contract, and no deployed reviewer
 * bundle needs to change to accept one.
 *
 * DISCRIMINATION IS STILL EXACT, by prefix AND length together. Every minted
 * share credential is short by construction — `alias` is `VARCHAR(16)`,
 * `transportAlias` is `VARCHAR(32)` and a raw share token is `s_` plus 43
 * base64url characters — so nothing that can legitimately resolve is 64
 * characters or longer. A resume media token always is. The prefix then makes
 * the intent legible at a glance in a log or a URL.
 */
export const RESUME_MEDIA_TOKEN_PREFIX = "rmv1";

/**
 * The shortest a resume media token can be, and the length above which no
 * minted share credential exists. See the prefix note above for why 64 is
 * exact rather than merely generous.
 */
export const RESUME_MEDIA_TOKEN_MIN_LENGTH = 64;

/**
 * A resume media token is `prefix + base64url(payload) + signature`, with NO
 * separator — the `.` the other grants use is not in the client's accepted
 * alphabet. The split is unambiguous because a SHA-256 base64url digest is
 * always exactly this many characters.
 */
export function splitFixedWidthGrant(
  value: string,
): { encodedPayload: string; signature: string } | null {
  if (
    value.length <= SHA256_BASE64URL_LENGTH ||
    !BASE64URL_PATTERN.test(value)
  ) {
    return null;
  }

  return {
    encodedPayload: value.slice(0, -SHA256_BASE64URL_LENGTH),
    signature: value.slice(-SHA256_BASE64URL_LENGTH),
  };
}

/**
 * Verifies a fixed-width (separator-free) grant and returns its encoded
 * payload, or null.
 *
 * `domain` here carries the HOST as well as the purpose — see
 * `PublicReviewResumeService.mediaDomain()`. Binding the host into the MAC
 * input rather than into the payload keeps the token short enough for the
 * client's 256-character segment limit even for a long hostname, and makes a
 * token minted for one host fail to verify on another rather than merely
 * failing a field comparison.
 */
export function verifyFixedWidthGrantSignature(params: {
  value: string;
  secret: string;
  domain: string;
}): string | null {
  const parts = splitFixedWidthGrant(params.value);
  if (parts === null) {
    return null;
  }

  const expected = signGrantPayload(
    params.secret,
    params.domain,
    parts.encodedPayload,
  );
  const presented = Buffer.from(parts.signature, "utf8");
  const computed = Buffer.from(expected, "utf8");

  if (
    presented.length !== computed.length ||
    !timingSafeEqual(presented, computed)
  ) {
    return null;
  }

  return parts.encodedPayload;
}

/** Unpadded base64url of a 32-byte digest. */
export const SHA256_BASE64URL_LENGTH = 43;

/** No padding, no `+`, no `/`, no whitespace, non-empty. */
export const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export function signGrantPayload(
  secret: string,
  domain: string,
  encodedPayload: string,
): string {
  const input = domain === "" ? encodedPayload : `${domain}.${encodedPayload}`;

  return createHmac("sha256", secret).update(input).digest("base64url");
}

/**
 * Splits `<payload>.<signature>`, checks the shape, and compares the signature
 * in constant time. Returns the encoded payload only when the MAC is good.
 *
 * ORDER MATTERS. Everything here is cheap and input-shaped; the caller decodes
 * and reads fields only after this returns, so a forged or malformed grant
 * never reaches `JSON.parse`, a database read, or any field comparison.
 */
export function verifyGrantSignature(params: {
  grant: string | undefined;
  secret: string;
  domain: string;
  maxLength?: number;
}): string | null {
  const { grant, secret, domain } = params;
  const maxLength = params.maxLength ?? 2048;

  if (
    typeof grant !== "string" ||
    grant.length === 0 ||
    grant.length > maxLength
  ) {
    return null;
  }

  const [encodedPayload, signature, extra] = grant.split(".");
  if (
    !encodedPayload ||
    !signature ||
    extra !== undefined ||
    !BASE64URL_PATTERN.test(encodedPayload) ||
    !BASE64URL_PATTERN.test(signature) ||
    signature.length !== SHA256_BASE64URL_LENGTH
  ) {
    return null;
  }

  const received = Buffer.from(signature);
  const expected = Buffer.from(
    signGrantPayload(secret, domain, encodedPayload),
  );
  if (
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  ) {
    return null;
  }

  return encodedPayload;
}

/**
 * Decodes a payload whose signature has ALREADY been verified.
 *
 * The re-encode check rejects a value that decodes but does not round-trip
 * byte-identically (non-canonical trailing bits). It runs after the MAC, so it
 * is defence in depth against our own encoder rather than an attacker-facing
 * boundary.
 */
export function decodeGrantPayload<T>(encodedPayload: string): T | null {
  try {
    const decoded = Buffer.from(encodedPayload, "base64url");
    if (decoded.toString("base64url") !== encodedPayload) {
      return null;
    }

    return JSON.parse(decoded.toString("utf8")) as T;
  } catch {
    return null;
  }
}

export function encodeGrantPayload(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

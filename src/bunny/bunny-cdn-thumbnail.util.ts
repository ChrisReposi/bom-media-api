import {
  isSafeBunnyFileName,
  isSafeBunnyPathSegment,
} from "./bunny-thumbnail.util";

/**
 * Validation for the ONE upstream URL the backend thumbnail proxy is allowed to
 * fetch.
 *
 * WHY THIS FILE IS SEVERE ABOUT A URL IT BUILT ITSELF.
 *
 * `VideoAsset.thumbnailUrl` is a database column. The Bunny sync path writes it
 * with `BunnyStreamService.buildThumbnailUrl()`, which is already strict — but
 * "the value we wrote" and "the value in the row right now" are not the same
 * claim. An operator, a migration, a restored backup or a direct SQL edit can
 * put anything there, and this is the boundary where a stored string would
 * become an outbound HTTP request from the API server. `fetch(row.thumbnailUrl)`
 * with no check is the textbook SSRF primitive: internal hosts, cloud metadata
 * endpoints, `file:`, redirect chains.
 *
 * So nothing here trusts the stored string. It is PARSED, every component is
 * checked against the authoritative Bunny identity the caller already proved,
 * and then the upstream URL is REBUILT from those proven components. The stored
 * string is only ever used as a source of two candidate path segments; it is
 * never the thing that gets fetched.
 *
 * Why not re-read `thumbnailFileName` from the Bunny Management API instead?
 * Because public watch is deliberately free of Management API latency
 * (`docs/features/bunny-stream.md` §4.4), and adding a per-view provider call to
 * recover a file name would trade an SSRF question for a latency and
 * rate-limit problem. The file name is recoverable from the stored URL under
 * validation, which is what this does.
 */

/** Everything the caller must already have PROVEN before validating a URL. */
export type BunnyThumbnailIdentity = {
  /** The authoritative Bunny video GUID, from `classifyBunnyVideoAsset()`. */
  bunnyVideoId: string;
  /** The configured pull-zone hostname. Lower-case, hostname only. */
  pullZoneHostname: string;
};

export type BunnyThumbnailUrlRejection =
  | "NOT_ABSOLUTE"
  | "NOT_HTTPS"
  | "HAS_CREDENTIALS"
  | "HAS_PORT"
  | "HAS_QUERY"
  | "HAS_FRAGMENT"
  | "HOSTNAME_MISMATCH"
  | "PATH_SHAPE"
  | "VIDEO_ID_MISMATCH"
  | "UNSAFE_FILE_NAME";

export type BunnyThumbnailUrlResult =
  | { ok: true; url: string; fileName: string }
  | { ok: false; reason: BunnyThumbnailUrlRejection };

/**
 * Whether a stored thumbnail URL even CLAIMS to be on the configured pull zone.
 *
 * Separate from full validation on purpose. A Bunny-provider video may carry an
 * operator-supplied poster on some other host — sync only fills an EMPTY
 * `thumbnailUrl`, it never overwrites one — and that is not a Bunny CDN URL at
 * all. Such a value keeps its existing pass-through behaviour rather than being
 * fail-closed as a malformed Bunny poster, which would silently delete a
 * working image.
 */
export function isBunnyPullZoneUrl(
  storedUrl: string | null,
  pullZoneHostname: string | null,
): boolean {
  if (storedUrl === null || pullZoneHostname === null) {
    return false;
  }

  try {
    const parsed = new URL(storedUrl.trim());
    return (
      parsed.protocol === "https:" &&
      parsed.hostname.toLowerCase() === pullZoneHostname
    );
  } catch {
    return false;
  }
}

/**
 * Validates a stored Bunny poster URL and returns the URL the proxy may fetch.
 *
 * EVERY CHECK, AND WHY IT IS THERE:
 *
 * - absolute + `https:` — a relative or `http:`/`file:`/`data:` value is not a
 *   Bunny CDN poster and must never be dereferenced.
 * - no username/password — `https://user:pass@host/` embeds credentials that
 *   would be sent upstream, and is also a classic host-confusion vector.
 * - no explicit port — the pull zone is served on 443. A port is how an
 *   attacker-controlled row reaches an unexpected service on a host that
 *   otherwise passes the name check.
 * - hostname EQUALS the configured pull zone, exactly. Not `endsWith`, which
 *   `evil-vz-x.b-cdn.net.attacker.com` would defeat, and not a pattern.
 * - no query, no fragment — Bunny's documented poster path carries neither, and
 *   allowing a query is how a caller-controlled parameter reaches the CDN.
 * - EXACTLY two path segments, the first equal to the AUTHORITATIVE Bunny video
 *   id the caller proved from the database row. This is what stops a row whose
 *   `thumbnailUrl` points at a DIFFERENT video's poster on the same pull zone
 *   from serving that other video's frame under this share link.
 * - the file name passes `isSafeBunnyFileName()` — the same allowlist the
 *   write path uses, so `..`, separators, schemes and whitespace are excluded
 *   by construction rather than by blocklist.
 *
 * The returned URL is REBUILT from `pullZoneHostname` + `bunnyVideoId` + the
 * validated file name, percent-encoded. Even a value that passed every check is
 * not the string that gets fetched.
 */
export function resolveBunnyThumbnailUpstreamUrl(
  storedUrl: string | null,
  identity: BunnyThumbnailIdentity,
): BunnyThumbnailUrlResult {
  const trimmed = storedUrl?.trim() ?? "";
  if (trimmed === "") {
    return { ok: false, reason: "NOT_ABSOLUTE" };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "NOT_ABSOLUTE" };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "NOT_HTTPS" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "HAS_CREDENTIALS" };
  }
  if (parsed.port !== "") {
    return { ok: false, reason: "HAS_PORT" };
  }
  if (parsed.search !== "") {
    return { ok: false, reason: "HAS_QUERY" };
  }
  if (parsed.hash !== "") {
    return { ok: false, reason: "HAS_FRAGMENT" };
  }
  if (parsed.hostname.toLowerCase() !== identity.pullZoneHostname) {
    return { ok: false, reason: "HOSTNAME_MISMATCH" };
  }

  const segments = parsed.pathname
    .split("/")
    .filter((segment) => segment !== "");
  if (segments.length !== 2) {
    return { ok: false, reason: "PATH_SHAPE" };
  }

  let videoSegment: string;
  let fileSegment: string;
  try {
    videoSegment = decodeURIComponent(segments[0]);
    fileSegment = decodeURIComponent(segments[1]);
  } catch {
    // A malformed percent-escape. Not a URL this backend produced.
    return { ok: false, reason: "PATH_SHAPE" };
  }

  if (
    !isSafeBunnyPathSegment(videoSegment) ||
    videoSegment !== identity.bunnyVideoId
  ) {
    return { ok: false, reason: "VIDEO_ID_MISMATCH" };
  }
  if (!isSafeBunnyFileName(fileSegment)) {
    return { ok: false, reason: "UNSAFE_FILE_NAME" };
  }

  return {
    ok: true,
    fileName: fileSegment,
    // REBUILT, not passed through. The proven identity supplies the host and
    // the video id; only the validated file name comes from the stored value.
    url: `https://${identity.pullZoneHostname}/${encodeURIComponent(
      identity.bunnyVideoId,
    )}/${encodeURIComponent(fileSegment)}`,
  };
}

/**
 * Image content types the public thumbnail proxy will pass to a browser.
 *
 * `image/svg+xml` is DELIBERATELY ABSENT. An SVG is a document: it can carry
 * script and external references, and it would be served from this API's origin
 * under a share token. Every poster this integration produces is a raster frame
 * Bunny encoded from the video, so nothing legitimate is lost. The route also
 * sends `X-Content-Type-Options: nosniff`, so a mislabelled body cannot be
 * re-interpreted by the browser either.
 */
export const ALLOWED_PROXY_IMAGE_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
];

/** Whether an upstream `Content-Type` header is an allowed image type. */
export function isAllowedProxyImageType(
  contentTypeHeader: string | null,
): boolean {
  if (contentTypeHeader === null) {
    return false;
  }

  const mediaType = contentTypeHeader.split(";", 1)[0].trim().toLowerCase();

  return ALLOWED_PROXY_IMAGE_TYPES.includes(mediaType);
}

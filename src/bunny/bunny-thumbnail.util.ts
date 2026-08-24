/**
 * Validation for Bunny Stream thumbnail (poster) delivery.
 *
 * Bunny's Get Video response gives a `thumbnailFileName`, and Bunny's documented
 * storage structure defines delivery as:
 *
 *     https://{pull_zone_hostname}/{videoId}/{thumbnailFileName}
 *
 * The hostname is configuration (`BUNNY_STREAM_PULL_ZONE_HOSTNAME`), so the URL
 * is assembled server-side rather than taken from any pre-built URL field.
 *
 * These predicates live in one place because BOTH boot-time validation
 * (`env.validation.ts`) and runtime construction (`BunnyStreamService`) must
 * agree on what a valid hostname is. If they diverged, a value could pass at
 * boot and then be silently rejected while building a URL - producing exactly
 * the "configured but no thumbnail" state this is meant to prevent.
 */

/** Max length of a DNS name, per RFC 1035. */
const MAX_HOSTNAME_LENGTH = 253;

/**
 * A dotted DNS hostname: at least two labels, letters/digits/hyphens only, no
 * label starting or ending with a hyphen, each label 1-63 characters.
 *
 * Requiring a dot is deliberate. A bare pull-zone *name* (`vz-abc123`) is a
 * common and dangerous mistake: it is a valid single label but not the CDN
 * hostname, so every thumbnail URL built from it would 404.
 */
const HOSTNAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A single safe path segment: no separators, no traversal, no scheme. */
const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Whether a value is a bare CDN hostname usable for Bunny thumbnail delivery.
 *
 * Accepts `vz-xxxxxxxx.b-cdn.net`. Rejects anything carrying a scheme, a port,
 * a path, a query, a fragment, credentials or whitespace - and rejects a bare
 * single label. Callers must lower-case and trim first.
 */
export function isBunnyPullZoneHostname(value: string): boolean {
  return value.length <= MAX_HOSTNAME_LENGTH && HOSTNAME_PATTERN.test(value);
}

/**
 * Whether a value is safe to use as one path segment of a thumbnail URL.
 *
 * Strict allowlist, so `/`, `\`, `:`, `?`, `#`, whitespace and any form of
 * `..` traversal are all excluded by construction rather than by blocklist.
 */
export function isSafeBunnyPathSegment(value: string): boolean {
  return (
    SAFE_PATH_SEGMENT_PATTERN.test(value) &&
    !value.includes("..") &&
    value !== "."
  );
}

/**
 * Whether a value is a plain file name Bunny could have reported.
 *
 * Same rules as a path segment, plus it must carry an extension - a poster is
 * always a file such as `thumbnail.jpg` or `thumbnail_ab12cd34.jpg`, never a
 * bare directory-like token.
 */
export function isSafeBunnyFileName(value: string): boolean {
  if (!isSafeBunnyPathSegment(value)) {
    return false;
  }

  const dotIndex = value.lastIndexOf(".");

  return dotIndex > 0 && dotIndex < value.length - 1;
}

import { createHash } from "node:crypto";

export function hashIpAddress(params: {
  ip: string | undefined;
  pepper: string | undefined;
}): string | null {
  const ip = params.ip?.trim();
  const pepper = params.pepper?.trim();

  if (!ip || !pepper) {
    return null;
  }

  return createHash("sha256").update(`${pepper}${ip}`, "utf8").digest("hex");
}

export function truncateAccessLogValue(
  value: string | undefined,
  maxLength: number,
): string | null {
  const trimmed = value?.trim();

  if (!trimmed) {
    return null;
  }

  return trimmed.slice(0, maxLength);
}

export function truncateDomain(value: string | null): string | null {
  return value === null ? null : truncateAccessLogValue(value, 253);
}

/**
 * The referer, reduced to the part that is safe to persist.
 *
 * A REFERER CAN CARRY A SHARE CREDENTIAL, and `AccessLog.referer` is durable
 * storage that outlives the link. Two real shapes put one in a query string:
 *
 *   /watch?r=<transportAlias>   the email-safe reviewer URL — an ALTERNATE
 *                               BEARER CREDENTIAL for the ShareLink
 *   /?token=<rawToken>          the V1 legacy form, still an accepted inbound
 *                               link, whose credential is the RAW share token
 *
 * The reviewer site sends `Referrer-Policy: no-referrer` and its one fetch
 * additionally sets `referrerPolicy: "no-referrer"`, so in the deployment we
 * control no such header arrives. That is a CLIENT policy, and a durable
 * credential store must not depend on one: another frontend, an older bundle,
 * a proxy that rewrites headers, or a browser that ignores the policy would
 * each be enough.
 *
 * So everything from the first `?` or `#` is dropped and only the origin and
 * path are kept. That is the whole diagnostic value of a referer — which page
 * the viewer came from — and none of the risk. A value that does not parse is
 * truncated at the first delimiter rather than trusted.
 */
export function sanitizeAccessLogReferer(
  value: string | undefined,
): string | null {
  const trimmed = value?.trim();

  if (!trimmed) {
    return null;
  }

  const withoutFragment = trimmed.split("#", 1)[0] ?? "";
  const withoutQuery = withoutFragment.split("?", 1)[0] ?? "";

  return truncateAccessLogValue(withoutQuery, 2048);
}

export function truncateReasonCode(value: string): string {
  return value.trim().slice(0, 80);
}

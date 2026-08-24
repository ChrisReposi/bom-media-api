import { randomBytes } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { normalizeWebsiteDomain } from "../../common/utils/domain.util";

export function generateShareToken(): string {
  return `s_${randomBytes(32).toString("base64url")}`;
}

export function generateShareAlias(): string {
  return randomBytes(5).toString("base64url");
}

/**
 * The clean (V2) public share URL.
 *
 *   https://<domain>/watch#k=<credential>
 *
 * WHY THE CREDENTIAL STAYS IN THE FRAGMENT.
 * `<credential>` is a bearer secret: `PublicService.resolvePublicWatch()`
 * accepts it as either a ShareLink `alias` or a raw share token and, once the
 * host matches, that alone authorizes the watch. A path segment or a query
 * parameter is transmitted to the static host and to every proxy in front of
 * it, so it is written into access logs that a share credential must never
 * reach. A URI fragment is never sent to any server.
 *
 * So V2 changes the PATH and not the credential's location. `/watch/<alias>`
 * was considered and rejected for exactly this reason. The previous forms
 * remain valid inbound links forever - the public site still parses every one
 * of them - this only changes what newly created links look like.
 */
function buildCleanPublicShareUrl(params: {
  protocol: string;
  domain: string;
  credential: string;
}): string {
  return `${params.protocol}://${params.domain}/watch#k=${encodeURIComponent(
    params.credential,
  )}`;
}

export function buildPublicShareUrl(params: {
  domain: string;
  alias?: string | undefined;
  token?: string | undefined;
  protocol?: string | undefined;
}): string {
  const domain = params.domain.trim();

  if (!domain) {
    throw new BadRequestException("Public share domain is required.");
  }

  const normalizedDomain = normalizeWebsiteDomain(domain);

  if (normalizedDomain === null) {
    throw new BadRequestException("Public share domain is invalid.");
  }

  const protocol = resolvePublicSiteProtocol(normalizedDomain, params.protocol);
  const alias = params.alias?.trim();

  if (alias) {
    return buildCleanPublicShareUrl({
      protocol,
      domain: normalizedDomain,
      credential: alias,
    });
  }

  const token = params.token?.trim();

  if (!token) {
    throw new BadRequestException("Public share token or alias is required.");
  }

  // The no-alias branch is not reachable from the current create path, which
  // always supplies a freshly generated alias. It previously emitted
  // `/?token=<token>#/videos`, putting a raw 256-bit share token into a query
  // string and therefore into every access log on the way. It now uses the
  // same fragment-only form as the alias branch.
  return buildCleanPublicShareUrl({
    protocol,
    domain: normalizedDomain,
    credential: token,
  });
}

/**
 * Canonical display URL for DMCA/provenance records. Uses the hash-router
 * form (`/#/s/<alias>/videos`) because the public sites are static SPAs where
 * the path form needs a server rewrite; this is also the exact shape the
 * Admin normalizer produces, so the recorded URL is byte-for-byte stable
 * regardless of which client rebuilds it. Host and protocol must come from
 * the canonical snapshot, never from the currently-preferred domain.
 *
 * DELIBERATELY NOT MIGRATED TO THE CLEAN (V2) FORM. This URL is provenance
 * evidence: the same website+video pair must keep producing a byte-identical
 * string forever, because copies of it have already been recorded in
 * DMCA/takedown submissions. Changing the shape would make previously filed
 * evidence disagree with what the system now reports for the same record. The
 * public site parses this form and the clean form identically, so a reviewer
 * following either one reaches the same ShareLink; only the recorded text is
 * pinned. Presentation of NEW links is `buildPublicShareUrl()`'s job.
 */
export function buildCanonicalPublicShareUrl(params: {
  host: string;
  alias: string;
  protocol: string;
}): string {
  const host = normalizeWebsiteDomain(params.host.trim());
  if (host === null) {
    throw new BadRequestException("Canonical share host is invalid.");
  }

  const alias = params.alias.trim();
  if (!alias) {
    throw new BadRequestException("Canonical share alias is required.");
  }

  const protocol = resolvePublicSiteProtocol(host, params.protocol);
  return `${protocol}://${host}/#/s/${encodeURIComponent(alias)}/videos`;
}

export function resolvePublicSiteProtocol(
  domain: string,
  configuredProtocol?: string,
): "http" | "https" {
  const normalizedProtocol = configuredProtocol?.trim().toLowerCase();

  if (normalizedProtocol === "http" || normalizedProtocol === "https") {
    return normalizedProtocol;
  }

  if (
    domain.startsWith("localhost") ||
    domain.startsWith("127.0.0.1") ||
    domain.startsWith("0.0.0.0") ||
    domain.includes(":5500")
  ) {
    return "http";
  }

  return "https";
}

import { randomBytes } from "node:crypto";
import { normalizeWebsiteDomain } from "../../common/utils/domain.util";

export function generateShareToken(): string {
  return `s_${randomBytes(32).toString("base64url")}`;
}

export function buildPublicShareUrl(params: {
  domain: string | null;
  token: string;
  protocol?: string | undefined;
}): string | null {
  if (params.domain === null) {
    return null;
  }

  const normalizedDomain = normalizeWebsiteDomain(params.domain);

  if (normalizedDomain === null) {
    return null;
  }

  const protocol = resolvePublicSiteProtocol(normalizedDomain, params.protocol);

  return `${protocol}://${normalizedDomain}/?token=${encodeURIComponent(
    params.token,
  )}#/videos`;
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

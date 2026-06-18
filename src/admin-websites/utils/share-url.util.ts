import { randomBytes } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { normalizeWebsiteDomain } from "../../common/utils/domain.util";

export function generateShareToken(): string {
  return `s_${randomBytes(32).toString("base64url")}`;
}

export function generateShareAlias(): string {
  return randomBytes(5).toString("base64url");
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
    return `${protocol}://${normalizedDomain}/s/${encodeURIComponent(
      alias,
    )}#/videos`;
  }

  const token = params.token?.trim();

  if (!token) {
    throw new BadRequestException("Public share token or alias is required.");
  }

  return `${protocol}://${normalizedDomain}/?token=${encodeURIComponent(
    token,
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

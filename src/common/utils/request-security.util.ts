import { createHash } from "node:crypto";
import type { Request } from "express";

export type ProxyTrustOptions = {
  trustProxyEnabled: boolean;
  trustProxyCloudflareOnly: boolean;
};

export type RequestSecurityMeta = {
  ip?: string | undefined;
  userAgent?: string | undefined;
};

export function readRequestHeader(
  request: Request,
  name: string,
): string | undefined {
  const value = request.headers[name.toLowerCase()];

  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

export function getClientIpFromRequest(
  request: Request,
  options: ProxyTrustOptions = {
    trustProxyEnabled: false,
    trustProxyCloudflareOnly: false,
  },
): string | undefined {
  if (options.trustProxyEnabled && options.trustProxyCloudflareOnly) {
    const cloudflareIp = normalizeIp(
      readRequestHeader(request, "cf-connecting-ip"),
    );

    if (cloudflareIp !== undefined) {
      return cloudflareIp;
    }
  }

  return (
    normalizeIp(request.ip) ??
    normalizeIp(request.socket.remoteAddress) ??
    undefined
  );
}

export function getRequestSecurityMeta(
  request: Request,
  options?: ProxyTrustOptions,
): RequestSecurityMeta {
  return {
    ip: getClientIpFromRequest(request, options),
    userAgent: readRequestHeader(request, "user-agent"),
  };
}

export function hashSensitiveValue(params: {
  value: string | undefined;
  pepper: string | undefined;
}): string | null {
  const value = params.value?.trim();
  const pepper = params.pepper?.trim();

  if (!value || !pepper) {
    return null;
  }

  return createHash("sha256").update(`${pepper}${value}`, "utf8").digest("hex");
}

export function truncateRequestValue(
  value: string | undefined,
  maxLength: number,
): string | null {
  const trimmed = value?.trim();

  if (!trimmed) {
    return null;
  }

  return trimmed.slice(0, maxLength);
}

function normalizeIp(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed ? trimmed : undefined;
}

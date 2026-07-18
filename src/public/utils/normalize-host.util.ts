import { normalizeWebsiteDomain } from "../../common/utils/domain.util";

export function normalizePublicHost(rawHost: unknown): string | null {
  if (typeof rawHost !== "string" || rawHost.length > 253) {
    return null;
  }

  return normalizeWebsiteDomain(rawHost);
}

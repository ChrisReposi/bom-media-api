import { normalizeWebsiteDomain } from "../../common/utils/domain.util";

export function normalizePublicHost(rawHost: string): string | null {
  return normalizeWebsiteDomain(rawHost);
}

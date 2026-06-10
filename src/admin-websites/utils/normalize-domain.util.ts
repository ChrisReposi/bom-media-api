import { normalizeWebsiteDomain } from "../../common/utils/domain.util";

export function normalizeDomain(rawDomain: string): string | null {
  return normalizeWebsiteDomain(rawDomain);
}

export function normalizeWebsiteSlug(rawSlug: string): string {
  return rawSlug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 120);
}

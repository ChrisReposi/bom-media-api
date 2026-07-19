export const ADMIN_WEBSITE_SEARCH_MIN_LENGTH = 2;
export const ADMIN_WEBSITE_SEARCH_MAX_LENGTH = 80;

export function normalizeAdminWebsiteSearch(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  return value
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, ADMIN_WEBSITE_SEARCH_MAX_LENGTH);
}

export function isShortAdminWebsiteSearch(value: string | undefined): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length < ADMIN_WEBSITE_SEARCH_MIN_LENGTH
  );
}

export const ADMIN_VIDEO_SEARCH_MIN_LENGTH = 2;
export const ADMIN_VIDEO_SEARCH_MAX_LENGTH = 80;

export function normalizeAdminVideoSearch(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, ADMIN_VIDEO_SEARCH_MAX_LENGTH);
}

export function isShortAdminVideoSearch(value: string): boolean {
  return value.length > 0 && value.length < ADMIN_VIDEO_SEARCH_MIN_LENGTH;
}

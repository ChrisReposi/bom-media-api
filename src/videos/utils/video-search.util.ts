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

/**
 * Prisma `contains` with the MariaDB driver adapter does not escape LIKE
 * metacharacters, so `s%l` matched "sml" and `%%`/`__` matched the whole
 * table (verified over HTTP against local MySQL 8). Escape `\`, `%` and `_`
 * so admin search always matches literally. MySQL's default LIKE escape
 * character is backslash, so no ESCAPE clause is needed.
 *
 * Apply this only when building the `contains` filter — cache keys and the
 * short-search length check must keep using the unescaped normalized value.
 */
export function escapeAdminVideoSearchLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export const VIDEO_FILTER_KEY_MAX_LENGTH = 64;

const VALID_VIDEO_FILTER_KEY_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const RESERVED_VIDEO_FILTER_KEYS = new Set(["all"]);

export function normalizeVideoFilterKey(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const normalized = String(value)
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized.length === 0 ? undefined : normalized;
}

export function isValidVideoFilterKey(value: string): boolean {
  return (
    value.length <= VIDEO_FILTER_KEY_MAX_LENGTH &&
    VALID_VIDEO_FILTER_KEY_PATTERN.test(value) &&
    !RESERVED_VIDEO_FILTER_KEYS.has(value)
  );
}

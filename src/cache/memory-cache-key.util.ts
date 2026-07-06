import { createHash } from "node:crypto";

const MAX_READABLE_CACHE_PART_LENGTH = 80;
const HASH_LENGTH = 32;

type JsonLike =
  | null
  | string
  | number
  | boolean
  | JsonLike[]
  | { [key: string]: JsonLike };

export function normalizeCachePart(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    const normalized = value.normalize("NFC").trim().replace(/\s+/g, " ");

    return normalized.length > MAX_READABLE_CACHE_PART_LENGTH
      ? `sha256:${hashCacheKeyPart(normalized)}`
      : normalized;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  const serialized = stableStringify(value);

  return serialized.length > MAX_READABLE_CACHE_PART_LENGTH
    ? `sha256:${hashCacheKeyPart(serialized)}`
    : serialized;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(toStableJsonLike(value));
}

export function hashCacheKeyPart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, HASH_LENGTH);
}

export function buildCacheKey(
  ...parts: Array<string | number | boolean | null | undefined>
): string {
  return parts.map((part) => normalizeCachePart(part)).join(":");
}

function toStableJsonLike(value: unknown): JsonLike {
  if (value === null || value === undefined) {
    return null;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => toStableJsonLike(item));
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;

    return Object.keys(record)
      .sort()
      .reduce<Record<string, JsonLike>>((accumulator, key) => {
        accumulator[key] = toStableJsonLike(record[key]);
        return accumulator;
      }, {});
  }

  return String(value);
}

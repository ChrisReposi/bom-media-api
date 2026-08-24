import { registerDecorator } from "class-validator";
import type { ValidationArguments, ValidationOptions } from "class-validator";

/**
 * `viewCount` IS A CANONICAL DECIMAL DIGIT STRING AT THE API BOUNDARY.
 *
 * WHY A STRING, AND ONLY A STRING. The column is `BIGINT` and the API
 * serialises it back as a string, so the contract must be able to express
 * integers a JSON number cannot hold exactly. It cannot.
 *
 *   { "viewCount": 9007199254740993 }
 *
 * `JSON.parse` turns that literal into the IEEE-754 double 9007199254740992 —
 * a DIFFERENT integer — before any validator or transform ever sees it. The
 * value is already corrupt on arrival, so no amount of care further down the
 * pipeline can recover it. The DTOs previously ran the parsed number through
 * `String(value)`, which produced the plausible-looking `"9007199254740992"`,
 * passed `/^\d+$/`, and persisted silently wrong.
 *
 * The only fix is to refuse the numeric form. `typeof value === "string"` is
 * checked FIRST, before any coercion, so a JSON number is rejected rather than
 * stringified. A client that wants an exact count sends exact digits:
 *
 *   { "viewCount": "9007199254740993" }        accepted, exact
 *   { "viewCount": 9007199254740993 }          rejected
 *   { "viewCount": 2630122 }                   rejected
 *
 * Numeric JSON is rejected outright, including values inside the safe integer
 * range. No shipped or internal caller sends one: the admin console sends the
 * canonical string on every path, `public_website` only ever READS the field,
 * and the sole numeric occurrence in this repository was a Swagger example.
 * Accepting a "safe" subset would mean the contract silently depended on
 * JavaScript's number range, which is exactly the coupling this removes.
 *
 * GROUPING IS A UI CONCERN. `"2.630.122"` is rejected here. The admin console
 * canonicalises human grouping before it sends anything — see
 * `bom-media-admin/src/features/videos/viewCountUtils.ts`.
 */

/** The canonical form: base-10 digits, nothing else. */
export const CANONICAL_VIEW_COUNT_PATTERN = /^\d+$/;

/**
 * The real upper bound of the column, not an invented one.
 *
 * `prisma/schema.prisma` declares `viewCount BigInt`, which the MySQL/MariaDB
 * connector maps to signed `BIGINT` (confirmed in
 * `prisma/migrations/20260531090000_add_video_admin_fields/migration.sql`).
 * Enforcing it here turns an opaque driver-level overflow into a `400` that
 * names the limit.
 */
export const MAX_VIEW_COUNT = 9223372036854775807n;

/** Digits in `MAX_VIEW_COUNT`; bounds the work done before the BigInt compare. */
const MAX_VIEW_COUNT_DIGITS = 19;

export const VIEW_COUNT_INVALID_MESSAGE =
  "viewCount must be a non-negative integer";

export const VIEW_COUNT_MUST_BE_STRING_MESSAGE =
  "viewCount must be sent as a JSON string of decimal digits, not a JSON number";

export const VIEW_COUNT_TOO_LARGE_MESSAGE = `viewCount must not exceed ${MAX_VIEW_COUNT.toString()}`;

/**
 * Normalises ONLY what the contract allows, and never changes a value's type.
 *
 * A non-string is passed through UNTOUCHED so the validator can see that it
 * was not a string and reject it. This is the whole point: a transform that
 * stringified a number here would hide the precision loss described above.
 *
 * `undefined`, `null` and `""` collapse to `undefined`, preserving the existing
 * "not supplied" contract — 0 on create, unchanged on update. Surrounding
 * whitespace on a string is trimmed, which is a harmless paste artefact.
 */
export function normalizeCanonicalViewCount(value: unknown): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();

  return trimmed === "" ? undefined : trimmed;
}

/** True only for a canonical digit string within the column's range. */
export function isCanonicalViewCount(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  if (!CANONICAL_VIEW_COUNT_PATTERN.test(value)) {
    return false;
  }

  const significant = value.replace(/^0+(?=\d)/, "");

  if (significant.length > MAX_VIEW_COUNT_DIGITS) {
    return false;
  }

  return BigInt(significant) <= MAX_VIEW_COUNT;
}

/**
 * Validates `viewCount` on every DTO that accepts it.
 *
 * One decorator so MANUAL, EMBED, LOCAL_FILE, DB_BLOB and BUNNY cannot drift
 * apart. The message distinguishes the three failure modes, because "not a
 * non-negative integer" is unhelpful when the real problem is that the client
 * sent `2630122` instead of `"2630122"`.
 */
export function IsCanonicalViewCount(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return function registerIsCanonicalViewCount(
    target: object,
    propertyName: string | symbol,
  ): void {
    registerDecorator({
      name: "isCanonicalViewCount",
      target: target.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return isCanonicalViewCount(value);
        },
        defaultMessage(args: ValidationArguments): string {
          const { value } = args;

          if (typeof value === "number" || typeof value === "bigint") {
            return VIEW_COUNT_MUST_BE_STRING_MESSAGE;
          }

          if (
            typeof value === "string" &&
            CANONICAL_VIEW_COUNT_PATTERN.test(value)
          ) {
            return VIEW_COUNT_TOO_LARGE_MESSAGE;
          }

          return VIEW_COUNT_INVALID_MESSAGE;
        },
      },
    });
  };
}

/**
 * Converts a validated canonical string to the exact `bigint` the column holds.
 *
 * `BigInt()` alone would be too permissive as a last line of defence — it
 * accepts `"0x10"`, `" 12 "` and `""` — so the canonical check is repeated
 * here. It never goes through `Number`, `parseInt` or `parseFloat`, so
 * `"9007199254740993"` becomes `9007199254740993n` exactly.
 */
export function toViewCountBigInt(value: string): bigint {
  if (!isCanonicalViewCount(value)) {
    throw new TypeError(VIEW_COUNT_INVALID_MESSAGE);
  }

  return BigInt(value);
}

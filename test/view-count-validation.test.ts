/**
 * `viewCount` IS A CANONICAL DECIMAL DIGIT STRING — enforced at the API
 * boundary, for every provider.
 *
 * TWO BUGS THIS SUITE PINS.
 *
 * 1. The admin console used an `<input type="number">` for "Lượt xem". Pasting
 *    a human-grouped figure such as `2.630.122` let the browser's numeric
 *    sanitisation reinterpret the grouping separators as a DECIMAL POINT, so
 *    the value silently became `2.630122` — wrong by a factor of a hundred
 *    thousand, and plausible enough to miss.
 *
 * 2. The DTOs accepted a JSON NUMBER and stringified it before validation.
 *    That is unrecoverable precision loss, not a convenience:
 *
 *      { "viewCount": 9007199254740993 }
 *
 *    `JSON.parse` produces the double 9007199254740992 — a DIFFERENT integer —
 *    before any transform runs. `String(value)` then yielded the
 *    plausible-looking `"9007199254740992"`, which passed `/^\d+$/` and was
 *    persisted as fact.
 *
 * THE CONTRACT NOW: `viewCount` must be a JSON STRING of decimal digits.
 *
 *   - the DTOs declare `viewCount?: string` validated with
 *     `@IsCanonicalViewCount()`, which checks `typeof value === "string"`
 *     FIRST, before any coercion;
 *   - `VideosService.parseViewCount()` converts it with `BigInt()`.
 *
 * So the value never passes through a JS float and never risks precision loss —
 * which matters because the column is `BIGINT` and the API serialises it back
 * as a string.
 *
 * Every video-creation DTO is covered, because a view count must mean the same
 * thing for MANUAL, EMBED, LOCAL_FILE, DB_BLOB and BUNNY alike.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { CreateVideoDto } from "../src/videos/dto/create-video.dto";
import { CreateEmbedVideoDto } from "../src/videos/dto/create-embed-video.dto";
import { InitBunnyVideoUploadDto } from "../src/videos/dto/init-bunny-video-upload.dto";
import { InitLocalVideoUploadDto } from "../src/videos/dto/init-local-video-upload.dto";
import { UpdateVideoDto } from "../src/videos/dto/update-video.dto";
import { UploadDatabaseVideoDto } from "../src/videos/dto/upload-database-video.dto";
import { UploadVideoDto } from "../src/videos/dto/upload-video.dto";
import {
  MAX_VIEW_COUNT,
  isCanonicalViewCount,
  toViewCountBigInt,
} from "../src/videos/utils/view-count.util";

/** Every DTO that accepts a view count, with a minimal otherwise-valid body. */
const DTOS = [
  ["CreateVideoDto", CreateVideoDto, { title: "t", playbackUrl: "https://e.test/v.mp4" }],
  ["CreateEmbedVideoDto", CreateEmbedVideoDto, { title: "t", embedUrl: "https://www.youtube.com/embed/abc" }],
  ["InitBunnyVideoUploadDto", InitBunnyVideoUploadDto, { title: "t" }],
  ["InitLocalVideoUploadDto", InitLocalVideoUploadDto, {
    title: "t",
    originalFilename: "v.mp4",
    mimeType: "video/mp4",
    totalBytes: 1024,
  }],
  ["UpdateVideoDto", UpdateVideoDto, {}],
  ["UploadDatabaseVideoDto", UploadDatabaseVideoDto, { title: "t" }],
  ["UploadVideoDto", UploadVideoDto, { title: "t" }],
] as const;

/** Runs the real transform + validation pipeline for one DTO. */
function validateViewCount(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  DtoClass: any,
  base: Record<string, unknown>,
  viewCount: unknown,
): { errors: string[]; value: unknown } {
  const instance = plainToInstance(DtoClass, { ...base, viewCount }) as Record<
    string,
    unknown
  >;
  const errors = validateSync(instance as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  return {
    errors: errors
      .filter((error) => error.property === "viewCount")
      .flatMap((error) => Object.values(error.constraints ?? {})),
    value: instance.viewCount,
  };
}

/** Asserts every DTO accepts the value and leaves it untouched. */
function assertAcceptedEverywhere(accepted: string): void {
  for (const [name, DtoClass, base] of DTOS) {
    const result = validateViewCount(DtoClass, base, accepted);
    assert.deepEqual(
      result.errors,
      [],
      `${name} must accept ${JSON.stringify(accepted)}`,
    );
    assert.equal(
      result.value,
      accepted,
      `${name} must leave ${JSON.stringify(accepted)} untouched`,
    );
  }
}

/** Renders any value for a failure message. `JSON.stringify` throws on bigint. */
function describeValue(value: unknown): string {
  return typeof value === "bigint" ? `${value.toString()}n` : String(value);
}

/** Asserts every DTO rejects the value and never yields a usable number. */
function assertRejectedEverywhere(rejected: unknown): void {
  for (const [name, DtoClass, base] of DTOS) {
    const result = validateViewCount(DtoClass, base, rejected);
    assert.ok(
      result.errors.length > 0,
      `${name} must reject ${describeValue(rejected)} but accepted it as ${describeValue(result.value)}`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Accepted — a canonical digit STRING
 * ------------------------------------------------------------------ */

describe("viewCount accepts a canonical non-negative integer string", () => {
  it("every DTO accepts the canonical digit string", () => {
    for (const accepted of ["0", "1", "100", "2630122", "999999999"]) {
      assertAcceptedEverywhere(accepted);
    }
  });

  it("2630122 survives end to end as an exact integer", () => {
    // The value from the original bug report, in the form the console sends.
    const result = validateViewCount(CreateVideoDto, DTOS[0][2], "2630122");

    assert.deepEqual(result.errors, []);
    assert.equal(result.value, "2630122");
    assert.equal(BigInt(String(result.value)), 2630122n);
  });

  it("omitting viewCount is valid and stays undefined", () => {
    // The existing empty contract: omitted means "not supplied", which the
    // service defaults to 0 on create and leaves untouched on update.
    for (const [name, DtoClass, base] of DTOS) {
      const instance = plainToInstance(DtoClass, { ...base }) as Record<
        string,
        unknown
      >;
      const errors = validateSync(instance as object).filter(
        (error) => error.property === "viewCount",
      );
      assert.deepEqual(errors, [], `${name} must allow an omitted viewCount`);
      assert.equal(instance.viewCount, undefined);
    }
  });

  it("an empty string is normalised to undefined, never to 0", () => {
    for (const [name, DtoClass, base] of DTOS) {
      const result = validateViewCount(DtoClass, base, "");
      assert.deepEqual(result.errors, [], `${name} must allow an empty string`);
      assert.equal(result.value, undefined, `${name} must not coerce "" to 0`);
    }
  });

  it("TRIMS surrounding whitespace rather than rejecting it", () => {
    // Deliberately NOT a rejection: a harmless paste artefact, and trimming it
    // loses nothing - unlike an internal space, which is ambiguous and IS
    // rejected below.
    const result = validateViewCount(CreateVideoDto, DTOS[0][2], " 2630122 ");

    assert.deepEqual(result.errors, []);
    assert.equal(result.value, "2630122");
  });
});

/* ------------------------------------------------------------------ *
 * Rejected strings
 * ------------------------------------------------------------------ */

describe("viewCount rejects every non-canonical string", () => {
  const REJECTED: Array<[string, unknown]> = [
    ["the corrupted decimal the number input produced", "2.630122"],
    ["a plain decimal", "2.5"],
    ["a decimal integer with a trailing fraction", "2630122.5"],
    ["scientific notation", "2e3"],
    ["upper-case scientific notation", "2E3"],
    ["a negative value", "-1"],
    ["a signed positive value", "+1"],
    ["human grouping with dots", "2.630.122"],
    ["human grouping with commas", "2,630,122"],
    ["human grouping with spaces", "2 630 122"],
    ["human grouping with underscores", "2_630_122"],
    ["free text", "abc"],
    ["digits with a suffix", "12abc34"],
    ["a hex literal", "0x10"],
    ["an internal space", "26 30122"],
    ["NaN as text", "NaN"],
    ["Infinity as text", "Infinity"],
  ];

  for (const [label, rejected] of REJECTED) {
    it(`rejects ${label}: ${JSON.stringify(rejected)}`, () => {
      assertRejectedEverywhere(rejected);
    });
  }

  it("NEVER truncates or rounds a decimal into a wrong integer", () => {
    // The worst failure mode: silently storing 2 for "2.5", or 2630122 for the
    // corrupted "2.630122". Rejection is the only safe answer.
    for (const decimal of ["2.5", "2.9", "2.630122", "2630122.5"]) {
      const result = validateViewCount(CreateVideoDto, DTOS[0][2], decimal);
      assert.ok(result.errors.length > 0, `${decimal} must be rejected`);
    }
  });

  it("GROUPING IS A UI CONCERN and is rejected at the API boundary", () => {
    // The console canonicalises "2.630.122" to "2630122" before sending. The
    // API itself accepts only the canonical form - the two layers are
    // deliberately different.
    assertRejectedEverywhere("2.630.122");
    assertAcceptedEverywhere("2630122");
  });

  it("the rejection message names the field and the rule", () => {
    const result = validateViewCount(CreateVideoDto, DTOS[0][2], "2.5");

    assert.ok(
      result.errors.some((message) =>
        /viewCount must be a non-negative integer/.test(message),
      ),
      `unexpected messages: ${JSON.stringify(result.errors)}`,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Rejected JSON numbers — blocker 2
 * ------------------------------------------------------------------ */

describe("viewCount rejects a JSON number outright", () => {
  it("rejects an ordinary numeric body value", () => {
    // `{ "viewCount": 2630122 }`. Correct in value, wrong in type: accepting it
    // would make the contract depend on JavaScript's number range.
    assertRejectedEverywhere(2630122);
  });

  it("rejects every numeric form, safe or not", () => {
    for (const numeric of [
      0,
      1,
      2630122,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
      9007199254740993,
      2.5,
      -1,
      2630122.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      assertRejectedEverywhere(numeric);
    }
  });

  it("names the actual problem when a number is sent", () => {
    const result = validateViewCount(CreateVideoDto, DTOS[0][2], 2630122);

    assert.ok(
      result.errors.some((message) =>
        /must be sent as a JSON string of decimal digits, not a JSON number/.test(
          message,
        ),
      ),
      `unexpected messages: ${JSON.stringify(result.errors)}`,
    );
  });

  it("THE UNSAFE NUMBER can never be persisted as its IEEE-754 neighbour", () => {
    // This is the blocker in one assertion. The literal 9007199254740993 is
    // already 9007199254740992 by the time any code here sees it, so the only
    // safe behaviour is refusal.
    const parsedByJson = JSON.parse('{"viewCount":9007199254740993}') as {
      viewCount: number;
    };

    assert.equal(
      parsedByJson.viewCount,
      9007199254740992,
      "JSON.parse itself loses the value - this is why numbers are refused",
    );

    for (const [name, DtoClass, base] of DTOS) {
      const result = validateViewCount(DtoClass, base, parsedByJson.viewCount);
      assert.ok(
        result.errors.length > 0,
        `${name} must reject the unsafe number instead of persisting it`,
      );
      assert.notEqual(
        result.value,
        "9007199254740992",
        `${name} must not stringify the corrupted value into the canonical form`,
      );
    }
  });

  it("rejects a bigint body value too", () => {
    // Not reachable over JSON, but a programmatic caller must not sneak past
    // the string requirement either.
    assertRejectedEverywhere(9007199254740993n);
  });
});

/* ------------------------------------------------------------------ *
 * Exact BigInt persistence — beyond Number.MAX_SAFE_INTEGER
 * ------------------------------------------------------------------ */

describe("viewCount persists exactly, past Number.MAX_SAFE_INTEGER", () => {
  it("accepts 9007199254740993 as a string on every DTO", () => {
    assertAcceptedEverywhere("9007199254740993");
  });

  it("9007199254740993 becomes exactly 9007199254740993n", () => {
    const result = validateViewCount(
      CreateVideoDto,
      DTOS[0][2],
      "9007199254740993",
    );

    assert.deepEqual(result.errors, []);
    assert.equal(result.value, "9007199254740993");

    const stored = toViewCountBigInt(String(result.value));

    assert.equal(stored, 9007199254740993n);
    assert.notEqual(stored, 9007199254740992n, "the neighbouring double");
    assert.equal(stored.toString(), "9007199254740993", "exact round trip");

    // Proof the value is genuinely outside what a double can represent.
    assert.equal(Number.isSafeInteger(Number("9007199254740993")), false);
    assert.equal(Number("9007199254740993"), 9007199254740992);
  });

  it("accepts the largest value the BIGINT column can hold", () => {
    // prisma/schema.prisma declares `viewCount BigInt` -> signed 64-bit BIGINT.
    const max = MAX_VIEW_COUNT.toString();

    assert.equal(max, "9223372036854775807");
    assertAcceptedEverywhere(max);
    assert.equal(toViewCountBigInt(max), MAX_VIEW_COUNT);
  });

  it("rejects one past the column's range instead of overflowing the DB", () => {
    // Reporting the real limit beats an opaque driver error at INSERT time.
    const overflow = (MAX_VIEW_COUNT + 1n).toString();

    assertRejectedEverywhere(overflow);

    const result = validateViewCount(CreateVideoDto, DTOS[0][2], overflow);
    assert.ok(
      result.errors.some((message) => /must not exceed 9223372036854775807/.test(message)),
      `unexpected messages: ${JSON.stringify(result.errors)}`,
    );
  });

  it("the shared predicate agrees with the DTOs", () => {
    for (const value of ["0", "2630122", "9007199254740993", "9223372036854775807"]) {
      assert.equal(isCanonicalViewCount(value), true, value);
    }
    for (const value of ["2.5", "-1", "+1", "2e3", "abc", "0x10", "2.630.122", "", " 1", 1, 1n, null, undefined]) {
      assert.equal(isCanonicalViewCount(value), false, describeValue(value));
    }
  });

  it("toViewCountBigInt refuses anything BigInt() would have accepted loosely", () => {
    // BigInt() alone takes "0x10" (=16), " 12 " and "" (=0). The guard stops a
    // future caller smuggling a different number past the DTO layer.
    for (const value of ["0x10", " 12 ", "", "-1", "1e3"]) {
      assert.throws(
        () => toViewCountBigInt(value),
        /viewCount must be a non-negative integer/,
        `${JSON.stringify(value)} must throw`,
      );
    }
  });
});

/* ------------------------------------------------------------------ *
 * Provider consistency
 * ------------------------------------------------------------------ */

describe("viewCount means the same thing for every provider", () => {
  it("all seven creation/update DTOs share one rule", () => {
    // MANUAL, EMBED, LOCAL_FILE (Hostinger NVMe), DB_BLOB and BUNNY all route
    // through these DTOs. A divergence here would let one provider store a
    // value another rejects.
    assertAcceptedEverywhere("2630122");
    assertAcceptedEverywhere("9007199254740993");
    assertRejectedEverywhere("2.630.122");
    assertRejectedEverywhere(2630122);
  });

  it("no DTO stringifies a number behind the validator's back", () => {
    // The exact regression: a transform that ran String(value) BEFORE
    // validation made every numeric body value look canonical.
    for (const [name, DtoClass, base] of DTOS) {
      const instance = plainToInstance(DtoClass, {
        ...base,
        viewCount: 2630122,
      }) as Record<string, unknown>;

      assert.equal(
        typeof instance.viewCount,
        "number",
        `${name} must leave a number as a number so validation can reject it`,
      );
    }
  });
});

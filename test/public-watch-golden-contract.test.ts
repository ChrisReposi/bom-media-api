/**
 * THE GOLDEN `#k` CONTRACT — pinned against the PRE-FEATURE HEAD.
 *
 * Every literal below was read out of `git show HEAD:` before any of the
 * email-safe, resume or alias-free work landed. Nothing here was derived from
 * what the code currently emits, and nothing here may be "updated to match" a
 * change — that is the one edit this file exists to make impossible.
 *
 * WHY IT EXISTS. `resumeGrant` was briefly added to `PublicWatchResponse` as a
 * REQUIRED property, so it appeared as `null` on the `#k` success body, on the
 * legacy `GET` body and on every denial. The justification was
 * anti-enumeration — a field present only on success would let the shape of a
 * reply reveal its outcome. That argument does not survive contact with the
 * body: `valid` already announces the outcome, so the field disclosed nothing
 * new, while silently changing a serialized contract that deployed public
 * sites and the release-blocking compatibility manifest were written against.
 * The regression was then absorbed by editing the old fixtures, which is how a
 * contract quietly becomes whatever the code does.
 *
 * WHAT IS PINNED, deliberately at the byte level rather than field by field:
 *
 *   - the exact serialized JSON of a `#k` success body
 *   - the exact serialized JSON of every denial body
 *   - PROPERTY ORDER, because these are compared as serialized strings
 *   - the legacy `GET /public/watch` body, which older bundles still use
 *   - and the ONE permitted addition: `resumeGrant` on a compat success
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ShareLinkStatus, VideoStatus } from "../src/generated/prisma/client";
import type { PublicWatchResponse } from "../src/public/types/public-watch-response.type";
import {
  createCompatHarness,
  directUrlVideo,
  FOREIGN_HOST,
  LEGACY_ALIAS,
  LEGACY_HOST,
  LEGACY_RAW_TOKEN,
  LEGACY_TRANSPORT_ALIAS,
  localFileVideo,
  UNKNOWN_HOST,
  type CompatHarnessOptions,
} from "./share-link-compat-harness";

const REQUEST_META = {
  ip: "203.0.113.5",
  userAgent: "golden-contract",
  referer: undefined,
};

/**
 * THE PRE-FEATURE DENIAL BODY, byte for byte.
 *
 * Read from `git show HEAD:src/public/public.service.ts` →
 * `invalidResponse()`, which has returned exactly this since the API shipped.
 * The key ORDER is part of it, because the assertions compare serialized
 * strings.
 */
const GOLDEN_DENIAL_JSON =
  '{"valid":false,"reasonCode":"INVALID_LINK","website":null,"videos":[]}';

/**
 * A COMPLETE PRE-FEATURE CANONICAL SUCCESS, including nested objects, the
 * entire video array and representative protected media URL structure.
 *
 * This is intentionally an in-source string literal. It is never generated
 * from current code and never reads Git, the filesystem or build output, so it
 * remains a historical oracle after this feature is committed and in CI.
 */
const GOLDEN_LOCAL_FILE_SUCCESS_JSON =
  '{"valid":true,"reasonCode":"OK","website":{"id":"website-compat-a","name":"Customer Website","slug":"customer-website","domain":"customer.example.com"},"videos":[{"id":"video-local-file","title":"Legacy shared video","description":null,"sourceType":"LOCAL_FILE","playbackUrl":null,"binaryPlaybackUrl":null,"publicPlaybackUrl":"/api/v1/public/watch/Ab3dEf7/videos/video-local-file/local-file?host=customer.example.com","binaryAsset":null,"localFileAsset":{"mimeType":"video/mp4","sizeBytes":"10"},"embedUrl":null,"embedProvider":null,"embedAllow":null,"thumbnailUrl":"/api/v1/public/watch/Ab3dEf7/videos/video-local-file/thumbnail?host=customer.example.com","publicThumbnailUrl":"/api/v1/public/watch/Ab3dEf7/videos/video-local-file/thumbnail?host=customer.example.com","durationSeconds":42,"viewCount":"1234","publishedAt":"2026-01-15T00:00:00.000Z"}]}';

/** The property set of a PRE-FEATURE success body, in declaration order. */
const GOLDEN_SUCCESS_PROPERTIES = ["valid", "reasonCode", "website", "videos"];

function harness(overrides: Partial<CompatHarnessOptions> = {}) {
  return createCompatHarness({
    videos: [directUrlVideo()],
    ...overrides,
    shareLink: {
      transportAlias: LEGACY_TRANSPORT_ALIAS,
      ...(overrides.shareLink ?? {}),
    },
  });
}

/* ------------------------------------------------------------------ *
 * The `#k` success body
 * ------------------------------------------------------------------ */

describe("GOLDEN the #k success body is the pre-feature contract", () => {
  it("serializes one complete LOCAL_FILE success to the static historical fixture", async () => {
    const { service } = harness({ videos: [localFileVideo()] });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
      requestMeta: REQUEST_META,
    });

    assert.equal(JSON.stringify(response), GOLDEN_LOCAL_FILE_SUCCESS_JSON);
  });

  for (const [label, token] of [
    ["the alias", LEGACY_ALIAS],
    ["the raw share token", LEGACY_RAW_TOKEN],
  ] as const) {
    it(`carries exactly the historical properties, in order, for ${label}`, async () => {
      const { service } = harness();

      const response = await service.resolvePublicWatch({
        host: LEGACY_HOST,
        token,
        requestMeta: REQUEST_META,
      });

      assert.equal(response.valid, true);
      // ORDER, not just membership: these bodies are compared as serialized
      // strings elsewhere, and a reordered key is a different string.
      assert.deepEqual(Object.keys(response), GOLDEN_SUCCESS_PROPERTIES);
      // And `resumeGrant` is ABSENT — not present-and-null. `in` is the check
      // that tells those two apart; `=== undefined` cannot.
      assert.equal("resumeGrant" in response, false);
      assert.equal(
        JSON.stringify(response).includes("resumeGrant"),
        false,
        "the #k success body serialized a resumeGrant key",
      );
    });
  }

  it("the legacy GET body is the same body", async () => {
    // `GET /public/watch` and `POST /public/watch/exchange` share one
    // resolver, and older deployed bundles still use the GET. Asserted
    // separately anyway, because "share one resolver" is a claim about code.
    const { service } = harness();

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
      requestMeta: REQUEST_META,
    });

    assert.deepEqual(Object.keys(response), GOLDEN_SUCCESS_PROPERTIES);
    assert.equal("resumeGrant" in response, false);
  });

  it("a resumed body also carries exactly the historical properties", async () => {
    // A resume is a continuation, not a new session, so it is issued no fresh
    // grant — and therefore emits the historical property set too.
    const { service } = harness();

    const opened = await service.resolvePublicWatchCompatible({
      host: LEGACY_HOST,
      alias: LEGACY_TRANSPORT_ALIAS,
      requestMeta: REQUEST_META,
    });
    const resumed = await service.resolvePublicWatchResume({
      host: LEGACY_HOST,
      grant: opened.resumeGrant as string,
      requestMeta: REQUEST_META,
    });

    assert.equal(resumed.valid, true);
    assert.deepEqual(Object.keys(resumed), GOLDEN_SUCCESS_PROPERTIES);
    assert.equal("resumeGrant" in resumed, false);
  });
});

/* ------------------------------------------------------------------ *
 * Every denial body
 * ------------------------------------------------------------------ */

describe("GOLDEN every denial body is byte-identical to the pre-feature one", () => {
  const denials: Array<[string, () => Promise<PublicWatchResponse>]> = [];

  const push = (
    label: string,
    build: () => Promise<PublicWatchResponse>,
  ): void => {
    denials.push([label, build]);
  };

  push("an unknown host", async () =>
    harness().service.resolvePublicWatch({
      host: UNKNOWN_HOST,
      token: LEGACY_ALIAS,
      requestMeta: REQUEST_META,
    }),
  );
  push("a foreign host", async () =>
    harness().service.resolvePublicWatch({
      host: FOREIGN_HOST,
      token: LEGACY_ALIAS,
      requestMeta: REQUEST_META,
    }),
  );
  push("an unknown credential", async () =>
    harness().service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: "not-a-credential",
      requestMeta: REQUEST_META,
    }),
  );
  push("a missing credential", async () =>
    harness().service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: "",
      requestMeta: REQUEST_META,
    }),
  );
  push("a missing host", async () =>
    harness().service.resolvePublicWatch({
      host: "",
      token: LEGACY_ALIAS,
      requestMeta: REQUEST_META,
    }),
  );
  push("a REVOKED link", async () =>
    harness({
      shareLink: { status: ShareLinkStatus.REVOKED },
    }).service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
      requestMeta: REQUEST_META,
    }),
  );
  push("an EXPIRED link", async () =>
    harness({
      shareLink: { expiresAt: new Date("2020-01-01T00:00:00.000Z") },
    }).service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
      requestMeta: REQUEST_META,
    }),
  );
  push("an exhausted view budget", async () =>
    harness({
      shareLink: { maxViews: 1, currentViews: 1 },
    }).service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
      requestMeta: REQUEST_META,
    }),
  );
  push("no playable video", async () =>
    harness({
      videos: [directUrlVideo({ status: VideoStatus.DISABLED })],
    }).service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
      requestMeta: REQUEST_META,
    }),
  );
  push("a refused COMPATIBILITY exchange", async () =>
    harness().service.resolvePublicWatchCompatible({
      host: LEGACY_HOST,
      alias: "uNkNoWnTrAnSpOrT_89efg",
      requestMeta: REQUEST_META,
    }),
  );
  push("a refused RESUME", async () =>
    harness().service.resolvePublicWatchResume({
      host: LEGACY_HOST,
      grant: "forged.grant",
      requestMeta: REQUEST_META,
    }),
  );

  for (const [label, build] of denials) {
    it(`${label} serializes to the golden denial`, async () => {
      const response = await build();

      // THE BYTE-LEVEL ASSERTION. Not a property set, not a deepEqual against
      // an object literal that could be edited alongside the code — the exact
      // string the pre-feature build returned.
      assert.equal(JSON.stringify(response), GOLDEN_DENIAL_JSON);
    });
  }

  it("and there are enough of them for that to mean something", () => {
    // Guards against the loop silently emptying.
    assert.ok(denials.length >= 11, String(denials.length));
  });
});

/* ------------------------------------------------------------------ *
 * The ONE permitted addition
 * ------------------------------------------------------------------ */

describe("GOLDEN only a compat success may add resumeGrant", () => {
  it("adds it, and adds nothing else, and adds it last", async () => {
    const { service } = harness();

    const response = await service.resolvePublicWatchCompatible({
      host: LEGACY_HOST,
      alias: LEGACY_TRANSPORT_ALIAS,
      requestMeta: REQUEST_META,
    });

    assert.equal(response.valid, true);
    assert.deepEqual(Object.keys(response), [
      ...GOLDEN_SUCCESS_PROPERTIES,
      "resumeGrant",
    ]);
    assert.equal(typeof response.resumeGrant, "string");
  });

  it("omits it when the link is not eligible for a session", async () => {
    // A budgeted link gets no grant, and therefore no key — so an ineligible
    // compat success is byte-identical to a `#k` success.
    const { service } = harness({ shareLink: { maxViews: 5, currentViews: 0 } });

    const response = await service.resolvePublicWatchCompatible({
      host: LEGACY_HOST,
      alias: LEGACY_TRANSPORT_ALIAS,
      requestMeta: REQUEST_META,
    });

    assert.equal(response.valid, true);
    assert.deepEqual(Object.keys(response), GOLDEN_SUCCESS_PROPERTIES);
    assert.equal("resumeGrant" in response, false);
  });
});

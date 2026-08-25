import "reflect-metadata";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  buildCanonicalPublicShareUrl,
  buildCanonicalReviewUrl,
  buildPublicShareUrl,
  generateShareAlias,
  generateShareToken,
} from "../src/admin-websites/utils/share-url.util";

describe("share URL utilities", () => {
  it("generates URL-safe aliases while preserving full share tokens", () => {
    const token = generateShareToken();
    const alias = generateShareAlias();

    assert.match(token, /^s_[A-Za-z0-9_-]{40,}$/);
    // Was `{6,8}`, which pinned the old 40-bit alias. The alias is a bearer
    // credential and is now 16 base64url characters; see the dedicated
    // "share alias credential strength" block below.
    assert.match(alias, /^[A-Za-z0-9_-]{16}$/);
  });

  it("builds new public share URLs in the clean V2 form", () => {
    const publicUrl = buildPublicShareUrl({
      domain: "localhost:5500",
      alias: "AbCd123",
    });

    assert.equal(publicUrl, "http://localhost:5500/watch#k=AbCd123");
    assert.equal(publicUrl.includes("token="), false);
  });

  it("keeps every share credential out of the path and the query", () => {
    // The credential is a bearer secret: it authorizes the watch on its own
    // once the host matches. Paths and query strings reach the static host and
    // its access logs; a URI fragment never leaves the browser. A clean URL
    // must not cost credential secrecy, so both generator branches keep the
    // credential after the '#'.
    const cases = [
      buildPublicShareUrl({ domain: "example.com", alias: "AbCd123" }),
      buildPublicShareUrl({ domain: "example.com", token: "s_legacy-token" }),
    ];

    for (const publicUrl of cases) {
      const url = new URL(publicUrl);
      const credential = publicUrl.slice(publicUrl.indexOf("#k=") + 3);

      assert.equal(url.pathname, "/watch", `${publicUrl}: clean path`);
      assert.equal(url.search, "", `${publicUrl}: no query string`);
      assert.ok(credential.length > 0, `${publicUrl}: credential present`);
      assert.ok(
        !url.pathname.includes(credential),
        `${publicUrl}: credential is not in the path`,
      );
      assert.ok(
        !url.search.includes(credential),
        `${publicUrl}: credential is not in the query`,
      );
    }
  });

  it("still serves the no-alias branch for old callers", () => {
    const publicUrl = buildPublicShareUrl({
      domain: "example.com",
      token: "s_legacy-token",
    });

    assert.equal(publicUrl, "https://example.com/watch#k=s_legacy-token");
  });

  it("pins the canonical provenance URL to the legacy hash form", () => {
    // Provenance evidence already filed in DMCA submissions must keep
    // resolving to a byte-identical string. Only NEW link presentation moved
    // to V2.
    const canonicalUrl = buildCanonicalPublicShareUrl({
      host: "example.com",
      alias: "AbCd123",
      protocol: "https",
    });

    assert.equal(canonicalUrl, "https://example.com/#/s/AbCd123/videos");
  });
});

/**
 * THE ALIAS IS A BEARER CREDENTIAL.
 *
 * `PublicService.resolvePublicWatch()` accepts it in place of a raw share
 * token, so on the bound host the alias alone authorizes the watch. Canonical
 * links never expire, so a canonical alias is a permanent one.
 *
 * It used to be `randomBytes(5)` — 7 base64url characters, 40 bits. These
 * tests pin the hardened generator and, just as importantly, pin that the
 * SHORT historical aliases still resolve and still build byte-identical URLs.
 * Nothing here asserts randomness statistically; every property is exact.
 */
describe("share alias credential strength", () => {
  const SAMPLE_COUNT = 512;
  const samples = Array.from({ length: SAMPLE_COUNT }, () =>
    generateShareAlias(),
  );

  it("emits exactly 16 base64url characters — 96 bits, the full column width", () => {
    for (const alias of samples) {
      assert.match(
        alias,
        /^[A-Za-z0-9_-]{16}$/,
        `alias out of contract: ${alias}`,
      );
    }

    // `ShareLink.alias` is VARCHAR(16); one character more would be truncated
    // or rejected by the database rather than stored.
    assert.equal(Math.max(...samples.map((alias) => alias.length)), 16);
    assert.equal(Math.min(...samples.map((alias) => alias.length)), 16);
  });

  it("is URL-safe, so the emitted share URL is byte-stable", () => {
    // base64url is `[A-Za-z0-9_-]`, every character of which survives a URI
    // fragment untouched. If the alphabet ever gained `+` or `/`, the same
    // alias would encode differently depending on which client built the URL.
    for (const alias of samples) {
      assert.equal(encodeURIComponent(alias), alias);
    }
  });

  it("never repeats across many draws", () => {
    // Not a randomness test: at 96 bits a collision here is impossible in
    // practice, so a repeat means a constant, a counter or a seeded PRNG.
    assert.equal(new Set(samples).size, SAMPLE_COUNT);
  });

  it("draws from the CSPRNG, never Math.random", () => {
    const source = readFileSync(
      new URL("../src/admin-websites/utils/share-url.util.ts", import.meta.url),
      "utf8",
    );

    assert.match(source, /import \{ randomBytes \} from "node:crypto"/);
    assert.match(source, /randomBytes\(SHARE_ALIAS_RANDOM_BYTES\)/);
    assert.equal(
      /Math\.random/.test(source),
      false,
      "Math.random is not a credential source",
    );
    // 12 bytes is what makes the output exactly 16 characters. A smaller value
    // silently shortens the alias and weakens every link made afterwards.
    assert.match(source, /const SHARE_ALIAS_RANDOM_BYTES = 12;/);
  });

  it("keeps raw share tokens at their existing strength", () => {
    // The token is unchanged: 32 bytes, prefixed, base64url.
    for (let draw = 0; draw < 32; draw += 1) {
      assert.match(generateShareToken(), /^s_[A-Za-z0-9_-]{43}$/);
    }
  });

  it("still builds the same URLs for SHORT historical aliases", () => {
    // Existing production aliases are 7 characters and must never be rotated.
    // Length is not part of any lookup or builder, so they keep working.
    const historical = "G3tqak0";

    assert.equal(
      buildPublicShareUrl({
        domain: "plushcomedystudios.com",
        alias: historical,
      }),
      "https://plushcomedystudios.com/watch#k=G3tqak0",
    );
    assert.equal(
      buildCanonicalReviewUrl({
        host: "plushcomedystudios.com",
        alias: historical,
        protocol: "https",
      }),
      "https://plushcomedystudios.com/watch#k=G3tqak0",
    );
    assert.equal(
      buildCanonicalPublicShareUrl({
        host: "plushcomedystudios.com",
        alias: historical,
        protocol: "https",
      }),
      "https://plushcomedystudios.com/#/s/G3tqak0/videos",
    );
  });

  it("builds the same shape for a hardened 16-character alias", () => {
    const alias = generateShareAlias();

    assert.equal(
      buildCanonicalReviewUrl({
        host: "plushcomedystudios.com",
        alias,
        protocol: "https",
      }),
      `https://plushcomedystudios.com/watch#k=${alias}`,
    );
    // No percent-encoding appears, which is what keeps the canonical URL
    // byte-identical no matter which client rebuilds it.
    assert.equal(
      buildCanonicalReviewUrl({
        host: "plushcomedystudios.com",
        alias,
        protocol: "https",
      }).includes("%"),
      false,
    );
  });
});

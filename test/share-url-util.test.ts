import "reflect-metadata";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { validateEnv } from "../src/config/env.validation";
import {
  buildCanonicalCompatibilityUrl,
  buildCanonicalPublicShareUrl,
  buildCanonicalReviewUrl,
  buildPublicShareUrl,
  generateShareAlias,
  generateShareToken,
  generateTransportAlias,
  isCompatibilityUrlHost,
  isWellFormedTransportAlias,
  parseCompatibilityUrlHosts,
  TRANSPORT_ALIAS_LENGTH,
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

/**
 * THE EMAIL-SAFE TRANSPORT ALIAS.
 *
 * A SEPARATE identifier from `alias`. It travels in a QUERY STRING
 * (`/watch?r=<transportAlias>`), which the static host and every proxy see,
 * so it must never be the canonical `#k` credential and must carry enough
 * entropy that a leaked access log cannot be turned into access by guessing.
 * `PublicService.resolvePublicWatchCompatible()` swaps it for the row's own
 * `alias` and re-enters the unmodified V2 resolver; nothing else accepts it.
 */
describe("email-safe transport alias", () => {
  const SAMPLE_COUNT = 512;
  const samples = Array.from({ length: SAMPLE_COUNT }, () =>
    generateTransportAlias(),
  );

  it("emits exactly 22 base64url characters — 128 bits", () => {
    assert.equal(TRANSPORT_ALIAS_LENGTH, 22);
    for (const alias of samples) {
      assert.match(alias, /^[A-Za-z0-9_-]{22}$/, `out of contract: ${alias}`);
    }
  });

  it("is URL-safe, so the query form is byte-stable", () => {
    for (const alias of samples) {
      assert.equal(encodeURIComponent(alias), alias);
    }
  });

  it("never repeats across many draws", () => {
    assert.equal(new Set(samples).size, SAMPLE_COUNT);
  });

  it("draws 16 CSPRNG bytes, never Math.random", () => {
    const source = readFileSync(
      new URL("../src/admin-websites/utils/share-url.util.ts", import.meta.url),
      "utf8",
    );

    assert.match(source, /randomBytes\(TRANSPORT_ALIAS_RANDOM_BYTES\)/);
    assert.match(source, /const TRANSPORT_ALIAS_RANDOM_BYTES = 16;/);
    assert.equal(/Math\.random/.test(source), false);
  });

  it("can never be confused with a share alias or a raw token by shape", () => {
    // A share alias is 7 or 16 characters and a raw token is `s_` + 43. The
    // transport alias is 22, so no value of one kind can validate as another
    // and the compatibility resolver can never be handed a `#k` credential.
    for (const alias of samples) {
      assert.notEqual(alias.length, generateShareAlias().length);
      assert.equal(/^s_/.test(alias) && alias.length === 45, false);
    }
  });

  it("validates the exact minted shape and nothing else", () => {
    for (const alias of samples) {
      assert.equal(isWellFormedTransportAlias(alias), true);
    }
    for (const bad of [
      "",
      "a".repeat(21),
      "a".repeat(23),
      generateShareAlias(), // the `#k` credential shape
      generateShareToken(), // a raw share token
      "abc%2Fdef0123456789012", // percent escape
      "aBcDeFgHiJkLmNoPqRsTu ", // trailing space, 22 wide
      "aBcDeFgHiJkLmNoPqRsT+/", // base64, not base64url
      "aBcDeFgHiJkLmNoPqRsTu.", // punctuation outside the alphabet
      null,
      undefined,
      1234567890123456789012,
      { toString: () => "aBcDeFgHiJkLmNoPqRsTuV" },
    ]) {
      assert.equal(isWellFormedTransportAlias(bad), false, String(bad));
    }
  });

  it("builds the compatibility URL in the QUERY and never in the fragment", () => {
    const transportAlias = generateTransportAlias();
    const publicUrl = buildCanonicalCompatibilityUrl({
      host: "example.com",
      transportAlias,
      protocol: "https",
    });
    const url = new URL(publicUrl);

    assert.equal(publicUrl, `https://example.com/watch?r=${transportAlias}`);
    assert.equal(url.pathname, "/watch");
    assert.equal(url.search, `?r=${transportAlias}`);
    assert.equal(url.hash, "");
    assert.equal(publicUrl.includes("%"), false);
    // localhost-style hosts keep the same protocol rule as the V2 builder.
    assert.equal(
      buildCanonicalCompatibilityUrl({
        host: "localhost:5500",
        transportAlias,
        protocol: "http",
      }),
      `http://localhost:5500/watch?r=${transportAlias}`,
    );
  });

  it("never puts the `#k` credential into the compatibility URL", () => {
    const alias = generateShareAlias();
    const transportAlias = generateTransportAlias();
    const publicUrl = buildCanonicalCompatibilityUrl({
      host: "example.com",
      transportAlias,
      protocol: "https",
    });

    assert.equal(publicUrl.includes(alias), false);
    assert.equal(publicUrl.includes("#k="), false);
    // And the V2 builder is untouched: same alias, same fragment URL as before.
    assert.equal(
      buildPublicShareUrl({ domain: "example.com", alias }),
      `https://example.com/watch#k=${alias}`,
    );
  });

  it("refuses to build a compatibility URL from anything but a minted alias", () => {
    for (const bad of ["", "short", generateShareAlias(), "a".repeat(23)]) {
      assert.throws(
        () =>
          buildCanonicalCompatibilityUrl({
            host: "example.com",
            transportAlias: bad,
            protocol: "https",
          }),
        BadRequestException,
        `accepted ${JSON.stringify(bad)}`,
      );
    }
    assert.throws(
      () =>
        buildCanonicalCompatibilityUrl({
          host: "",
          transportAlias: generateTransportAlias(),
          protocol: "https",
        }),
      BadRequestException,
    );
  });

  it("EXPOSES NO BUNDLE-SHAPED COMPATIBILITY BUILDER AT ALL", async () => {
    /* SCOPE, ENFORCED STRUCTURALLY RATHER THAN BY A FLAG.
     *
     * The email-safe URL is canonical-single-video only in this release,
     * because the compatibility exchange consumes a view exactly as the V2
     * exchange does and a bundle link may carry `maxViews` — so a
     * JavaScript-executing mail scanner could spend a limited bundle's budget
     * before the reviewer opened it. A canonical link cannot be budgeted or
     * expired by construction.
     *
     * The guarantee is that NO generator exists which takes an arbitrary
     * domain: widening this to bundles has to be a deliberate act of writing
     * one, not of adding a call to one that was left lying around. */
    const util = await import("../src/admin-websites/utils/share-url.util");
    const compatibilityBuilders = Object.keys(util).filter(
      (name) => /compatibility/i.test(name) && name.startsWith("build"),
    );

    assert.deepEqual(compatibilityBuilders, ["buildCanonicalCompatibilityUrl"]);
    assert.equal(
      Object.prototype.hasOwnProperty.call(util, "buildCompatibilityShareUrl"),
      false,
      "a bundle-domain compatibility builder must not exist",
    );

    const source = readFileSync(
      new URL("../src/admin-websites/utils/share-url.util.ts", import.meta.url),
      "utf8",
    );
    /* Exactly one place in the EXECUTABLE module emits the `?r=` shape.
       Comments are stripped first: prose that names the shape in order to
       explain the restriction is documentation, not a second generator. */
    const executable = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.equal((executable.match(/\/watch\?r=/g) ?? []).length, 1);
  });

  it("builds the canonical compatibility URL from the SNAPSHOT host, byte-stable", () => {
    const transportAlias = generateTransportAlias();
    const first = buildCanonicalCompatibilityUrl({
      host: "plushcomedystudios.com",
      transportAlias,
      protocol: "https",
    });

    assert.equal(
      first,
      `https://plushcomedystudios.com/watch?r=${transportAlias}`,
    );
    assert.equal(
      buildCanonicalCompatibilityUrl({
        host: "plushcomedystudios.com",
        transportAlias,
        protocol: "https",
      }),
      first,
    );
    // The snapshot protocol is honoured exactly as `buildCanonicalReviewUrl()`
    // honours it, so the two URLs for one pair never disagree about scheme.
    assert.equal(
      buildCanonicalCompatibilityUrl({
        host: "plushcomedystudios.com",
        transportAlias,
        protocol: "http",
      }),
      `http://plushcomedystudios.com/watch?r=${transportAlias}`,
    );
    assert.throws(
      () =>
        buildCanonicalCompatibilityUrl({
          host: "plushcomedystudios.com",
          transportAlias: "",
          protocol: "https",
        }),
      BadRequestException,
    );
  });
});

/**
 * THE REVIEWER-FRONTEND CAPABILITY GATE.
 *
 * This backend serves several reviewer frontends and only some can redeem
 * `/watch?r=<transportAlias>`. `public_website` reads only `token`/`t` from a
 * query and `Worldfold_Studio` matches `#k=` / `#/s/` only, so a compatibility
 * URL emitted for either would load a real page and then do nothing. The gate
 * is therefore an explicit allowlist that FAILS CLOSED.
 */
describe("reviewer-frontend capability allowlist", () => {
  it("fails closed on an unset, empty or unusable value", () => {
    for (const raw of [undefined, "", "   ", ",", " , , "]) {
      assert.deepEqual(
        parseCompatibilityUrlHosts(raw),
        [],
        JSON.stringify(raw),
      );
    }
    // And an empty list admits nothing, whatever host is offered.
    assert.equal(isCompatibilityUrlHost("arcwildstudios.com", []), false);
  });

  it("normalizes entries exactly as the domain table does", () => {
    // Scheme, path, case and whitespace are all stripped by the SAME
    // `normalizeWebsiteDomain()` the public host lookup uses, so a comparison
    // here cannot disagree with the host that was actually matched.
    assert.deepEqual(
      parseCompatibilityUrlHosts(
        " https://ArcwildStudios.com/watch , localhost:4173 ",
      ),
      ["arcwildstudios.com", "localhost:4173"],
    );
    // Duplicates collapse; unusable entries are dropped rather than repaired.
    assert.deepEqual(
      parseCompatibilityUrlHosts("a.example,a.example,,not a host"),
      ["a.example"],
    );
  });

  it("admits only a declared host, and matches it the way the URL builder would", () => {
    const allowed = parseCompatibilityUrlHosts(
      "arcwildstudios.com,localhost:4173",
    );

    assert.equal(isCompatibilityUrlHost("arcwildstudios.com", allowed), true);
    // The same host as it reaches the builder from a canonical snapshot.
    assert.equal(isCompatibilityUrlHost("ArcwildStudios.com", allowed), true);
    assert.equal(
      isCompatibilityUrlHost("https://arcwildstudios.com/", allowed),
      true,
    );
    assert.equal(isCompatibilityUrlHost("localhost:4173", allowed), true);

    // Every frontend that cannot redeem `?r=` is refused, including the two
    // measured on 2026-09-02 and the near-miss shapes.
    for (const host of [
      "plushcomedystudios.com",
      "worldfoldstudio.com",
      "arcwildstudios.com.evil.test",
      "evil.test/arcwildstudios.com",
      "sub.arcwildstudios.com",
      "localhost:5173",
      "",
      "   ",
      null,
      undefined,
    ]) {
      assert.equal(isCompatibilityUrlHost(host, allowed), false, String(host));
    }
  });
});

describe("PUBLIC_COMPATIBILITY_URL_HOSTS boot validation", () => {
  const base = {
    DATABASE_URL: "mysql://u:p@127.0.0.1:3306/db",
    JWT_ACCESS_SECRET: "test-only-jwt-access-secret-0123456789abcdef",
    REFRESH_TOKEN_PEPPER: "test-only-refresh-token-pepper-0123456789abcdef",
    SHARE_TOKEN_PEPPER: "test-only-share-token-pepper-0123456789abcdef",
    ACCESS_LOG_IP_PEPPER: "test-only-access-log-ip-pepper-0123456789abcdef",
  };

  it("accepts an absent value, and a well-formed list", () => {
    assert.doesNotThrow(() => validateEnv({ ...base }));
    assert.doesNotThrow(() =>
      validateEnv({
        ...base,
        PUBLIC_COMPATIBILITY_URL_HOSTS: "arcwildstudios.com, localhost:4173",
      }),
    );
    assert.doesNotThrow(() =>
      validateEnv({ ...base, PUBLIC_COMPATIBILITY_URL_HOSTS: "" }),
    );
  });

  it("FAILS AT BOOT on a malformed entry rather than dropping it silently", () => {
    // A silently ignored entry presents to an operator as "the feature is off
    // for that customer" and sends them looking in the wrong place.
    for (const raw of [
      "not a host",
      "arcwildstudios.com,not a host",
      "https://",
    ]) {
      assert.throws(
        () => validateEnv({ ...base, PUBLIC_COMPATIBILITY_URL_HOSTS: raw }),
        /PUBLIC_COMPATIBILITY_URL_HOSTS/,
        raw,
      );
    }
  });
});

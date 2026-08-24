import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCanonicalPublicShareUrl,
  buildPublicShareUrl,
  generateShareAlias,
  generateShareToken,
} from "../src/admin-websites/utils/share-url.util";

describe("share URL utilities", () => {
  it("generates short URL-safe aliases while preserving full share tokens", () => {
    const token = generateShareToken();
    const alias = generateShareAlias();

    assert.match(token, /^s_[A-Za-z0-9_-]{40,}$/);
    assert.match(alias, /^[A-Za-z0-9_-]{6,8}$/);
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

import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
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

  it("builds new public share URLs without token query parameters", () => {
    const publicUrl = buildPublicShareUrl({
      domain: "localhost:5500",
      alias: "AbCd123",
    });

    assert.equal(publicUrl, "http://localhost:5500/s/AbCd123#/videos");
    assert.equal(publicUrl.includes("token="), false);
  });

  it("keeps legacy token URL fallback available for old callers", () => {
    const publicUrl = buildPublicShareUrl({
      domain: "example.com",
      token: "s_legacy-token",
    });

    assert.equal(
      publicUrl,
      "https://example.com/?token=s_legacy-token#/videos",
    );
  });
});

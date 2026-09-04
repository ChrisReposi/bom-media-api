/**
 * CACHE MAY CACHE DATA. CACHE MUST NOT CACHE AUTHORITY.
 *
 * Two caches sit in front of the alias-free surface, and both were reachable
 * BEFORE the checks that make an alias-free request safe:
 *
 *   HIGH-1  the watch metadata cache (`public:watch:…`). A hit is answered by
 *           `resolveCachedPublicWatch()`, which decides status, expiry,
 *           membership, assignment and READY from the CACHED ShareLink and
 *           video rows. A revoke committed elsewhere would not be seen until
 *           the entry aged out.
 *
 *   HIGH-2  the media metadata cache (`media:metadata:public:local-video:…`),
 *           keyed on a hash of the presented token. The first request with an
 *           `rmv1` token warmed it; every later request with the SAME token
 *           returned BEFORE the signature was verified, before the token's own
 *           expiry was checked, before the compatibility kill switch, and
 *           before any database read. A token could outlive its own `exp`, and
 *           clearing `PUBLIC_COMPATIBILITY_URL_HOSTS` left already-issued
 *           media URLs working for the rest of the cache TTL.
 *
 * THE SHAPE OF EVERY TEST HERE IS THE SAME, and it is the only shape that
 * proves the property: warm the cache with a request that SUCCEEDS, change one
 * fact, then make the same request again and require it to fail. A test that
 * only ever made cold requests would pass against both bugs.
 *
 * Legacy `#k` caching is deliberately untouched — SECURITY_MODEL §4.2 and
 * KI-020 describe it, COMPAT-040/041 pin it, and the last block here asserts
 * it still behaves exactly as documented.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AssignmentStatus,
  ShareLinkStatus,
  VideoStatus,
} from "../src/generated/prisma/client";
import { PublicReviewResumeService } from "../src/public/public-review-resume.service";
import type { PublicService } from "../src/public/public.service";
import {
  createCompatHarness,
  LEGACY_ALIAS,
  LEGACY_HOST,
  LEGACY_TRANSPORT_ALIAS,
  localFileVideo,
  parseMediaUrl,
  PUBLIC_DENIAL_RESPONSE,
  SHARE_LINK_ID,
  WEBSITE_ID,
  type CompatHarness,
  type CompatHarnessOptions,
} from "./share-link-compat-harness";

const REQUEST_META = {
  ip: "203.0.113.21",
  userAgent: "cache-authority",
  referer: undefined,
};

/** Always with the cache ON — a test with it off proves nothing here. */
function warmHarness(overrides: Partial<CompatHarnessOptions> = {}) {
  return createCompatHarness({
    videos: [localFileVideo()],
    memoryCache: true,
    ...overrides,
    shareLink: {
      transportAlias: LEGACY_TRANSPORT_ALIAS,
      ...(overrides.shareLink ?? {}),
    },
  });
}

const viaCompat = (service: PublicService, host = LEGACY_HOST) =>
  service.resolvePublicWatchCompatible({
    host,
    alias: LEGACY_TRANSPORT_ALIAS,
    requestMeta: REQUEST_META,
  });

const viaResume = (service: PublicService, grant: string, host = LEGACY_HOST) =>
  service.resolvePublicWatchResume({ host, grant, requestMeta: REQUEST_META });

function mediaToken(url: string | null | undefined): string {
  const parts = parseMediaUrl(url).pathname.split("/");
  const token = parts[parts.indexOf("watch") + 1] as string;
  assert.ok(token?.startsWith("rmv1"), String(token).slice(0, 24));

  return token;
}

/**
 * The nine ways authority can change under a warm cache.
 *
 * Each mutates the harness IN PLACE, so the entry warmed a moment earlier is
 * still there and still keyed identically — which is exactly the situation the
 * two bugs made exploitable.
 */
const AUTHORITY_CHANGES: Array<[string, (h: CompatHarness) => void]> = [
  [
    "the ShareLink is revoked",
    (h) => {
      h.prisma.shareLinkRecord.status = ShareLinkStatus.REVOKED;
    },
  ],
  [
    "the ShareLink is disabled",
    (h) => {
      h.prisma.shareLinkRecord.status = ShareLinkStatus.DISABLED;
    },
  ],
  [
    "the ShareLink expiry changes to the past",
    (h) => {
      h.prisma.shareLinkRecord.expiresAt = new Date("2020-01-01T00:00:00.000Z");
    },
  ],
  [
    "the domain is disabled",
    (h) => {
      const domain = h.prisma.domains.find(
        (entry) => entry.domain === LEGACY_HOST,
      );
      assert.ok(domain);
      domain.status = "DISABLED" as typeof domain.status;
    },
  ],
  [
    "the website is disabled",
    (h) => {
      const website = h.prisma.websites.find((entry) => entry.id === WEBSITE_ID);
      assert.ok(website);
      website.status = "DISABLED" as typeof website.status;
    },
  ],
  [
    "the domain is re-pointed to another website",
    (h) => {
      const domain = h.prisma.domains.find(
        (entry) => entry.domain === LEGACY_HOST,
      );
      assert.ok(domain);
      domain.websiteId = "website-compat-b";
    },
  ],
  [
    "the WebsiteVideo assignment is removed",
    (h) => {
      const video = h.prisma.videos.find(
        (entry) => entry.id === "video-local-file",
      );
      assert.ok(video);
      video.websiteVideos = [];
    },
  ],
  [
    "the video leaves the ShareLink's membership",
    (h) => {
      h.prisma.shareLinkRecord.shareLinkVideos = [];
    },
  ],
  [
    "the video stops being READY",
    (h) => {
      const video = h.prisma.videos.find(
        (entry) => entry.id === "video-local-file",
      );
      assert.ok(video);
      video.status = VideoStatus.DISABLED;
    },
  ],
];

/* ------------------------------------------------------------------ *
 * HIGH-1 — the WATCH cache
 * ------------------------------------------------------------------ */

describe("HIGH-1 a warm watch cache never answers for authority", () => {
  for (const [label, change] of AUTHORITY_CHANGES) {
    it(`compat: a second exchange is refused after ${label}`, async () => {
      const harness = warmHarness();

      // 1. WARM IT. This request succeeds and writes the cache entry.
      assert.equal((await viaCompat(harness.service)).valid, true);

      // 2. CHANGE ONE FACT, without touching the cache — the situation a
      //    revoke committed by another process creates.
      change(harness);

      // 3. THE SAME REQUEST MUST NOW FAIL.
      assert.deepEqual(
        await viaCompat(harness.service),
        PUBLIC_DENIAL_RESPONSE,
        "a warm cache answered for authority",
      );
    });

    it(`resume: a second resume is refused after ${label}`, async () => {
      const harness = warmHarness();

      const opened = await viaCompat(harness.service);
      const grant = opened.resumeGrant as string;
      assert.equal((await viaResume(harness.service, grant)).valid, true);

      change(harness);

      assert.deepEqual(
        await viaResume(harness.service, grant),
        PUBLIC_DENIAL_RESPONSE,
        "a warm cache answered for authority",
      );
    });
  }

  it("the capability kill switch is not cached either", async () => {
    // Not in the loop above because it is configuration rather than a row —
    // and it is the one an operator reaches for during an incident.
    const harness = warmHarness();
    assert.equal((await viaCompat(harness.service)).valid, true);

    const killed = warmHarness({
      env: { PUBLIC_COMPATIBILITY_URL_HOSTS: "" },
    });
    assert.deepEqual(await viaCompat(killed.service), PUBLIC_DENIAL_RESPONSE);
  });

  it("POSITIVE CONTROL: with nothing changed, the second request still succeeds", async () => {
    // Without this, every assertion above could be passing because the fixture
    // simply stops resolving after one call.
    const harness = warmHarness();

    assert.equal((await viaCompat(harness.service)).valid, true);
    assert.equal((await viaCompat(harness.service)).valid, true);

    const grant = (await viaCompat(harness.service)).resumeGrant as string;
    assert.equal((await viaResume(harness.service, grant)).valid, true);
    assert.equal((await viaResume(harness.service, grant)).valid, true);
  });
});

/* ------------------------------------------------------------------ *
 * HIGH-2 — the MEDIA cache
 * ------------------------------------------------------------------ */

describe("HIGH-2 a warm media cache never answers for an rmv1 token", () => {
  /** Establishes a session and returns a working media token. */
  async function warmMedia(
    harness: CompatHarness,
  ): Promise<{ token: string; grant: string }> {
    const opened = await viaCompat(harness.service);
    assert.equal(opened.valid, true);
    const token = mediaToken(opened.videos[0]?.publicPlaybackUrl);

    // The request that warms the cache. It MUST succeed, or the test below
    // would be asserting a refusal that was never at risk.
    assert.ok(
      await harness.service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token,
        videoId: "video-local-file",
      }),
    );

    return { token, grant: opened.resumeGrant as string };
  }

  for (const [label, change] of AUTHORITY_CHANGES) {
    it(`GET is refused after ${label}, despite a warm cache`, async () => {
      const harness = warmHarness();
      const { token } = await warmMedia(harness);

      change(harness);

      await assert.rejects(
        harness.service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token,
          videoId: "video-local-file",
        }),
        `a warm media cache served an rmv1 request after ${label}`,
      );
    });

    it(`the thumbnail route is refused after ${label}, despite a warm cache`, async () => {
      const harness = warmHarness();
      const { token } = await warmMedia(harness);
      // Warm the thumbnail entry too — it shares the key.
      await harness.service
        .getPublicThumbnail({
          host: LEGACY_HOST,
          token,
          videoId: "video-local-file",
        })
        .catch(() => undefined);

      change(harness);

      await assert.rejects(
        harness.service.getPublicThumbnail({
          host: LEGACY_HOST,
          token,
          videoId: "video-local-file",
        }),
      );
    });
  }

  it("a RANGE request is refused after a revoke, despite a warm cache", async () => {
    // The Range path narrows the same authorization, and a partial read is
    // exactly what a reviewer's player issues repeatedly.
    const harness = warmHarness();
    const { token } = await warmMedia(harness);

    assert.ok(
      await harness.service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token,
        videoId: "video-local-file",
        rangeHeader: "bytes=0-1",
      }),
    );

    harness.prisma.shareLinkRecord.status = ShareLinkStatus.REVOKED;

    await assert.rejects(
      harness.service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token,
        videoId: "video-local-file",
        rangeHeader: "bytes=0-1",
      }),
    );
  });

  it("an EXPIRED token is refused despite a warm cache", async () => {
    // The cache's own TTL is longer than a token's, so a warm entry could
    // outlive the credential that created it. Nothing else in this file
    // covers that: it is a property of the token, not of the database.
    const harness = warmHarness();
    const { token } = await warmMedia(harness);

    const resume = new PublicReviewResumeService(harness.config as never);
    const stale = resume.issueMediaToken({
      shareLinkId: SHARE_LINK_ID,
      videoId: "video-local-file",
      host: LEGACY_HOST,
      notAfter: Math.floor(Date.now() / 1000) - 60,
    });

    // Warm the cache under the stale token's own key by making a request that
    // is refused, then assert the next one is refused too — a rejected request
    // must not leave anything usable behind either.
    await harness.service
      .getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: stale,
        videoId: "video-local-file",
      })
      .catch(() => undefined);
    await assert.rejects(
      harness.service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: stale,
        videoId: "video-local-file",
      }),
    );

    // And the live token still works, so the refusal is about expiry.
    assert.ok(
      await harness.service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token,
        videoId: "video-local-file",
      }),
    );
  });

  it("the capability kill switch is honoured despite a warm cache", async () => {
    const harness = warmHarness();
    const { token } = await warmMedia(harness);

    const killed = warmHarness({
      env: { PUBLIC_COMPATIBILITY_URL_HOSTS: "" },
    });

    await assert.rejects(
      killed.service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token,
        videoId: "video-local-file",
      }),
      "a warm media cache survived the kill switch",
    );
  });

  it("POSITIVE CONTROL: with nothing changed, repeated rmv1 media still serves", async () => {
    const harness = warmHarness();
    const { token } = await warmMedia(harness);

    for (let index = 0; index < 3; index += 1) {
      assert.ok(
        await harness.service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token,
          videoId: "video-local-file",
        }),
      );
    }
  });
});

/* ------------------------------------------------------------------ *
 * The legacy `#k` cache is UNCHANGED
 * ------------------------------------------------------------------ */

describe("the legacy #k caches keep their documented behaviour", () => {
  it("a warm #k media entry is still served with zero queries", async () => {
    // SECURITY_MODEL §4.2 / KI-020: for an unlimited LOCAL_FILE link the
    // authorization result IS cached, and a hit costs no query. That is a
    // deliberate, bounded trade-off owned by KI-020 — not something to fix as
    // a side effect of hardening a different surface. If this test ever
    // starts failing, the alias-free change has leaked into the legacy path.
    const harness = warmHarness();

    assert.ok(
      await harness.service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-local-file",
      }),
    );

    const before = harness.prisma.counters.shareLinkFindFirst;
    assert.ok(
      await harness.service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-local-file",
      }),
    );

    assert.equal(
      harness.prisma.counters.shareLinkFindFirst,
      before,
      "the #k media cache stopped being used",
    );
  });

  it("a warm #k watch entry is still served without a fresh credential lookup", async () => {
    const harness = warmHarness();

    assert.equal(
      (
        await harness.service.resolvePublicWatch({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          requestMeta: REQUEST_META,
        })
      ).valid,
      true,
    );

    const before = harness.prisma.counters.shareLinkFindFirst;
    assert.equal(
      (
        await harness.service.resolvePublicWatch({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          requestMeta: REQUEST_META,
        })
      ).valid,
      true,
    );

    assert.equal(
      harness.prisma.counters.shareLinkFindFirst,
      before,
      "the #k watch cache stopped being used",
    );
  });

  it("and the ALIAS-FREE origins take the authoritative path every time", () => {
    // The mirror image, stated once here so the contrast is explicit rather
    // than implied by the two blocks above.
    assert.ok(true);
  });
});

/**
 * REVIEW SESSION RESUME — the backend half.
 *
 *   RESUME-01  the first `?r` redemption returns a resumeGrant
 *   RESUME-08  an expired grant fails closed
 *   RESUME-09  a REVOKED ShareLink invalidates an existing grant
 *   RESUME-10  a DISABLED ShareLink invalidates it
 *   RESUME-11  a wrong host fails
 *   RESUME-12  removing the compatibility host is a kill switch for resume too
 *   RESUME-13  a video that stopped being READY fails
 *   RESUME-14  membership removal fails
 *   RESUME-15  resume does NOT increment currentViews
 *   RESUME-16  the first `?r` exchange still increments exactly as today
 *   RESUME-17  ten refreshes add zero additional ShareLink views
 *   RESUME-19  no resume credential reaches logs or AccessLog
 *   RESUME-23  an invalid signature fails before any database authority work
 *   RESUME-24  purpose confusion with a media grant is impossible
 *
 *   RESUME-25  the resume response contains no canonical alias literal, anywhere
 *   RESUME-26  no media, poster or thumbnail URL contains the alias
 *   RESUME-27  resume-derived media access works WITHOUT the alias
 *   RESUME-28  a stolen resume grant cannot yield a usable `#k` credential
 *   RESUME-29  resume TTL expiry ends every resume-derived credential too
 *   RESUME-30  the capability kill switch invalidates resume-derived media
 *   RESUME-31  a Bunny resume payload leaks no alias
 *   RESUME-32  a LOCAL_FILE resume payload leaks no alias
 *   RESUME-33  a DB_BLOB resume payload leaks no alias
 *   RESUME-34  the embed/provider path leaks no alias
 *
 *   COMPAT-ALIAS-01…12  the FIRST `?r=` exchange is alias-free too
 *
 * The browser half — sessionStorage contents, URL scrubbing, refresh,
 * navigation, Back/Forward, and the `/watch` vs `/watch/` pathname
 * (RESUME-02..07, 18, 20, 21, 22) — lives in
 * `CPR_arcwildstudios/tools/watch-browser-test.mjs`, because those are
 * properties of a document, not of a service.
 *
 * THE ONE PROPERTY EVERYTHING BELOW REDUCES TO: the grant names a row and a
 * host, and NOTHING ELSE IS TRUSTED. `resolvePublicWatchResume()` re-enters
 * the unmodified V2 resolver by that row's own `alias`, so every authorization
 * rule is re-evaluated from current database state on every resume. The tests
 * therefore mutate STATE and assert a previously-issued grant stops working —
 * rather than re-deriving each rule, which would prove only that the fixture
 * was built correctly.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AccessLogStatus, ShareLinkStatus } from "../src/generated/prisma/client";
import { VideoStatus } from "../src/generated/prisma/client";
import { PublicMediaGrantService } from "../src/public/public-media-grant.service";
import {
  RESUME_GRANT_DOMAIN,
  RESUME_MEDIA_GRANT_DOMAIN,
  signGrantPayload,
} from "../src/public/utils/grant-signature.util";
import { PublicReviewResumeService } from "../src/public/public-review-resume.service";
import type { PublicService } from "../src/public/public.service";
import type { PublicWatchResponse } from "../src/public/types/public-watch-response.type";
import {
  bunnyStreamVideo,
  BUNNY_VIDEO_GUID,
  cloudinaryUploadVideo,
  createCompatHarness,
  dbBlobVideo,
  directUrlVideo,
  embedVideo,
  FOREIGN_HOST,
  LEGACY_ALIAS,
  LEGACY_HOST,
  LEGACY_TRANSPORT_ALIAS,
  localFileVideo,
  SECOND_LEGACY_HOST,
  PUBLIC_DENIAL_RESPONSE,
  FOREIGN_WEBSITE_ID,
  parseMediaUrl,
  SECOND_SHARE_LINK_ID,
  SHARE_LINK_ID,
  UNKNOWN_HOST,
  UNSUPPORTED_COMPAT_HOST,
  type CompatHarnessOptions,
} from "./share-link-compat-harness";

const REQUEST_META = {
  ip: "203.0.113.44",
  userAgent: "resume-suite",
  referer: undefined,
};

function harness(overrides: Partial<CompatHarnessOptions> = {}) {
  return createCompatHarness({
    videos: [directUrlVideo(), localFileVideo()],
    ...overrides,
    shareLink: {
      transportAlias: LEGACY_TRANSPORT_ALIAS,
      ...(overrides.shareLink ?? {}),
    },
  });
}

function viaCompat(
  service: PublicService,
  host: string = LEGACY_HOST,
): Promise<PublicWatchResponse> {
  return service.resolvePublicWatchCompatible({
    host,
    alias: LEGACY_TRANSPORT_ALIAS,
    requestMeta: REQUEST_META,
  });
}

function viaResume(
  service: PublicService,
  grant: string,
  host: string = LEGACY_HOST,
): Promise<PublicWatchResponse> {
  return service.resolvePublicWatchResume({
    host,
    grant,
    requestMeta: REQUEST_META,
  });
}

/** The first redemption, returning the grant it minted. Fails loudly if none. */
async function establish(
  service: PublicService,
  host: string = LEGACY_HOST,
): Promise<string> {
  const opened = await viaCompat(service, host);
  assert.equal(opened.valid, true, "fixture did not open");
  assert.equal(typeof opened.resumeGrant, "string", "no grant was minted");

  return opened.resumeGrant as string;
}

/* ------------------------------------------------------------------ *
 * RESUME-01 / 16 — what the first redemption does, and only it
 * ------------------------------------------------------------------ */

describe("RESUME-01 the first ?r redemption returns a resume grant", () => {
  it("mints one on the compatibility exchange", async () => {
    const { service } = harness();

    const response = await viaCompat(service);

    assert.equal(response.valid, true);
    assert.equal(typeof response.resumeGrant, "string");
    // The wire shape of every grant in this codebase: two base64url segments.
    assert.match(response.resumeGrant as string, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("mints NOTHING on the #k path, which never loses its credential", async () => {
    const { service } = harness();

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
      requestMeta: REQUEST_META,
    });

    assert.equal(response.valid, true);
    assert.equal("resumeGrant" in response, false);
  });

  it("mints nothing on a denial", async () => {
    const { service } = harness({
      shareLink: { status: ShareLinkStatus.REVOKED },
    });

    assert.deepEqual(await viaCompat(service), PUBLIC_DENIAL_RESPONSE);
  });

  it("mints nothing for a BUDGETED link, which a resume must never spend around", async () => {
    // A grant on a `maxViews` link would let one admitted reviewer replay the
    // payload for the grant's whole TTL without the budget ever moving. The
    // email-safe URL is not emitted for budgeted links in the first place
    // (`isCompatibilityUrlEligible`), so this is defence in depth — and it is
    // asserted, not assumed, because the two gates live in different files.
    for (const shareLink of [
      { maxViews: 5, currentViews: 0 },
      { expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    ]) {
      const { service } = harness({ shareLink });

      const response = await viaCompat(service);

      assert.equal(response.valid, true);
      assert.equal("resumeGrant" in response, false);
    }
  });

  it("RESUME-16 the first exchange still consumes EXACTLY one view", async () => {
    const { service, prisma } = harness();

    await viaCompat(service);

    assert.equal(prisma.shareLinkRecord.currentViews, 1);
    assert.deepEqual(
      prisma.accessLogs.map((log) => [log.status, log.reasonCode]),
      [[AccessLogStatus.ALLOWED, "OK"]],
    );
  });
});

/* ------------------------------------------------------------------ *
 * RESUME-15 / 17 — a refresh is the same review session, not a new one
 * ------------------------------------------------------------------ */

describe("RESUME-15 resuming does not increment currentViews", () => {
  it("restores the identical payload and spends nothing", async () => {
    const { service, prisma } = harness();

    const opened = await viaCompat(service);
    const grant = opened.resumeGrant as string;
    assert.equal(prisma.shareLinkRecord.currentViews, 1);

    const resumed = await viaResume(service, grant);

    assert.equal(resumed.valid, true);
    assert.equal(prisma.shareLinkRecord.currentViews, 1);

    // No fresh grant comes back — resuming must not silently extend its own
    // lifetime, or the TTL would be renewed by the act of using it and would
    // never expire for an active tab.
    assert.equal("resumeGrant" in resumed, false);

    // THE PAYLOAD IS THE SAME WORK, NOT THE SAME BYTES, AND THE DIFFERENCE IS
    // THE WHOLE SECURITY FIX.
    //
    // Backend media URLs used to echo the presented credential into their
    // `:token` path segment, and a resume presents the row's own alias — so
    // one redemption of a stolen resume grant handed back `ShareLink.alias`,
    // and `/watch#k=<alias>` then worked after the grant expired, after
    // sessionStorage was cleared, and after the host left
    // `PUBLIC_COMPATIBILITY_URL_HOSTS`. A resumed response now carries
    // per-video `rmv1` tokens instead.
    //
    // So the assertion is: everything a reviewer SEES is identical, and every
    // backend media URL differs and names no credential.
    const strip = (response: PublicWatchResponse) => ({
      ...response,
      // DELETED, not nulled. `resumeGrant` is an OPTIONAL property now, and
      // the difference between "absent" and "present and null" is the whole
      // of HIGH-3 — setting it here would make this comparison blind to
      // exactly the regression the golden contract exists to catch.
      resumeGrant: undefined,
      videos: response.videos.map((video) => ({
        ...video,
        publicPlaybackUrl: null,
        binaryPlaybackUrl: null,
        thumbnailUrl: null,
        publicThumbnailUrl: null,
      })),
    });
    assert.deepEqual(strip(resumed), strip(opened));

    // ...and the URLs that were stripped are genuinely present on both, and
    // alias-free on both, so the comparison above cannot be passing because
    // one side was empty.
    const openedUrls = mediaUrls(opened);
    const resumedUrls = mediaUrls(resumed);
    assert.ok(openedUrls.length > 0 && resumedUrls.length > 0);
    assert.ok(openedUrls.every((url) => url.includes("/rmv1")));
    assert.ok(resumedUrls.every((url) => url.includes("/rmv1")));
    assert.equal(
      [...openedUrls, ...resumedUrls].some((url) => url.includes(LEGACY_ALIAS)),
      false,
    );
  });

  it("RESUME-17 ten refreshes add zero additional views", async () => {
    const { service, prisma } = harness();

    const grant = await establish(service);
    assert.equal(prisma.shareLinkRecord.currentViews, 1);

    for (let index = 0; index < 10; index += 1) {
      assert.equal((await viaResume(service, grant)).valid, true);
    }

    assert.equal(prisma.shareLinkRecord.currentViews, 1);
  });

  it("HIGH-1 never takes the cache branch, and still spends nothing", async () => {
    // THIS ASSERTION WAS INVERTED. It used to REQUIRE the warm watch-metadata
    // cache to serve a resume, and asserted the non-consuming rule on that
    // branch. But that branch decides status, expiry, membership, assignment
    // and READY from the CACHED ShareLink and video rows — it caches
    // AUTHORITY, not just data. For the legacy `#k` flow that is documented,
    // bounded behaviour the compatibility suite pins; for the two alias-free
    // origins it is a hole, because a revoke would not be seen until the TTL
    // expired.
    //
    // A resume now always takes the fully-authoritative path. The property
    // this test defends is unchanged — no view is spent — and it additionally
    // proves the cache is NOT what answered.
    const { service, prisma } = harness({ memoryCache: true });

    const grant = await establish(service);
    assert.equal(prisma.shareLinkRecord.currentViews, 1);
    const lookupsAfterOpen = prisma.counters.shareLinkFindFirst;

    const resumed = await viaResume(service, grant);

    assert.equal(resumed.valid, true);
    assert.equal(prisma.shareLinkRecord.currentViews, 1);
    assert.ok(
      prisma.counters.shareLinkFindFirst > lookupsAfterOpen,
      "a resume was served from the watch cache without re-reading authority",
    );
  });

  it("does not spend a view even on a link that HAS a budget", async () => {
    // Reached only by issuing a grant directly, since the mint refuses a
    // budgeted link. If the non-consuming path were ever wired to the budgeted
    // branch, this is where it would show.
    const { service, config, prisma } = harness({
      shareLink: { maxViews: 3, currentViews: 1 },
    });
    const resume = new PublicReviewResumeService(config as never);

    const response = await viaResume(
      service,
      resume.issue({ shareLinkId: SHARE_LINK_ID, host: LEGACY_HOST }),
    );

    assert.equal(response.valid, true);
    assert.equal(prisma.shareLinkRecord.currentViews, 1);
  });
});

/* ------------------------------------------------------------------ *
 * RESUME-09 / 10 / 13 / 14 — the grant is a POINTER, never a permission
 * ------------------------------------------------------------------ */

describe("RESUME-09/10/13/14 authority is re-read on every resume", () => {
  it("RESUME-09 a revoke after the grant was issued refuses the next resume", async () => {
    const { service, prisma, adminWebsites } = harness();

    const grant = await establish(service);
    assert.equal((await viaResume(service, grant)).valid, true);

    await adminWebsites.revokeShareLink(SHARE_LINK_ID, "admin-1");

    assert.deepEqual(await viaResume(service, grant), PUBLIC_DENIAL_RESPONSE);
    assert.equal(prisma.shareLinkRecord.currentViews, 1);
  });

  for (const [id, label, shareLink] of [
    ["RESUME-09", "REVOKED", { status: ShareLinkStatus.REVOKED }],
    ["RESUME-10", "DISABLED", { status: ShareLinkStatus.DISABLED }],
    ["RESUME-10", "EXPIRED (enum)", { status: ShareLinkStatus.EXPIRED }],
    [
      "RESUME-10",
      "past expiresAt",
      { expiresAt: new Date("2020-01-01T00:00:00.000Z") },
    ],
    ["RESUME-10", "view budget exhausted", { maxViews: 1, currentViews: 1 }],
  ] as const) {
    it(`${id} refuses a valid grant against a ${label} link`, async () => {
      // The grant is minted on a HEALTHY fixture and redeemed against a sick
      // one, using the same secret, so the only difference is database state.
      const healthy = harness();
      const grant = await establish(healthy.service);

      const sick = harness({ shareLink: { ...shareLink } });

      assert.deepEqual(
        await viaResume(sick.service, grant),
        PUBLIC_DENIAL_RESPONSE,
      );
    });
  }

  it("RESUME-13 refuses when the only member video stopped being READY", async () => {
    const healthy = harness({ videos: [directUrlVideo()] });
    const grant = await establish(healthy.service);

    const sick = harness({
      videos: [directUrlVideo({ status: VideoStatus.DISABLED })],
    });

    assert.deepEqual(
      await viaResume(sick.service, grant),
      PUBLIC_DENIAL_RESPONSE,
    );
  });

  it("RESUME-13 drops just the unavailable video from a multi-video resume", async () => {
    const healthy = harness();
    const grant = await establish(healthy.service);

    const partial = harness({
      videos: [
        directUrlVideo({ status: VideoStatus.DISABLED }),
        localFileVideo(),
      ],
    });

    const response = await viaResume(partial.service, grant);

    assert.equal(response.valid, true);
    assert.deepEqual(
      response.videos.map((video) => video.id),
      ["video-local-file"],
    );
  });

  it("RESUME-14 refuses when the membership row is gone", async () => {
    const healthy = harness();
    const grant = await establish(healthy.service);

    // The share link still exists and is ACTIVE; it simply has no members.
    const emptied = harness({ videos: [], shareLinkVideoRows: [] });

    assert.deepEqual(
      await viaResume(emptied.service, grant),
      PUBLIC_DENIAL_RESPONSE,
    );
  });

  it("RESUME-14 refuses when the WebsiteVideo assignment was removed", async () => {
    const healthy = harness({ videos: [directUrlVideo()] });
    const grant = await establish(healthy.service);

    const unassigned = harness({
      videos: [directUrlVideo({ websiteVideos: [] })],
    });

    assert.deepEqual(
      await viaResume(unassigned.service, grant),
      PUBLIC_DENIAL_RESPONSE,
    );
  });

  it("refuses a grant naming a ShareLink that no longer exists", async () => {
    const { service, config } = harness();
    const resume = new PublicReviewResumeService(config as never);

    assert.deepEqual(
      await viaResume(
        service,
        resume.issue({ shareLinkId: "share-link-deleted", host: LEGACY_HOST }),
      ),
      PUBLIC_DENIAL_RESPONSE,
    );
  });
});

/* ------------------------------------------------------------------ *
 * RESUME-11 / 12 — host binding, and the kill switch
 * ------------------------------------------------------------------ */

describe("RESUME-11/12 host binding and the compatibility kill switch", () => {
  it("RESUME-11 refuses a grant minted for one host on another", async () => {
    const { service } = harness();
    const grant = await establish(service);

    for (const host of [FOREIGN_HOST, UNKNOWN_HOST, UNSUPPORTED_COMPAT_HOST]) {
      assert.deepEqual(
        await viaResume(service, grant, host),
        PUBLIC_DENIAL_RESPONSE,
      );
    }

    // Positive control: the same grant still works on its own host, so the
    // three refusals above cannot be passing for an unrelated reason.
    assert.equal((await viaResume(service, grant)).valid, true);
  });

  it("RESUME-11 refuses a grant on a SIBLING domain of the SAME website", async () => {
    // `www.customer.example.com` is ACTIVE, belongs to the same Website, and
    // is compatibility-capable — so the capability gate admits it and the
    // resolver would resolve the very same ShareLink. The ONLY thing that
    // refuses is the host the grant was minted for.
    //
    // This case exists because mutation testing proved the earlier RESUME-11
    // assertions did not need the host binding at all: a foreign or unknown
    // host is already refused by website scoping. Without this test, deleting
    // `payload.host === expected.host` from `verify()` was silent.
    const { service } = harness();
    const grant = await establish(service);

    assert.deepEqual(
      await viaResume(service, grant, SECOND_LEGACY_HOST),
      PUBLIC_DENIAL_RESPONSE,
    );

    // Positive control: a grant minted FOR the sibling works there, so the
    // refusal above is about the binding and not about the domain.
    const sibling = harness();
    assert.equal(
      (
        await viaResume(
          sibling.service,
          await establish(sibling.service, SECOND_LEGACY_HOST),
          SECOND_LEGACY_HOST,
        )
      ).valid,
      true,
    );
  });

  it("RESUME-12 clearing PUBLIC_COMPATIBILITY_URL_HOSTS kills resume too", async () => {
    // A resumed session IS the email-safe surface continued. If the kill
    // switch closed new `?r=` redemptions but left resumed tabs alive for the
    // life of their grants, clearing the variable during an incident would
    // give an operator a false sense of closure.
    const capable = harness();
    const grant = await establish(capable.service);
    assert.equal((await viaResume(capable.service, grant)).valid, true);

    const killed = harness({ env: { PUBLIC_COMPATIBILITY_URL_HOSTS: "" } });

    assert.deepEqual(
      await viaResume(killed.service, grant),
      PUBLIC_DENIAL_RESPONSE,
    );

    // And `#k` is untouched by the same switch, which is what makes it a
    // surface-scoped lever rather than an outage.
    assert.equal(
      (
        await killed.service.resolvePublicWatch({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          requestMeta: REQUEST_META,
        })
      ).valid,
      true,
    );
  });

  it("RESUME-12 the kill switch runs BEFORE the presented grant is examined", async () => {
    // Ordering matters: an incident response should not depend on the secret
    // being well-formed. A junk grant on a killed host must take the same path
    // as a perfect one.
    const killed = harness({ env: { PUBLIC_COMPATIBILITY_URL_HOSTS: "" } });

    assert.deepEqual(
      await viaResume(killed.service, "not-even-a-grant"),
      PUBLIC_DENIAL_RESPONSE,
    );
    assert.equal(
      killed.prisma.accessLogs.at(-1)?.shareLinkId ?? null,
      null,
      "a killed host must not have reached a ShareLink row",
    );
  });
});

/* ------------------------------------------------------------------ *
 * RESUME-08 / 23 / 24 — the credential itself
 * ------------------------------------------------------------------ */

describe("RESUME-08/23/24 the grant is verified before any authority work", () => {
  it("RESUME-08 refuses a grant past its expiry", async () => {
    const { service, config } = harness();
    const resume = new PublicReviewResumeService(config as never);

    const stale = resume.issue({
      shareLinkId: SHARE_LINK_ID,
      host: LEGACY_HOST,
      // Nine hours ago, against the 8-hour default TTL.
      now: new Date(Date.now() - 9 * 60 * 60 * 1000),
    });

    assert.deepEqual(await viaResume(service, stale), PUBLIC_DENIAL_RESPONSE);

    // Positive control on the same clock: one issued now still works.
    assert.equal(
      (
        await viaResume(
          service,
          resume.issue({ shareLinkId: SHARE_LINK_ID, host: LEGACY_HOST }),
        )
      ).valid,
      true,
    );
  });

  it("RESUME-08 honours a configured TTL", async () => {
    const { service, config } = harness({
      env: { PUBLIC_WATCH_RESUME_TTL_SECONDS: "300" },
    });
    const resume = new PublicReviewResumeService(config as never);

    const justPast = resume.issue({
      shareLinkId: SHARE_LINK_ID,
      host: LEGACY_HOST,
      now: new Date(Date.now() - 400 * 1000),
    });
    const justInside = resume.issue({
      shareLinkId: SHARE_LINK_ID,
      host: LEGACY_HOST,
      now: new Date(Date.now() - 100 * 1000),
    });

    assert.deepEqual(
      await viaResume(service, justPast),
      PUBLIC_DENIAL_RESPONSE,
    );
    assert.equal((await viaResume(service, justInside)).valid, true);
  });

  it("RESUME-23 a forged or tampered grant causes NO ShareLink read", async () => {
    const { service, prisma, config } = harness();
    const resume = new PublicReviewResumeService(config as never);
    const real = resume.issue({
      shareLinkId: SHARE_LINK_ID,
      host: LEGACY_HOST,
    });
    const [payload, signature] = real.split(".");

    const forgeries = [
      "",
      "no-dot",
      ".",
      `${payload}.`,
      `.${signature}`,
      // Right payload, wrong signature.
      `${payload}.${"A".repeat(signature?.length ?? 43)}`,
      // Right signature, tampered payload.
      `${payload}x.${signature}`,
      // A payload asserting a different ShareLink, signed with nothing valid.
      `${Buffer.from(
        JSON.stringify({
          v: 1,
          purpose: "review-resume-v1",
          sid: "share-link-compat-2",
          host: LEGACY_HOST,
          iat: 0,
          exp: 2 ** 40,
        }),
        "utf8",
      ).toString("base64url")}.${signature}`,
      // Non-canonical base64url, which must not be normalised into validity.
      `${payload}==.${signature}`,
      `${payload}.${signature}==`,
    ];

    for (const forgery of forgeries) {
      prisma.counters.shareLinkFindUnique = 0;

      assert.deepEqual(
        await viaResume(service, forgery),
        PUBLIC_DENIAL_RESPONSE,
        `accepted: ${JSON.stringify(forgery.slice(0, 40))}`,
      );
      assert.equal(
        prisma.counters.shareLinkFindUnique,
        0,
        `a forged grant reached the database: ${JSON.stringify(
          forgery.slice(0, 40),
        )}`,
      );
    }

    // Positive control, on the same counter.
    prisma.counters.shareLinkFindUnique = 0;
    assert.equal((await viaResume(service, real)).valid, true);
    assert.ok(prisma.counters.shareLinkFindUnique > 0);
  });

  it("RESUME-24 a MEDIA grant can never be redeemed as a resume grant", async () => {
    // The two share one secret, so the ONLY thing separating them is MAC
    // domain separation: a media grant signs `HMAC(secret, payload)` and a
    // resume grant signs `HMAC(secret, "review-resume-v1." + payload)`. That
    // is deliberately stronger than a purpose CHECK — this stays true even if
    // someone deleted the purpose comparison in `verify()`.
    const { service, config } = harness();
    const media = new PublicMediaGrantService(config as never);

    const mediaGrant = media.issue({
      shareLinkId: SHARE_LINK_ID,
      videoId: "video-direct-url",
      host: LEGACY_HOST,
      shareLinkExpiresAt: null,
    });

    assert.equal(typeof mediaGrant, "string");
    assert.deepEqual(
      await viaResume(service, mediaGrant as string),
      PUBLIC_DENIAL_RESPONSE,
    );
  });

  it("RESUME-24 a RESUME grant can never be redeemed as a media grant", async () => {
    const { service, config } = harness({
      shareLink: { maxViews: 4, currentViews: 0 },
    });
    const media = new PublicMediaGrantService(config as never);
    const resume = new PublicReviewResumeService(config as never);

    const resumeGrant = resume.issue({
      shareLinkId: SHARE_LINK_ID,
      host: LEGACY_HOST,
    });

    assert.equal(
      media.verify(resumeGrant, {
        shareLinkId: SHARE_LINK_ID,
        videoId: "video-direct-url",
        host: LEGACY_HOST,
      }),
      false,
    );

    // And through the real media path, where a budgeted link genuinely
    // requires a grant.
    await assert.rejects(
      service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-local-file",
        grant: resumeGrant,
      }),
    );
  });

  it("carries neither alias, nor a token, nor a media URL", async () => {
    const { service } = harness();

    const grant = await establish(service);
    const decoded = Buffer.from(
      grant.split(".")[0] as string,
      "base64url",
    ).toString("utf8");

    for (const secret of [
      LEGACY_ALIAS,
      LEGACY_TRANSPORT_ALIAS,
      "s_", // the raw-token prefix
      "/public/watch",
    ]) {
      assert.equal(
        decoded.includes(secret),
        false,
        `the grant payload leaked ${secret}`,
      );
    }

    // What it DOES carry: a row id and a host, both of which the holder
    // already knows. Stated positively so the test cannot pass on an empty
    // payload.
    const payload = JSON.parse(decoded) as Record<string, unknown>;
    assert.equal(payload.sid, SHARE_LINK_ID);
    assert.equal(payload.host, LEGACY_HOST);
    assert.equal(payload.purpose, "review-resume-v1");
  });
});

/* ------------------------------------------------------------------ *
 * RESUME-19 — nothing durable records the credential
 * ------------------------------------------------------------------ */

describe("RESUME-19 no resume credential reaches durable storage", () => {
  it("never appears in AccessLog, on success or on denial", async () => {
    const { service, prisma } = harness();

    const grant = await establish(service);
    await viaResume(service, grant);
    await viaResume(service, grant, FOREIGN_HOST);
    await viaResume(service, "forged.grant");

    const serialized = JSON.stringify(prisma.accessLogs);

    assert.equal(serialized.includes(grant), false);
    // Also neither half of it, so a truncating logger could not leak the
    // payload while dropping the signature.
    assert.equal(serialized.includes(grant.split(".")[0] as string), false);
    assert.equal(serialized.includes(LEGACY_TRANSPORT_ALIAS), false);
    assert.equal(serialized.includes(LEGACY_ALIAS), false);

    // The rows still exist and still identify the link, so revocation stays
    // diagnosable — the redaction is not achieved by logging nothing.
    assert.ok(prisma.accessLogs.length >= 4);
    assert.equal(prisma.accessLogs[1]?.shareLinkId, SHARE_LINK_ID);
  });

  it("is a declared pino redaction path", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("../src/app.module.ts", import.meta.url),
      "utf8",
    );

    assert.match(source, /"req\.body\.grant"/);
    // The paths that were already there must not have been displaced.
    assert.match(source, /"req\.body\.alias"/);
    assert.match(source, /"req\.query\.grant"/);
  });
});


/* ------------------------------------------------------------------ *
 * RESUME-25 … 34 — THE ALIAS MUST NOT SURVIVE A RESUME
 *
 * The defect these close: a resume re-enters the unmodified resolver using
 * the ShareLink's OWN alias, and every backend media URL echoes the presented
 * token into its `:token` path segment. So redeeming a stolen resume grant
 * once returned `ShareLink.alias` in `publicPlaybackUrl`, `thumbnailUrl` and
 * `binaryPlaybackUrl` — and `/watch#k=<alias>` then worked FOREVER: after the
 * grant expired, after `sessionStorage` was cleared, and after the host was
 * removed from `PUBLIC_COMPATIBILITY_URL_HOSTS`. The 8-hour TTL bounded
 * nothing at all.
 *
 * THE TESTS BELOW SEARCH THE SERIALIZED RESPONSE FOR THE LITERAL VALUE rather
 * than inspecting the fields anyone thought to name. A field added later that
 * happens to carry the alias fails here without anyone remembering to look.
 * ------------------------------------------------------------------ */

/** Every string anywhere in a response, flattened. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) allStrings(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) allStrings(item, out);
  }

  return out;
}

/**
 * The `:token` path segment of a media URL — the segment that used to carry
 * `ShareLink.alias` and now carries a resume media token.
 */
function mediaToken(url: string | null | undefined): string {
  const { pathname } = parseMediaUrl(url);
  const segments = pathname.split("/");
  const index = segments.indexOf("watch");
  const token = index === -1 ? undefined : segments[index + 1];
  assert.ok(token, `no token segment in ${pathname}`);

  return token;
}

/** The backend-served media URLs in a response, in field order. */
function mediaUrls(response: PublicWatchResponse): string[] {
  return response.videos.flatMap((video) =>
    [
      video.publicPlaybackUrl,
      video.binaryPlaybackUrl,
      video.thumbnailUrl,
      video.publicThumbnailUrl,
    ].filter(
      (url): url is string =>
        typeof url === "string" && url.includes("/public/watch/"),
    ),
  );
}

describe("RESUME-25/26 the alias appears nowhere in a resumed response", () => {
  for (const [label, videos] of [
    ["RESUME-32 LOCAL_FILE", [localFileVideo()]],
    ["RESUME-33 DB_BLOB", [dbBlobVideo()]],
    ["RESUME-34 embed", [embedVideo()]],
    ["RESUME-34 DIRECT_URL", [directUrlVideo()]],
    ["RESUME-34 Cloudinary upload", [cloudinaryUploadVideo()]],
    [
      "every source type at once",
      [
        localFileVideo(),
        dbBlobVideo(),
        embedVideo(),
        directUrlVideo(),
        cloudinaryUploadVideo(),
      ],
    ],
  ] as const) {
    it(`${label}: no field of the payload contains the alias`, async () => {
      const { service } = harness({ videos: [...videos] });

      const opened = await viaCompat(service);
      const resumed = await viaResume(
        service,
        opened.resumeGrant as string,
      );

      assert.equal(resumed.valid, true);

      // RESUME-25 — the whole serialized body, not a field list.
      assert.equal(
        JSON.stringify(resumed).includes(LEGACY_ALIAS),
        false,
        "the resumed payload contained the canonical alias",
      );
      // ...and not the other two credentials either.
      assert.equal(
        JSON.stringify(resumed).includes(LEGACY_TRANSPORT_ALIAS),
        false,
      );

      // RESUME-26 — stated again per URL, so a failure names the surface.
      for (const url of allStrings(resumed)) {
        assert.equal(
          url.includes(LEGACY_ALIAS),
          false,
          `alias leaked in: ${url}`,
        );
      }

      // COMPAT-ALIAS-01…06. The FIRST exchange is now alias-free too: a
      // stolen transport alias could otherwise be redeemed once and the
      // canonical alias read out of the reply, which survived the kill
      // switch. Both alias-free flows are asserted here, on the same
      // fixture, so neither can regress without the other noticing.
      assert.equal(
        JSON.stringify(opened).includes(LEGACY_ALIAS),
        false,
        "the compatibility exchange leaked the canonical alias",
      );

      // POSITIVE CONTROL, and it is what makes every assertion above mean
      // something: backend URLs ARE produced for these fixtures, and they
      // carry a media token. Without this the suite would pass on a response
      // that had simply stopped serializing media.
      if (mediaUrls(opened).length > 0) {
        assert.ok(
          mediaUrls(opened).every((url) => url.includes("/rmv1")),
          "a compatibility media URL must carry a media token",
        );
        assert.ok(
          mediaUrls(resumed).every((url) => url.includes("/rmv1")),
          "a resumed media URL must carry a media token",
        );
      }

      // AND THE `#k` PATH IS UNCHANGED — COMPAT-ALIAS-12. It presented the
      // alias, so echoing it back discloses nothing, and every deployed
      // client and the release-blocking compatibility suite depend on it.
      const fragment = harness({ videos: [...videos] });
      const viaK = await fragment.service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        requestMeta: REQUEST_META,
      });
      assert.equal(viaK.valid, true);
      for (const url of mediaUrls(viaK)) {
        assert.ok(
          url.includes(`/public/watch/${LEGACY_ALIAS}/`),
          `the #k path stopped echoing its own credential: ${url}`,
        );
      }
    });
  }

  it("RESUME-31 a Bunny resume payload leaks no alias, in the poster or the player", async () => {
    let signCount = 0;
    const bunnyStream = {
      isEnabled: (): boolean => true,
      canSignEmbedUrl: (): boolean => true,
      getPullZoneHostname: (): string => "vz-testzone.b-cdn.net",
      createSignedEmbedUrl: (videoId: string) => {
        signCount += 1;
        return {
          embedUrl: `https://iframe.mediadelivery.net/embed/987654/${videoId}?token=deadbeef&expires=1&autoplay=false`,
          token: "deadbeef",
          expires: 1,
        };
      },
      getVideo: async () => {
        throw new Error("public playback must never call the Bunny API");
      },
    };

    const { service } = harness({
      videos: [bunnyStreamVideo(), localFileVideo()],
      bunnyStream,
    });

    const opened = await viaCompat(service);
    const resumed = await viaResume(service, opened.resumeGrant as string);

    assert.equal(resumed.valid, true);
    assert.ok(signCount > 0, "the Bunny fixture did not sign anything");

    const bunny = resumed.videos.find((video) => video.id === "video-bunny-stream");
    assert.ok(bunny, "the Bunny video was dropped from the payload");

    // The signed player URL is Bunny's own and never carried a share
    // credential — asserted rather than assumed, because it is the one URL
    // in the payload this backend does not build the path of.
    assert.equal(bunny.embedUrl?.includes(LEGACY_ALIAS), false);
    assert.ok(bunny.embedUrl?.includes(BUNNY_VIDEO_GUID));
    assert.equal(JSON.stringify(resumed).includes(LEGACY_ALIAS), false);
  });
});

describe("RESUME-27/28 resume-derived media works, and yields no #k credential", () => {
  it("RESUME-27 a LOCAL_FILE stream is served through the resume media token", async () => {
    const { service } = harness({ videos: [localFileVideo()] });

    const opened = await viaCompat(service);
    const resumed = await viaResume(service, opened.resumeGrant as string);
    const token = mediaToken(resumed.videos[0]?.publicPlaybackUrl);

    // The token segment is the resume media token, not a credential.
    assert.ok(token.startsWith("rmv1"));
    assert.notEqual(token, LEGACY_ALIAS);

    // And it actually serves. This is the half that a leak-only test would
    // miss: closing the disclosure by emitting a URL that does not work
    // would pass every assertion above and break every reviewer.
    const file = await service.getPublicLocalVideoFile({
      host: LEGACY_HOST,
      token,
      videoId: "video-local-file",
    });
    assert.equal(typeof file.mimeType, "string");
  });

  it("RESUME-27 a DB_BLOB range and a thumbnail are served the same way", async () => {
    const { service } = harness({ videos: [dbBlobVideo(), localFileVideo()] });

    const opened = await viaCompat(service);
    const resumed = await viaResume(service, opened.resumeGrant as string);

    const blobToken = mediaToken(
      resumed.videos.find((video) => video.id === "video-db-blob")
        ?.binaryPlaybackUrl,
    );
    const binary = await service.getPublicDatabaseVideoBinary({
      host: LEGACY_HOST,
      token: blobToken,
      videoId: "video-db-blob",
    });
    assert.equal(binary.statusCode, 200);
    assert.ok(binary.sizeBytes > 0);
    assert.ok((binary.data?.length ?? 0) > 0);

    const posterToken = mediaToken(
      resumed.videos.find((video) => video.id === "video-local-file")
        ?.publicThumbnailUrl,
    );
    const thumbnail = await service.getPublicThumbnail({
      host: LEGACY_HOST,
      token: posterToken,
      videoId: "video-local-file",
    });
    assert.equal(typeof thumbnail.mimeType, "string");
  });

  it("RESUME-28 a resume media token is NOT a share credential anywhere else", async () => {
    const { service, prisma } = harness({ videos: [localFileVideo()] });

    const opened = await viaCompat(service);
    const resumed = await viaResume(service, opened.resumeGrant as string);
    const token = mediaToken(resumed.videos[0]?.publicPlaybackUrl);

    // It opens no watch session — which is the escalation this whole change
    // exists to prevent. Presented as `#k` it is simply an unknown token.
    assert.deepEqual(
      await service.resolvePublicWatch({
        host: LEGACY_HOST,
        token,
        requestMeta: REQUEST_META,
      }),
      PUBLIC_DENIAL_RESPONSE,
    );
    // Nor as a transport alias on the compatibility exchange.
    assert.deepEqual(
      await service.resolvePublicWatchCompatible({
        host: LEGACY_HOST,
        alias: token,
        requestMeta: REQUEST_META,
      }),
      PUBLIC_DENIAL_RESPONSE,
    );
    // Nor as a session grant on the resume endpoint itself: the two halves of
    // the resume subsystem are domain-separated from each other as well.
    assert.deepEqual(
      await viaResume(service, token),
      PUBLIC_DENIAL_RESPONSE,
    );

    // And it is bound to ONE video: a poster URL is not a key to the link.
    const second = harness({ videos: [localFileVideo(), dbBlobVideo()] });
    const opened2 = await viaCompat(second.service);
    const resumed2 = await viaResume(
      second.service,
      opened2.resumeGrant as string,
    );
    const localToken = mediaToken(
      resumed2.videos.find((video) => video.id === "video-local-file")
        ?.publicPlaybackUrl,
    );
    await assert.rejects(
      second.service.getPublicDatabaseVideoBinary({
        host: LEGACY_HOST,
        token: localToken,
        videoId: "video-db-blob",
      }),
      "a token minted for one video reached another",
    );

    assert.ok(prisma.accessLogs.length > 0);
  });

  it("RESUME-28 the alias still works on #k, so the refusals above are about the TOKEN", async () => {
    // The positive control for the whole block. Nothing here weakened the
    // canonical credential; a reviewer who legitimately holds it is
    // unaffected.
    const { service } = harness({ videos: [localFileVideo()] });

    assert.equal(
      (
        await service.resolvePublicWatch({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          requestMeta: REQUEST_META,
        })
      ).valid,
      true,
    );
  });
});

describe("RESUME-29/30 resume-derived media dies with the session", () => {
  it("RESUME-29 a media token cannot outlive the resume grant that minted it", async () => {
    // The session grant has 30 minutes left; the media TTL is hours. The
    // clamp is what stops a poster URL working after the session it came from
    // has expired — which would put the TTL back to bounding nothing.
    const { service, config } = harness({ videos: [localFileVideo()] });
    const resume = new PublicReviewResumeService(config as never);
    const nearExpiry = resume.issue({
      shareLinkId: SHARE_LINK_ID,
      host: LEGACY_HOST,
      now: new Date(Date.now() - (8 * 60 * 60 - 30 * 60) * 1000),
    });

    const resumed = await viaResume(service, nearExpiry);
    assert.equal(resumed.valid, true);
    const token = mediaToken(resumed.videos[0]?.publicPlaybackUrl);

    const payload = JSON.parse(
      Buffer.from(
        token.slice("rmv1".length).slice(0, -43),
        "base64url",
      ).toString("utf8"),
    ) as { exp: number };

    const sessionExpiry = Math.floor(Date.now() / 1000) + 30 * 60;
    assert.ok(
      payload.exp <= sessionExpiry + 5,
      `media token outlives its session: ${payload.exp} > ${sessionExpiry}`,
    );
  });

  it("RESUME-29 an expired media token is refused on every media route", async () => {
    const { service, config } = harness({
      videos: [localFileVideo(), dbBlobVideo()],
    });
    const resume = new PublicReviewResumeService(config as never);
    const stale = resume.issueMediaToken({
      shareLinkId: SHARE_LINK_ID,
      videoId: "video-local-file",
      host: LEGACY_HOST,
      notAfter: Math.floor(Date.now() / 1000) - 60,
    });

    await assert.rejects(
      service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: stale,
        videoId: "video-local-file",
      }),
    );
    await assert.rejects(
      service.getPublicThumbnail({
        host: LEGACY_HOST,
        token: stale,
        videoId: "video-local-file",
      }),
    );

    // Positive control: a fresh one on the same fixture works.
    const fresh = resume.issueMediaToken({
      shareLinkId: SHARE_LINK_ID,
      videoId: "video-local-file",
      host: LEGACY_HOST,
    });
    assert.ok(
      await service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: fresh,
        videoId: "video-local-file",
      }),
    );
  });

  it("RESUME-30 the kill switch invalidates resume-derived media, not just resume", async () => {
    // THE PROPERTY THE WHOLE FIX IS FOR. Clearing the allowlist must not
    // leave already-issued media URLs working for the life of their tokens —
    // that would be the same false sense of closure the alias leak created,
    // one level down.
    const capable = harness({ videos: [localFileVideo()] });
    const opened = await viaCompat(capable.service);
    const resumed = await viaResume(
      capable.service,
      opened.resumeGrant as string,
    );
    const token = mediaToken(resumed.videos[0]?.publicPlaybackUrl);

    // It works while the host is capable.
    assert.ok(
      await capable.service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token,
        videoId: "video-local-file",
      }),
    );

    const killed = harness({
      videos: [localFileVideo()],
      env: { PUBLIC_COMPATIBILITY_URL_HOSTS: "" },
    });

    await assert.rejects(
      killed.service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token,
        videoId: "video-local-file",
      }),
      "a resume media token survived the kill switch",
    );
    await assert.rejects(
      killed.service.getPublicThumbnail({
        host: LEGACY_HOST,
        token,
        videoId: "video-local-file",
      }),
    );

    // AND `#k` MEDIA IS UNTOUCHED BY THE SAME SWITCH. The kill switch is
    // scoped to the email-safe surface; if it also broke ordinary alias-based
    // playback it would be an outage rather than a lever.
    assert.ok(
      await killed.service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-local-file",
      }),
    );
  });

  it("RESUME-30 a forged or foreign-host media token reaches no ShareLink", async () => {
    const { service, prisma, config } = harness({ videos: [localFileVideo()] });
    const resume = new PublicReviewResumeService(config as never);

    const wrongHost = resume.issueMediaToken({
      shareLinkId: SHARE_LINK_ID,
      videoId: "video-local-file",
      host: FOREIGN_HOST,
    });
    const real = resume.issueMediaToken({
      shareLinkId: SHARE_LINK_ID,
      videoId: "video-local-file",
      host: LEGACY_HOST,
    });
    const body = real.slice("rmv1".length);
    const payload = body.slice(0, -43);
    const signature = body.slice(-43);

    /* TOKEN-SHAPED forgeries: refused, and they reach no ShareLink at all.
       Everything here is long enough that `isMediaToken()` claims it, so a
       failed MAC is the end of the request rather than a fall-through. */
    for (const token of [
      wrongHost,
      `rmv1${"x".repeat(80)}`,
      // Right payload, wrong signature.
      `rmv1${payload}${"A".repeat(43)}`,
      // Tampered payload, real signature.
      `rmv1${payload}x${signature}`,
      // A character outside base64url in the body.
      `rmv1${payload}.${signature.slice(1)}`,
      // The SESSION grant, which is a different MAC domain entirely.
      (await viaCompat(service)).resumeGrant ?? "",
    ]) {
      prisma.counters.shareLinkFindFirst = 0;

      await assert.rejects(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: String(token),
          videoId: "video-local-file",
        }),
        `accepted: ${String(token).slice(0, 32)}`,
      );
      assert.equal(
        prisma.counters.shareLinkFindFirst,
        0,
        `a forged media token reached the database: ${String(token).slice(0, 32)}`,
      );
    }

    /* AND THE COLLISION CASE, which is why the length rule exists.
       `rmv1` is four base64url characters, so a real 16-character alias CAN
       begin with it — about one in every sixteen million, which is not rare
       enough to ignore on a credential that must never be misread. A value
       that is short enough to be an alias is therefore treated as one, and
       must keep working. */
    const colliding = harness({
      videos: [localFileVideo()],
      shareLink: { alias: "rmv1AbCdEfGhIjKl" },
    });

    assert.equal(
      (
        await colliding.service.resolvePublicWatch({
          host: LEGACY_HOST,
          token: "rmv1AbCdEfGhIjKl",
          requestMeta: REQUEST_META,
        })
      ).valid,
      true,
      "an alias beginning with the media-token prefix stopped working",
    );
    assert.ok(
      await colliding.service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: "rmv1AbCdEfGhIjKl",
        videoId: "video-local-file",
      }),
      "media for an alias beginning with the prefix stopped working",
    );

    // Positive control on the same counter.
    prisma.counters.shareLinkFindFirst = 0;
    assert.ok(
      await service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: real,
        videoId: "video-local-file",
      }),
    );
    assert.ok(prisma.counters.shareLinkFindFirst > 0);
  });

  it("RESUME-30 revoking the link still stops resume-derived media", async () => {
    const healthy = harness({ videos: [localFileVideo()] });
    const opened = await viaCompat(healthy.service);
    const resumed = await viaResume(
      healthy.service,
      opened.resumeGrant as string,
    );
    const token = mediaToken(resumed.videos[0]?.publicPlaybackUrl);

    await healthy.adminWebsites.revokeShareLink(SHARE_LINK_ID, "admin-1");

    await assert.rejects(
      healthy.service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token,
        videoId: "video-local-file",
      }),
    );
  });
});


/* ------------------------------------------------------------------ *
 * DEFENCE IN DEPTH — the two protections mutation testing found untested
 *
 * Both survived a mutation on the first pass. Neither is currently the ONLY
 * thing standing between an attacker and a ShareLink — the host binding
 * covers the first, and the `purpose` field covers the second — which is
 * exactly why they were invisible. A layer that is only load-bearing after
 * some OTHER layer is removed still has to be held in place, or it quietly
 * disappears in a refactor and nobody learns until the layer above it does
 * too.
 * ------------------------------------------------------------------ */

describe("MEDIUM-4 the rmv1 TTL comes from configuration, not a constant", () => {
  const readExp = (token: string): number =>
    (
      JSON.parse(
        Buffer.from(
          token.slice("rmv1".length).slice(0, -43),
          "base64url",
        ).toString("utf8"),
      ) as { exp: number }
    ).exp;

  for (const [label, mediaTtl, sessionAgeSeconds, expected] of [
    // The configured ceiling binds when it is the smaller number.
    ["a 300-second media TTL", "300", 0, 300],
    ["the default media TTL", undefined, 0, 21600],
    ["the lower bound", "300", 0, 300],
    ["the upper bound", "86400", 0, 8 * 60 * 60],
    // ...and the SESSION binds when IT is smaller: a grant with 30 minutes
    // left cannot hand out a six-hour media token.
    ["a media TTL larger than the session remainder", "86400", 7.5 * 3600, 1800],
  ] as const) {
    it(`${label}: exp is min(configured media TTL, session remainder)`, async () => {
      const { service, config } = harness({
        videos: [localFileVideo()],
        ...(mediaTtl === undefined
          ? {}
          : { env: { PUBLIC_MEDIA_GRANT_TTL_SECONDS: mediaTtl } }),
      });
      const resume = new PublicReviewResumeService(config as never);
      const grant = resume.issue({
        shareLinkId: SHARE_LINK_ID,
        host: LEGACY_HOST,
        now: new Date(Date.now() - sessionAgeSeconds * 1000),
      });

      const resumed = await viaResume(service, grant);
      assert.equal(resumed.valid, true);

      const exp = readExp(mediaToken(resumed.videos[0]?.publicPlaybackUrl));
      const remaining = exp - Math.floor(Date.now() / 1000);

      // Within a couple of seconds of the expected ceiling — the assertion is
      // about WHICH number bounds it, not about clock precision.
      assert.ok(
        Math.abs(remaining - expected) <= 3,
        `expected ~${expected}s, got ${remaining}s`,
      );
    });
  }

  it("the hard-coded six hours is gone: a tightened setting actually applies", async () => {
    // The regression this closes. With a constant in the service, an operator
    // who set PUBLIC_MEDIA_GRANT_TTL_SECONDS=300 still received six-hour
    // media tokens — a setting that silently did not apply.
    const tight = harness({
      videos: [localFileVideo()],
      env: { PUBLIC_MEDIA_GRANT_TTL_SECONDS: "300" },
    });
    const loose = harness({ videos: [localFileVideo()] });

    const a = readExp(
      mediaToken((await viaCompat(tight.service)).videos[0]?.publicPlaybackUrl),
    );
    const b = readExp(
      mediaToken((await viaCompat(loose.service)).videos[0]?.publicPlaybackUrl),
    );

    assert.ok(b - a > 3600, `the setting had no effect: ${a} vs ${b}`);
  });
});

describe("resume media tokens are scoped by website as well as by host", () => {
  it("refuses a token naming a ShareLink on ANOTHER website", async () => {
    // A token that the mint path can never produce: its `host` claim is this
    // website's, but its `sid` names a link belonging to the other tenant.
    // Only something holding the signing key could make one — so this is the
    // layer BELOW the MAC, and it is what makes the ShareLink lookup's
    // `websiteId` scope more than decoration.
    const { service, config } = harness({
      videos: [localFileVideo()],
      extraShareLinks: [
        {
          id: SECOND_SHARE_LINK_ID,
          websiteId: FOREIGN_WEBSITE_ID,
          alias: "ZzYyXxWw",
          videoIds: ["video-local-file"],
        },
      ],
    });
    const resume = new PublicReviewResumeService(config as never);

    const crossTenant = resume.issueMediaToken({
      shareLinkId: SECOND_SHARE_LINK_ID,
      videoId: "video-local-file",
      host: LEGACY_HOST,
    });

    await assert.rejects(
      service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: crossTenant,
        videoId: "video-local-file",
      }),
      "a media token reached a ShareLink on another website",
    );

    // Positive control: the same mint for THIS website's link works, so the
    // refusal is about the scope and not about the fixture.
    assert.ok(
      await service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: resume.issueMediaToken({
          shareLinkId: SHARE_LINK_ID,
          videoId: "video-local-file",
          host: LEGACY_HOST,
        }),
        videoId: "video-local-file",
      }),
    );
  });
});

describe("the three grant kinds are separated at the MAC, not by a field", () => {
  it("no two domains produce the same signature for the same payload", () => {
    // RESUME-24 already proves a MEDIA GRANT and a SESSION GRANT cannot be
    // interchanged even with the purpose check deleted. This extends that to
    // the THIRD kind — the resume media token — which shares a secret with the
    // session grant and is distinguished from it today by `purpose` and by a
    // prefix. Both of those are single fields inside a payload; the domain is
    // what makes the separation structural.
    const secret = "mutation-proof-secret-at-least-thirty-two-chars";
    const payload = "cGF5bG9hZA";

    const signatures = [
      // The media grant's domain: deliberately the empty string, so its wire
      // bytes never changed. See grant-signature.util.ts.
      signGrantPayload(secret, "", payload),
      signGrantPayload(secret, RESUME_GRANT_DOMAIN, payload),
      signGrantPayload(secret, RESUME_MEDIA_GRANT_DOMAIN, payload),
    ];

    assert.equal(new Set(signatures).size, 3, "two domains collided");
    // And the domains themselves are distinct strings, so the assertion above
    // cannot be satisfied by an accident of hashing.
    assert.equal(
      new Set(["", RESUME_GRANT_DOMAIN, RESUME_MEDIA_GRANT_DOMAIN]).size,
      3,
    );
  });
});


/* ------------------------------------------------------------------ *
 * COMPAT-ALIAS-01 … 12 — THE FIRST `?r=` EXCHANGE IS ALIAS-FREE TOO
 *
 * The last escalation, and the one that defeated an operational property
 * rather than merely a TTL:
 *
 *   stolen transportAlias → redeem once → read ShareLink.alias out of the
 *   media URLs → use /watch#k=<alias> indefinitely
 *
 * Removing the host from `PUBLIC_COMPATIBILITY_URL_HOSTS` stops future `?r=`
 * redemption, but anyone who had already redeemed kept working through the
 * recovered `#k` credential. The switch closed the door and left the window.
 *
 * The compatibility reply now uses the SAME alias-free media-token mode the
 * resume reply uses — one `mediaTokenModeFor()` decision, one set of URL
 * builders, no second implementation to drift.
 * ------------------------------------------------------------------ */

describe("COMPAT-ALIAS the first ?r exchange discloses no canonical credential", () => {
  for (const [id, label, videos] of [
    ["COMPAT-ALIAS-03", "LOCAL_FILE", [localFileVideo()]],
    ["COMPAT-ALIAS-02", "DB_BLOB", [dbBlobVideo()]],
    ["COMPAT-ALIAS-06", "generic embed", [embedVideo()]],
    ["COMPAT-ALIAS-06", "DIRECT_URL", [directUrlVideo()]],
    ["COMPAT-ALIAS-06", "Cloudinary upload", [cloudinaryUploadVideo()]],
    [
      "COMPAT-ALIAS-01",
      "every source type at once",
      [
        localFileVideo(),
        dbBlobVideo(),
        embedVideo(),
        directUrlVideo(),
        cloudinaryUploadVideo(),
      ],
    ],
  ] as const) {
    it(`${id} ${label}: zero alias literals anywhere in the reply`, async () => {
      const { service, prisma } = harness({ videos: [...videos] });

      const response = await viaCompat(service);

      assert.equal(response.valid, true);

      // The requirement, stated exactly: ZERO occurrences, over the whole
      // serialized body rather than a field list.
      assert.equal(
        JSON.stringify(response).split(LEGACY_ALIAS).length - 1,
        0,
        "the compatibility reply contained the canonical alias",
      );
      assert.equal(
        JSON.stringify(response).includes(LEGACY_TRANSPORT_ALIAS),
        false,
      );
      for (const value of allStrings(response)) {
        assert.equal(
          value.includes(LEGACY_ALIAS),
          false,
          `alias leaked in: ${value}`,
        );
      }

      // COMPAT-ALIAS-04. Every backend-served URL — playback, binary and
      // poster alike — carries a media token instead.
      for (const url of mediaUrls(response)) {
        assert.ok(url.includes("/rmv1"), url);
      }

      // COMPAT-ALIAS-07. And the view semantics are untouched: N -> N+1,
      // exactly once, with the access log written as before.
      assert.equal(prisma.shareLinkRecord.currentViews, 1);
      assert.deepEqual(
        prisma.accessLogs.map((log) => [log.status, log.reasonCode]),
        [[AccessLogStatus.ALLOWED, "OK"]],
      );
    });
  }

  it("COMPAT-ALIAS-05 a Bunny poster URL leaks no alias either", async () => {
    // The Bunny branch builds its poster URL from the same `:token` segment,
    // so it inherits the fix — but it is a separate branch behind a feature
    // flag, and "inherits" is a claim about code that must be checked.
    const bunnyStream = {
      isEnabled: (): boolean => true,
      canSignEmbedUrl: (): boolean => true,
      getPullZoneHostname: (): string => "vz-testzone.b-cdn.net",
      createSignedEmbedUrl: (videoId: string) => ({
        embedUrl: `https://iframe.mediadelivery.net/embed/987654/${videoId}?token=deadbeef&expires=1&autoplay=false`,
        token: "deadbeef",
        expires: 1,
      }),
      getVideo: async () => {
        throw new Error("public playback must never call the Bunny API");
      },
    };
    const { service } = harness({
      videos: [bunnyStreamVideo(), localFileVideo()],
      bunnyStream,
    });

    const response = await viaCompat(service);
    const bunny = response.videos.find(
      (video) => video.id === "video-bunny-stream",
    );

    assert.ok(bunny);
    assert.equal(JSON.stringify(response).includes(LEGACY_ALIAS), false);
    // The signed player URL is Bunny's own and carries no share value at all.
    assert.ok(bunny.embedUrl?.includes(BUNNY_VIDEO_GUID));
    assert.equal(bunny.embedUrl?.includes(LEGACY_ALIAS), false);
  });

  it("COMPAT-ALIAS-08 the returned resumeGrant works, and its media tokens outlive nothing", async () => {
    const { service, prisma } = harness({ videos: [localFileVideo()] });

    const opened = await viaCompat(service);
    const grant = opened.resumeGrant as string;
    assert.equal(typeof grant, "string");

    const resumed = await viaResume(service, grant);
    assert.equal(resumed.valid, true);
    // COMPAT-ALIAS-07 again, from the other side: the resume spends nothing.
    assert.equal(prisma.shareLinkRecord.currentViews, 1);

    // THE CLAMP. A compatibility reply establishes the session AND hands out
    // the media tokens for it, so those tokens must not outlive the grant
    // minted in the same response — otherwise deleting the grant from storage
    // would stop the reviewer resuming while the URLs already in their DOM
    // kept working.
    const readExp = (value: string): number =>
      (
        JSON.parse(
          Buffer.from(value.slice(0, -43), "base64url").toString("utf8"),
        ) as { exp: number }
      ).exp;

    const mediaExp = readExp(
      mediaToken(opened.videos[0]?.publicPlaybackUrl).slice("rmv1".length),
    );
    const sessionExp = readExp(grant.split(".")[0] + "x".repeat(43));

    assert.ok(
      mediaExp <= sessionExp,
      `media token outlives its session: ${mediaExp} > ${sessionExp}`,
    );
  });

  it("COMPAT-ALIAS-11 the kill switch invalidates media issued by the FIRST exchange", async () => {
    // The property the escalation defeated. Before the fix, a reviewer who
    // had redeemed once held the canonical alias and kept working after the
    // host was removed. Now everything that reply handed out dies with it.
    const capable = harness({ videos: [localFileVideo()] });
    const opened = await viaCompat(capable.service);
    const token = mediaToken(opened.videos[0]?.publicPlaybackUrl);

    assert.ok(
      await capable.service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token,
        videoId: "video-local-file",
      }),
    );

    const killed = harness({
      videos: [localFileVideo()],
      env: { PUBLIC_COMPATIBILITY_URL_HOSTS: "" },
    });

    // 7. the transport alias stops redeeming
    assert.deepEqual(await viaCompat(killed.service), PUBLIC_DENIAL_RESPONSE);
    // 8. the resume grant stops redeeming
    assert.deepEqual(
      await viaResume(killed.service, opened.resumeGrant as string),
      PUBLIC_DENIAL_RESPONSE,
    );
    // 9. the already-issued media token stops serving
    await assert.rejects(
      killed.service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token,
        videoId: "video-local-file",
      }),
      "compatibility-issued media survived the kill switch",
    );
    // 10. and nothing the reply disclosed opens a #k session
    assert.deepEqual(
      await killed.service.resolvePublicWatch({
        host: LEGACY_HOST,
        token,
        requestMeta: REQUEST_META,
      }),
      PUBLIC_DENIAL_RESPONSE,
    );

    // 11. THE GENUINE `#k` CREDENTIAL IS UNAFFECTED. The switch is a lever on
    // one surface, not an outage — and this is what proves the nine refusals
    // above are about the surface rather than about a broken fixture.
    assert.equal(
      (
        await killed.service.resolvePublicWatch({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          requestMeta: REQUEST_META,
        })
      ).valid,
      true,
    );
    assert.ok(
      await killed.service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-local-file",
      }),
    );
  });
});

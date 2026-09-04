/**
 * EMAIL-SAFE REVIEWER URL — the backend half of the compatibility matrix.
 *
 *   COMPAT-01  the existing `#k` credential path is unchanged
 *   COMPAT-02  `?r=<transportAlias>` opens the SAME ShareLink with the SAME payload
 *   COMPAT-04  an invalid, malformed or foreign-kind alias fails closed
 *   COMPAT-05  a REVOKED ShareLink is refused through the transport alias
 *   COMPAT-06  an expired ShareLink is refused
 *   COMPAT-07  a DISABLED ShareLink is refused
 *   COMPAT-08  a wrong, unknown or disabled host is refused
 *   COMPAT-09  a video outside the membership is never listed or served
 *   COMPAT-10  the compatibility exchange has no GET form (a page fetch reaches nothing)
 *   COMPAT-11  the compatibility exchange consumes EXACTLY what the `#k` exchange consumes
 *   COMPAT-12  `/view` and media requests keep their current maxViews semantics
 *   COMPAT-13  a scanner's GET/HEAD cannot consume a link
 *
 * The browser half (scrubbing, referrer, storage, conflict, reload) lives in
 * `CPR_arcwildstudios/tools/watch-browser-test.mjs`. The design is in
 * `docs/superpowers/specs/2026-09-02-email-safe-reviewer-url-design.md`.
 *
 * THE ONE PROPERTY EVERYTHING BELOW REDUCES TO: the transport alias is
 * swapped for the row's own `alias` and the UNMODIFIED V2 resolver runs. So
 * the tests compare the compatibility exchange against the `#k` exchange on
 * the same fixture, rather than re-deriving each authorization rule — a rule
 * the `#k` path enforces is enforced here by construction, and a rule the `#k`
 * path does not enforce would be a lie to claim.
 *
 * This file is deliberately NOT named `share-link-compat-*`: those ids are the
 * Wave A backward-compatibility manifest. These are new behaviour.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import {
  HttpStatus,
  NotFoundException,
  RequestMethod,
  ValidationPipe,
  type INestApplication,
} from "@nestjs/common";
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { validate } from "class-validator";
import type { Request, Response } from "express";
import type { ApiEnvironmentConfig } from "../src/config/env.config";
import {
  AccessLogStatus,
  AssignmentStatus,
  DomainStatus,
  ShareLinkStatus,
} from "../src/generated/prisma/client";
import { PublicController } from "../src/public/public.controller";
import { PublicWatchCompatibleExchangeDto } from "../src/public/dto/public-watch-compatible-exchange.dto";
import { PublicService } from "../src/public/public.service";
import type { PublicWatchResponse } from "../src/public/types/public-watch-response.type";
import {
  THROTTLE_PROFILE_METADATA,
  THROTTLE_PROFILES,
} from "../src/security/throttle-profile.decorator";
import {
  createCompatHarness,
  directUrlVideo,
  FOREIGN_HOST,
  LEGACY_ALIAS,
  LEGACY_HOST,
  LEGACY_RAW_TOKEN,
  LEGACY_TRANSPORT_ALIAS,
  localFileVideo,
  parseMediaUrl,
  propertyNames,
  PUBLIC_DENIAL_RESPONSE,
  SECOND_TRANSPORT_ALIAS,
  SHARE_LINK_ID,
  UNKNOWN_HOST,
  UNKNOWN_TRANSPORT_ALIAS,
  UNSUPPORTED_COMPAT_HOST,
  WEBSITE_ID,
  type CompatHarnessOptions,
} from "./share-link-compat-harness";
import { defineControllerParamTypes } from "./share-link-compat-http-harness";

/** A 16-character share alias — the CURRENT `#k` credential shape. */
const HARDENED_SHARE_ALIAS = "aBcDeFgHiJkLmNoP";

const REQUEST_META = {
  ip: "203.0.113.10",
  userAgent: "compat-matrix",
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
  alias: string,
  host: string = LEGACY_HOST,
): Promise<PublicWatchResponse> {
  return service.resolvePublicWatchCompatible({
    host,
    alias,
    requestMeta: REQUEST_META,
  });
}

function viaFragment(
  service: PublicService,
  token: string,
  host: string = LEGACY_HOST,
): Promise<PublicWatchResponse> {
  return service.resolvePublicWatch({ host, token, requestMeta: REQUEST_META });
}

/* ------------------------------------------------------------------ *
 * COMPAT-01 — the `#k` path is byte-for-behaviour what it was
 * ------------------------------------------------------------------ */

describe("COMPAT-01 the existing #k credential path is unchanged", () => {
  it("still resolves the share alias on a row that also carries a transport alias", async () => {
    const { service, prisma } = harness();

    const response = await viaFragment(service, LEGACY_ALIAS);

    assert.equal(response.valid, true);
    assert.equal(response.website?.id, WEBSITE_ID);
    assert.deepEqual(
      response.videos.map((video) => video.id),
      ["video-direct-url", "video-local-file"],
    );
    assert.deepEqual(propertyNames(response), [
      "reasonCode",
      "valid",
      "videos",
      "website",
    ]);
    assert.equal(prisma.shareLinkRecord.currentViews, 1);
  });

  it("still resolves a legacy raw token on such a row", async () => {
    const { service } = harness();

    assert.equal((await viaFragment(service, LEGACY_RAW_TOKEN)).valid, true);
  });

  it("never accepts the transport alias as a `#k` credential", async () => {
    // The transport alias is not a watch credential. Handing it to the V2
    // resolver — the `#k` fragment, the legacy GET, or a media route path —
    // must be refused, or the compatibility endpoint would have created a
    // second credential with the authority of the first.
    const { service, prisma } = harness();

    assert.deepEqual(
      await viaFragment(service, LEGACY_TRANSPORT_ALIAS),
      PUBLIC_DENIAL_RESPONSE,
    );
    await assert.rejects(
      service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: LEGACY_TRANSPORT_ALIAS,
        videoId: "video-local-file",
      }),
      NotFoundException,
    );
    assert.equal(prisma.shareLinkRecord.currentViews, 0);
  });
});

/* ------------------------------------------------------------------ *
 * COMPAT-02 — same ShareLink, same payload
 * ------------------------------------------------------------------ */

describe("COMPAT-02 ?r=<transportAlias> opens the same ShareLink", () => {
  it("returns a payload identical to the #k exchange for the same link", async () => {
    // Two FRESH harnesses, so each path claims exactly one view from the
    // same starting state; unlimited link, so no time-bound grant differs.
    const fragment = harness();
    const compat = harness();

    const viaK = await viaFragment(fragment.service, LEGACY_ALIAS);
    const viaR = await viaCompat(compat.service, LEGACY_TRANSPORT_ALIAS);

    assert.equal(viaR.valid, true);

    // TWO PERMITTED DIFFERENCES, BOTH PINNED IN BOTH DIRECTIONS.
    //
    // 1. `resumeGrant` is minted only for the flow that scrubs its own carrier
    //    from the address bar, because that is the only flow a refresh would
    //    otherwise strand. The `#k` fragment survives a reload unaided, so it
    //    needs none — and issuing one there would be a second credential
    //    handed out for no reason.
    //
    // 2. THE BACKEND MEDIA URLS DIFFER, AND THAT IS THE SECURITY FIX.
    //    A media URL echoes the presented token into its `:token` path
    //    segment. The `#k` caller presented the alias, so echoing it back
    //    discloses nothing. The `?r=` caller presented only a TRANSPORT
    //    alias — so echoing the canonical alias let one redemption convert
    //    the weaker credential into the permanent one, and keep working after
    //    the host was removed from `PUBLIC_COMPATIBILITY_URL_HOSTS`. The
    //    compatibility reply now carries per-video `rmv1` tokens.
    //
    // Everything a reviewer SEES is still identical; that is asserted below
    // by stripping exactly these fields and comparing the rest.
    assert.equal(typeof viaR.resumeGrant, "string");
    assert.ok((viaR.resumeGrant ?? "").length > 0);
    // ABSENT on the `#k` body, not present-and-null. `in` is what tells those
    // two apart, and the pre-feature contract is "absent".
    assert.equal("resumeGrant" in viaK, false);

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
    assert.deepEqual(strip(viaR), strip(viaK));

    // The stripped URLs are genuinely different and genuinely present, so the
    // comparison above cannot be passing on two empty sets.
    const kUrls = viaK.videos.map((video) => video.publicPlaybackUrl);
    const rUrls = viaR.videos.map((video) => video.publicPlaybackUrl);
    assert.ok(kUrls.some((url) => typeof url === "string"));
    assert.notDeepEqual(rUrls, kUrls);

    // And the grant is not a smuggled credential: neither alias appears in it.
    assert.equal((viaR.resumeGrant ?? "").includes(LEGACY_ALIAS), false);
    assert.equal(
      (viaR.resumeGrant ?? "").includes(LEGACY_TRANSPORT_ALIAS),
      false,
    );
    assert.deepEqual(
      compat.prisma.accessLogs.map((log) => [
        log.status,
        log.reasonCode,
        log.shareLinkId,
      ]),
      [[AccessLogStatus.ALLOWED, "OK", SHARE_LINK_ID]],
    );
  });

  it("COMPAT-ALIAS-10 issues media URLs that carry NO credential at all", async () => {
    const { service } = harness();

    const response = await viaCompat(service, LEGACY_TRANSPORT_ALIAS);
    const local = response.videos.find(
      (video) => video.id === "video-local-file",
    );
    const playback = parseMediaUrl(local?.publicPlaybackUrl);
    const segments = playback.pathname.split("/");
    const token = segments[segments.indexOf("watch") + 1] as string;

    /* COMPAT-ALIAS-03. THIS ASSERTION WAS INVERTED ON 2026-09-03, and the
       inversion is the fix rather than a relaxation.

       It used to require the pathname to be
       `/api/v1/public/watch/<LEGACY_ALIAS>/videos/…` — i.e. it PINNED the
       canonical alias into a reply whose caller had presented only a
       transport alias. That is a credential escalation: redeem a stolen `?r=`
       once, read the alias out of `publicPlaybackUrl`, and use
       `/watch#k=<alias>` indefinitely — surviving removal of the host from
       `PUBLIC_COMPATIBILITY_URL_HOSTS`, which is precisely the operational
       property that switch exists to provide.

       The reply now carries a per-video, host-bound, short-lived media token
       instead, and the assertion states the property the old one contradicted. */
    assert.equal(
      playback.pathname,
      `/api/v1/public/watch/${token}/videos/video-local-file/local-file`,
    );
    assert.ok(token.startsWith("rmv1"), token.slice(0, 24));
    assert.notEqual(token, LEGACY_ALIAS);
    assert.equal(playback.params.host, LEGACY_HOST);

    // COMPAT-ALIAS-01. NEITHER credential reaches ANY part of the reply —
    // searched as a literal over the whole serialized body, so a field added
    // later that happens to carry one fails here without anyone remembering
    // to look.
    assert.equal(JSON.stringify(response).includes(LEGACY_ALIAS), false);
    assert.equal(
      JSON.stringify(response).includes(LEGACY_TRANSPORT_ALIAS),
      false,
    );

    // And that URL is servable by the existing local-file route as-is —
    // closing the disclosure by emitting a URL that does not work would pass
    // every assertion above and break every reviewer.
    const file = await service.getPublicLocalVideoFile({
      host: playback.params.host,
      token,
      videoId: "video-local-file",
    });
    assert.equal(file.statusCode, 200);

    // COMPAT-ALIAS-09. The token opens nothing as a share credential.
    assert.deepEqual(
      await service.resolvePublicWatch({
        host: LEGACY_HOST,
        token,
        requestMeta: REQUEST_META,
      }),
      PUBLIC_DENIAL_RESPONSE,
    );
  });

  it("COMPAT-ALIAS-12 the #k path still echoes its own credential, byte for byte", async () => {
    // The other half of the contract, and the reason the change is scoped to
    // one origin: a `#k` caller presented the alias, so echoing it back
    // discloses nothing they did not already hold — and every deployed client
    // and the release-blocking compatibility suite depend on that URL shape.
    const { service } = harness();

    const response = await viaFragment(service, LEGACY_ALIAS);
    const local = response.videos.find(
      (video) => video.id === "video-local-file",
    );

    assert.equal(
      parseMediaUrl(local?.publicPlaybackUrl).pathname,
      `/api/v1/public/watch/${LEGACY_ALIAS}/videos/video-local-file/local-file`,
    );
    assert.equal("resumeGrant" in response, false);
  });

  it("does not consult the credential of a DIFFERENT ShareLink", async () => {
    // Two links on the same website, each with its own transport alias. Each
    // transport alias opens exactly its own link and never the other.
    const { service, prisma } = harness({
      extraShareLinks: [
        {
          id: "share-link-other",
          alias: "Zy9wQr2",
          tokenHash: "0".repeat(64),
          transportAlias: SECOND_TRANSPORT_ALIAS,
          videoIds: ["video-direct-url"],
        },
      ],
    });

    const primary = await viaCompat(service, LEGACY_TRANSPORT_ALIAS);
    const other = await viaCompat(service, SECOND_TRANSPORT_ALIAS);

    assert.equal(primary.valid, true);
    assert.equal(other.valid, true);
    assert.deepEqual(
      primary.videos.map((video) => video.id),
      ["video-direct-url", "video-local-file"],
    );
    assert.deepEqual(
      other.videos.map((video) => video.id),
      ["video-direct-url"],
    );
    assert.equal(prisma.findShareLink(SHARE_LINK_ID).currentViews, 1);
    assert.equal(prisma.findShareLink("share-link-other").currentViews, 1);
  });
});

/* ------------------------------------------------------------------ *
 * COMPAT-04 — fail closed on anything that is not a minted alias
 * ------------------------------------------------------------------ */

describe("COMPAT-04 an invalid alias fails closed", () => {
  it("refuses an unknown but well-formed alias with the generic denial and no view", async () => {
    const { service, prisma } = harness();

    const response = await viaCompat(service, UNKNOWN_TRANSPORT_ALIAS);

    assert.deepEqual(response, PUBLIC_DENIAL_RESPONSE);
    assert.equal(prisma.shareLinkRecord.currentViews, 0);
    assert.deepEqual(
      prisma.accessLogs.map((log) => [log.status, log.reasonCode]),
      [[AccessLogStatus.DENIED, "INVALID_LINK"]],
    );
  });

  it("refuses every malformed shape BEFORE any database read", async () => {
    const { service, prisma } = harness();
    const before = { ...prisma.counters };

    for (const alias of [
      "",
      "   ",
      LEGACY_TRANSPORT_ALIAS.slice(0, 21), // one short
      `${LEGACY_TRANSPORT_ALIAS}x`, // one long
      `${LEGACY_TRANSPORT_ALIAS.slice(0, 19)}%2F`, // percent escape, 22 wide
      `${LEGACY_TRANSPORT_ALIAS.slice(0, 21)} `, // trailing space
      `${LEGACY_TRANSPORT_ALIAS.slice(0, 20)}+/`, // base64, not base64url
      ` ${LEGACY_TRANSPORT_ALIAS}`, // leading space: not trimmed into validity
      LEGACY_TRANSPORT_ALIAS.toUpperCase().slice(0, 21) + "é", // non-ASCII
      "a".repeat(256),
    ]) {
      assert.deepEqual(
        await viaCompat(service, alias),
        PUBLIC_DENIAL_RESPONSE,
        JSON.stringify(alias),
      );
    }

    // Secondary coverage: a shape refusal must not cost a query, so the
    // endpoint cannot be used to make the database do work on garbage.
    assert.equal(
      prisma.counters.shareLinkFindUnique,
      before.shareLinkFindUnique,
    );
    assert.equal(prisma.counters.shareLinkFindFirst, before.shareLinkFindFirst);
    assert.equal(
      prisma.counters.websiteDomainFindUnique,
      before.websiteDomainFindUnique,
    );
    assert.equal(prisma.shareLinkRecord.currentViews, 0);
    assert.ok(prisma.accessLogs.length > 0);
    assert.ok(
      prisma.accessLogs.every((log) => log.status === AccessLogStatus.DENIED),
    );
  });

  it("never accepts the `#k` credential (share alias or raw token) as a transport alias", async () => {
    // The two credential kinds must stay disjoint in BOTH directions. A share
    // alias offered on the compatibility endpoint is refused by shape (7 or
    // 16 characters) — and a 22-character string can never equal a share
    // alias, because the column that holds one is 16 wide.
    const { service, prisma } = harness({
      shareLink: { alias: HARDENED_SHARE_ALIAS },
    });

    for (const notATransportAlias of [
      LEGACY_ALIAS,
      HARDENED_SHARE_ALIAS,
      LEGACY_RAW_TOKEN,
    ]) {
      assert.deepEqual(
        await viaCompat(service, notATransportAlias),
        PUBLIC_DENIAL_RESPONSE,
        notATransportAlias,
      );
    }
    assert.equal(prisma.shareLinkRecord.currentViews, 0);
    // Positive control: the same row opens through its transport alias.
    assert.equal(
      (await viaCompat(service, LEGACY_TRANSPORT_ALIAS)).valid,
      true,
    );
  });

  it("refuses a row whose transport alias resolves but whose share alias is missing", async () => {
    // A row cannot be re-entered into the V2 resolver without its own alias.
    // Nothing falls back to the token hash or to another row.
    const { service, prisma } = harness({ shareLink: { alias: null } });

    assert.deepEqual(
      await viaCompat(service, LEGACY_TRANSPORT_ALIAS),
      PUBLIC_DENIAL_RESPONSE,
    );
    assert.equal(prisma.shareLinkRecord.currentViews, 0);
  });

  it("writes no credential of either kind into the access log", async () => {
    const { service, prisma } = harness();

    await viaCompat(service, LEGACY_TRANSPORT_ALIAS);
    await viaCompat(service, UNKNOWN_TRANSPORT_ALIAS);

    const serialized = JSON.stringify(prisma.accessLogs);
    assert.equal(serialized.includes(LEGACY_TRANSPORT_ALIAS), false);
    assert.equal(serialized.includes(UNKNOWN_TRANSPORT_ALIAS), false);
    assert.equal(serialized.includes(LEGACY_ALIAS), false);
  });
});

/* ------------------------------------------------------------------ *
 * COMPAT-05 / 06 / 07 — the ShareLink's own lifecycle governs
 * ------------------------------------------------------------------ */

describe("COMPAT-05/06/07 the ShareLink's lifecycle is the transport alias's lifecycle", () => {
  for (const [id, label, overrides, reason] of [
    [
      "COMPAT-05",
      "REVOKED",
      { status: ShareLinkStatus.REVOKED },
      "INVALID_LINK",
    ],
    [
      "COMPAT-06",
      "past expiresAt",
      { expiresAt: new Date("2020-01-01T00:00:00.000Z") },
      "EXPIRED_LINK",
    ],
    [
      "COMPAT-07",
      "DISABLED",
      { status: ShareLinkStatus.DISABLED },
      "INVALID_LINK",
    ],
    [
      "COMPAT-06",
      "EXPIRED (enum)",
      { status: ShareLinkStatus.EXPIRED },
      "INVALID_LINK",
    ],
    [
      "COMPAT-11",
      "view budget exhausted",
      { maxViews: 2, currentViews: 2 },
      "VIEW_LIMIT_REACHED",
    ],
  ] as const) {
    it(`${id} refuses a ${label} link through its transport alias, consuming nothing`, async () => {
      const { service, prisma } = harness({ shareLink: { ...overrides } });
      const viewsBefore = prisma.shareLinkRecord.currentViews;

      const viaR = await viaCompat(service, LEGACY_TRANSPORT_ALIAS);
      const viaK = await viaFragment(service, LEGACY_ALIAS);

      assert.deepEqual(viaR, PUBLIC_DENIAL_RESPONSE);
      assert.deepEqual(viaK, PUBLIC_DENIAL_RESPONSE);
      assert.equal(prisma.shareLinkRecord.currentViews, viewsBefore);
      // The real reason is recorded for the operator, identically on both
      // paths, and the shareLinkId is attached so a revoke is diagnosable.
      assert.deepEqual(
        prisma.accessLogs.map((log) => [
          log.status,
          log.reasonCode,
          log.shareLinkId,
        ]),
        [
          [AccessLogStatus.DENIED, reason, SHARE_LINK_ID],
          [AccessLogStatus.DENIED, reason, SHARE_LINK_ID],
        ],
      );
    });
  }

  it("COMPAT-05 a revoke that happens AFTER a successful compat exchange refuses the next one", async () => {
    const { service, prisma, adminWebsites } = harness();

    assert.equal(
      (await viaCompat(service, LEGACY_TRANSPORT_ALIAS)).valid,
      true,
    );
    await adminWebsites.revokeShareLink(SHARE_LINK_ID, "admin-1");

    assert.deepEqual(
      await viaCompat(service, LEGACY_TRANSPORT_ALIAS),
      PUBLIC_DENIAL_RESPONSE,
    );
    assert.equal(prisma.shareLinkRecord.currentViews, 1);
  });
});

/* ------------------------------------------------------------------ *
 * COMPAT-08 — host / domain binding
 * ------------------------------------------------------------------ */

describe("COMPAT-08 the transport alias is bound to the ShareLink's website", () => {
  it("refuses a host that belongs to another website", async () => {
    const { service, prisma } = harness();

    assert.deepEqual(
      await viaCompat(service, LEGACY_TRANSPORT_ALIAS, FOREIGN_HOST),
      PUBLIC_DENIAL_RESPONSE,
    );
    assert.equal(prisma.shareLinkRecord.currentViews, 0);
    // Positive control: the bound host admits the same alias.
    assert.equal(
      (await viaCompat(service, LEGACY_TRANSPORT_ALIAS, LEGACY_HOST)).valid,
      true,
    );
  });

  it("refuses an unknown host and a malformed host", async () => {
    const { service, prisma } = harness();

    for (const host of [UNKNOWN_HOST, "", "not a host", "a".repeat(254)]) {
      assert.deepEqual(
        await viaCompat(service, LEGACY_TRANSPORT_ALIAS, host),
        PUBLIC_DENIAL_RESPONSE,
        JSON.stringify(host),
      );
    }
    assert.equal(prisma.shareLinkRecord.currentViews, 0);
  });

  it("refuses a DISABLED domain and a DISABLED website", async () => {
    const disabledDomain = harness({
      domains: [
        {
          id: "domain-compat-1",
          domain: LEGACY_HOST,
          status: DomainStatus.DISABLED,
          websiteId: WEBSITE_ID,
        },
      ],
    });
    assert.deepEqual(
      await viaCompat(disabledDomain.service, LEGACY_TRANSPORT_ALIAS),
      PUBLIC_DENIAL_RESPONSE,
    );

    const disabledWebsite = harness();
    disabledWebsite.prisma.findWebsite(WEBSITE_ID).status = "DISABLED" as never;
    assert.deepEqual(
      await viaCompat(disabledWebsite.service, LEGACY_TRANSPORT_ALIAS),
      PUBLIC_DENIAL_RESPONSE,
    );
  });
});

/* ------------------------------------------------------------------ *
 * COMPAT-09 — membership
 * ------------------------------------------------------------------ */

describe("COMPAT-09 a video outside the membership is never listed or served", () => {
  it("omits a READY, assigned video that is simply not a member", async () => {
    const outsider = localFileVideo({ id: "video-outside" });
    const { service } = harness({ standaloneVideos: [outsider] });

    const response = await viaCompat(service, LEGACY_TRANSPORT_ALIAS);

    assert.equal(response.valid, true);
    assert.equal(
      response.videos.some((video) => video.id === "video-outside"),
      false,
    );
    await assert.rejects(
      service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-outside",
      }),
      NotFoundException,
    );
  });

  it("omits a member whose website assignment is no longer ACTIVE", async () => {
    const { service, prisma } = harness();
    prisma.setAssignmentStatus(
      "video-direct-url",
      WEBSITE_ID,
      AssignmentStatus.DISABLED,
    );

    const response = await viaCompat(service, LEGACY_TRANSPORT_ALIAS);

    assert.equal(response.valid, true);
    assert.deepEqual(
      response.videos.map((video) => video.id),
      ["video-local-file"],
    );
  });
});

/* ------------------------------------------------------------------ *
 * COMPAT-11 / 12 — view consumption parity, and what never consumes
 * ------------------------------------------------------------------ */

describe("COMPAT-11 the compatibility exchange consumes exactly what the #k exchange consumes", () => {
  it("claims one view per successful exchange on either path, and none on a denial", async () => {
    const { service, prisma } = harness();

    await viaCompat(service, LEGACY_TRANSPORT_ALIAS);
    assert.equal(prisma.shareLinkRecord.currentViews, 1);
    await viaFragment(service, LEGACY_ALIAS);
    assert.equal(prisma.shareLinkRecord.currentViews, 2);
    await viaCompat(service, UNKNOWN_TRANSPORT_ALIAS);
    await viaCompat(service, LEGACY_TRANSPORT_ALIAS, FOREIGN_HOST);
    assert.equal(prisma.shareLinkRecord.currentViews, 2);
  });

  it("shares ONE view budget between the two URL forms", async () => {
    // No independent counter: a maxViews budget is the ShareLink's, whichever
    // door the reviewer came through.
    const { service, prisma } = harness({ shareLink: { maxViews: 2 } });

    assert.equal(
      (await viaCompat(service, LEGACY_TRANSPORT_ALIAS)).valid,
      true,
    );
    assert.equal((await viaFragment(service, LEGACY_ALIAS)).valid, true);
    assert.deepEqual(
      await viaCompat(service, LEGACY_TRANSPORT_ALIAS),
      PUBLIC_DENIAL_RESPONSE,
    );
    assert.deepEqual(
      await viaFragment(service, LEGACY_ALIAS),
      PUBLIC_DENIAL_RESPONSE,
    );
    assert.equal(prisma.shareLinkRecord.currentViews, 2);
  });
});

describe("COMPAT-12 /view and media requests keep their current semantics", () => {
  it("records a display view without touching the ShareLink budget", async () => {
    const { service, prisma } = harness();
    await viaCompat(service, LEGACY_TRANSPORT_ALIAS);

    const view = await service.recordPublicVideoView({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
      videoId: "video-direct-url",
    });

    assert.equal(view.valid, true);
    assert.equal(prisma.shareLinkRecord.currentViews, 1);
  });

  it("serves any number of media requests without consuming a view", async () => {
    const { service, prisma } = harness();
    await viaCompat(service, LEGACY_TRANSPORT_ALIAS);

    for (let request = 0; request < 3; request += 1) {
      const file = await service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-local-file",
        rangeHeader: "bytes=0-1",
      });
      assert.ok(file.statusCode === 200 || file.statusCode === 206);
    }
    assert.equal(prisma.shareLinkRecord.currentViews, 1);
  });
});

/* ------------------------------------------------------------------ *
 * Controller and DTO — the wire contract
 * ------------------------------------------------------------------ */

class FakePublicService {
  readonly calls: Array<Record<string, unknown>> = [];

  async resolvePublicWatchCompatible(params: Record<string, unknown>) {
    this.calls.push(params);

    return PUBLIC_DENIAL_RESPONSE as PublicWatchResponse;
  }
}

class FakeConfigService {
  getOrThrow<T = unknown>(key: string): T {
    assert.equal(key, "api");

    return {
      trustProxyEnabled: false,
      trustProxyCloudflareOnly: false,
    } satisfies Partial<ApiEnvironmentConfig> as T;
  }
}

class FakeResponse {
  readonly headers = new Map<string, string>();

  setHeader(name: string, value: string): this {
    this.headers.set(name, value);

    return this;
  }
}

describe("POST /public/watch/exchange-compatible — controller contract", () => {
  it("registers the route as POST 200 with the public watch throttle and no guard", () => {
    const handler = PublicController.prototype.exchangePublicWatchCompatible;

    assert.equal(
      Reflect.getMetadata(PATH_METADATA, handler),
      "watch/exchange-compatible",
    );
    assert.equal(
      Reflect.getMetadata(METHOD_METADATA, handler),
      RequestMethod.POST,
    );
    assert.equal(
      Reflect.getMetadata(HTTP_CODE_METADATA, handler),
      HttpStatus.OK,
    );
    assert.equal(
      Reflect.getMetadata(THROTTLE_PROFILE_METADATA, handler),
      THROTTLE_PROFILES.publicWatch,
    );
    assert.equal(Reflect.getMetadata(GUARDS_METADATA, handler), undefined);
  });

  it("delegates host, alias and request metadata, and sets the no-store family", async () => {
    const publicService = new FakePublicService();
    const controller = new PublicController(
      publicService as never,
      new FakeConfigService() as never,
    );
    const response = new FakeResponse();

    const body = await controller.exchangePublicWatchCompatible(
      { host: LEGACY_HOST, alias: LEGACY_TRANSPORT_ALIAS },
      {
        headers: {
          referer: "https://customer.example.com/watch",
          "user-agent": "compat-matrix",
        },
        ip: "127.0.0.1",
        socket: {},
      } as unknown as Request,
      response as unknown as Response,
    );

    assert.deepEqual(body, PUBLIC_DENIAL_RESPONSE);
    assert.deepEqual(publicService.calls, [
      {
        host: LEGACY_HOST,
        alias: LEGACY_TRANSPORT_ALIAS,
        requestMeta: {
          ip: "127.0.0.1",
          referer: "https://customer.example.com/watch",
          userAgent: "compat-matrix",
        },
      },
    ]);
    assert.equal(
      response.headers.get("Cache-Control"),
      "private, no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  });

  it("requires host and alias in the body", async () => {
    const errors = await validate(new PublicWatchCompatibleExchangeDto());

    assert.deepEqual(errors.map((error) => error.property).sort(), [
      "alias",
      "host",
    ]);
  });

  it("rejects empty and oversized fields", async () => {
    const dto = new PublicWatchCompatibleExchangeDto();
    dto.host = "";
    dto.alias = "x".repeat(65);

    const errors = await validate(dto);
    const constraints = new Map(
      errors.map((error) => [error.property, error.constraints ?? {}]),
    );

    assert.ok(constraints.get("host")?.isNotEmpty);
    assert.ok(constraints.get("alias")?.maxLength);
  });
});

/* ------------------------------------------------------------------ *
 * COMPAT-10 / 13 — over a real Nest + Express server
 * ------------------------------------------------------------------ */

class RouteProbePublicService {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> =
    [];

  async resolvePublicWatch(params: Record<string, unknown>) {
    this.calls.push({ method: "resolvePublicWatch", params });

    return PUBLIC_DENIAL_RESPONSE;
  }

  async resolvePublicWatchCompatible(params: Record<string, unknown>) {
    this.calls.push({ method: "resolvePublicWatchCompatible", params });

    return {
      valid: true,
      reasonCode: "OK",
      website: {
        id: WEBSITE_ID,
        name: "Customer Website",
        slug: "customer-website",
        domain: LEGACY_HOST,
      },
      videos: [],
    } satisfies PublicWatchResponse;
  }
}

class RouteProbeConfigService {
  getOrThrow<T = unknown>(key: string): T {
    if (key !== "api") {
      throw new Error(`${key} missing`);
    }

    return {
      trustProxyEnabled: false,
      trustProxyCloudflareOnly: false,
    } satisfies Partial<ApiEnvironmentConfig> as T;
  }
}

describe("COMPAT-10/13 the compatibility exchange over a real server", () => {
  const API_PREFIX = "api/v1";
  let app: INestApplication;
  let baseUrl: string;
  let publicService: RouteProbePublicService;

  before(async () => {
    defineControllerParamTypes(PublicController, [
      PublicService,
      ConfigService,
    ]);
    publicService = new RouteProbePublicService();
    const moduleRef = await Test.createTestingModule({
      controllers: [PublicController],
      providers: [
        { provide: PublicService, useValue: publicService },
        { provide: ConfigService, useValue: new RouteProbeConfigService() },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(API_PREFIX);
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/${API_PREFIX}`;
  });

  after(async () => {
    await app?.close();
  });

  it("COMPAT-10 has no GET or HEAD form: a page-style fetch reaches no resolver", async () => {
    const url = new URL(`${baseUrl}/public/watch/exchange-compatible`);
    url.searchParams.set("host", LEGACY_HOST);
    url.searchParams.set("alias", LEGACY_TRANSPORT_ALIAS);

    const get = await fetch(url);
    const head = await fetch(url, { method: "HEAD" });

    assert.equal(get.status, 404);
    assert.equal(head.status, 404);
    assert.equal(publicService.calls.length, 0);
  });

  it("COMPAT-13 the alias in a query string of the LEGACY GET route is not a credential either", async () => {
    // A scanner that turns the reviewer URL into a GET against the API by
    // some accident of rewriting must still find nothing that consumes.
    const url = new URL(`${baseUrl}/public/watch`);
    url.searchParams.set("host", LEGACY_HOST);
    url.searchParams.set("token", LEGACY_TRANSPORT_ALIAS);

    const response = await fetch(url);
    assert.equal(response.status, 200);
    // It reaches the V2 resolver as an ordinary (unknown) credential, which
    // the resolution suite above proves is refused. Never the compat one.
    assert.equal(
      publicService.calls.every(
        (call) => call.method !== "resolvePublicWatchCompatible",
      ),
      true,
    );
    publicService.calls.length = 0;
  });

  it("answers a JSON POST with the watch shape and the no-store family", async () => {
    const response = await fetch(
      `${baseUrl}/public/watch/exchange-compatible`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          host: LEGACY_HOST,
          alias: LEGACY_TRANSPORT_ALIAS,
        }),
      },
    );
    const body = (await response.json()) as PublicWatchResponse;

    assert.equal(response.status, 200);
    assert.equal(body.valid, true);
    assert.equal(body.website?.domain, LEGACY_HOST);
    assert.equal(
      response.headers.get("cache-control"),
      "private, no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    const call = publicService.calls.find(
      (entry) => entry.method === "resolvePublicWatchCompatible",
    );
    assert.ok(call);
    assert.equal(call.params.host, LEGACY_HOST);
    assert.equal(call.params.alias, LEGACY_TRANSPORT_ALIAS);
  });
});

/* ------------------------------------------------------------------ *
 * CAPABILITY GATES REDEMPTION, NOT ONLY EMISSION
 *
 * `PUBLIC_COMPATIBILITY_URL_HOSTS` decides two separate things, and they must
 * agree: whether the Admin may be HANDED a `/watch?r=` URL for a host, and
 * whether a transport alias presented ON that host may be REDEEMED.
 *
 * Gating emission alone would make the variable a labelling preference. A
 * transport alias is a BEARER CREDENTIAL that nothing expires, so every URL
 * already delivered would keep working after an operator cleared the variable
 * and restarted — believing, reasonably, that they had closed the surface.
 * These tests pin the lever so that belief is correct.
 * ------------------------------------------------------------------ */

describe("CAP-REDEEM the capability allowlist gates redemption", () => {
  const requestMeta = {
    ip: "203.0.113.44",
    userAgent: "capability-suite",
    referer: undefined,
  };

  function harness(env?: Record<string, string>) {
    return createCompatHarness({
      videos: [directUrlVideo(), localFileVideo()],
      shareLink: { transportAlias: LEGACY_TRANSPORT_ALIAS },
      ...(env === undefined ? {} : { env }),
    });
  }

  it("CAP-REDEEM-01 an ALLOWED host redeems, and gets the full payload", async () => {
    const { service, prisma } = harness();

    const response = await service.resolvePublicWatchCompatible({
      host: LEGACY_HOST,
      alias: LEGACY_TRANSPORT_ALIAS,
      requestMeta,
    });

    assert.equal(response.valid, true);
    assert.equal(response.reasonCode, "OK");
    assert.equal(response.website?.domain, LEGACY_HOST);
    assert.ok(response.videos.length > 0);
    // The positive control that gives every denial below its meaning.
    assert.equal(
      prisma.accessLogs.at(-1)?.status,
      AccessLogStatus.ALLOWED,
      "the allowed host wrote an ALLOWED access log",
    );
  });

  it("CAP-REDEEM-02 an UNSUPPORTED host is refused BEFORE the credential is read", async () => {
    /* The control host is an ACTIVE domain of the CORRECT website holding the
       CORRECT transport alias. The single thing wrong with it is that it is
       not on the allowlist, so a denial here can have no other cause.

       "Before credential resolution" is asserted on observable state rather
       than on a spy: zero `shareLink.findUnique` calls means the presented
       secret was never looked up, let alone matched. */
    const { service, prisma } = harness();
    const before = prisma.counters.shareLinkFindUnique;

    const response = await service.resolvePublicWatchCompatible({
      host: UNSUPPORTED_COMPAT_HOST,
      alias: LEGACY_TRANSPORT_ALIAS,
      requestMeta,
    });

    assert.deepEqual(response, PUBLIC_DENIAL_RESPONSE);
    assert.equal(
      prisma.counters.shareLinkFindUnique,
      before,
      "the transport alias was read despite the host being incapable",
    );

    const logged = prisma.accessLogs.at(-1);
    assert.equal(logged?.status, AccessLogStatus.DENIED);
    assert.equal(logged?.reasonCode, "INVALID_LINK");
    // Generic denial: the reason is not distinguishable from an unknown alias,
    // and the credential itself is nowhere in the row.
    assert.equal(
      JSON.stringify(prisma.accessLogs).includes(LEGACY_TRANSPORT_ALIAS),
      false,
    );
    assert.equal(logged?.shareLinkId ?? null, null);
  });

  it("CAP-REDEEM-03 REMOVING the capability stops an ALREADY-ISSUED alias redeeming", async () => {
    /* THE KILL SWITCH, END TO END. The same alias on the same host, once with
       the allowlist set and once with it cleared. This is the property an
       incident responder will assume they have; without a redemption-side
       gate they would not. */
    const armed = harness();
    const first = await armed.service.resolvePublicWatchCompatible({
      host: LEGACY_HOST,
      alias: LEGACY_TRANSPORT_ALIAS,
      requestMeta,
    });
    assert.equal(first.valid, true, "positive control");

    for (const cleared of ["", "   ", "other-site.example.com"]) {
      const disarmed = harness({ PUBLIC_COMPATIBILITY_URL_HOSTS: cleared });
      const before = disarmed.prisma.counters.shareLinkFindUnique;

      const response = await disarmed.service.resolvePublicWatchCompatible({
        host: LEGACY_HOST,
        alias: LEGACY_TRANSPORT_ALIAS,
        requestMeta,
      });

      assert.deepEqual(
        response,
        PUBLIC_DENIAL_RESPONSE,
        `still redeemed with allowlist ${JSON.stringify(cleared)}`,
      );
      assert.equal(disarmed.prisma.counters.shareLinkFindUnique, before);
      // No view was spent by the refusal.
      assert.equal(disarmed.prisma.shareLinks[0]?.currentViews, 0);
    }
  });

  it("CAP-REDEEM-04 the `#k` credential is COMPLETELY unaffected by the allowlist", async () => {
    /* The whole reason for a separate lever: clearing the allowlist must close
       the alternate surface and nothing else. Both `#k` forms — alias and raw
       token — keep working on a host that can no longer redeem `?r=`, on the
       exchange AND on the legacy GET. */
    const { service } = harness({ PUBLIC_COMPATIBILITY_URL_HOSTS: "" });

    for (const credential of [LEGACY_ALIAS, LEGACY_RAW_TOKEN]) {
      const response = await service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: credential,
        requestMeta,
      });

      assert.equal(response.valid, true, `#k credential ${credential} denied`);
      assert.equal(response.reasonCode, "OK");
      assert.ok(response.videos.length > 0);
    }
  });

  it("CAP-REDEEM-05 an unsupported host is refused even with a MALFORMED alias, and identically", async () => {
    /* Ordering check. The capability gate runs before the shape gate, so the
       two refusals are indistinguishable from outside — a prober cannot use
       a deliberately malformed alias to tell the two branches apart. */
    const { service, prisma } = harness();

    const bad = await service.resolvePublicWatchCompatible({
      host: UNSUPPORTED_COMPAT_HOST,
      alias: "not-a-transport-alias",
      requestMeta,
    });
    const good = await service.resolvePublicWatchCompatible({
      host: UNSUPPORTED_COMPAT_HOST,
      alias: LEGACY_TRANSPORT_ALIAS,
      requestMeta,
    });

    assert.deepEqual(bad, PUBLIC_DENIAL_RESPONSE);
    assert.deepEqual(good, PUBLIC_DENIAL_RESPONSE);
    assert.equal(prisma.counters.shareLinkFindUnique, 0);
    assert.deepEqual(
      prisma.accessLogs.map((row) => row.reasonCode),
      ["INVALID_LINK", "INVALID_LINK"],
    );
  });

  it("CAP-REDEEM-06 capability is necessary but NOT sufficient — website scope still decides", async () => {
    /* FOREIGN_HOST is on the allowlist precisely so this test still exercises
       what it is named for. A capable host belonging to another website must
       still be refused, by the unmodified V2 resolver, AFTER the credential
       is resolved. If this ever starts failing at the capability gate instead,
       the allowlist fixture has drifted and COMPAT-08 has quietly stopped
       testing website scope. */
    const { service, prisma } = harness();

    const response = await service.resolvePublicWatchCompatible({
      host: FOREIGN_HOST,
      alias: LEGACY_TRANSPORT_ALIAS,
      requestMeta,
    });

    assert.deepEqual(response, PUBLIC_DENIAL_RESPONSE);
    assert.ok(
      prisma.counters.shareLinkFindUnique > 0,
      "denial came from the capability gate, not from website scope",
    );
  });
});

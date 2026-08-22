/**
 * SHARE-LINK BACKWARD COMPATIBILITY - resolution surface.
 *
 * COMPAT-001 raw token · COMPAT-002 alias · COMPAT-003 host binding
 * COMPAT-004 revoked · COMPAT-005 expired · COMPAT-006 public denial contract
 * COMPAT-007 unlimited · COMPAT-008 maxViews · COMPAT-010 WebsiteVideo
 * COMPAT-011 ShareLinkVideo membership · COMPAT-012 video status
 * COMPAT-013 multi-video ordering
 *
 * COMPAT-043 is NOT a runtime test - it is a documented structural invariant.
 * See `docs/SHARE_LINK_COMPATIBILITY_TESTS.md`.
 *
 * A FAILURE IN THIS FILE IS RELEASE BLOCKING.
 *
 * These tests assert what the source does today, not what it ought to do, and
 * they assert it behaviourally: what a caller receives, not which private
 * helper ran or in what order.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NotFoundException } from "@nestjs/common";
import {
  AccessLogStatus,
  AssignmentStatus,
  ShareLinkStatus,
  VideoStatus,
} from "../src/generated/prisma/client";
import { hashShareToken } from "../src/public/utils/share-token.util";
import {
  assignedTo,
  createCompatHarness,
  dbBlobVideo,
  directUrlVideo,
  embedVideo,
  FOREIGN_HOST,
  FOREIGN_WEBSITE_ID,
  LEGACY_ALIAS,
  LEGACY_EXPECTED_TOKEN_HASH,
  LEGACY_HOST,
  LEGACY_RAW_TOKEN,
  LEGACY_TOKEN_PEPPER,
  localFileVideo,
  NFC_EXPECTED_TOKEN_HASH,
  NFC_TOKEN_PEPPER,
  NFD_EXPECTED_TOKEN_HASH,
  NFD_TOKEN_PEPPER,
  parseMediaUrl,
  propertyNames,
  PUBLIC_DENIAL_RESPONSE,
  REVERSED_CONCATENATION_HASH,
  ROTATED_TOKEN_PEPPER,
  SECOND_ALIAS,
  SECOND_EXPECTED_TOKEN_HASH,
  SECOND_LEGACY_HOST,
  SECOND_RAW_TOKEN,
  UNICODE_EXPECTED_TOKEN_HASH,
  UNICODE_TOKEN_PEPPER,
  UNKNOWN_HOST,
  WEBSITE_ID,
} from "./share-link-compat-harness";

/** Order-insensitive: the public response carries exactly these properties. */
const PUBLIC_RESPONSE_PROPERTIES = [
  "reasonCode",
  "valid",
  "videos",
  "website",
];

describe("COMPAT-001 raw share tokens", () => {
  it("keeps sha256(pepper + token) as the stored share-token digest", () => {
    // The expectation is an immutable literal computed OUTSIDE this codebase
    // with a different SHA-256 implementation. `hashShareToken()` is called
    // only to produce ACTUAL behaviour - never to produce the expectation - so
    // this is not circular.
    assert.equal(
      hashShareToken({ pepper: LEGACY_TOKEN_PEPPER, token: LEGACY_RAW_TOKEN }),
      LEGACY_EXPECTED_TOKEN_HASH,
    );
  });

  it("keeps the pepper-first concatenation order", () => {
    // Independently computed digest of the REVERSED concatenation. If the
    // operands were ever swapped, the production output would equal this value
    // instead - so pinning both directions catches the swap explicitly.
    const actual = hashShareToken({
      pepper: LEGACY_TOKEN_PEPPER,
      token: LEGACY_RAW_TOKEN,
    });

    assert.notEqual(actual, REVERSED_CONCATENATION_HASH);
    assert.equal(
      hashShareToken({ pepper: LEGACY_RAW_TOKEN, token: LEGACY_TOKEN_PEPPER }),
      REVERSED_CONCATENATION_HASH,
    );
  });

  it("keeps a legacy raw token resolvable against its independently stored hash", async () => {
    // The fixture's `tokenHash` column holds the immutable literal, not the
    // output of the function under test. Resolution therefore proves the
    // production hashing path still reproduces the stored legacy digest.
    const { service, prisma } = createCompatHarness({
      videos: [directUrlVideo()],
    });
    assert.equal(prisma.shareLinkRecord.tokenHash, LEGACY_EXPECTED_TOKEN_HASH);

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_RAW_TOKEN,
    });

    assert.equal(response.valid, true);
    assert.equal(response.reasonCode, "OK");
    assert.deepEqual(response.website, {
      id: WEBSITE_ID,
      name: "Customer Website",
      slug: "customer-website",
      domain: LEGACY_HOST,
    });
    assert.deepEqual(
      response.videos.map((video) => video.id),
      ["video-direct-url"],
    );
    assert.deepEqual(
      prisma.accessLogs.map((log) => [log.status, log.reasonCode]),
      [[AccessLogStatus.ALLOWED, "OK"]],
    );
  });

  it("encodes a non-ASCII pepper as UTF-8", () => {
    // `SHARE_TOKEN_PEPPER` is an environment variable and may hold arbitrary
    // UTF-8. The expectation is an independently computed literal, so this
    // pins the encoding rather than restating the implementation.
    assert.equal(
      hashShareToken({
        pepper: UNICODE_TOKEN_PEPPER,
        token: LEGACY_RAW_TOKEN,
      }),
      UNICODE_EXPECTED_TOKEN_HASH,
    );
  });

  it("applies no Unicode normalisation to the pepper", () => {
    // The same visual pepper in NFC and NFD is two different byte sequences.
    // Hashing must stay byte-faithful: if a normalisation step were ever
    // introduced, every existing raw token peppered with the other form would
    // stop resolving.
    const nfc = hashShareToken({
      pepper: NFC_TOKEN_PEPPER,
      token: LEGACY_RAW_TOKEN,
    });
    const nfd = hashShareToken({
      pepper: NFD_TOKEN_PEPPER,
      token: LEGACY_RAW_TOKEN,
    });

    assert.notEqual(NFC_TOKEN_PEPPER, NFD_TOKEN_PEPPER);
    assert.equal(nfc, NFC_EXPECTED_TOKEN_HASH);
    assert.equal(nfd, NFD_EXPECTED_TOKEN_HASH);
    assert.notEqual(nfc, nfd);
  });

  it("stops resolving raw tokens once SHARE_TOKEN_PEPPER is rotated", async () => {
    const { service } = createCompatHarness({
      videos: [directUrlVideo()],
      pepper: ROTATED_TOKEN_PEPPER,
    });

    assert.deepEqual(
      await service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_RAW_TOKEN,
      }),
      PUBLIC_DENIAL_RESPONSE,
    );
  });
});

describe("COMPAT-002 alias share links", () => {
  it("keeps legacy alias share links resolvable", async () => {
    const { service } = createCompatHarness({ videos: [directUrlVideo()] });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.valid, true);
    assert.equal(response.website?.id, WEBSITE_ID);
    assert.deepEqual(
      response.videos.map((video) => video.id),
      ["video-direct-url"],
    );
  });

  it("keeps alias share links working after SHARE_TOKEN_PEPPER rotation", async () => {
    // Aliases are stored in clear and are not peppered, so pepper rotation
    // kills raw tokens but leaves alias links alive - docs/features/share-links.md
    // section 5.
    const { service } = createCompatHarness({
      videos: [directUrlVideo()],
      pepper: ROTATED_TOKEN_PEPPER,
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.valid, true);
  });

  it("carries the presented credential into backend media URLs", async () => {
    const { service } = createCompatHarness({ videos: [localFileVideo()] });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    const url = parseMediaUrl(response.videos[0]?.publicPlaybackUrl);
    assert.equal(
      url.pathname,
      `/api/v1/public/watch/${LEGACY_ALIAS}/videos/video-local-file/local-file`,
    );
    assert.equal(url.params.host, LEGACY_HOST);
  });
});

describe("COMPAT-003 host, domain and cross-tenant binding", () => {
  /**
   * Video X is READY and ACTIVELY assigned to BOTH websites, so the
   * `WebsiteVideo` filter cannot be the thing that denies. Share A belongs to
   * website A only; share B belongs to website B only. Both contain video X.
   */
  function crossTenantHarness() {
    const videoX = directUrlVideo({
      id: "video-x",
      websiteVideos: assignedTo(WEBSITE_ID, FOREIGN_WEBSITE_ID),
    });

    return createCompatHarness({
      videos: [videoX],
      extraShareLinks: [
        {
          id: "share-link-compat-b",
          websiteId: FOREIGN_WEBSITE_ID,
          alias: SECOND_ALIAS,
          tokenHash: SECOND_EXPECTED_TOKEN_HASH,
          videoIds: ["video-x"],
        },
      ],
    });
  }

  it("keeps each tenant's own credential working on its own host", async () => {
    // Positive control for the cross-tenant tests below: both shares resolve
    // the same video on their own host, so any denial there is caused by the
    // credential's website binding and nothing else.
    const { service } = crossTenantHarness();

    const onA = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });
    const onB = await service.resolvePublicWatch({
      host: FOREIGN_HOST,
      token: SECOND_ALIAS,
    });

    assert.equal(onA.valid, true);
    assert.equal(onA.website?.id, WEBSITE_ID);
    assert.deepEqual(
      onA.videos.map((video) => video.id),
      ["video-x"],
    );
    assert.equal(onB.valid, true);
    assert.equal(onB.website?.id, FOREIGN_WEBSITE_ID);
    assert.deepEqual(
      onB.videos.map((video) => video.id),
      ["video-x"],
    );
  });

  it("refuses one tenant's credential on another tenant's host", async () => {
    // The share-link credential is bound to its own website. Video X is fully
    // authorized on both websites, so this can only be the credential binding.
    const { service } = crossTenantHarness();

    for (const [label, host, token] of [
      ["share A credential on host B", FOREIGN_HOST, LEGACY_ALIAS],
      ["share A raw token on host B", FOREIGN_HOST, LEGACY_RAW_TOKEN],
      ["share B credential on host A", LEGACY_HOST, SECOND_ALIAS],
      ["share B raw token on host A", LEGACY_HOST, SECOND_RAW_TOKEN],
    ] as const) {
      assert.deepEqual(
        await service.resolvePublicWatch({ host, token }),
        PUBLIC_DENIAL_RESPONSE,
        label,
      );
    }
  });

  it("refuses one tenant's credential for another tenant's backend media", async () => {
    const videoX = localFileVideo({
      id: "video-x",
      websiteVideos: assignedTo(WEBSITE_ID, FOREIGN_WEBSITE_ID),
    });
    const { service } = createCompatHarness({
      videos: [videoX],
      extraShareLinks: [
        {
          id: "share-link-compat-b",
          websiteId: FOREIGN_WEBSITE_ID,
          alias: SECOND_ALIAS,
          tokenHash: SECOND_EXPECTED_TOKEN_HASH,
          videoIds: ["video-x"],
        },
      ],
    });

    // Positive control: each credential serves the video on its own host.
    await assert.doesNotReject(
      service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-x",
      }),
    );
    await assert.doesNotReject(
      service.getPublicLocalVideoFile({
        host: FOREIGN_HOST,
        token: SECOND_ALIAS,
        videoId: "video-x",
      }),
    );

    // Cross-tenant: denied on the media route too.
    await assert.rejects(
      service.getPublicLocalVideoFile({
        host: FOREIGN_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-x",
      }),
      NotFoundException,
    );
    await assert.rejects(
      service.getPublicLocalThumbnail({
        host: FOREIGN_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-x",
      }),
      NotFoundException,
    );
  });

  it("refuses a valid credential presented on an unknown host", async () => {
    const { service } = createCompatHarness({ videos: [directUrlVideo()] });

    assert.deepEqual(
      await service.resolvePublicWatch({
        host: UNKNOWN_HOST,
        token: LEGACY_RAW_TOKEN,
      }),
      PUBLIC_DENIAL_RESPONSE,
    );
  });

  it("keeps every additional active domain of the same website resolvable", async () => {
    const { service } = createCompatHarness({ videos: [directUrlVideo()] });

    const response = await service.resolvePublicWatch({
      host: SECOND_LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.valid, true);
    assert.equal(response.website?.domain, SECOND_LEGACY_HOST);
  });

  it("keeps legacy host normalization (case, scheme, path, whitespace)", async () => {
    const { service } = createCompatHarness({ videos: [directUrlVideo()] });

    for (const rawHost of [
      "Customer.Example.COM",
      "https://customer.example.com",
      "customer.example.com/",
      "https://customer.example.com/s/Ab3dEf7",
      "  customer.example.com  ",
    ]) {
      const response = await service.resolvePublicWatch({
        host: rawHost,
        token: LEGACY_ALIAS,
      });

      assert.equal(response.valid, true, `host not normalized: ${rawHost}`);
      assert.equal(response.website?.domain, LEGACY_HOST);
    }
  });

  it("refuses a disabled domain and a disabled website", async () => {
    const disabledDomain = createCompatHarness({ videos: [directUrlVideo()] });
    const domainRecord = disabledDomain.prisma.domains.find(
      (entry) => entry.domain === LEGACY_HOST,
    );
    assert.ok(domainRecord);
    domainRecord.status = "DISABLED" as typeof domainRecord.status;
    assert.deepEqual(
      await disabledDomain.service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
      }),
      PUBLIC_DENIAL_RESPONSE,
    );

    const disabledWebsite = createCompatHarness({ videos: [directUrlVideo()] });
    disabledWebsite.prisma.findWebsite(WEBSITE_ID).status = "DISABLED" as never;
    assert.deepEqual(
      await disabledWebsite.service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
      }),
      PUBLIC_DENIAL_RESPONSE,
    );
  });

});

describe("COMPAT-004 revoked share links", () => {
  it("stops resolving a revoked link and logs INVALID_LINK internally", async () => {
    const { service, prisma } = createCompatHarness({
      videos: [directUrlVideo()],
      shareLink: { status: ShareLinkStatus.REVOKED },
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.deepEqual(response, PUBLIC_DENIAL_RESPONSE);
    assert.deepEqual(
      prisma.accessLogs.map((log) => [log.status, log.reasonCode]),
      [[AccessLogStatus.DENIED, "INVALID_LINK"]],
    );
    assert.equal(prisma.shareLinkRecord.currentViews, 0);
  });

  it("stops resolving DISABLED and EXPIRED share-link statuses too", async () => {
    for (const status of [ShareLinkStatus.DISABLED, ShareLinkStatus.EXPIRED]) {
      const { service } = createCompatHarness({
        videos: [directUrlVideo()],
        shareLink: { status },
      });

      assert.deepEqual(
        await service.resolvePublicWatch({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
        }),
        PUBLIC_DENIAL_RESPONSE,
        `status ${status} must not resolve`,
      );
    }
  });

  it("stops serving backend media for a revoked link", async () => {
    const { service } = createCompatHarness({
      videos: [dbBlobVideo()],
      shareLink: { status: ShareLinkStatus.REVOKED },
    });

    await assert.rejects(
      service.getPublicDatabaseVideoBinary({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-db-blob",
      }),
      NotFoundException,
    );
  });
});

describe("COMPAT-005 expired share links", () => {
  it("stops resolving an expired link and logs EXPIRED_LINK internally", async () => {
    const { service, prisma } = createCompatHarness({
      videos: [directUrlVideo()],
      shareLink: { expiresAt: new Date("2020-01-01T00:00:00.000Z") },
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.deepEqual(response, PUBLIC_DENIAL_RESPONSE);
    // EXPIRED_LINK is an access-log code. It is never client-visible.
    assert.deepEqual(
      prisma.accessLogs.map((log) => [log.status, log.reasonCode]),
      [[AccessLogStatus.DENIED, "EXPIRED_LINK"]],
    );
  });

  it("keeps a future expiry resolvable", async () => {
    const { service } = createCompatHarness({
      videos: [directUrlVideo()],
      shareLink: { expiresAt: new Date(Date.now() + 86_400_000) },
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.valid, true);
  });
});

describe("COMPAT-006 public denial contract", () => {
  it("preserves INVALID_LINK as the public denial contract for every cause", async () => {
    const causes: Array<[string, Promise<unknown>]> = [];

    const missingToken = createCompatHarness({ videos: [directUrlVideo()] });
    causes.push([
      "missing token",
      missingToken.service.resolvePublicWatch({ host: LEGACY_HOST }),
    ]);

    const blankToken = createCompatHarness({ videos: [directUrlVideo()] });
    causes.push([
      "blank token",
      blankToken.service.resolvePublicWatch({ host: LEGACY_HOST, token: "  " }),
    ]);

    const missingHost = createCompatHarness({ videos: [directUrlVideo()] });
    causes.push([
      "missing host",
      missingHost.service.resolvePublicWatch({ host: "", token: LEGACY_ALIAS }),
    ]);

    const unknownHost = createCompatHarness({ videos: [directUrlVideo()] });
    causes.push([
      "unknown host",
      unknownHost.service.resolvePublicWatch({
        host: UNKNOWN_HOST,
        token: LEGACY_ALIAS,
      }),
    ]);

    const foreignHost = createCompatHarness({
      videos: [
        directUrlVideo({
          websiteVideos: assignedTo(WEBSITE_ID, FOREIGN_WEBSITE_ID),
        }),
      ],
    });
    causes.push([
      "other tenant host",
      foreignHost.service.resolvePublicWatch({
        host: FOREIGN_HOST,
        token: LEGACY_ALIAS,
      }),
    ]);

    const wrongToken = createCompatHarness({ videos: [directUrlVideo()] });
    causes.push([
      "unknown credential",
      wrongToken.service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: "not-a-real-credential",
      }),
    ]);

    const revoked = createCompatHarness({
      videos: [directUrlVideo()],
      shareLink: { status: ShareLinkStatus.REVOKED },
    });
    causes.push([
      "revoked",
      revoked.service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
      }),
    ]);

    const expired = createCompatHarness({
      videos: [directUrlVideo()],
      shareLink: { expiresAt: new Date("2020-01-01T00:00:00.000Z") },
    });
    causes.push([
      "expired",
      expired.service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
      }),
    ]);

    const exhausted = createCompatHarness({
      videos: [directUrlVideo()],
      shareLink: { maxViews: 2, currentViews: 2 },
    });
    causes.push([
      "view limit reached",
      exhausted.service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
      }),
    ]);

    const unassigned = createCompatHarness({
      videos: [
        directUrlVideo({
          websiteVideos: [
            {
              id: "assignment-disabled",
              websiteId: WEBSITE_ID,
              videoId: "video-direct-url",
              status: AssignmentStatus.DISABLED,
              sortOrder: 0,
            },
          ],
        }),
      ],
    });
    causes.push([
      "no assigned videos",
      unassigned.service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
      }),
    ]);

    const notReady = createCompatHarness({
      videos: [directUrlVideo({ status: VideoStatus.DRAFT })],
    });
    causes.push([
      "no ready videos",
      notReady.service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
      }),
    ]);

    for (const [label, pending] of causes) {
      const response = await pending;
      assert.deepEqual(response, PUBLIC_DENIAL_RESPONSE, `cause: ${label}`);
      // Property SET, not property order - key order is not an external
      // compatibility contract.
      assert.deepEqual(
        propertyNames(response as object),
        PUBLIC_RESPONSE_PROPERTIES,
        `cause: ${label}`,
      );
    }
  });

  it("keeps the successful response to the same public property set", async () => {
    const { service } = createCompatHarness({ videos: [directUrlVideo()] });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.deepEqual(propertyNames(response), PUBLIC_RESPONSE_PROPERTIES);
  });

  it("never leaks an internal access-log reason code to the client", async () => {
    const internalOnly = [
      "MISSING_HOST",
      "MISSING_TOKEN",
      "EXPIRED_LINK",
      "VIEW_LIMIT_REACHED",
      "NO_VIDEOS",
      "SERVER_ERROR",
    ];

    const expired = createCompatHarness({
      videos: [directUrlVideo()],
      shareLink: { expiresAt: new Date("2020-01-01T00:00:00.000Z") },
    });
    const response = await expired.service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(internalOnly.includes(response.reasonCode), false);
    assert.equal(response.reasonCode, "INVALID_LINK");
    // ...while the real reason is still recorded server-side.
    assert.equal(expired.prisma.accessLogs[0]?.reasonCode, "EXPIRED_LINK");
  });

  it("keeps every media denial to the same generic 404", async () => {
    const { service } = createCompatHarness({ videos: [localFileVideo()] });

    for (const params of [
      { host: LEGACY_HOST, token: "wrong", videoId: "video-local-file" },
      { host: UNKNOWN_HOST, token: LEGACY_ALIAS, videoId: "video-local-file" },
      { host: LEGACY_HOST, token: LEGACY_ALIAS, videoId: "video-missing" },
    ]) {
      await assert.rejects(
        service.getPublicLocalVideoFile(params),
        (error: unknown) =>
          error instanceof NotFoundException &&
          error.message === "Video not found.",
      );
    }
  });
});

describe("COMPAT-007 unlimited share links", () => {
  it("keeps an ACTIVE unlimited link resolvable on every request", async () => {
    const { service, prisma } = createCompatHarness({
      videos: [directUrlVideo()],
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
      });
      assert.equal(response.valid, true, `attempt ${attempt} must resolve`);
    }

    assert.equal(prisma.shareLinkRecord.maxViews, null);
    // currentViews still advances on an unlimited link - it is a counter, not
    // a budget.
    assert.equal(prisma.shareLinkRecord.currentViews, 5);
  });

  it("issues no media grant for an unlimited link", async () => {
    const { service } = createCompatHarness({ videos: [localFileVideo()] });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    const url = parseMediaUrl(response.videos[0]?.publicPlaybackUrl);
    assert.equal(Object.hasOwn(url.params, "grant"), false);
    await assert.doesNotReject(
      service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-local-file",
      }),
    );
  });
});

describe("COMPAT-008 view-limited share links", () => {
  it("spends exactly maxViews resolutions and then denies", async () => {
    const { service, prisma } = createCompatHarness({
      videos: [directUrlVideo()],
      shareLink: { maxViews: 3 },
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
      });
      assert.equal(response.valid, true, `view ${attempt} must resolve`);
      assert.equal(prisma.shareLinkRecord.currentViews, attempt);
    }

    assert.deepEqual(
      await service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
      }),
      PUBLIC_DENIAL_RESPONSE,
    );
    // The refused attempt must not advance the counter past the budget.
    assert.equal(prisma.shareLinkRecord.currentViews, 3);
    assert.equal(prisma.accessLogs.at(-1)?.reasonCode, "VIEW_LIMIT_REACHED");
  });

  it("admits at most one of two simultaneous resolutions at the final view", async () => {
    // The behavioural proof that consumption is atomic: a read-then-write
    // implementation lets both requests through.
    const { service, prisma } = createCompatHarness({
      videos: [directUrlVideo()],
      shareLink: { maxViews: 4, currentViews: 3 },
    });

    const responses = await Promise.all([
      service.resolvePublicWatch({ host: LEGACY_HOST, token: LEGACY_ALIAS }),
      service.resolvePublicWatch({ host: LEGACY_HOST, token: LEGACY_ALIAS }),
    ]);

    assert.equal(responses.filter((response) => response.valid).length, 1);
    assert.deepEqual(
      responses.find((response) => !response.valid),
      PUBLIC_DENIAL_RESPONSE,
    );
    assert.equal(prisma.shareLinkRecord.currentViews, 4);
  });

  it("never exceeds the budget under heavier concurrency", async () => {
    const { service, prisma } = createCompatHarness({
      videos: [directUrlVideo()],
      shareLink: { maxViews: 3 },
    });

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.resolvePublicWatch({ host: LEGACY_HOST, token: LEGACY_ALIAS }),
      ),
    );

    assert.equal(responses.filter((response) => response.valid).length, 3);
    assert.equal(prisma.shareLinkRecord.currentViews, 3);
  });
});

describe("COMPAT-010 WebsiteVideo assignment", () => {
  it("requires an ACTIVE WebsiteVideo assignment for the resolving website", async () => {
    const active = createCompatHarness({ videos: [directUrlVideo()] });
    const activeResponse = await active.service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });
    assert.equal(activeResponse.videos.length, 1);

    const disabled = createCompatHarness({ videos: [directUrlVideo()] });
    disabled.prisma.setAssignmentStatus(
      "video-direct-url",
      WEBSITE_ID,
      AssignmentStatus.DISABLED,
    );
    assert.deepEqual(
      await disabled.service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
      }),
      PUBLIC_DENIAL_RESPONSE,
    );

    const missing = createCompatHarness({
      videos: [directUrlVideo({ websiteVideos: [] })],
    });
    assert.deepEqual(
      await missing.service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
      }),
      PUBLIC_DENIAL_RESPONSE,
    );
  });

  it("does not accept an assignment that belongs only to a different website", async () => {
    const { service } = createCompatHarness({
      videos: [
        directUrlVideo({ websiteVideos: assignedTo(FOREIGN_WEBSITE_ID) }),
      ],
    });

    assert.deepEqual(
      await service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
      }),
      PUBLIC_DENIAL_RESPONSE,
    );
  });

  it("stops serving backend media once the assignment is disabled", async () => {
    const { service, prisma } = createCompatHarness({
      videos: [dbBlobVideo()],
    });

    await assert.doesNotReject(
      service.getPublicDatabaseVideoBinary({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-db-blob",
      }),
    );

    prisma.setAssignmentStatus(
      "video-db-blob",
      WEBSITE_ID,
      AssignmentStatus.DISABLED,
    );

    await assert.rejects(
      service.getPublicDatabaseVideoBinary({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-db-blob",
      }),
      NotFoundException,
    );
  });
});

describe("COMPAT-011 ShareLinkVideo membership", () => {
  /**
   * `video-y-*` are REAL rows: they exist globally, are READY, are playable,
   * and hold an ACTIVE `WebsiteVideo` assignment to the very website being
   * resolved. The only thing they lack is a `ShareLinkVideo` row for this
   * share. A nonexistent id would not prove membership is enforced.
   */
  function membershipHarness() {
    return createCompatHarness({
      videos: [localFileVideo({ id: "video-member" }), dbBlobVideo()],
      standaloneVideos: [
        localFileVideo({ id: "video-y-local" }),
        dbBlobVideo({ id: "video-y-blob" }),
      ],
    });
  }

  it("keeps member videos of the share fully playable (positive control)", async () => {
    const { service, prisma } = membershipHarness();

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });
    assert.deepEqual(
      response.videos.map((video) => video.id).sort(),
      ["video-db-blob", "video-member"],
    );

    // The non-members are genuinely valid rows on this same website.
    for (const videoId of ["video-y-local", "video-y-blob"]) {
      const video = prisma.findVideo(videoId);
      assert.equal(video.status, VideoStatus.READY);
      assert.equal(
        video.websiteVideos.some(
          (assignment) =>
            assignment.websiteId === WEBSITE_ID &&
            assignment.status === AssignmentStatus.ACTIVE,
        ),
        true,
      );
    }
  });

  it("never lists or serves a real non-member video through this share", async () => {
    const { service } = membershipHarness();

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });
    assert.equal(
      response.videos.some((video) => video.id.startsWith("video-y")),
      false,
    );

    await assert.rejects(
      service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-y-local",
      }),
      NotFoundException,
    );
    await assert.rejects(
      service.getPublicLocalThumbnail({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-y-local",
      }),
      NotFoundException,
    );
    await assert.rejects(
      service.getPublicDatabaseVideoBinary({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-y-blob",
      }),
      NotFoundException,
    );
  });

  it("does not record a public view for a real non-member video", async () => {
    const { service } = membershipHarness();

    const denied = await service.recordPublicVideoView({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
      videoId: "video-y-local",
    });
    assert.equal(denied.valid, false);
    assert.equal(denied.videoId, null);

    // Positive control: a member video does record.
    const allowed = await service.recordPublicVideoView({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
      videoId: "video-member",
    });
    assert.equal(allowed.valid, true);
  });
});

describe("COMPAT-012 video status", () => {
  it("keeps READY as the only publicly playable video status", async () => {
    for (const status of [
      VideoStatus.DRAFT,
      VideoStatus.PROCESSING,
      VideoStatus.FAILED,
      VideoStatus.DISABLED,
    ]) {
      const { service } = createCompatHarness({
        videos: [directUrlVideo({ status })],
      });

      assert.deepEqual(
        await service.resolvePublicWatch({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
        }),
        PUBLIC_DENIAL_RESPONSE,
        `status ${status} must not be playable`,
      );
    }

    const ready = createCompatHarness({
      videos: [directUrlVideo({ status: VideoStatus.READY })],
    });
    assert.equal(
      (
        await ready.service.resolvePublicWatch({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
        })
      ).valid,
      true,
    );
  });

  it("keeps requiring a usable asset alongside READY status", async () => {
    const cases = [
      directUrlVideo({ playbackUrl: "   " }),
      embedVideo({ embedUrl: "" }),
      dbBlobVideo({ binaryAsset: null }),
      localFileVideo({
        localFileAsset: {
          storageKey: "videos/video-local-file/source/video.mp4",
          mimeType: "video/mp4",
          sizeBytes: 0n,
        },
      }),
    ];

    for (const video of cases) {
      const { service } = createCompatHarness({ videos: [video] });
      assert.deepEqual(
        await service.resolvePublicWatch({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
        }),
        PUBLIC_DENIAL_RESPONSE,
        `${video.sourceType} with an unusable asset must not be playable`,
      );
    }
  });
});

describe("COMPAT-013 multi-video ordering", () => {
  /**
   * Physical membership-row order is C, A, B while the configured sortOrder is
   * A=10, B=20, C=30. The expected output is A, B, C, so the assertion can
   * only pass if production actually orders by `sortOrder`. Dropping the
   * `orderBy` leaves the physical order and fails.
   */
  it("returns multi-video shares in sortOrder, not in row order", async () => {
    const { service } = createCompatHarness({
      videos: [
        directUrlVideo({ id: "video-a" }),
        directUrlVideo({ id: "video-b" }),
        directUrlVideo({ id: "video-c" }),
      ],
      shareLinkVideoRows: [
        { videoId: "video-c", sortOrder: 30 },
        { videoId: "video-a", sortOrder: 10 },
        { videoId: "video-b", sortOrder: 20 },
      ],
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.valid, true);
    assert.deepEqual(
      response.videos.map((video) => video.id),
      ["video-a", "video-b", "video-c"],
    );
  });

  it("keeps sortOrder while filtering unauthorized videos out of the middle", async () => {
    const { service, prisma } = createCompatHarness({
      videos: [
        directUrlVideo({ id: "video-a" }),
        directUrlVideo({ id: "video-b" }),
        directUrlVideo({ id: "video-c" }),
        directUrlVideo({ id: "video-d", status: VideoStatus.DRAFT }),
      ],
      shareLinkVideoRows: [
        { videoId: "video-d", sortOrder: 15 },
        { videoId: "video-c", sortOrder: 30 },
        { videoId: "video-b", sortOrder: 20 },
        { videoId: "video-a", sortOrder: 10 },
      ],
    });
    prisma.setAssignmentStatus(
      "video-b",
      WEBSITE_ID,
      AssignmentStatus.DISABLED,
    );

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    // video-d is DRAFT, video-b lost its assignment; A and C survive in order.
    assert.deepEqual(
      response.videos.map((video) => video.id),
      ["video-a", "video-c"],
    );
  });

  it("keeps a multi-video share alive while at least one video stays authorized", async () => {
    const { service } = createCompatHarness({
      videos: [
        directUrlVideo({ id: "video-gone", status: VideoStatus.DISABLED }),
        directUrlVideo({ id: "video-still-here" }),
      ],
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.valid, true);
    assert.deepEqual(
      response.videos.map((video) => video.id),
      ["video-still-here"],
    );
  });
});

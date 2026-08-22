/**
 * SHARE-LINK BACKWARD COMPATIBILITY - authorization cache and media grants.
 *
 * COMPAT-040 unlimited LOCAL_FILE cache and its key dimensions
 * COMPAT-041 view-limited links cannot use the authorization cache
 * COMPAT-042 media grant binding, cross-share replay and independent expiry
 * COMPAT-044 real admin mutation paths invalidate the authorization cache
 *
 * A FAILURE IN THIS FILE IS RELEASE BLOCKING. COMPAT-041 in particular is the
 * invariant that keeps the cache from ever skipping grant verification.
 * See `docs/SHARE_LINK_COMPATIBILITY_TESTS.md`.
 *
 * ## How "was it cached?" is decided here
 *
 * Never by inspecting the cache. The probe is behavioural:
 *
 *   1. make one media request, so authorization may be cached;
 *   2. break authorization **in the database only** (an out-of-band change the
 *      cache cannot observe);
 *   3. request again.
 *      served  => the entry was cached and is being reused
 *      denied  => there was no entry; the request re-authorized
 *
 * That probe is what makes the key-dimension tests meaningful: a cache keyed on
 * too little would serve a request it never authorized.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NotFoundException } from "@nestjs/common";
import {
  AssignmentStatus,
  ShareLinkStatus,
} from "../src/generated/prisma/client";
import {
  createCompatHarness,
  FOREIGN_HOST,
  LEGACY_ALIAS,
  LEGACY_HOST,
  localFileVideo,
  readGrant,
  SECOND_ALIAS,
  SECOND_EXPECTED_TOKEN_HASH,
  SECOND_SHARE_LINK_ID,
  SHARE_LINK_ID,
  SECOND_LEGACY_HOST,
  WEBSITE_ID,
} from "./share-link-compat-harness";

const GRANT_TTL_SECONDS = 21_600; // matches the harness config (6 h)

/**
 * Flips the final base64url character of a signature so the result is ALWAYS
 * different from the input, and always still a syntactically valid base64url
 * string of the same length. `slice(0, -1) + "A"` is not safe: a signature that
 * already ends in "A" would be returned unchanged and the test would silently
 * assert nothing.
 */
function tamperSignature(signature: string): string {
  const last = signature.at(-1);
  if (last === undefined) {
    throw new Error("signature must not be empty");
  }
  // Both replacements are valid base64url characters, so the tampered value
  // still reaches HMAC verification rather than being rejected on shape.
  const flipped = last === "A" ? "B" : "A";

  return `${signature.slice(0, -1)}${flipped}`;
}

function decodeGrant(grant: string): {
  v: number;
  sid: string;
  vid: string;
  host: string;
  exp: number;
  purpose: string;
} {
  const [payload] = grant.split(".");
  assert.ok(payload);

  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

/** Resolves to true when the media request was served, false when denied. */
async function isServed(request: Promise<unknown>): Promise<boolean> {
  try {
    await request;

    return true;
  } catch (error) {
    if (error instanceof NotFoundException) {
      return false;
    }
    throw error;
  }
}

describe("COMPAT-040 unlimited LOCAL_FILE authorization cache", () => {
  it("caches the authorization result for an unlimited LOCAL_FILE link", async () => {
    // Documented design characteristic (KI-020): the cache is consulted before
    // any database query, so an out-of-band change is not observed until the
    // entry expires or is invalidated. This records the window that exists; it
    // is NOT a statement that the window is desirable. The COMPAT-044 tests
    // below are the contrast - a real admin mutation does close it.
    const { service, prisma } = createCompatHarness({
      videos: [localFileVideo()],
      memoryCache: true,
    });

    await service.getPublicLocalVideoFile({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
      videoId: "video-local-file",
    });

    prisma.shareLinkRecord.status = ShareLinkStatus.REVOKED;

    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-local-file",
        }),
      ),
      true,
      "current behaviour: the cached entry is still served",
    );
  });

  it("re-authorizes from the database when the cache is disabled", async () => {
    // Control for the test above: with no cache, the same out-of-band change
    // denies immediately. This is what proves the difference is the cache.
    const { service, prisma } = createCompatHarness({
      videos: [localFileVideo()],
      memoryCache: false,
    });

    await service.getPublicLocalVideoFile({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
      videoId: "video-local-file",
    });

    prisma.shareLinkRecord.status = ShareLinkStatus.REVOKED;

    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-local-file",
        }),
      ),
      false,
    );
  });

  it("A - keys the cache by host: another host of the same website is not served", async () => {
    const { service, prisma } = createCompatHarness({
      videos: [localFileVideo()],
      memoryCache: true,
    });

    // Positive control: both hosts authorize while the database allows it.
    await service.getPublicLocalVideoFile({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
      videoId: "video-local-file",
    });

    // Break authorization out of band, then try the OTHER host. If the entry
    // were keyed on credential+video alone, this would be wrongly served.
    prisma.shareLinkRecord.status = ShareLinkStatus.REVOKED;

    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: SECOND_LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-local-file",
        }),
      ),
      false,
      "a cached entry must not be reused for a different host",
    );
    // ...while the host that was cached is still served, proving an entry does
    // exist and the difference above is the host dimension.
    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-local-file",
        }),
      ),
      true,
    );
  });

  it("B - keys the cache by credential: another share link is not served", async () => {
    // Two unlimited share links on the SAME website and host, both containing
    // the same video. Only their credentials differ.
    const { service, prisma } = createCompatHarness({
      videos: [localFileVideo()],
      memoryCache: true,
      extraShareLinks: [
        {
          id: SECOND_SHARE_LINK_ID,
          alias: SECOND_ALIAS,
          tokenHash: SECOND_EXPECTED_TOKEN_HASH,
          videoIds: ["video-local-file"],
        },
      ],
    });

    // Positive control: both credentials authorize independently.
    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-local-file",
        }),
      ),
      true,
    );
    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: SECOND_ALIAS,
          videoId: "video-local-file",
        }),
      ),
      true,
    );

    // Revoke ONLY the second share link, out of band.
    prisma.findShareLink(SECOND_SHARE_LINK_ID).status =
      ShareLinkStatus.REVOKED;

    // Its own cached entry is what would serve it - but the key includes the
    // credential, so it cannot borrow the first link's entry. Both entries
    // exist here, so the meaningful assertion is that credential B's outcome
    // tracks credential B's own state.
    const secondHarness = createCompatHarness({
      videos: [localFileVideo()],
      memoryCache: true,
      extraShareLinks: [
        {
          id: SECOND_SHARE_LINK_ID,
          alias: SECOND_ALIAS,
          tokenHash: SECOND_EXPECTED_TOKEN_HASH,
          videoIds: ["video-local-file"],
        },
      ],
    });

    // Warm ONLY credential A, then break the shared database state.
    await secondHarness.service.getPublicLocalVideoFile({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
      videoId: "video-local-file",
    });
    secondHarness.prisma
      .findShareLink(SECOND_SHARE_LINK_ID).status = ShareLinkStatus.REVOKED;

    assert.equal(
      await isServed(
        secondHarness.service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: SECOND_ALIAS,
          videoId: "video-local-file",
        }),
      ),
      false,
      "a cached entry must not be reused for a different credential",
    );
    assert.equal(
      await isServed(
        secondHarness.service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-local-file",
        }),
      ),
      true,
    );
  });

  it("C - keys the cache by video: a second video is not served from the first", async () => {
    const { service, prisma } = createCompatHarness({
      videos: [
        localFileVideo({ id: "video-one" }),
        localFileVideo({ id: "video-two" }),
      ],
      memoryCache: true,
    });

    // Warm ONLY video-one.
    await service.getPublicLocalVideoFile({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
      videoId: "video-one",
    });

    // Break authorization for BOTH videos out of band.
    prisma.setAssignmentStatus(
      "video-one",
      WEBSITE_ID,
      AssignmentStatus.DISABLED,
    );
    prisma.setAssignmentStatus(
      "video-two",
      WEBSITE_ID,
      AssignmentStatus.DISABLED,
    );

    // video-one keeps being served from its own entry...
    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-one",
        }),
      ),
      true,
    );
    // ...and video-two, which was never cached, is denied.
    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-two",
        }),
      ),
      false,
      "a cached entry must not be reused for a different video",
    );
  });

  it("does not cache a link whose expiry falls inside the cache TTL", async () => {
    const { service, prisma } = createCompatHarness({
      videos: [localFileVideo()],
      // mediaMetadataTtlSeconds is 300 in the harness config.
      shareLink: { expiresAt: new Date(Date.now() + 60_000) },
      memoryCache: true,
    });

    await service.getPublicLocalVideoFile({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
      videoId: "video-local-file",
    });

    prisma.setAssignmentStatus(
      "video-local-file",
      WEBSITE_ID,
      AssignmentStatus.DISABLED,
    );

    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-local-file",
        }),
      ),
      false,
      "a soon-to-expire link must not be cached",
    );
  });
});

describe("COMPAT-041 view-limited links and the authorization cache", () => {
  it("does not cache authorization for view-limited LOCAL_FILE media", async () => {
    // RELEASE-BLOCKING INVARIANT. `canCachePublicWatchShareLink()` refuses any
    // share link with `maxViews !== null`, so no entry ever exists for a
    // view-limited link and a cache hit can never skip `hasValidMediaGrant()`.
    const { service, prisma } = createCompatHarness({
      videos: [localFileVideo()],
      shareLink: { maxViews: 5 },
      memoryCache: true,
    });

    const watch = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });
    const grant = readGrant(watch.videos[0]?.publicPlaybackUrl);
    assert.ok(grant);

    // Warm the request path with a fully valid, granted request.
    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-local-file",
          grant,
        }),
      ),
      true,
    );

    // Break authorization out of band. An unlimited link would still be served
    // from cache here (COMPAT-040); a view-limited link must not be.
    prisma.shareLinkRecord.status = ShareLinkStatus.REVOKED;

    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-local-file",
          grant,
        }),
      ),
      false,
      "a view-limited media request must never be served from cache",
    );
  });

  it("keeps requiring the grant on every view-limited media request", async () => {
    const { service } = createCompatHarness({
      videos: [localFileVideo()],
      shareLink: { maxViews: 5 },
      memoryCache: true,
    });

    const watch = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });
    const grant = readGrant(watch.videos[0]?.publicPlaybackUrl);
    assert.ok(grant);

    await assert.doesNotReject(
      service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-local-file",
        grant,
      }),
    );
    // A successful granted request must not leave anything behind that lets the
    // next, ungranted request through.
    await assert.rejects(
      service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-local-file",
      }),
      NotFoundException,
    );
    await assert.rejects(
      service.getPublicLocalThumbnail({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-local-file",
      }),
      NotFoundException,
    );
  });

  it("does not cache watch metadata for a view-limited link", async () => {
    const { service, prisma } = createCompatHarness({
      videos: [localFileVideo()],
      shareLink: { maxViews: 5 },
      memoryCache: true,
    });

    await service.resolvePublicWatch({ host: LEGACY_HOST, token: LEGACY_ALIAS });
    prisma.setAssignmentStatus(
      "video-local-file",
      WEBSITE_ID,
      AssignmentStatus.DISABLED,
    );

    const second = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(
      second.valid,
      false,
      "view-limited watch metadata must not be served from cache",
    );
  });

  it("never caches DB_BLOB authorization", async () => {
    const { service, prisma } = createCompatHarness({
      videos: [
        {
          ...localFileVideo(),
          id: "video-db-blob",
          sourceType: "DB_BLOB" as never,
          localFileAsset: null,
          localThumbnailAsset: null,
          binaryAsset: { mimeType: "video/mp4", sizeBytes: 10n },
        },
      ],
      memoryCache: true,
    });

    await service.getPublicDatabaseVideoBinary({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
      videoId: "video-db-blob",
    });

    prisma.shareLinkRecord.status = ShareLinkStatus.REVOKED;

    assert.equal(
      await isServed(
        service.getPublicDatabaseVideoBinary({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-db-blob",
        }),
      ),
      false,
      "DB_BLOB must re-authorize on every request",
    );
  });

  it("documents the hazard that COMPAT-043 keeps closed", async () => {
    // NOT a release gate. An entry cached while a link was unlimited would be
    // served without a grant if that same link could later gain a maxViews
    // budget. No application path mutates maxViews today (COMPAT-043, a
    // documented structural invariant - see the manifest), so the transition
    // cannot occur. This records the coupling so it is explicit rather than
    // implied, and shows what the guard looks like from the outside.
    const { service, prisma } = createCompatHarness({
      videos: [localFileVideo()],
      memoryCache: true,
    });

    // With no cached entry, a view-limited link demands a grant.
    prisma.shareLinkRecord.maxViews = 3;
    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-local-file",
        }),
      ),
      false,
    );
  });
});

describe("COMPAT-044 real admin mutations invalidate the authorization cache", () => {
  /**
   * These drive the **actual production services** that operators call, sharing
   * one `MemoryCacheService` instance with `PublicService` exactly as the Nest
   * container does. Contrast with COMPAT-040: the identical database state
   * change applied out of band leaves the cached entry in place, so a denial
   * here can only come from the service having invalidated the cache.
   */

  it("share revocation through AdminWebsitesService invalidates cached media authorization", async () => {
    const { service, adminWebsites, prisma } = createCompatHarness({
      videos: [localFileVideo()],
      memoryCache: true,
    });

    // Warm the cache.
    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-local-file",
        }),
      ),
      true,
    );

    // Real revocation path: POST /admin/share-links/:id/revoke.
    const result = await adminWebsites.revokeShareLink(SHARE_LINK_ID, "admin-1");
    assert.equal(result.shareLink.status, ShareLinkStatus.REVOKED);
    assert.equal(prisma.shareLinkRecord.status, ShareLinkStatus.REVOKED);
    assert.equal(
      prisma.auditLogs.some((entry) => entry.action === "SHARE_LINK_REVOKE"),
      true,
    );

    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-local-file",
        }),
      ),
      false,
      "revoking through the admin service must invalidate the cached entry",
    );
  });

  it("unassigning a video through AdminWebsitesService invalidates cached media authorization", async () => {
    const { service, adminWebsites, prisma } = createCompatHarness({
      videos: [localFileVideo()],
      memoryCache: true,
    });

    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-local-file",
        }),
      ),
      true,
    );

    // Real assignment path: PATCH /admin/websites/:id/video-assignments.
    // Both arrays are required by UpdateWebsiteVideoAssignmentsDto, so a real
    // request always sends both.
    const result = await adminWebsites.updateVideoAssignments(
      WEBSITE_ID,
      { assignVideoIds: [], unassignVideoIds: ["video-local-file"] },
      "admin-1",
    );
    assert.deepEqual(result.unassignedVideoIds, ["video-local-file"]);
    assert.equal(
      prisma.findVideo("video-local-file").websiteVideos[0]?.status,
      AssignmentStatus.DISABLED,
    );

    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-local-file",
        }),
      ),
      false,
      "unassigning through the admin service must invalidate the cached entry",
    );
  });

  it("disabling a video through VideosService invalidates cached media authorization", async () => {
    const { service, videos, prisma } = createCompatHarness({
      videos: [localFileVideo()],
      memoryCache: true,
    });

    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-local-file",
        }),
      ),
      true,
    );

    // Real soft-disable path: DELETE /admin/videos/:id.
    await videos.disableVideo("video-local-file", "admin-1");
    assert.equal(prisma.findVideo("video-local-file").status, "DISABLED");
    // Soft-disabling a video also disables the share links that contain it.
    assert.equal(prisma.shareLinkRecord.status, ShareLinkStatus.DISABLED);

    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-local-file",
        }),
      ),
      false,
      "disabling through the video service must invalidate the cached entry",
    );
  });

  it("invalidates every media entry, not only the mutated one", async () => {
    // `invalidatePublicAccessCaches()` clears the whole `media:metadata:`
    // prefix, so a mutation touching one video also drops unrelated entries.
    const { service, adminWebsites, prisma } = createCompatHarness({
      videos: [
        localFileVideo({ id: "video-one" }),
        localFileVideo({ id: "video-two" }),
      ],
      memoryCache: true,
    });

    await service.getPublicLocalVideoFile({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
      videoId: "video-one",
    });
    prisma.setAssignmentStatus(
      "video-one",
      WEBSITE_ID,
      AssignmentStatus.DISABLED,
    );

    // Sanity: out of band, video-one is still served from its cached entry.
    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-one",
        }),
      ),
      true,
    );

    // A mutation on a DIFFERENT video clears the whole media prefix.
    await adminWebsites.assignSingleVideo(WEBSITE_ID, "video-two", "admin-1");

    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-one",
        }),
      ),
      false,
    );
  });
});

describe("grant tamper helper", () => {
  it("always produces a different, still-valid base64url signature", () => {
    // Exhaustive over the whole base64url alphabet, so the guarantee is proved
    // rather than sampled. The previous `slice(0, -1) + "A"` form returned the
    // input unchanged whenever a signature happened to end in "A", which made
    // the tamper assertion silently vacuous on those runs.
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    for (const last of alphabet) {
      const signature = `abc${last}`;
      const tampered = tamperSignature(signature);

      assert.notEqual(tampered, signature, `unchanged for final char ${last}`);
      assert.equal(tampered.length, signature.length);
      assert.match(tampered, /^[A-Za-z0-9_-]+$/);
    }
  });
});

describe("COMPAT-042 media grant binding", () => {
  function twoShareHarness() {
    return createCompatHarness({
      videos: [localFileVideo()],
      shareLink: { maxViews: 3 },
      extraShareLinks: [
        {
          id: SECOND_SHARE_LINK_ID,
          alias: SECOND_ALIAS,
          tokenHash: SECOND_EXPECTED_TOKEN_HASH,
          maxViews: 3,
          videoIds: ["video-local-file"],
        },
      ],
    });
  }

  it("binds the grant to share link, video, host and expiry", async () => {
    const expiresAt = new Date(Date.now() + 3_600_000);
    const { service } = createCompatHarness({
      videos: [localFileVideo()],
      shareLink: { maxViews: 2, expiresAt },
    });

    const watch = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });
    const grant = readGrant(watch.videos[0]?.publicPlaybackUrl);
    assert.ok(grant);

    const payload = decodeGrant(grant);
    assert.equal(payload.v, 1);
    assert.equal(payload.purpose, "public_media");
    assert.equal(payload.sid, SHARE_LINK_ID);
    assert.equal(payload.vid, "video-local-file");
    assert.equal(payload.host, LEGACY_HOST);
    // exp = min(now + configured TTL, shareLink.expiresAt) - the share link
    // expiry wins here because it is nearer than the 6 h default TTL.
    assert.equal(payload.exp, Math.floor(expiresAt.getTime() / 1000));
  });

  it("refuses a grant from another share link on the same host and video", async () => {
    // FIX: cross-share replay. Both shares are on the same website, same host,
    // same video, both view-limited - only the share link differs. Verification
    // runs through the real PublicMediaGrantService inside the production media
    // authorization path.
    const { service } = twoShareHarness();

    const watchA = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });
    const watchB = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: SECOND_ALIAS,
    });
    const grantA = readGrant(watchA.videos[0]?.publicPlaybackUrl);
    const grantB = readGrant(watchB.videos[0]?.publicPlaybackUrl);
    assert.ok(grantA);
    assert.ok(grantB);
    assert.notEqual(grantA, grantB);
    assert.equal(decodeGrant(grantA).sid, SHARE_LINK_ID);
    assert.equal(decodeGrant(grantB).sid, SECOND_SHARE_LINK_ID);

    // Positive control: each grant works with its own credential.
    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-local-file",
          grant: grantA,
        }),
      ),
      true,
    );
    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: SECOND_ALIAS,
          videoId: "video-local-file",
          grant: grantB,
        }),
      ),
      true,
    );

    // Cross-share replay in both directions must be denied.
    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: SECOND_ALIAS,
          videoId: "video-local-file",
          grant: grantA,
        }),
      ),
      false,
      "share A's grant must not authorize media through share B",
    );
    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-local-file",
          grant: grantB,
        }),
      ),
      false,
      "share B's grant must not authorize media through share A",
    );
    // The thumbnail route shares the same authorization path.
    assert.equal(
      await isServed(
        service.getPublicLocalThumbnail({
          host: LEGACY_HOST,
          token: SECOND_ALIAS,
          videoId: "video-local-file",
          grant: grantA,
        }),
      ),
      false,
    );
  });

  it("refuses a grant replayed onto another video in the same share", async () => {
    const { service } = createCompatHarness({
      videos: [
        localFileVideo({ id: "video-one" }),
        localFileVideo({ id: "video-two" }),
      ],
      shareLink: { maxViews: 2 },
    });

    const watch = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });
    const firstGrant = readGrant(watch.videos[0]?.publicPlaybackUrl);
    const secondGrant = readGrant(watch.videos[1]?.publicPlaybackUrl);
    assert.ok(firstGrant);
    assert.ok(secondGrant);

    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-two",
          grant: firstGrant,
        }),
      ),
      false,
    );
    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-two",
          grant: secondGrant,
        }),
      ),
      true,
    );
  });

  it("refuses a grant replayed onto another host", async () => {
    const { service } = createCompatHarness({
      videos: [localFileVideo()],
      shareLink: { maxViews: 2 },
    });

    const watch = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });
    const grant = readGrant(watch.videos[0]?.publicPlaybackUrl);
    assert.ok(grant);

    for (const host of [SECOND_LEGACY_HOST, FOREIGN_HOST]) {
      assert.equal(
        await isServed(
          service.getPublicLocalVideoFile({
            host,
            token: LEGACY_ALIAS,
            videoId: "video-local-file",
            grant,
          }),
        ),
        false,
        `grant must not be replayable onto ${host}`,
      );
    }
  });

  it("refuses a grant whose own expiry has passed, while the share stays valid", async () => {
    // FIX: independent grant expiry. The share link is ACTIVE with NO expiry
    // and the video stays fully authorized on a valid host - the ONLY reason
    // for the denial is the grant's own `exp`. Time is controlled through the
    // grant service's own `now` parameter, so this is deterministic.
    const { service, grants, prisma } = createCompatHarness({
      videos: [localFileVideo()],
      shareLink: { maxViews: 5 },
    });

    const issuedAt = new Date(Date.now() - (GRANT_TTL_SECONDS + 3600) * 1000);
    const expiredGrant = grants.issue({
      shareLinkId: SHARE_LINK_ID,
      videoId: "video-local-file",
      host: LEGACY_HOST,
      shareLinkExpiresAt: null,
      now: issuedAt,
    });
    const payload = decodeGrant(expiredGrant);
    assert.ok(
      payload.exp < Math.floor(Date.now() / 1000),
      "the fixture grant must actually be expired",
    );

    // The share link itself is untouched: ACTIVE, unexpired, budget remaining.
    assert.equal(prisma.shareLinkRecord.status, ShareLinkStatus.ACTIVE);
    assert.equal(prisma.shareLinkRecord.expiresAt, null);
    assert.ok(prisma.shareLinkRecord.currentViews < 5);

    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-local-file",
          grant: expiredGrant,
        }),
      ),
      false,
      "an expired grant must be refused",
    );

    // Positive control: a freshly issued grant, identical in every other way,
    // is accepted - so the denial above is the expiry and nothing else.
    const freshGrant = grants.issue({
      shareLinkId: SHARE_LINK_ID,
      videoId: "video-local-file",
      host: LEGACY_HOST,
      shareLinkExpiresAt: null,
    });
    assert.equal(
      await isServed(
        service.getPublicLocalVideoFile({
          host: LEGACY_HOST,
          token: LEGACY_ALIAS,
          videoId: "video-local-file",
          grant: freshGrant,
        }),
      ),
      true,
    );
  });

  it("refuses tampered, truncated and oversized grants", async () => {
    const { service, prisma } = createCompatHarness({
      videos: [localFileVideo()],
      shareLink: { maxViews: 2 },
    });

    const watch = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });
    const grant = readGrant(watch.videos[0]?.publicPlaybackUrl);
    assert.ok(grant);
    const [payload, signature] = grant.split(".");
    assert.ok(payload);
    assert.ok(signature);

    // The tampered signature must differ from the original every time, or the
    // "signature rejected" assertion below proves nothing.
    const tampered = tamperSignature(signature);
    assert.notEqual(tampered, signature);
    assert.equal(tampered.length, signature.length);
    assert.match(tampered, /^[A-Za-z0-9_-]+$/);

    const forged = Buffer.from(
      JSON.stringify({
        v: 1,
        sid: SHARE_LINK_ID,
        vid: "video-local-file",
        host: LEGACY_HOST,
        exp: Math.floor(Date.now() / 1000) + 3600,
        purpose: "public_media",
      }),
    ).toString("base64url");

    for (const candidate of [
      `${forged}.${signature}`,
      payload,
      `${payload}.${signature}.extra`,
      `${payload}.${tamperSignature(signature)}`,
      "x".repeat(2049),
    ]) {
      assert.equal(
        await isServed(
          service.getPublicLocalVideoFile({
            host: LEGACY_HOST,
            token: LEGACY_ALIAS,
            videoId: "video-local-file",
            grant: candidate,
          }),
        ),
        false,
        `grant candidate must be refused: ${candidate.slice(0, 24)}`,
      );
    }

    // The oversized grant is rejected before any database work.
    const lookups = prisma.counters.shareLinkFindFirst;
    await assert.rejects(
      service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-local-file",
        grant: "x".repeat(2049),
      }),
      NotFoundException,
    );
    assert.equal(prisma.counters.shareLinkFindFirst, lookups);
  });

  it("issues no grant and requires none on an unlimited link", async () => {
    const { service } = createCompatHarness({ videos: [localFileVideo()] });

    const watch = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(readGrant(watch.videos[0]?.publicPlaybackUrl), null);
    await assert.doesNotReject(
      service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-local-file",
      }),
    );
    // A stray grant on an unlimited link is ignored, not rejected.
    await assert.doesNotReject(
      service.getPublicLocalVideoFile({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
        videoId: "video-local-file",
        grant: "not-a-real-grant",
      }),
    );
  });

  it("stops honouring a grant once the share link is revoked or expired", async () => {
    for (const shareLink of [
      { maxViews: 2, status: ShareLinkStatus.REVOKED },
      { maxViews: 2, expiresAt: new Date("2020-01-01T00:00:00.000Z") },
    ]) {
      const issuer = createCompatHarness({
        videos: [localFileVideo()],
        shareLink: { maxViews: 2 },
      });
      const watch = await issuer.service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
      });
      const grant = readGrant(watch.videos[0]?.publicPlaybackUrl);
      assert.ok(grant);

      const revoked = createCompatHarness({
        videos: [localFileVideo()],
        shareLink,
      });
      assert.equal(
        await isServed(
          revoked.service.getPublicLocalVideoFile({
            host: LEGACY_HOST,
            token: LEGACY_ALIAS,
            videoId: "video-local-file",
            grant,
          }),
        ),
        false,
      );
    }
  });
});

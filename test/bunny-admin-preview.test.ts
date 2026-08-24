/**
 * BUNNY STREAM — authenticated ADMIN PREVIEW signing.
 *
 * Why this file exists: the stored `VideoAsset.embedUrl` for a Bunny asset is
 * deliberately the **unsigned** base URL. The Bunny library has Embed View
 * Token Authentication enabled, so rendering the stored value in the admin
 * console produced a Bunny 403. `GET /admin/videos/:id/bunny/preview` mints a
 * short-lived signed URL instead.
 *
 * These tests pin the security properties of that endpoint, not the happy path
 * alone: nothing is signed for a malformed Bunny record, for a non-Bunny video,
 * for a non-READY video, or while Bunny is disabled or misconfigured — and no
 * Bunny secret ever reaches the response.
 *
 * Like `bunny-stream.test.ts`, nothing here performs a real network request.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { BUNNY_STREAM_EMBED_BASE_URL } from "../src/bunny/bunny-stream.constants";
import { BunnyStreamService } from "../src/bunny/bunny-stream.service";
import { ADMIN_ROLES_METADATA } from "../src/admin-auth/decorators/admin-roles.decorator";
import { AdminAccessTokenGuard } from "../src/admin-auth/guards/admin-access-token.guard";
import { AdminRolesGuard } from "../src/admin-auth/guards/admin-roles.guard";
import {
  AdminRole,
  EmbedProvider,
  VideoProvider,
  VideoSourceType,
  VideoStatus,
} from "../src/generated/prisma/client";
import { VideosController } from "../src/videos/videos.controller";
import { VideosService } from "../src/videos/videos.service";

/* ------------------------------------------------------------------ *
 * Synthetic configuration. No production value appears here.
 * ------------------------------------------------------------------ */

const LIBRARY_ID = "987654";
const API_KEY = "bunny-test-api-key-0123456789abcdef";
const TOKEN_SECURITY_KEY = "bunny-test-token-security-key-0123456789";
const VIDEO_GUID = "11111111-2222-3333-4444-555555555555";
const VIDEO_ID = "video-bunny-ready";

type ConfigOverrides = Record<string, string | undefined>;

function createBunnyService(
  overrides: ConfigOverrides = {},
): BunnyStreamService {
  const values: ConfigOverrides = {
    BUNNY_STREAM_ENABLED: "true",
    BUNNY_STREAM_LIBRARY_ID: LIBRARY_ID,
    BUNNY_STREAM_API_KEY: API_KEY,
    BUNNY_STREAM_TOKEN_SECURITY_KEY: TOKEN_SECURITY_KEY,
    ...overrides,
  };

  return new BunnyStreamService({
    get: (key: string): string | undefined => values[key],
  } as never);
}

/**
 * Wraps the real service so every signing call is counted. The count is the
 * evidence for "nothing was minted", which is stronger than only asserting
 * that the call threw.
 */
function createSigningSpy(overrides: ConfigOverrides = {}): {
  bunny: BunnyStreamService;
  signCount: () => number;
} {
  const service = createBunnyService(overrides);
  let calls = 0;
  const original = service.createSignedEmbedUrl.bind(service);

  // Forwards every argument, including the player-parameter overload. A spy
  // that drops arguments would silently hide what the caller actually passed.
  service.createSignedEmbedUrl = ((
    ...args: Parameters<BunnyStreamService["createSignedEmbedUrl"]>
  ) => {
    calls += 1;
    return original(...args);
  }) as typeof service.createSignedEmbedUrl;

  return { bunny: service, signCount: () => calls };
}

type FakeVideoRecord = {
  id: string;
  status: VideoStatus;
  provider: VideoProvider;
  sourceType: VideoSourceType;
  providerAssetId: string | null;
  playbackId: string | null;
  metadataJson: unknown;
};

class FakePrismaService {
  readonly videos = new Map<string, FakeVideoRecord>();

  videoAsset = {
    findUnique: async (args: { where: { id: string } }) =>
      this.videos.get(args.where.id) ?? null,
  };
}

/** Exactly the shape `initBunnyVideoUpload()` writes. */
function readyBunnyVideo(
  overrides: Partial<FakeVideoRecord> = {},
): FakeVideoRecord {
  return {
    id: VIDEO_ID,
    status: VideoStatus.READY,
    provider: VideoProvider.BUNNY,
    sourceType: VideoSourceType.EMBED,
    providerAssetId: VIDEO_GUID,
    playbackId: VIDEO_GUID,
    metadataJson: {
      bunnyStream: {
        videoId: VIDEO_GUID,
        libraryId: LIBRARY_ID,
        createdAt: "2026-08-23T00:00:00.000Z",
      },
    },
    ...overrides,
  };
}

function createService(params?: {
  video?: FakeVideoRecord | null;
  bunnyOverrides?: ConfigOverrides;
  omitBunnyCollaborator?: boolean;
}): {
  service: VideosService;
  signCount: () => number;
} {
  const prisma = new FakePrismaService();
  const video = params?.video === undefined ? readyBunnyVideo() : params.video;

  if (video !== null) {
    prisma.videos.set(video.id, video);
  }

  const { bunny, signCount } = createSigningSpy(params?.bunnyOverrides);

  const service = new VideosService(
    prisma as never,
    {} as never,
    { get: () => undefined } as never,
    {} as never,
    {} as never,
    undefined,
    params?.omitBunnyCollaborator === true ? undefined : (bunny as never),
  );

  return { service, signCount };
}

async function expectRejection(
  promise: Promise<unknown>,
): Promise<{ message: string; status: number | undefined }> {
  try {
    await promise;
  } catch (error: unknown) {
    const typed = error as {
      message?: string;
      getStatus?: () => number;
    };

    return {
      message: typed.message ?? "",
      status: typed.getStatus?.(),
    };
  }

  assert.fail("Expected the admin Bunny preview to be refused.");
}

/* ------------------------------------------------------------------ *
 * A. Valid, READY Bunny asset
 * ------------------------------------------------------------------ */

describe("Admin Bunny preview - valid asset", () => {
  it("returns a signed embed URL for a READY Bunny asset", async () => {
    const { service, signCount } = createService();

    const result = await service.getBunnyVideoPreview(VIDEO_ID);

    assert.equal(signCount(), 1);
    assert.equal(typeof result.embedUrl, "string");
    assert.equal(typeof result.expires, "number");

    const url = new URL(result.embedUrl);
    assert.equal(
      `${url.protocol}//${url.host}${url.pathname}`,
      `${BUNNY_STREAM_EMBED_BASE_URL}/${LIBRARY_ID}/${VIDEO_GUID}`,
    );
  });

  it("does NOT return the stored unsigned embed URL", async () => {
    const { service } = createService();

    const result = await service.getBunnyVideoPreview(VIDEO_ID);
    const unsigned = `${BUNNY_STREAM_EMBED_BASE_URL}/${LIBRARY_ID}/${VIDEO_GUID}`;

    // The exact bug being fixed: a bare embed URL is what Bunny 403s.
    assert.notEqual(result.embedUrl, unsigned);
    assert.ok(result.embedUrl.startsWith(`${unsigned}?`));
  });

  /* E. Signed URL shape */
  it("carries token=<64 hex> and expires=<unix seconds>", async () => {
    const { service } = createService();

    const result = await service.getBunnyVideoPreview(VIDEO_ID);
    const params = new URL(result.embedUrl).searchParams;
    const token = params.get("token");
    const expires = params.get("expires");

    assert.match(token ?? "", /^[0-9a-f]{64}$/);
    assert.match(expires ?? "", /^\d+$/);
    assert.equal(Number(expires), result.expires);
    // Default embed TTL is 300s; the expiry must be in the near future.
    assert.ok(result.expires > Math.floor(Date.now() / 1000));
  });

  it("matches the documented token formula, computed independently", async () => {
    const { service } = createService();

    const result = await service.getBunnyVideoPreview(VIDEO_ID);
    const params = new URL(result.embedUrl).searchParams;
    const expected = createHash("sha256")
      .update(`${TOKEN_SECURITY_KEY}${VIDEO_GUID}${result.expires}`)
      .digest("hex");

    assert.equal(params.get("token"), expected);
  });
});

/* ------------------------------------------------------------------ *
 * B. Malformed Bunny record - must fail closed
 * ------------------------------------------------------------------ */

describe("Admin Bunny preview - malformed Bunny record fails closed", () => {
  const malformedCases: Array<{ name: string; video: FakeVideoRecord }> = [
    {
      name: "missing providerAssetId",
      video: readyBunnyVideo({ providerAssetId: null }),
    },
    {
      name: "blank providerAssetId",
      video: readyBunnyVideo({ providerAssetId: "   " }),
    },
    {
      name: "playbackId does not match providerAssetId",
      video: readyBunnyVideo({ playbackId: "some-other-guid" }),
    },
    {
      name: "missing bunnyStream metadata marker",
      video: readyBunnyVideo({ metadataJson: {} }),
    },
    {
      name: "metadata videoId does not match providerAssetId",
      video: readyBunnyVideo({
        metadataJson: { bunnyStream: { videoId: "mismatched-guid" } },
      }),
    },
  ];

  for (const testCase of malformedCases) {
    it(`refuses and signs nothing - ${testCase.name}`, async () => {
      const { service, signCount } = createService({ video: testCase.video });

      const failure = await expectRejection(
        service.getBunnyVideoPreview(VIDEO_ID),
      );

      assert.equal(signCount(), 0);
      assert.equal(failure.status, 400);
      assert.match(failure.message, /malformed/i);
    });
  }
});

/* ------------------------------------------------------------------ *
 * C. Non-Bunny videos
 * ------------------------------------------------------------------ */

describe("Admin Bunny preview - non-Bunny assets are refused", () => {
  const notBunnyCases: Array<{ name: string; video: FakeVideoRecord }> = [
    {
      name: "ordinary DIRECT_URL video",
      video: readyBunnyVideo({
        provider: VideoProvider.MANUAL,
        sourceType: VideoSourceType.DIRECT_URL,
        providerAssetId: null,
        playbackId: null,
        metadataJson: null,
      }),
    },
    {
      name: "ordinary EMBED video",
      video: readyBunnyVideo({
        provider: VideoProvider.MANUAL,
        sourceType: VideoSourceType.EMBED,
        providerAssetId: null,
        playbackId: null,
        metadataJson: { embedProvider: EmbedProvider.YOUTUBE },
      }),
    },
    {
      name: "Cloudinary upload",
      video: readyBunnyVideo({
        provider: VideoProvider.CLOUDINARY,
        sourceType: VideoSourceType.UPLOAD,
        metadataJson: null,
      }),
    },
    {
      name: "LOCAL_FILE video",
      video: readyBunnyVideo({
        provider: VideoProvider.MANUAL,
        sourceType: VideoSourceType.LOCAL_FILE,
        providerAssetId: null,
        playbackId: null,
        metadataJson: null,
      }),
    },
    {
      name: "DB_BLOB video",
      video: readyBunnyVideo({
        provider: VideoProvider.MANUAL,
        sourceType: VideoSourceType.DB_BLOB,
        providerAssetId: null,
        playbackId: null,
        metadataJson: null,
      }),
    },
    {
      // The legacy record merely LABELLED Bunny. Must stay `not-bunny`.
      name: "legacy provider:BUNNY with sourceType:DIRECT_URL",
      video: readyBunnyVideo({
        provider: VideoProvider.BUNNY,
        sourceType: VideoSourceType.DIRECT_URL,
      }),
    },
  ];

  for (const testCase of notBunnyCases) {
    it(`refuses and signs nothing - ${testCase.name}`, async () => {
      const { service, signCount } = createService({ video: testCase.video });

      const failure = await expectRejection(
        service.getBunnyVideoPreview(VIDEO_ID),
      );

      assert.equal(signCount(), 0);
      assert.equal(failure.status, 400);
      assert.match(failure.message, /not backed by Bunny Stream/i);
    });
  }

  it("returns 404 and signs nothing for a missing video", async () => {
    const { service, signCount } = createService({ video: null });

    const failure = await expectRejection(
      service.getBunnyVideoPreview(VIDEO_ID),
    );

    assert.equal(signCount(), 0);
    assert.equal(failure.status, 404);
  });
});

/* ------------------------------------------------------------------ *
 * Non-READY assets
 * ------------------------------------------------------------------ */

describe("Admin Bunny preview - requires a READY asset", () => {
  for (const status of [
    VideoStatus.DRAFT,
    VideoStatus.PROCESSING,
    VideoStatus.FAILED,
    VideoStatus.DISABLED,
  ]) {
    it(`refuses and signs nothing while status is ${status}`, async () => {
      const { service, signCount } = createService({
        video: readyBunnyVideo({ status }),
      });

      const failure = await expectRejection(
        service.getBunnyVideoPreview(VIDEO_ID),
      );

      assert.equal(signCount(), 0);
      assert.equal(failure.status, 400);
      assert.match(failure.message, /not ready/i);
    });
  }
});

/* ------------------------------------------------------------------ *
 * D. Disabled / misconfigured Bunny - fail closed
 * ------------------------------------------------------------------ */

describe("Admin Bunny preview - disabled or misconfigured fails closed", () => {
  it("refuses while BUNNY_STREAM_ENABLED is false", async () => {
    const { service, signCount } = createService({
      bunnyOverrides: { BUNNY_STREAM_ENABLED: "false" },
    });

    const failure = await expectRejection(
      service.getBunnyVideoPreview(VIDEO_ID),
    );

    assert.equal(signCount(), 0);
    assert.equal(failure.status, 400);
    assert.match(failure.message, /Bunny Stream is not enabled/);
  });

  it("refuses when no Bunny collaborator is wired at all", async () => {
    const { service, signCount } = createService({
      omitBunnyCollaborator: true,
    });

    const failure = await expectRejection(
      service.getBunnyVideoPreview(VIDEO_ID),
    );

    assert.equal(signCount(), 0);
    assert.equal(failure.status, 400);
    assert.match(failure.message, /Bunny Stream is not enabled/);
  });

  it("refuses when the token security key is missing", async () => {
    const { service, signCount } = createService({
      bunnyOverrides: { BUNNY_STREAM_TOKEN_SECURITY_KEY: undefined },
    });

    const failure = await expectRejection(
      service.getBunnyVideoPreview(VIDEO_ID),
    );

    assert.equal(signCount(), 0);
    assert.equal(failure.status, 400);
  });

  it("refuses when the library id is missing", async () => {
    const { service, signCount } = createService({
      bunnyOverrides: { BUNNY_STREAM_LIBRARY_ID: undefined },
    });

    const failure = await expectRejection(
      service.getBunnyVideoPreview(VIDEO_ID),
    );

    assert.equal(signCount(), 0);
    assert.equal(failure.status, 400);
  });
});

/* ------------------------------------------------------------------ *
 * F. Admin authentication and authorization
 * ------------------------------------------------------------------ */

describe("Admin Bunny preview - authorization", () => {
  it("inherits the admin access-token and roles guards from the controller", () => {
    const guards = (Reflect.getMetadata(GUARDS_METADATA, VideosController) ??
      []) as unknown[];

    assert.ok(guards.includes(AdminAccessTokenGuard));
    assert.ok(guards.includes(AdminRolesGuard));
  });

  it("carries explicit admin role metadata, so it is not deny-by-default", () => {
    // `AdminRolesGuard` denies any handler with NO role metadata. A handler
    // without this would be unreachable rather than public - but recording the
    // exact roles keeps an accidental widening visible.
    const roles = Reflect.getMetadata(
      ADMIN_ROLES_METADATA,
      VideosController.prototype.getBunnyVideoPreview,
    ) as AdminRole[] | undefined;

    assert.deepEqual(roles, [
      AdminRole.OWNER,
      AdminRole.ADMIN,
      AdminRole.STAFF,
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * G. Secret boundary
 * ------------------------------------------------------------------ */

describe("Admin Bunny preview - secret boundary", () => {
  it("returns only embedUrl and expires", async () => {
    const { service } = createService();

    const result = await service.getBunnyVideoPreview(VIDEO_ID);

    assert.deepEqual(Object.keys(result).sort(), ["embedUrl", "expires"]);
  });

  it("never leaks the API key or the token security key", async () => {
    const { service } = createService();

    const result = await service.getBunnyVideoPreview(VIDEO_ID);
    const serialized = JSON.stringify(result);

    assert.doesNotMatch(serialized, new RegExp(API_KEY));
    assert.doesNotMatch(serialized, new RegExp(TOKEN_SECURITY_KEY));
    assert.doesNotMatch(serialized, /AccessKey/i);
  });

  it("keeps every refusal message free of Bunny secrets", async () => {
    const cases: Array<Promise<unknown>> = [
      createService({ video: readyBunnyVideo({ playbackId: "x" }) }).service
        .getBunnyVideoPreview(VIDEO_ID),
      createService({
        bunnyOverrides: { BUNNY_STREAM_ENABLED: "false" },
      }).service.getBunnyVideoPreview(VIDEO_ID),
      createService({
        bunnyOverrides: { BUNNY_STREAM_TOKEN_SECURITY_KEY: undefined },
      }).service.getBunnyVideoPreview(VIDEO_ID),
    ];

    for (const pending of cases) {
      const failure = await expectRejection(pending);

      assert.doesNotMatch(failure.message, new RegExp(API_KEY));
      assert.doesNotMatch(failure.message, new RegExp(TOKEN_SECURITY_KEY));
    }
  });
});

/* ------------------------------------------------------------------ *
 * Admin preview must open PAUSED
 *
 * The Bunny library's Player settings default to autoplay, so the embed page
 * renders `<video ... autoplay ...>` and the browser starts playing the moment
 * the admin iframe loads. `autoplay=false` is Bunny's documented per-embed
 * override: it is scoped to this one URL, changes no library setting, and is
 * not covered by the embed token.
 * ------------------------------------------------------------------ */

describe("Admin Bunny preview - does not autoplay", () => {
  it("returns a URL carrying autoplay=false", async () => {
    const { service } = createService();

    const result = await service.getBunnyVideoPreview(VIDEO_ID);
    const params = new URL(result.embedUrl).searchParams;

    assert.equal(params.get("autoplay"), "false");
  });

  it("keeps the credential pair intact alongside the player parameter", async () => {
    const { service } = createService();

    const result = await service.getBunnyVideoPreview(VIDEO_ID);
    const params = new URL(result.embedUrl).searchParams;

    assert.match(params.get("token") ?? "", /^[0-9a-f]{64}$/);
    assert.equal(Number(params.get("expires")), result.expires);
  });

  it("orders the query as token, expires, then player parameters", async () => {
    const { service } = createService();

    const result = await service.getBunnyVideoPreview(VIDEO_ID);
    const query = new URL(result.embedUrl).search;

    // The signed pair stays exactly where it has always been, so the admin URL
    // is the public URL plus a suffix - never a re-ordered or rebuilt one.
    assert.match(query, /^\?token=[0-9a-f]{64}&expires=\d+&autoplay=false$/);
  });

  it("still refuses to sign anything when the asset is ineligible", async () => {
    // Guards against the player-parameter change accidentally moving signing
    // ahead of the eligibility gate.
    const { service, signCount } = createService({
      video: readyBunnyVideo({ playbackId: "mismatched" }),
    });

    await expectRejection(service.getBunnyVideoPreview(VIDEO_ID));

    assert.equal(signCount(), 0);
  });
});

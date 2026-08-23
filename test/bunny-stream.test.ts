/**
 * BUNNY STREAM — provider integration.
 *
 * Scope note: this file is deliberately NOT part of the release-blocking
 * share-link compatibility suite (`test/share-link-compat-*.test.ts`). Bunny has
 * no legacy production share links to keep compatible; what the compatibility
 * suite proves about Bunny is the opposite direction — that adding it changed
 * nothing for the five existing source types.
 *
 * Nothing here performs a real network request. The Bunny HTTP boundary is
 * mocked by replacing `globalThis.fetch` for the duration of a test.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import {
  BUNNY_STREAM_EMBED_BASE_URL,
  BUNNY_STREAM_TUS_ENDPOINT,
  BUNNY_VIDEO_STATUS,
} from "../src/bunny/bunny-stream.constants";
import { BunnyStreamModule } from "../src/bunny/bunny-stream.module";
import { BunnyStreamService } from "../src/bunny/bunny-stream.service";
import {
  classifyBunnyVideoAsset,
  readBunnyVideoAsset,
} from "../src/bunny/bunny-video-asset.util";
import { apiConfig } from "../src/config/env.config";
import { validateEnv } from "../src/config/env.validation";
import {
  EmbedProvider,
  ShareLinkStatus,
  VideoProvider,
  VideoSourceType,
} from "../src/generated/prisma/client";
import { PublicModule } from "../src/public/public.module";
import { VideosModule } from "../src/videos/videos.module";
import {
  BUNNY_UNSIGNED_EMBED_URL,
  BUNNY_VIDEO_GUID,
  bunnyStreamVideo,
  cloudinaryEmbedVideo,
  createCompatHarness,
  dbBlobVideo,
  directUrlVideo,
  embedVideo,
  LEGACY_ALIAS,
  LEGACY_HOST,
  legacyLabelledBunnyVideo,
  localFileVideo,
  PUBLIC_DENIAL_RESPONSE,
  UNKNOWN_HOST,
} from "./share-link-compat-harness";

/* ------------------------------------------------------------------ *
 * Synthetic configuration. No production value appears here.
 * ------------------------------------------------------------------ */

const LIBRARY_ID = "987654";
const API_KEY = "bunny-test-api-key-0123456789abcdef";
const TOKEN_SECURITY_KEY = "bunny-test-token-security-key-0123456789";
const VIDEO_GUID = "11111111-2222-3333-4444-555555555555";
const FIXED_NOW = new Date("2026-08-23T00:00:00.000Z");
const FIXED_NOW_SECONDS = Math.floor(FIXED_NOW.getTime() / 1000);

type ConfigOverrides = Record<string, string | undefined>;

function createConfigService(overrides: ConfigOverrides = {}) {
  const values: ConfigOverrides = {
    BUNNY_STREAM_ENABLED: "true",
    BUNNY_STREAM_LIBRARY_ID: LIBRARY_ID,
    BUNNY_STREAM_API_KEY: API_KEY,
    BUNNY_STREAM_TOKEN_SECURITY_KEY: TOKEN_SECURITY_KEY,
    ...overrides,
  };

  return {
    get: (key: string): string | undefined => values[key],
  };
}

function createService(overrides: ConfigOverrides = {}): BunnyStreamService {
  return new BunnyStreamService(createConfigService(overrides) as never);
}

/** Independently computed expectation, never derived from the service. */
function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
};

type StubResponse = {
  status?: number;
  json?: unknown;
};

const originalFetch = globalThis.fetch;

function stubFetch(response: StubResponse | (() => never)): FetchCall[] {
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (
    input: string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    if (typeof response === "function") {
      response();
    }

    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    const status = response.status ?? 200;

    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response.json ?? {},
    } as Response;
  }) as typeof fetch;

  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/* ------------------------------------------------------------------ *
 * Configuration gate
 * ------------------------------------------------------------------ */

describe("Bunny Stream configuration gate", () => {
  it("reports disabled when BUNNY_STREAM_ENABLED is absent or false", () => {
    assert.equal(
      createService({ BUNNY_STREAM_ENABLED: undefined }).isEnabled(),
      false,
    );
    assert.equal(
      createService({ BUNNY_STREAM_ENABLED: "false" }).isEnabled(),
      false,
    );
    assert.equal(
      createService({ BUNNY_STREAM_ENABLED: "true" }).isEnabled(),
      true,
    );
    assert.equal(
      createService({ BUNNY_STREAM_ENABLED: "1" }).isEnabled(),
      true,
    );
  });

  it("refuses every Bunny entry point while disabled, with no secret in the message", () => {
    const service = createService({ BUNNY_STREAM_ENABLED: "false" });

    assert.throws(
      () => service.ensureEnabled(),
      (error: Error) => {
        assert.match(error.message, /Bunny Stream is not enabled/);
        assert.doesNotMatch(error.message, new RegExp(API_KEY));
        assert.doesNotMatch(error.message, new RegExp(TOKEN_SECURITY_KEY));
        return true;
      },
    );
  });

  it("does not require any Bunny value to construct the service while disabled", () => {
    const service = createService({
      BUNNY_STREAM_ENABLED: "false",
      BUNNY_STREAM_LIBRARY_ID: undefined,
      BUNNY_STREAM_API_KEY: undefined,
      BUNNY_STREAM_TOKEN_SECURITY_KEY: undefined,
    });

    assert.equal(service.isEnabled(), false);
  });
});

/* ------------------------------------------------------------------ *
 * Create / get / delete — request construction
 * ------------------------------------------------------------------ */

describe("Bunny Stream management requests", () => {
  it("creates a video with the AccessKey header on the official API base", async () => {
    const calls = stubFetch({ json: { guid: VIDEO_GUID, status: 0 } });
    const video = await createService().createVideo("Bunny title");

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.url,
      `https://video.bunnycdn.com/library/${LIBRARY_ID}/videos`,
    );
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.headers.AccessKey, API_KEY);
    assert.equal(calls[0]?.headers["Content-Type"], "application/json");
    assert.equal(calls[0]?.body, JSON.stringify({ title: "Bunny title" }));
    assert.equal(video.guid, VIDEO_GUID);
  });

  it("reads a video by GUID and surfaces status and encodeProgress", async () => {
    const calls = stubFetch({
      json: {
        guid: VIDEO_GUID,
        status: BUNNY_VIDEO_STATUS.TRANSCODING,
        encodeProgress: 62,
        length: 128,
        videoLibraryId: 987654,
      },
    });
    const video = await createService().getVideo(VIDEO_GUID);

    assert.equal(
      calls[0]?.url,
      `https://video.bunnycdn.com/library/${LIBRARY_ID}/videos/${VIDEO_GUID}`,
    );
    assert.equal(calls[0]?.method, "GET");
    assert.equal(calls[0]?.headers.AccessKey, API_KEY);
    assert.equal(video.status, BUNNY_VIDEO_STATUS.TRANSCODING);
    assert.equal(video.encodeProgress, 62);
    assert.equal(video.length, 128);
  });

  it("deletes a video by GUID and reports confirmation", async () => {
    const calls = stubFetch({ status: 200, json: { success: true } });
    const deleted = await createService().deleteVideo(VIDEO_GUID);

    assert.equal(deleted, true);
    assert.equal(calls[0]?.method, "DELETE");
    assert.equal(
      calls[0]?.url,
      `https://video.bunnycdn.com/library/${LIBRARY_ID}/videos/${VIDEO_GUID}`,
    );
  });

  it("treats a Bunny 404 on delete as already gone", async () => {
    stubFetch({ status: 404 });

    assert.equal(await createService().deleteVideo(VIDEO_GUID), true);
  });

  it("throws rather than claiming success when Bunny returns an error status", async () => {
    stubFetch({ status: 500 });

    await assert.rejects(() => createService().deleteVideo(VIDEO_GUID));
  });

  it("keeps the API key out of the exception when Bunny fails", async () => {
    stubFetch({ status: 401 });

    await assert.rejects(
      () => createService().getVideo(VIDEO_GUID),
      (error: Error) => {
        assert.doesNotMatch(error.message, new RegExp(API_KEY));
        assert.doesNotMatch(error.message, new RegExp(TOKEN_SECURITY_KEY));
        return true;
      },
    );
  });
});

/* ------------------------------------------------------------------ *
 * TUS credentials
 * ------------------------------------------------------------------ */

describe("Bunny Stream TUS upload credentials", () => {
  it("signs SHA256(libraryId + apiKey + expiration + videoId) as hex", () => {
    const credentials = createService().createTusUploadCredentials(
      VIDEO_GUID,
      FIXED_NOW,
    );
    const expected = sha256Hex(
      `${LIBRARY_ID}${API_KEY}${credentials.expirationTime}${VIDEO_GUID}`,
    );

    assert.equal(credentials.signature, expected);
    assert.match(credentials.signature, /^[a-f0-9]{64}$/);
  });

  it("fails if any signature operand is reordered", () => {
    const credentials = createService().createTusUploadCredentials(
      VIDEO_GUID,
      FIXED_NOW,
    );
    const reordered = sha256Hex(
      `${API_KEY}${LIBRARY_ID}${credentials.expirationTime}${VIDEO_GUID}`,
    );

    assert.notEqual(credentials.signature, reordered);
  });

  it("expires one hour ahead by default, in UNIX seconds", () => {
    const credentials = createService().createTusUploadCredentials(
      VIDEO_GUID,
      FIXED_NOW,
    );

    assert.equal(credentials.expirationTime, FIXED_NOW_SECONDS + 3600);
    assert.equal(Number.isInteger(credentials.expirationTime), true);
  });

  it("honours a configured TTL and clamps it to the supported bounds", () => {
    const configured = createService({
      BUNNY_STREAM_TUS_TTL_SECONDS: "900",
    }).createTusUploadCredentials(VIDEO_GUID, FIXED_NOW);
    assert.equal(configured.expirationTime, FIXED_NOW_SECONDS + 900);

    const tooSmall = createService({
      BUNNY_STREAM_TUS_TTL_SECONDS: "1",
    }).createTusUploadCredentials(VIDEO_GUID, FIXED_NOW);
    assert.equal(tooSmall.expirationTime, FIXED_NOW_SECONDS + 300);

    const tooLarge = createService({
      BUNNY_STREAM_TUS_TTL_SECONDS: "999999",
    }).createTusUploadCredentials(VIDEO_GUID, FIXED_NOW);
    assert.equal(tooLarge.expirationTime, FIXED_NOW_SECONDS + 86400);
  });

  it("returns exactly the five documented fields and never the API key", () => {
    const credentials = createService().createTusUploadCredentials(
      VIDEO_GUID,
      FIXED_NOW,
    );

    assert.deepEqual(Object.keys(credentials).sort(), [
      "expirationTime",
      "libraryId",
      "signature",
      "tusEndpoint",
      "videoId",
    ]);
    assert.equal(credentials.tusEndpoint, BUNNY_STREAM_TUS_ENDPOINT);
    assert.equal(
      credentials.tusEndpoint,
      "https://video.bunnycdn.com/tusupload",
    );

    const serialized = JSON.stringify(credentials);
    assert.equal(serialized.includes(API_KEY), false);
    assert.equal(serialized.includes(TOKEN_SECURITY_KEY), false);
  });
});

/* ------------------------------------------------------------------ *
 * Signed embed URL
 * ------------------------------------------------------------------ */

describe("Bunny Stream signed embed URL", () => {
  it("signs SHA256(tokenSecurityKey + videoId + expires) as hex", () => {
    const signed = createService().createSignedEmbedUrl(VIDEO_GUID, FIXED_NOW);

    assert.equal(
      signed.token,
      sha256Hex(`${TOKEN_SECURITY_KEY}${VIDEO_GUID}${signed.expires}`),
    );
    assert.match(signed.token, /^[a-f0-9]{64}$/);
  });

  it("is not the TUS signature and not a reordered digest", () => {
    const signed = createService().createSignedEmbedUrl(VIDEO_GUID, FIXED_NOW);

    assert.notEqual(
      signed.token,
      sha256Hex(`${VIDEO_GUID}${TOKEN_SECURITY_KEY}${signed.expires}`),
    );
    assert.notEqual(
      signed.token,
      sha256Hex(`${LIBRARY_ID}${API_KEY}${signed.expires}${VIDEO_GUID}`),
    );
  });

  it("expires five minutes ahead by default and clamps a configured TTL", () => {
    assert.equal(
      createService().createSignedEmbedUrl(VIDEO_GUID, FIXED_NOW).expires,
      FIXED_NOW_SECONDS + 300,
    );
    assert.equal(
      createService({
        BUNNY_STREAM_EMBED_TOKEN_TTL_SECONDS: "120",
      }).createSignedEmbedUrl(VIDEO_GUID, FIXED_NOW).expires,
      FIXED_NOW_SECONDS + 120,
    );
    assert.equal(
      createService({
        BUNNY_STREAM_EMBED_TOKEN_TTL_SECONDS: "1",
      }).createSignedEmbedUrl(VIDEO_GUID, FIXED_NOW).expires,
      FIXED_NOW_SECONDS + 60,
    );
    assert.equal(
      createService({
        BUNNY_STREAM_EMBED_TOKEN_TTL_SECONDS: "999999",
      }).createSignedEmbedUrl(VIDEO_GUID, FIXED_NOW).expires,
      FIXED_NOW_SECONDS + 3600,
    );
  });

  it("builds the documented iframe URL with token and expires", () => {
    const signed = createService().createSignedEmbedUrl(VIDEO_GUID, FIXED_NOW);
    const url = new URL(signed.embedUrl);

    assert.equal(url.origin, "https://iframe.mediadelivery.net");
    assert.equal(url.pathname, `/embed/${LIBRARY_ID}/${VIDEO_GUID}`);
    assert.equal(url.searchParams.get("token"), signed.token);
    assert.equal(url.searchParams.get("expires"), String(signed.expires));
    assert.ok(signed.embedUrl.startsWith(BUNNY_STREAM_EMBED_BASE_URL));
  });

  it("never leaks the token security key into the URL", () => {
    const signed = createService().createSignedEmbedUrl(VIDEO_GUID, FIXED_NOW);

    assert.equal(signed.embedUrl.includes(TOKEN_SECURITY_KEY), false);
    assert.equal(signed.embedUrl.includes(API_KEY), false);
  });

  it("produces a different token for a later expiry, so reloads re-sign", () => {
    const first = createService().createSignedEmbedUrl(VIDEO_GUID, FIXED_NOW);
    const later = createService().createSignedEmbedUrl(
      VIDEO_GUID,
      new Date(FIXED_NOW.getTime() + 60_000),
    );

    assert.notEqual(first.token, later.token);
    assert.equal(later.expires, first.expires + 60);
  });
});

/* ------------------------------------------------------------------ *
 * Status mapping
 * ------------------------------------------------------------------ */

describe("Bunny Stream status mapping", () => {
  it("maps only 4 (Finished) to READY", () => {
    const service = createService();

    assert.equal(
      service.mapProcessingState(BUNNY_VIDEO_STATUS.FINISHED),
      "READY",
    );
    // 3 is Transcoding, not Finished. A video there is still encoding.
    assert.equal(
      service.mapProcessingState(BUNNY_VIDEO_STATUS.TRANSCODING),
      "PROCESSING",
    );
  });

  it("maps 5 (Error) and 6 (UploadFailed) to FAILED", () => {
    const service = createService();

    assert.equal(
      service.mapProcessingState(BUNNY_VIDEO_STATUS.ERROR),
      "FAILED",
    );
    assert.equal(
      service.mapProcessingState(BUNNY_VIDEO_STATUS.UPLOAD_FAILED),
      "FAILED",
    );
  });

  it("maps every other state, and an absent state, to PROCESSING", () => {
    const service = createService();

    for (const status of [
      BUNNY_VIDEO_STATUS.CREATED,
      BUNNY_VIDEO_STATUS.UPLOADED,
      BUNNY_VIDEO_STATUS.PROCESSING,
      BUNNY_VIDEO_STATUS.JIT_SEGMENTING,
      BUNNY_VIDEO_STATUS.JIT_PLAYLISTS_CREATED,
    ]) {
      assert.equal(service.mapProcessingState(status), "PROCESSING");
    }

    assert.equal(service.mapProcessingState(null), "PROCESSING");
    assert.equal(service.mapProcessingState(99), "PROCESSING");
  });
});

/* ------------------------------------------------------------------ *
 * Provider isolation
 * ------------------------------------------------------------------ */

describe("Bunny provider isolation", () => {
  it("matches only a record carrying all four Bunny markers", () => {
    const bunny = bunnyStreamVideo();

    assert.deepEqual(readBunnyVideoAsset(bunny), {
      bunnyVideoId: BUNNY_VIDEO_GUID,
      libraryId: "987654",
    });
  });

  it("does not match any legacy source type", () => {
    for (const fixture of [
      directUrlVideo(),
      embedVideo(),
      localFileVideo(),
      dbBlobVideo(),
      cloudinaryEmbedVideo(),
      legacyLabelledBunnyVideo(),
    ]) {
      assert.equal(
        readBunnyVideoAsset(fixture),
        null,
        `${fixture.provider}/${fixture.sourceType} must not be treated as Bunny`,
      );
    }
  });

  it("does not match a partially marked record", () => {
    // Right provider and source type, no metadata marker.
    assert.equal(
      readBunnyVideoAsset({
        provider: VideoProvider.BUNNY,
        sourceType: VideoSourceType.EMBED,
        providerAssetId: BUNNY_VIDEO_GUID,
        metadataJson: null,
      }),
      null,
    );

    // Marker present but pointing at a different asset id.
    assert.equal(
      readBunnyVideoAsset({
        provider: VideoProvider.BUNNY,
        sourceType: VideoSourceType.EMBED,
        providerAssetId: BUNNY_VIDEO_GUID,
        metadataJson: { bunnyStream: { videoId: "some-other-guid" } },
      }),
      null,
    );

    // Marker present, but the record is a DIRECT_URL video.
    assert.equal(
      readBunnyVideoAsset({
        provider: VideoProvider.BUNNY,
        sourceType: VideoSourceType.DIRECT_URL,
        providerAssetId: BUNNY_VIDEO_GUID,
        metadataJson: { bunnyStream: { videoId: BUNNY_VIDEO_GUID } },
      }),
      null,
    );

    // Cloudinary asset that happens to carry a stray marker.
    assert.equal(
      readBunnyVideoAsset({
        provider: VideoProvider.CLOUDINARY,
        sourceType: VideoSourceType.EMBED,
        providerAssetId: BUNNY_VIDEO_GUID,
        metadataJson: { bunnyStream: { videoId: BUNNY_VIDEO_GUID } },
      }),
      null,
    );
  });

  it("keeps the Bunny fixture shaped the way the upload path writes it", () => {
    const bunny = bunnyStreamVideo();

    assert.equal(bunny.provider, VideoProvider.BUNNY);
    assert.equal(bunny.sourceType, VideoSourceType.EMBED);
    assert.equal(bunny.embedProvider, EmbedProvider.GENERIC_IFRAME);
  });
});

/* ------------------------------------------------------------------ *
 * Public playback: authorization strictly before signing
 * ------------------------------------------------------------------ */

/**
 * A signing spy standing in for `BunnyStreamService` in `PublicService`.
 * `signCount` is the evidence: it must stay at zero for every denied request.
 */
function createSigningSpy(options: { enabled?: boolean } = {}) {
  const spy = {
    enabled: options.enabled ?? true,
    /** Counts every actual mint. The evidence for BLOCKER 1 and BLOCKER 2. */
    signCount: 0,
    /**
     * Counts the pure capability check. It must be safe to call before
     * consumption, so it is tracked separately and never treated as a mint.
     */
    canSignCount: 0,
    signedVideoIds: [] as string[],
    isEnabled(): boolean {
      return spy.enabled;
    },
    canSignEmbedUrl(): boolean {
      spy.canSignCount += 1;
      return spy.enabled;
    },
    createSignedEmbedUrl(videoId: string) {
      spy.signCount += 1;
      spy.signedVideoIds.push(videoId);
      const expires = FIXED_NOW_SECONDS + 300;
      const token = sha256Hex(`${TOKEN_SECURITY_KEY}${videoId}${expires}`);

      return {
        embedUrl: `${BUNNY_STREAM_EMBED_BASE_URL}/${LIBRARY_ID}/${videoId}?token=${token}&expires=${expires}`,
        token,
        expires,
      };
    },
  };

  return spy;
}

describe("Bunny public playback requires full share authorization first", () => {
  it("returns a signed embed URL once every existing check has passed", async () => {
    const bunnyStream = createSigningSpy();
    const { service } = createCompatHarness({
      videos: [bunnyStreamVideo()],
      bunnyStream,
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });
    const video = response.videos[0];

    assert.equal(response.valid, true);
    assert.ok(video);
    assert.equal(video.sourceType, VideoSourceType.EMBED);

    const url = new URL(String(video.embedUrl));
    assert.equal(url.origin, "https://iframe.mediadelivery.net");
    assert.match(String(url.searchParams.get("token")), /^[a-f0-9]{64}$/);
    assert.ok(Number(url.searchParams.get("expires")) > FIXED_NOW_SECONDS - 1);
    assert.ok(bunnyStream.signCount > 0);
  });

  it("never returns the stored unsigned embed URL", async () => {
    const { service } = createCompatHarness({
      videos: [bunnyStreamVideo()],
      bunnyStream: createSigningSpy(),
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.notEqual(response.videos[0]?.embedUrl, BUNNY_UNSIGNED_EMBED_URL);
    assert.equal(
      JSON.stringify(response).includes(`${BUNNY_UNSIGNED_EMBED_URL}"`),
      false,
    );
  });

  for (const scenario of [
    { name: "an unknown host", host: UNKNOWN_HOST, token: LEGACY_ALIAS },
    {
      name: "an unknown credential",
      host: LEGACY_HOST,
      token: "not-a-real-alias",
    },
    { name: "a missing credential", host: LEGACY_HOST, token: undefined },
  ]) {
    it(`signs nothing for ${scenario.name}`, async () => {
      const bunnyStream = createSigningSpy();
      const { service } = createCompatHarness({
        videos: [bunnyStreamVideo()],
        bunnyStream,
      });

      const response = await service.resolvePublicWatch({
        host: scenario.host,
        ...(scenario.token === undefined ? {} : { token: scenario.token }),
      });

      assert.equal(response.valid, false);
      assert.deepEqual(response.videos, []);
      assert.equal(
        bunnyStream.signCount,
        0,
        "a denied request must never reach the signing key",
      );
    });
  }

  it("signs nothing for a revoked share link", async () => {
    const bunnyStream = createSigningSpy();
    const { service } = createCompatHarness({
      videos: [bunnyStreamVideo()],
      shareLink: { status: "REVOKED" },
      bunnyStream,
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.valid, false);
    assert.equal(bunnyStream.signCount, 0);
  });

  it("signs nothing for an expired share link", async () => {
    const bunnyStream = createSigningSpy();
    const { service } = createCompatHarness({
      videos: [bunnyStreamVideo()],
      shareLink: { expiresAt: new Date("2020-01-01T00:00:00.000Z") },
      bunnyStream,
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.valid, false);
    assert.equal(bunnyStream.signCount, 0);
  });

  it("signs nothing once the view budget is exhausted", async () => {
    const bunnyStream = createSigningSpy();
    const { service } = createCompatHarness({
      videos: [bunnyStreamVideo()],
      shareLink: { maxViews: 1, currentViews: 1 },
      bunnyStream,
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.valid, false);
    assert.equal(bunnyStream.signCount, 0);
  });

  it("signs nothing when the website assignment is removed", async () => {
    const bunnyStream = createSigningSpy();
    const { service } = createCompatHarness({
      videos: [bunnyStreamVideo({ websiteVideos: [] })],
      bunnyStream,
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.valid, false);
    assert.equal(bunnyStream.signCount, 0);
  });

  it("signs nothing while the video is not READY", async () => {
    const bunnyStream = createSigningSpy();
    const { service } = createCompatHarness({
      videos: [bunnyStreamVideo({ status: "PROCESSING" })],
      bunnyStream,
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.valid, false);
    assert.equal(bunnyStream.signCount, 0);
  });

  it("re-signs on every resolution, including a cached-metadata hit", async () => {
    const bunnyStream = createSigningSpy();
    const { service } = createCompatHarness({
      videos: [bunnyStreamVideo()],
      memoryCache: true,
      bunnyStream,
    });

    const first = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });
    const countAfterFirst = bunnyStream.signCount;

    const second = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(first.valid, true);
    assert.equal(second.valid, true);
    assert.ok(
      bunnyStream.signCount > countAfterFirst,
      "a cache hit must still mint a fresh signature, not replay a stored one",
    );
  });

  it("fails closed when Bunny is disabled: the video is dropped, not served unsigned", async () => {
    const bunnyStream = createSigningSpy({ enabled: false });
    const { service } = createCompatHarness({
      videos: [bunnyStreamVideo()],
      bunnyStream,
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.valid, false);
    assert.equal(bunnyStream.signCount, 0);
    assert.equal(JSON.stringify(response).includes("mediadelivery"), false);
  });

  it("fails closed when no Bunny collaborator is wired at all", async () => {
    const { service } = createCompatHarness({ videos: [bunnyStreamVideo()] });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.valid, false);
  });
});

/* ------------------------------------------------------------------ *
 * Legacy behaviour is untouched
 * ------------------------------------------------------------------ */

describe("Bunny changes nothing for existing providers", () => {
  it("leaves every legacy source type resolving with Bunny wired in", async () => {
    const bunnyStream = createSigningSpy();

    for (const fixture of [
      directUrlVideo(),
      embedVideo(),
      localFileVideo(),
      dbBlobVideo(),
      cloudinaryEmbedVideo(),
      legacyLabelledBunnyVideo(),
    ]) {
      const { service } = createCompatHarness({
        videos: [fixture],
        bunnyStream,
      });
      const response = await service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
      });

      assert.equal(response.valid, true, `${fixture.id} must still resolve`);
      assert.equal(response.videos.length, 1);
    }

    assert.equal(
      bunnyStream.signCount,
      0,
      "no legacy source type may reach the Bunny signing key",
    );
  });

  it("returns a legacy EMBED url verbatim even with Bunny wired in", async () => {
    const fixture = embedVideo();
    const { service } = createCompatHarness({
      videos: [fixture],
      bunnyStream: createSigningSpy(),
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.videos[0]?.embedUrl, fixture.embedUrl);
  });

  it("keeps a legacy provider:BUNNY DIRECT_URL record on the generic path", async () => {
    const fixture = legacyLabelledBunnyVideo();
    const bunnyStream = createSigningSpy();
    const { service } = createCompatHarness({
      videos: [fixture],
      bunnyStream,
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });
    const video = response.videos[0];

    assert.equal(video?.sourceType, VideoSourceType.DIRECT_URL);
    assert.equal(video?.playbackUrl, fixture.playbackUrl);
    assert.equal(video?.embedUrl, null);
    assert.equal(bunnyStream.signCount, 0);
  });
});

/* ------------------------------------------------------------------ *
 * Environment validation
 *
 * A production deployment that has never heard of Bunny must still boot.
 * ------------------------------------------------------------------ */

const BASE_ENV = {
  NODE_ENV: "production",
  APP_ENV: "production",
  DATABASE_URL: "mysql://user:pass@localhost:3306/db",
  JWT_ACCESS_SECRET: "test-access-secret",
  REFRESH_TOKEN_PEPPER: "test-refresh-pepper",
  SHARE_TOKEN_PEPPER: "test-share-pepper",
  ACCESS_LOG_IP_PEPPER: "test-ip-pepper",
  PUBLIC_MEDIA_GRANT_SECRET: "test-public-media-grant-secret-0123456789",
  ADMIN_CHANGE_PASSWORD_SECRET: "test-change-secret",
  ADMIN_WEB_ORIGIN: "https://admin.example.com",
} as const;

function withCleanEnv(run: () => void): void {
  const previousEnv = { ...process.env };
  try {
    run();
  } finally {
    process.env = previousEnv;
  }
}

describe("Bunny Stream environment validation", () => {
  it("boots a production configuration with no Bunny variables at all", () => {
    withCleanEnv(() => {
      const validated = validateEnv({ ...BASE_ENV });

      assert.equal(validated.BUNNY_STREAM_ENABLED, "false");
      assert.equal(apiConfig().bunnyStream.enabled, false);
      assert.equal(apiConfig().bunnyStream.libraryId, null);
    });
  });

  it("boots with BUNNY_STREAM_ENABLED=false even when the keys are blank", () => {
    withCleanEnv(() => {
      const validated = validateEnv({
        ...BASE_ENV,
        BUNNY_STREAM_ENABLED: "false",
        BUNNY_STREAM_LIBRARY_ID: "",
        BUNNY_STREAM_API_KEY: "",
        BUNNY_STREAM_TOKEN_SECURITY_KEY: "",
      });

      assert.equal(validated.BUNNY_STREAM_ENABLED, "false");
    });
  });

  it("requires the library id, API key and token security key once enabled", () => {
    for (const missing of [
      "BUNNY_STREAM_LIBRARY_ID",
      "BUNNY_STREAM_API_KEY",
      "BUNNY_STREAM_TOKEN_SECURITY_KEY",
    ]) {
      withCleanEnv(() => {
        const config: Record<string, string> = {
          ...BASE_ENV,
          BUNNY_STREAM_ENABLED: "true",
          BUNNY_STREAM_LIBRARY_ID: LIBRARY_ID,
          BUNNY_STREAM_API_KEY: API_KEY,
          BUNNY_STREAM_TOKEN_SECURITY_KEY: TOKEN_SECURITY_KEY,
        };
        delete config[missing];

        assert.throws(
          () => validateEnv(config),
          new RegExp(`${missing} is required`),
        );
      });
    }
  });

  it("rejects a non-numeric library id", () => {
    withCleanEnv(() => {
      assert.throws(
        () =>
          validateEnv({
            ...BASE_ENV,
            BUNNY_STREAM_ENABLED: "true",
            BUNNY_STREAM_LIBRARY_ID: "not-a-library",
            BUNNY_STREAM_API_KEY: API_KEY,
            BUNNY_STREAM_TOKEN_SECURITY_KEY: TOKEN_SECURITY_KEY,
          }),
        /BUNNY_STREAM_LIBRARY_ID must be a numeric library id/,
      );
    });
  });

  it("exposes only non-secret Bunny values through the typed config", () => {
    withCleanEnv(() => {
      validateEnv({
        ...BASE_ENV,
        BUNNY_STREAM_ENABLED: "true",
        BUNNY_STREAM_LIBRARY_ID: LIBRARY_ID,
        BUNNY_STREAM_API_KEY: API_KEY,
        BUNNY_STREAM_TOKEN_SECURITY_KEY: TOKEN_SECURITY_KEY,
      });

      const bunnyStream = apiConfig().bunnyStream;

      assert.deepEqual(Object.keys(bunnyStream).sort(), [
        "embedTokenTtlSeconds",
        "enabled",
        "libraryId",
        "tusTtlSeconds",
      ]);
      assert.equal(bunnyStream.enabled, true);
      assert.equal(bunnyStream.libraryId, LIBRARY_ID);
      assert.equal(bunnyStream.tusTtlSeconds, 3600);
      assert.equal(bunnyStream.embedTokenTtlSeconds, 300);

      const serialized = JSON.stringify(bunnyStream);
      assert.equal(serialized.includes(API_KEY), false);
      assert.equal(serialized.includes(TOKEN_SECURITY_KEY), false);
    });
  });

  it("accepts in-range TTL overrides", () => {
    withCleanEnv(() => {
      validateEnv({
        ...BASE_ENV,
        BUNNY_STREAM_TUS_TTL_SECONDS: "900",
        BUNNY_STREAM_EMBED_TOKEN_TTL_SECONDS: "120",
      });

      assert.equal(apiConfig().bunnyStream.tusTtlSeconds, 900);
      assert.equal(apiConfig().bunnyStream.embedTokenTtlSeconds, 120);
    });
  });

  it("fails fast on an out-of-range TTL rather than silently clamping", () => {
    // Matches how every other bounded value in this file behaves: a malformed
    // deployment value is reported at boot, not quietly rewritten.
    withCleanEnv(() => {
      assert.throws(
        () =>
          validateEnv({
            ...BASE_ENV,
            BUNNY_STREAM_TUS_TTL_SECONDS: "999999",
          }),
        /BUNNY_STREAM_TUS_TTL_SECONDS must be between 300 and 86400/,
      );
    });

    withCleanEnv(() => {
      assert.throws(
        () =>
          validateEnv({
            ...BASE_ENV,
            BUNNY_STREAM_EMBED_TOKEN_TTL_SECONDS: "1",
          }),
        /BUNNY_STREAM_EMBED_TOKEN_TTL_SECONDS must be between 60 and 3600/,
      );
    });
  });
});

/* ------------------------------------------------------------------ *
 * Module wiring
 *
 * Reads the same Nest module metadata `NestFactory.create(AppModule)` reads at
 * boot. It cannot boot the graph — tsx/esbuild does not emit the
 * `design:paramtypes` the container needs — but it does catch the realistic
 * regression: someone removing the import and leaving Bunny silently disabled
 * at runtime.
 * ------------------------------------------------------------------ */

describe("Bunny Stream module wiring", () => {
  it("registers BunnyStreamService as an exported provider", () => {
    const providers = (Reflect.getMetadata("providers", BunnyStreamModule) ??
      []) as unknown[];
    const exports = (Reflect.getMetadata("exports", BunnyStreamModule) ??
      []) as unknown[];

    assert.equal(providers.includes(BunnyStreamService), true);
    assert.equal(exports.includes(BunnyStreamService), true);
  });

  it("keeps BunnyStreamModule imported by both consumers", () => {
    for (const [name, consumer] of [
      ["VideosModule", VideosModule],
      ["PublicModule", PublicModule],
    ] as const) {
      const imports = (Reflect.getMetadata("imports", consumer) ??
        []) as unknown[];

      assert.equal(
        imports.includes(BunnyStreamModule),
        true,
        `${name} no longer imports BunnyStreamModule - Bunny would be silently unavailable at runtime`,
      );
    }
  });
});

/* ------------------------------------------------------------------ *
 * BLOCKER 1 — signing happens only AFTER atomic view consumption
 *
 * The ordering under test:
 *
 *   1. resolve credential / domain / share / video candidates
 *   2. all existing authorization checks
 *   3. authoritative atomic view consumption (`incrementShareLinkView`)
 *   4. ONLY IF 3 succeeded: serialize and sign
 *
 * `signCount` is the evidence. `canSignCount` may be non-zero before step 3 -
 * that is the pure capability check and mints nothing.
 * ------------------------------------------------------------------ */

/** Forces the authoritative conditional update to claim zero rows. */
function failNextConsumption(prisma: {
  shareLink: { updateMany: unknown };
}): void {
  prisma.shareLink.updateMany = (async () => ({ count: 0 })) as never;
}

describe("Bunny signing happens strictly after atomic view consumption", () => {
  it("signs exactly once for a single video, only after consumption succeeded", async () => {
    const bunnyStream = createSigningSpy();
    const { service } = createCompatHarness({
      videos: [bunnyStreamVideo()],
      bunnyStream,
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.valid, true);
    assert.equal(
      bunnyStream.signCount,
      1,
      "one authorized, consumed resolution must mint exactly one URL",
    );
  });

  it("signs nothing when the atomic consumption loses its race", async () => {
    const bunnyStream = createSigningSpy();
    const { service, prisma } = createCompatHarness({
      videos: [bunnyStreamVideo()],
      bunnyStream,
    });

    // Every earlier check passes; only the authoritative conditional update
    // fails, exactly as a concurrent revoke, expiry or maxViews exhaustion
    // would make it fail.
    failNextConsumption(prisma as never);

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.deepEqual(response, PUBLIC_DENIAL_RESPONSE);
    assert.equal(
      bunnyStream.signCount,
      0,
      "a request that ends INVALID_LINK must never have minted a credential",
    );
  });

  it("signs nothing when a cached resolution then loses its consumption race", async () => {
    const bunnyStream = createSigningSpy();
    const { service, prisma } = createCompatHarness({
      videos: [bunnyStreamVideo()],
      memoryCache: true,
      bunnyStream,
    });

    // Warm the cache with one legitimate, consumed resolution.
    const first = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });
    assert.equal(first.valid, true);
    const signedDuringWarmup = bunnyStream.signCount;
    assert.equal(signedDuringWarmup, 1);

    // Now the consume fails. The cache may accelerate lookup, but must not
    // shortcut the ordering.
    failNextConsumption(prisma as never);

    const second = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.deepEqual(second, PUBLIC_DENIAL_RESPONSE);
    assert.equal(
      bunnyStream.signCount,
      signedDuringWarmup,
      "the cache-hit denial must not have minted a credential",
    );
  });

  it("gives a valid cache hit a NEWLY signed URL, after its own consumption", async () => {
    const bunnyStream = createSigningSpy();
    const { service } = createCompatHarness({
      videos: [bunnyStreamVideo()],
      memoryCache: true,
      bunnyStream,
    });

    const first = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });
    const second = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(first.valid, true);
    assert.equal(second.valid, true);
    assert.equal(
      bunnyStream.signCount,
      2,
      "each successful consumption mints its own URL - never a replayed one",
    );
    assert.match(
      String(second.videos[0]?.embedUrl),
      /token=[a-f0-9]{64}&expires=\d+$/,
    );
  });

  it("does not consume a view for any denial path, and signs nothing", async () => {
    for (const overrides of [
      { shareLink: { status: ShareLinkStatus.REVOKED } },
      { shareLink: { expiresAt: new Date("2020-01-01T00:00:00.000Z") } },
      { shareLink: { maxViews: 1, currentViews: 1 } },
    ]) {
      const bunnyStream = createSigningSpy();
      const { service, prisma } = createCompatHarness({
        videos: [bunnyStreamVideo()],
        bunnyStream,
        ...overrides,
      });

      const before = prisma.shareLinks[0]?.currentViews ?? 0;
      const response = await service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
      });

      assert.equal(response.valid, false);
      assert.equal(bunnyStream.signCount, 0);
      assert.equal(
        prisma.shareLinks[0]?.currentViews,
        before,
        "existing view-count semantics must be unchanged",
      );
    }
  });
});

/* ------------------------------------------------------------------ *
 * BLOCKER 2 — the Bunny EMBED shape fails closed
 * ------------------------------------------------------------------ */

describe("A Bunny EMBED record never falls back to unsigned playback", () => {
  it("serves a fully marked Bunny EMBED through a dynamically signed URL", async () => {
    const bunnyStream = createSigningSpy();
    const { service } = createCompatHarness({
      videos: [bunnyStreamVideo()],
      bunnyStream,
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });
    const embedUrl = String(response.videos[0]?.embedUrl);

    assert.equal(response.valid, true);
    assert.notEqual(embedUrl, BUNNY_UNSIGNED_EMBED_URL);
    assert.equal(new URL(embedUrl).searchParams.get("token")?.length, 64);
  });

  for (const malformed of [
    {
      name: "no metadata marker at all",
      video: bunnyStreamVideo({ metadataJson: null }),
    },
    {
      name: "a metadata marker for a different video",
      video: bunnyStreamVideo({
        metadataJson: { bunnyStream: { videoId: "some-other-guid" } },
      }),
    },
    {
      name: "a providerAssetId that does not match the marker",
      video: bunnyStreamVideo({ providerAssetId: "mismatched-guid" }),
    },
    {
      name: "a playbackId that does not match providerAssetId",
      video: bunnyStreamVideo({ playbackId: "mismatched-guid" }),
    },
    {
      name: "a null playbackId",
      video: bunnyStreamVideo({ playbackId: null }),
    },
    {
      name: "a null providerAssetId",
      video: bunnyStreamVideo({ providerAssetId: null }),
    },
  ]) {
    it(`refuses a Bunny EMBED with ${malformed.name}`, async () => {
      const bunnyStream = createSigningSpy();
      const { service } = createCompatHarness({
        videos: [malformed.video],
        bunnyStream,
      });

      const response = await service.resolvePublicWatch({
        host: LEGACY_HOST,
        token: LEGACY_ALIAS,
      });

      // Not publicly playable, so the whole link resolves to NO_VIDEOS.
      assert.deepEqual(response, PUBLIC_DENIAL_RESPONSE);
      assert.equal(bunnyStream.signCount, 0);
      // The stored unsigned Bunny URL must appear nowhere in the response.
      assert.equal(
        JSON.stringify(response).includes("mediadelivery"),
        false,
        "a malformed Bunny EMBED must never emit its stored unsigned URL",
      );
    });
  }

  it("classifies each shape exactly once, with no generic-embed fallback", () => {
    assert.equal(classifyBunnyVideoAsset(bunnyStreamVideo()).kind, "bunny");
    assert.equal(
      classifyBunnyVideoAsset(bunnyStreamVideo({ metadataJson: null })).kind,
      "bunny-malformed",
    );
    assert.equal(
      classifyBunnyVideoAsset(bunnyStreamVideo({ playbackId: null })).kind,
      "bunny-malformed",
    );
    // Legacy label on a DIRECT_URL record: explicitly NOT malformed.
    assert.equal(
      classifyBunnyVideoAsset(legacyLabelledBunnyVideo()).kind,
      "not-bunny",
    );
    assert.equal(classifyBunnyVideoAsset(embedVideo()).kind, "not-bunny");
  });

  it("leaves an ordinary GENERIC_IFRAME embed on the generic path", async () => {
    const fixture = embedVideo({
      provider: VideoProvider.MANUAL,
      embedProvider: EmbedProvider.GENERIC_IFRAME,
      embedUrl: "https://player.vimeo.com/video/000000009",
    });
    const bunnyStream = createSigningSpy();
    const { service } = createCompatHarness({
      videos: [fixture],
      bunnyStream,
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.valid, true);
    assert.equal(response.videos[0]?.embedUrl, fixture.embedUrl);
    assert.equal(bunnyStream.signCount, 0);
  });

  it("leaves a legacy provider:BUNNY DIRECT_URL record entirely unchanged", async () => {
    const fixture = legacyLabelledBunnyVideo();
    const bunnyStream = createSigningSpy();
    const { service } = createCompatHarness({
      videos: [fixture],
      bunnyStream,
    });

    const response = await service.resolvePublicWatch({
      host: LEGACY_HOST,
      token: LEGACY_ALIAS,
    });

    assert.equal(response.valid, true);
    assert.equal(response.videos[0]?.playbackUrl, fixture.playbackUrl);
    assert.equal(response.videos[0]?.embedUrl, null);
    assert.equal(bunnyStream.signCount, 0);
  });
});

/* ------------------------------------------------------------------ *
 * BLOCKER 3 — the enabled gate blocks every Bunny network operation
 * ------------------------------------------------------------------ */

describe("Bunny disabled blocks every network operation", () => {
  const disabled = { BUNNY_STREAM_ENABLED: "false" };

  it("makes no network request for createVideo", async () => {
    const calls = stubFetch({ json: { guid: VIDEO_GUID } });

    await assert.rejects(() => createService(disabled).createVideo("t"));
    assert.equal(calls.length, 0);
  });

  it("makes no network request for getVideo", async () => {
    const calls = stubFetch({ json: { guid: VIDEO_GUID } });

    await assert.rejects(() => createService(disabled).getVideo(VIDEO_GUID));
    assert.equal(calls.length, 0);
  });

  it("makes no network request for deleteVideo", async () => {
    const calls = stubFetch({ status: 200, json: {} });

    await assert.rejects(() => createService(disabled).deleteVideo(VIDEO_GUID));
    assert.equal(
      calls.length,
      0,
      "a disabled deployment must not reach Bunny even with credentials present",
    );
  });

  it("blocks the network even when full credentials are still configured", async () => {
    const calls = stubFetch({ status: 200, json: {} });
    const service = createService({
      BUNNY_STREAM_ENABLED: "false",
      BUNNY_STREAM_LIBRARY_ID: LIBRARY_ID,
      BUNNY_STREAM_API_KEY: API_KEY,
      BUNNY_STREAM_TOKEN_SECURITY_KEY: TOKEN_SECURITY_KEY,
    });

    await assert.rejects(() => service.deleteVideo(VIDEO_GUID));
    assert.equal(calls.length, 0);
  });

  it("reports canSignEmbedUrl false while disabled, and mints nothing", () => {
    const service = createService(disabled);

    assert.equal(service.canSignEmbedUrl(), false);
    assert.equal(service.isEnabled(), false);
  });

  it("requires the library id and token security key for canSignEmbedUrl", () => {
    assert.equal(
      createService({ BUNNY_STREAM_LIBRARY_ID: undefined }).canSignEmbedUrl(),
      false,
    );
    assert.equal(
      createService({
        BUNNY_STREAM_TOKEN_SECURITY_KEY: undefined,
      }).canSignEmbedUrl(),
      false,
    );
    assert.equal(createService().canSignEmbedUrl(), true);
  });
});

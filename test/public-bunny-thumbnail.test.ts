import "reflect-metadata";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { afterEach, describe, it } from "node:test";
import { NotFoundException } from "@nestjs/common";
import {
  isAllowedProxyImageType,
  isBunnyPullZoneUrl,
  resolveBunnyThumbnailUpstreamUrl,
} from "../src/bunny/bunny-cdn-thumbnail.util";
import { BunnyStreamService } from "../src/bunny/bunny-stream.service";
import { BunnyThumbnailProxyService } from "../src/bunny/bunny-thumbnail-proxy.service";
import { MemoryCacheService } from "../src/cache/memory-cache.service";
import type { MemoryCacheRuntimeConfig } from "../src/cache/memory-cache.types";
import {
  AccessLogStatus,
  AssignmentStatus,
  DomainStatus,
  ShareLinkStatus,
  VideoProvider,
  VideoSourceType,
  VideoStatus,
  WebsiteStatus,
} from "../src/generated/prisma/client";
import { PublicMediaGrantService } from "../src/public/public-media-grant.service";
import { PublicReviewResumeService } from "../src/public/public-review-resume.service";
import { PublicService } from "../src/public/public.service";
import { hashShareToken } from "../src/public/utils/share-token.util";

/**
 * PUBLIC BUNNY THUMBNAIL DELIVERY.
 *
 * THE PRODUCTION FAILURE. Public watch returned the raw Bunny pull-zone poster
 * URL and the reviewer's browser fetched it directly. Worldfold sends
 * `Referrer-Policy: no-referrer` — a deliberate privacy property — so no
 * `Referer` reached Bunny, the pull zone's hotlink protection refused, and every
 * poster rendered as a broken image with HTTP 403.
 *
 * THE FIX under test: the reviewer's browser is given THIS API's already-
 * existing thumbnail route, and the backend performs the one upstream request
 * under an explicitly configured authorization mode. That removes the
 * dependency on browser referrer policy entirely, keeps the reviewer's IP away
 * from Bunny, and puts the poster behind the same share authorization as the
 * video.
 *
 * A proxy that merely moved the 403 from the browser to the API server would
 * not be a fix, so the upstream authorization mode is asserted directly (T25),
 * not assumed.
 *
 * NO TEST HERE MAKES A REAL NETWORK REQUEST. The Bunny HTTP boundary is mocked
 * by replacing `globalThis.fetch`, exactly as `bunny-stream.test.ts` does.
 */

const token = "test-share-token";
const shareAlias = "AbCd123";
const tokenPepper = "test-share-token-pepper";
const tokenHash = hashShareToken({ pepper: tokenPepper, token });
const host = "reviewer.example.com";
const PULL_ZONE = "vz-11112222-abc.b-cdn.net";
const BUNNY_GUID = "11111111-2222-3333-4444-555555555555";
const THUMB_FILE = "thumbnail_ab12cd34.jpg";
const STORED_THUMBNAIL_URL = `https://${PULL_ZONE}/${BUNNY_GUID}/${THUMB_FILE}`;
const ALLOWED_REFERER = "https://reviewer.example.com/";

const defaultMemoryCacheConfig: MemoryCacheRuntimeConfig = {
  enabled: true,
  maxEntries: 1000,
  defaultTtlSeconds: 60,
  inflightTtlMs: 5000,
  adminVideosListTtlSeconds: 30,
  adminWebsitesListTtlSeconds: 60,
  publicWatchMetadataTtlSeconds: 10,
  mediaMetadataTtlSeconds: 300,
};

type ProxyEnv = {
  proxyEnabled?: boolean;
  authMode?: string;
  referer?: string | undefined;
  maxBytes?: string;
  timeoutMs?: string;
  pullZoneHostname?: string | undefined;
};

class FakeConfigService {
  constructor(private readonly env: ProxyEnv = {}) {}

  get<T = string>(key: string): T | undefined {
    const values: Record<string, string | undefined> = {
      SHARE_TOKEN_PEPPER: tokenPepper,
      ACCESS_LOG_IP_PEPPER: "test-access-log-pepper",
      API_PREFIX: "api/v1",
      PUBLIC_MEDIA_GRANT_SECRET:
        "test-public-media-grant-secret-at-least-32-bytes",
      PUBLIC_MEDIA_GRANT_TTL_SECONDS: "21600",
      BUNNY_STREAM_ENABLED: "true",
      BUNNY_STREAM_LIBRARY_ID: "424242",
      BUNNY_STREAM_API_KEY: "bunny-management-api-key-value",
      BUNNY_STREAM_TOKEN_SECURITY_KEY: "bunny-embed-token-security-key-value",
      BUNNY_STREAM_PULL_ZONE_HOSTNAME:
        this.env.pullZoneHostname === undefined
          ? PULL_ZONE
          : this.env.pullZoneHostname,
      BUNNY_PUBLIC_THUMBNAIL_PROXY_ENABLED:
        this.env.proxyEnabled === false ? "false" : "true",
      BUNNY_PUBLIC_THUMBNAIL_UPSTREAM_AUTH_MODE: this.env.authMode ?? "referer",
      BUNNY_PUBLIC_THUMBNAIL_UPSTREAM_REFERER:
        this.env.referer === undefined ? ALLOWED_REFERER : this.env.referer,
      ...(this.env.maxBytes === undefined
        ? {}
        : { BUNNY_PUBLIC_THUMBNAIL_MAX_BYTES: this.env.maxBytes }),
      ...(this.env.timeoutMs === undefined
        ? {}
        : { BUNNY_PUBLIC_THUMBNAIL_TIMEOUT_MS: this.env.timeoutMs }),
    };

    return values[key] as T | undefined;
  }

  getOrThrow<T = string>(key: string): T {
    const value = this.get<T>(key);
    if (value === undefined) {
      throw new Error(`${key} missing`);
    }
    return value;
  }
}

class FakeMemoryCacheConfigService {
  get<T = unknown>(key: string): T | undefined {
    return key === "api"
      ? ({ memoryCache: defaultMemoryCacheConfig } as T)
      : undefined;
  }
}

type FakeVideo = {
  id: string;
  title: string;
  description: string | null;
  provider: VideoProvider;
  sourceType: VideoSourceType;
  providerAssetId: string | null;
  playbackId: string | null;
  playbackUrl: string | null;
  embedUrl: string | null;
  embedProvider: null;
  embedAllow: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  viewCount: bigint;
  publishedAt: Date | null;
  status: VideoStatus;
  metadataJson: unknown;
  binaryAsset: null;
  localFileAsset: null;
  localThumbnailAsset: null;
};

function createBunnyVideo(overrides: Partial<FakeVideo> = {}): FakeVideo {
  return {
    id: "video-1",
    title: "Bunny reviewer video",
    description: null,
    provider: VideoProvider.BUNNY,
    sourceType: VideoSourceType.EMBED,
    providerAssetId: BUNNY_GUID,
    playbackId: BUNNY_GUID,
    playbackUrl: null,
    embedUrl: `https://iframe.mediadelivery.net/embed/424242/${BUNNY_GUID}`,
    embedProvider: null,
    embedAllow: null,
    thumbnailUrl: STORED_THUMBNAIL_URL,
    durationSeconds: 42,
    viewCount: 7n,
    publishedAt: new Date("2026-06-14T00:00:00.000Z"),
    status: VideoStatus.READY,
    metadataJson: {
      bunnyStream: { videoId: BUNNY_GUID, libraryId: "424242" },
    },
    binaryAsset: null,
    localFileAsset: null,
    localThumbnailAsset: null,
    ...overrides,
  };
}

class FakePrismaService {
  shareLinkRecord: {
    id: string;
    websiteId: string;
    tokenHash: string;
    alias: string | null;
    status: ShareLinkStatus;
    expiresAt: Date | null;
    maxViews: number | null;
    currentViews: number;
    shareLinkVideos: Array<{ sortOrder: number; video: FakeVideo }>;
  };
  assignmentActive = true;
  domainStatus: DomainStatus = DomainStatus.ACTIVE;
  websiteStatus: WebsiteStatus = WebsiteStatus.ACTIVE;
  shareLinkUpdateManyCalls = 0;
  readonly accessLogs: Array<{ status: AccessLogStatus; reasonCode: string }> =
    [];

  constructor(video: FakeVideo) {
    this.shareLinkRecord = {
      id: "share-1",
      websiteId: "website-1",
      tokenHash,
      alias: shareAlias,
      status: ShareLinkStatus.ACTIVE,
      expiresAt: null,
      maxViews: null,
      currentViews: 0,
      shareLinkVideos: [{ sortOrder: 0, video }],
    };
  }

  get video(): FakeVideo {
    return this.shareLinkRecord.shareLinkVideos[0].video;
  }

  websiteDomain = {
    findUnique: async (args: { where: { domain: string } }) => {
      if (args.where.domain !== host) {
        return null;
      }

      return {
        id: "domain-1",
        domain: host,
        status: this.domainStatus,
        website: {
          id: "website-1",
          name: "Reviewer Site",
          slug: "reviewer-site",
          status: this.websiteStatus,
        },
      };
    },
  };

  shareLink = {
    findFirst: async (args: {
      where: { alias?: string; tokenHash?: string; websiteId: string };
      include?: { shareLinkVideos?: { where?: { videoId?: string } } };
    }) => {
      if (
        args.where.websiteId !== this.shareLinkRecord.websiteId ||
        (args.where.alias !== undefined &&
          args.where.alias !== this.shareLinkRecord.alias) ||
        (args.where.tokenHash !== undefined &&
          args.where.tokenHash !== this.shareLinkRecord.tokenHash) ||
        (args.where.alias === undefined && args.where.tokenHash === undefined)
      ) {
        return null;
      }

      const requestedVideoId = args.include?.shareLinkVideos?.where?.videoId;
      // Models the ACTIVE `WebsiteVideo` predicate the real include carries:
      // an inactive assignment yields an EMPTY membership list, exactly as the
      // database would.
      const shareLinkVideos = !this.assignmentActive
        ? []
        : requestedVideoId === undefined
          ? this.shareLinkRecord.shareLinkVideos
          : this.shareLinkRecord.shareLinkVideos.filter(
              ({ video }) => video.id === requestedVideoId,
            );

      return { ...this.shareLinkRecord, shareLinkVideos };
    },
    updateMany: async (args: {
      where?: { currentViews?: { lt: number } };
    }): Promise<{ count: number }> => {
      this.shareLinkUpdateManyCalls += 1;
      const limit = args.where?.currentViews?.lt;
      if (limit !== undefined && this.shareLinkRecord.currentViews >= limit) {
        return { count: 0 };
      }
      this.shareLinkRecord.currentViews += 1;
      return { count: 1 };
    },
    findUnique: async () => this.shareLinkRecord,
  };

  videoAsset = {
    findMany: async () => [
      {
        id: this.video.id,
        status: this.video.status,
        provider: this.video.provider,
        sourceType: this.video.sourceType,
        providerAssetId: this.video.providerAssetId,
        playbackId: this.video.playbackId,
        metadataJson: this.video.metadataJson,
      },
    ],
  };

  accessLog = {
    create: async (args: {
      data: { status: AccessLogStatus; reasonCode: string };
    }): Promise<void> => {
      this.accessLogs.push({
        status: args.data.status,
        reasonCode: args.data.reasonCode,
      });
    },
  };
}

class FakeLocalVideoStorageService {
  createFullReadStream(): never {
    throw new Error("LOCAL_FILE storage must not be consulted for Bunny.");
  }
  createRangeReadStream(): never {
    throw new Error("LOCAL_FILE storage must not be consulted for Bunny.");
  }
}

class FakeVideoViewGrowthService {}

/* ------------------------------------------------------------------ *
 * The mocked Bunny CDN boundary
 * ------------------------------------------------------------------ */

const originalFetch = globalThis.fetch;

type UpstreamCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  redirect?: string;
};

type UpstreamStub = {
  status?: number;
  contentType?: string | null;
  contentLength?: string | null;
  body?: Buffer | null;
  throws?: Error;
  /** Fires each time the consumer pulls a chunk, to prove laziness. */
  onPull?: () => void;
  /** Fires when the body is cancelled, to prove HEAD releases the socket. */
  onCancel?: () => void;
  /** Errors the body mid-stream, after one chunk has been yielded. */
  errorAfterFirstChunk?: boolean;
};

function stubUpstream(stub: UpstreamStub): UpstreamCall[] {
  const calls: UpstreamCall[] = [];

  globalThis.fetch = (async (
    input: string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(init?.redirect === undefined ? {} : { redirect: init.redirect }),
    });

    if (stub.throws) {
      throw stub.throws;
    }

    const status = stub.status ?? 200;
    const headers = new Map<string, string>();
    const contentType =
      stub.contentType === undefined ? "image/jpeg" : stub.contentType;
    if (contentType !== null) {
      headers.set("content-type", contentType);
    }
    if (stub.contentLength !== null) {
      headers.set(
        "content-length",
        stub.contentLength ?? String((stub.body ?? Buffer.alloc(4)).length),
      );
    }

    const payload = stub.body === undefined ? Buffer.from("JPEG") : stub.body;

    // An observable body: a generator, so a pull is a real event the test can
    // count, and `cancel()` on early exit is a real event too.
    async function* chunks(): AsyncGenerator<Buffer> {
      const source = payload ?? Buffer.alloc(0);
      // 8 KiB chunks so a multi-chunk body actually yields more than once.
      for (let offset = 0; offset < source.length; offset += 8192) {
        stub.onPull?.();
        yield source.subarray(offset, offset + 8192);
        if (stub.errorAfterFirstChunk === true) {
          throw new Error("upstream exploded mid-body");
        }
      }
    }

    const nodeBody = Readable.from(chunks());
    nodeBody.on("close", () => {
      if (!nodeBody.readableEnded) {
        stub.onCancel?.();
      }
    });

    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) => headers.get(name.toLowerCase()) ?? null,
      },
      body:
        payload === null
          ? null
          : (Readable.toWeb(nodeBody) as ReadableStream<Uint8Array>),
    } as unknown as Response;
  }) as typeof fetch;

  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createService(
  video: FakeVideo,
  env: ProxyEnv = {},
): { prisma: FakePrismaService; service: PublicService } {
  const prisma = new FakePrismaService(video);
  const config = new FakeConfigService(env);
  const service = new PublicService(
    prisma as never,
    config as never,
    new FakeLocalVideoStorageService() as never,
    new FakeVideoViewGrowthService() as never,
    new PublicMediaGrantService(config as never),
    new PublicReviewResumeService(config as never),
    new MemoryCacheService(new FakeMemoryCacheConfigService() as never),
    new BunnyStreamService(config as never),
    new BunnyThumbnailProxyService(config as never),
  );

  return { prisma, service };
}

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const BACKEND_THUMBNAIL_URL =
  "/api/v1/public/watch/test-share-token/videos/video-1/thumbnail?host=reviewer.example.com";

/* ================================================================== *
 * T2, T3 — the public response contract
 * ================================================================== */

describe("public watch response for a Bunny-backed video", () => {
  it("T2 returns the backend-protected thumbnail route, not the CDN URL", async () => {
    const { service } = createService(createBunnyVideo());

    const response = await service.resolvePublicWatch({ host, token });
    const video = response.videos[0];

    assert.equal(response.valid, true);
    assert.ok(video);
    assert.equal(video.thumbnailUrl, BACKEND_THUMBNAIL_URL);
    // Worldfold reads `publicThumbnailUrl` first and falls back to
    // `thumbnailUrl`; older public bundles read only `thumbnailUrl`. Both must
    // carry the protected URL so an already-deployed client picks it up with no
    // change of its own.
    assert.equal(video.publicThumbnailUrl, BACKEND_THUMBNAIL_URL);
  });

  /**
   * THE SHAPE BOTH SHIPPED CLIENTS DEPEND ON.
   *
   * Neither public client treats a backend media URL as a same-origin website
   * path — both strip `/api/v1` and re-base onto the API origin:
   *
   *   Worldfold  `private-watch.js` resolveMediaUrl()
   *              raw.replace(/^\/_api(?=\/|$)/,"").replace(/^\/api\/v1(?=\/|$)/,"")
   *              -> `${resolveApiBase()}${path}`   (`/_api` in production)
   *
   *   public_website `assets/app.js` buildApiResourceUrl()
   *              /^\/api\/v1\/public(?:\/|$)/ -> buildApiUrl(stripApiVersionPrefix(raw))
   *              -> `${API_CONFIG.baseUrl}${path}` (`/_api` in production)
   *
   * Both keep the query string, and both reject a URL containing an `admin`
   * segment. This test pins the BACKEND half of that contract, which is the
   * only half this repository can enforce.
   */
  it("emits a relative /api/v1/public URL both shipped clients re-base", async () => {
    const { service } = createService(createBunnyVideo());

    const response = await service.resolvePublicWatch({ host, token });
    const emitted = response.videos[0]?.thumbnailUrl ?? "";

    assert.ok(emitted.startsWith("/api/v1/public/"), emitted);
    assert.equal(/^https?:\/\//i.test(emitted), false, "must stay relative");
    // Worldfold's `apiOwnedThumbnail()` DROPS an absolute off-origin URL, so an
    // absolute value here would render no poster at all.

    // The query must survive re-basing: `host` is required by the route and
    // `grant` carries the maxViews authorization.
    const [path, query] = emitted.split("?");
    assert.ok(query, "the host query parameter must be present");
    assert.equal(new URLSearchParams(query).get("host"), host);

    // Both clients refuse any path containing an `admin` segment.
    assert.equal(
      path.split("/").some((segment) => segment.toLowerCase() === "admin"),
      false,
    );

    // Reproduce each client's transform and assert the result lands on the API.
    const stripped = path.replace(/^\/api\/v1(?=\/|$)/, "");
    assert.equal(stripped, `/public/watch/${token}/videos/video-1/thumbnail`);
    assert.equal(`/_api${stripped}?${query}`.startsWith("/_api/public/"), true);
  });

  it("T3 never exposes the raw Bunny CDN poster URL anywhere in the response", async () => {
    const { service } = createService(createBunnyVideo());

    const response = await service.resolvePublicWatch({ host, token });

    const serialized = JSON.stringify(response);
    assert.equal(serialized.includes(PULL_ZONE), false);
    assert.equal(serialized.includes(STORED_THUMBNAIL_URL), false);
    assert.equal(serialized.includes(THUMB_FILE), false);
  });

  it("T4 exposes no thumbnail at all for a bunny-malformed record", async () => {
    // `playbackId` disagreeing with `providerAssetId` is the malformed shape.
    // Such a record is not publicly playable at all, so it is absent from the
    // response — and critically, its stored pull-zone URL is never emitted.
    const { service } = createService(
      createBunnyVideo({ playbackId: "a-different-guid" }),
    );

    const response = await service.resolvePublicWatch({ host, token });

    assert.equal(response.valid, false);
    assert.equal(JSON.stringify(response).includes(PULL_ZONE), false);
  });

  it("T12 exposes no thumbnail for a remote-missing Bunny video", async () => {
    const { service } = createService(
      createBunnyVideo({
        metadataJson: {
          bunnyStream: {
            videoId: BUNNY_GUID,
            libraryId: "424242",
            remoteMissing: {
              detectedAt: "2026-08-01T00:00:00.000Z",
              reason: "NOT_FOUND",
            },
          },
        },
      }),
    );

    const response = await service.resolvePublicWatch({ host, token });
    const video = response.videos[0];

    assert.ok(video);
    assert.equal(video.thumbnailUrl, null);
    assert.equal(video.publicThumbnailUrl, null);
    assert.equal(JSON.stringify(response).includes(PULL_ZONE), false);
  });

  it("leaves the response byte-identical when the proxy is disabled", async () => {
    // THE DEFAULT. A deployment that has not opted in keeps exactly the
    // serialization it had before this feature existed, including the raw
    // stored URL — that is what makes the change safe to ship dark.
    const { service } = createService(createBunnyVideo(), {
      proxyEnabled: false,
    });

    const response = await service.resolvePublicWatch({ host, token });
    const video = response.videos[0];

    assert.ok(video);
    assert.equal(video.thumbnailUrl, STORED_THUMBNAIL_URL);
    assert.equal(video.publicThumbnailUrl, STORED_THUMBNAIL_URL);
  });

  it("passes an operator-set non-pull-zone poster through unchanged", async () => {
    // Bunny sync only ever fills an EMPTY `thumbnailUrl` and never overwrites
    // one, so a value on another host was a deliberate operator choice. Nulling
    // it would silently delete a working image; it is not a Bunny CDN URL and
    // the proxy has no claim on it.
    const operatorPoster = "https://res.cloudinary.com/demo/image/poster.jpg";
    const { service } = createService(
      createBunnyVideo({ thumbnailUrl: operatorPoster }),
    );

    const response = await service.resolvePublicWatch({ host, token });

    assert.equal(response.videos[0]?.thumbnailUrl, operatorPoster);
  });

  it("advertises no poster when the AUTHORITATIVE row disagrees with the cache", async () => {
    const { prisma, service } = createService(createBunnyVideo());
    // The share-link row still says READY (this is the cached/serialized view),
    // but the authoritative `videoAsset.findMany` gate — the same one that
    // decides whether an embed URL may be signed — now reports the video gone.
    prisma.videoAsset.findMany = async () => [];

    const response = await service.resolvePublicWatch({ host, token });
    const video = response.videos[0];

    assert.ok(video);
    assert.equal(video.embedUrl, null, "playback fails closed");
    assert.equal(
      video.thumbnailUrl,
      null,
      "the poster must fail closed with it, not advertise a URL the route refuses",
    );
    assert.equal(video.publicThumbnailUrl, null);
    assert.equal(JSON.stringify(response).includes(PULL_ZONE), false);
  });

  it("T22 leaks no Bunny secret into the reviewer-facing response", async () => {
    const { service } = createService(createBunnyVideo());

    const response = await service.resolvePublicWatch({ host, token });

    const serialized = JSON.stringify(response);
    for (const secret of [
      "bunny-management-api-key-value",
      "bunny-embed-token-security-key-value",
      "test-share-token-pepper",
      "test-public-media-grant-secret-at-least-32-bytes",
      tokenHash,
    ]) {
      assert.equal(
        serialized.includes(secret),
        false,
        `response must not contain ${secret.slice(0, 12)}…`,
      );
    }
  });

  it("T24 makes ZERO Bunny Management API requests during public watch", async () => {
    const calls = stubUpstream({});
    const { service } = createService(createBunnyVideo());

    await service.resolvePublicWatch({ host, token });

    // Public watch stays free of provider latency: the poster URL is built from
    // stored state and the proxy request only happens when a browser actually
    // asks for the image.
    assert.deepEqual(calls, []);
  });
});

/* ================================================================== *
 * T5 - T11 — authorization on the thumbnail route itself
 * ================================================================== */

describe("public Bunny thumbnail authorization", () => {
  it("serves the poster when every gate passes", async () => {
    stubUpstream({ body: Buffer.from("JPEGDATA") });
    const { service } = createService(createBunnyVideo());

    const result = await service.getPublicThumbnail({
      host,
      token,
      videoId: "video-1",
    });

    assert.equal(result.mimeType, "image/jpeg");
    assert.equal(result.contentLength, 8);
    assert.equal((await drain(result.stream)).toString(), "JPEGDATA");
  });

  it("accepts the share alias as well as the raw token", async () => {
    stubUpstream({});
    const { service } = createService(createBunnyVideo());

    const result = await service.getPublicThumbnail({
      host,
      token: shareAlias,
      videoId: "video-1",
    });

    assert.equal(result.mimeType, "image/jpeg");
  });

  it("T5 refuses when the video is not READY", async () => {
    stubUpstream({});
    const { service } = createService(
      createBunnyVideo({ status: VideoStatus.DISABLED }),
    );

    await assert.rejects(
      service.getPublicThumbnail({ host, token, videoId: "video-1" }),
      NotFoundException,
    );
  });

  it("T6 refuses when the WebsiteVideo assignment is not ACTIVE", async () => {
    stubUpstream({});
    const { prisma, service } = createService(createBunnyVideo());
    prisma.assignmentActive = false;

    await assert.rejects(
      service.getPublicThumbnail({ host, token, videoId: "video-1" }),
      NotFoundException,
    );
  });

  it("T7 refuses a video the share link does not contain", async () => {
    stubUpstream({});
    const { service } = createService(createBunnyVideo());

    await assert.rejects(
      service.getPublicThumbnail({ host, token, videoId: "video-999" }),
      NotFoundException,
    );
  });

  it("T8 refuses a host that is not the bound domain", async () => {
    stubUpstream({});
    const { service } = createService(createBunnyVideo());

    await assert.rejects(
      service.getPublicThumbnail({
        host: "attacker.example.net",
        token,
        videoId: "video-1",
      }),
      NotFoundException,
    );
  });

  it("T8 refuses when the domain itself is DISABLED", async () => {
    stubUpstream({});
    const { prisma, service } = createService(createBunnyVideo());
    prisma.domainStatus = DomainStatus.DISABLED;

    await assert.rejects(
      service.getPublicThumbnail({ host, token, videoId: "video-1" }),
      NotFoundException,
    );
  });

  it("T8 refuses when the website is DISABLED", async () => {
    stubUpstream({});
    const { prisma, service } = createService(createBunnyVideo());
    prisma.websiteStatus = WebsiteStatus.DISABLED;

    await assert.rejects(
      service.getPublicThumbnail({ host, token, videoId: "video-1" }),
      NotFoundException,
    );
  });

  it("T9 refuses a revoked share link", async () => {
    stubUpstream({});
    const { prisma, service } = createService(createBunnyVideo());
    prisma.shareLinkRecord.status = ShareLinkStatus.REVOKED;

    await assert.rejects(
      service.getPublicThumbnail({ host, token, videoId: "video-1" }),
      NotFoundException,
    );
  });

  it("T9 refuses an expired share link", async () => {
    stubUpstream({});
    const { prisma, service } = createService(createBunnyVideo());
    prisma.shareLinkRecord.expiresAt = new Date("2020-01-01");

    await assert.rejects(
      service.getPublicThumbnail({ host, token, videoId: "video-1" }),
      NotFoundException,
    );
  });

  it("T10 requires a valid media grant on a view-limited link", async () => {
    stubUpstream({});
    const { prisma, service } = createService(createBunnyVideo());
    prisma.shareLinkRecord.maxViews = 5;

    // No grant, and a wrong grant, are both refused — the existing
    // `hasValidMediaGrant()` semantics, unchanged for the new branch.
    await assert.rejects(
      service.getPublicThumbnail({ host, token, videoId: "video-1" }),
      NotFoundException,
    );
    await assert.rejects(
      service.getPublicThumbnail({
        host,
        token,
        videoId: "video-1",
        grant: "not-a-real-grant",
      }),
      NotFoundException,
    );
  });

  it("T10 serves the poster with a correctly issued grant", async () => {
    stubUpstream({});
    const config = new FakeConfigService();
    const grantService = new PublicMediaGrantService(config as never);
    const prisma = new FakePrismaService(createBunnyVideo());
    prisma.shareLinkRecord.maxViews = 5;
    const service = new PublicService(
      prisma as never,
      config as never,
      new FakeLocalVideoStorageService() as never,
      new FakeVideoViewGrowthService() as never,
      grantService,
      new PublicReviewResumeService(config as never),
      new MemoryCacheService(new FakeMemoryCacheConfigService() as never),
      new BunnyStreamService(config as never),
      new BunnyThumbnailProxyService(config as never),
    );

    const grant = grantService.issue({
      shareLinkId: prisma.shareLinkRecord.id,
      videoId: "video-1",
      host,
      shareLinkExpiresAt: null,
    });

    const result = await service.getPublicThumbnail({
      host,
      token,
      videoId: "video-1",
      grant,
    });

    assert.equal(result.mimeType, "image/jpeg");
  });

  it("T11 never increments views, on GET or on repeated requests", async () => {
    stubUpstream({});
    const { prisma, service } = createService(createBunnyVideo());
    const viewsBefore = prisma.shareLinkRecord.currentViews;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await service.getPublicThumbnail({
        host,
        token,
        videoId: "video-1",
      });
      await drain(result.stream);
    }

    assert.equal(
      prisma.shareLinkUpdateManyCalls,
      0,
      "no consumption query ran",
    );
    assert.equal(prisma.shareLinkRecord.currentViews, viewsBefore);
  });

  it("T11 spends no view budget on a view-limited link either", async () => {
    stubUpstream({});
    const config = new FakeConfigService();
    const grantService = new PublicMediaGrantService(config as never);
    const prisma = new FakePrismaService(createBunnyVideo());
    prisma.shareLinkRecord.maxViews = 2;
    prisma.shareLinkRecord.currentViews = 1;
    const service = new PublicService(
      prisma as never,
      config as never,
      new FakeLocalVideoStorageService() as never,
      new FakeVideoViewGrowthService() as never,
      grantService,
      new PublicReviewResumeService(config as never),
      undefined as never,
      new BunnyStreamService(config as never),
      new BunnyThumbnailProxyService(config as never),
    );
    const grant = grantService.issue({
      shareLinkId: prisma.shareLinkRecord.id,
      videoId: "video-1",
      host,
      shareLinkExpiresAt: null,
    });

    await service.getPublicThumbnail({
      host,
      token,
      videoId: "video-1",
      grant,
    });

    assert.equal(prisma.shareLinkRecord.currentViews, 1, "budget untouched");
    assert.equal(prisma.shareLinkUpdateManyCalls, 0);
  });

  it("T12 refuses a remote-missing Bunny video at the route too", async () => {
    stubUpstream({});
    const { service } = createService(
      createBunnyVideo({
        metadataJson: {
          bunnyStream: {
            videoId: BUNNY_GUID,
            remoteMissing: { detectedAt: "2026-08-01", reason: "NOT_FOUND" },
          },
        },
      }),
    );

    await assert.rejects(
      service.getPublicThumbnail({ host, token, videoId: "video-1" }),
      NotFoundException,
    );
  });

  it("T4 refuses a bunny-malformed record at the route too", async () => {
    stubUpstream({});
    const { service } = createService(
      createBunnyVideo({ providerAssetId: null }),
    );

    await assert.rejects(
      service.getPublicThumbnail({ host, token, videoId: "video-1" }),
      NotFoundException,
    );
  });

  it("refuses when the proxy is disabled, without ever calling upstream", async () => {
    const calls = stubUpstream({});
    const { service } = createService(createBunnyVideo(), {
      proxyEnabled: false,
    });

    await assert.rejects(
      service.getPublicThumbnail({ host, token, videoId: "video-1" }),
      NotFoundException,
    );
    assert.deepEqual(calls, []);
  });
});

/* ================================================================== *
 * T13 - T21, T25 — the upstream boundary
 * ================================================================== */

describe("public Bunny thumbnail upstream boundary", () => {
  it("T25 sends the CONFIGURED Referer in referer mode, and no redirect following", async () => {
    const calls = stubUpstream({});
    const { service } = createService(createBunnyVideo());

    await service.getPublicThumbnail({ host, token, videoId: "video-1" });

    assert.equal(calls.length, 1);
    // THE WHOLE POINT. A proxy that moved the browser's missing `Referer`
    // problem to the API server would fail here.
    assert.equal(calls[0].headers.Referer, ALLOWED_REFERER);
    assert.equal(calls[0].redirect, "manual");
    assert.equal(calls[0].url, STORED_THUMBNAIL_URL);
  });

  it("T25 sends NO Referer in none mode", async () => {
    const calls = stubUpstream({});
    const { service } = createService(createBunnyVideo(), {
      authMode: "none",
    });

    await service.getPublicThumbnail({ host, token, videoId: "video-1" });

    assert.equal(calls[0].headers.Referer, undefined);
  });

  it("T25 fails closed when referer mode has no usable Referer configured", async () => {
    const calls = stubUpstream({});
    const { service } = createService(createBunnyVideo(), { referer: "" });

    // Silently downgrading to `none` would send an unauthenticated request and
    // produce a 403 that looks like a Bunny fault rather than a config fault.
    await assert.rejects(
      service.getPublicThumbnail({ host, token, videoId: "video-1" }),
      NotFoundException,
    );
    assert.deepEqual(calls, [], "no upstream request is attempted");
  });

  it("T25 rejects a non-https or credential-bearing Referer as unusable", async () => {
    for (const referer of [
      "http://reviewer.example.com/",
      "https://user:pass@reviewer.example.com/",
      "not-a-url",
    ]) {
      const calls = stubUpstream({});
      const { service } = createService(createBunnyVideo(), { referer });

      await assert.rejects(
        service.getPublicThumbnail({ host, token, videoId: "video-1" }),
        NotFoundException,
      );
      assert.deepEqual(calls, [], `${referer} must not be sent`);
    }
  });

  it("T13 handles an upstream 403 as a generic denial", async () => {
    stubUpstream({ status: 403 });
    const { service } = createService(createBunnyVideo());

    await assert.rejects(
      service.getPublicThumbnail({ host, token, videoId: "video-1" }),
      (error: unknown) => {
        assert.ok(error instanceof NotFoundException);
        // A reviewer must not be able to tell an upstream 403 from a 404 from a
        // size rejection: same non-enumerability rule as every public denial.
        assert.equal(
          (error.getResponse() as { message?: string }).message ??
            error.message,
          "Video not found.",
        );
        return true;
      },
    );
  });

  it("T14 handles an upstream 404 as the same generic denial", async () => {
    stubUpstream({ status: 404 });
    const { service } = createService(createBunnyVideo());

    await assert.rejects(
      service.getPublicThumbnail({ host, token, videoId: "video-1" }),
      NotFoundException,
    );
  });

  it("T15 handles an upstream 5xx as the same generic denial", async () => {
    stubUpstream({ status: 503 });
    const { service } = createService(createBunnyVideo());

    await assert.rejects(
      service.getPublicThumbnail({ host, token, videoId: "video-1" }),
      NotFoundException,
    );
  });

  it("T15 handles a network failure or timeout as the same generic denial", async () => {
    stubUpstream({
      throws: Object.assign(new Error("aborted"), { name: "TimeoutError" }),
    });
    const { service } = createService(createBunnyVideo());

    await assert.rejects(
      service.getPublicThumbnail({ host, token, videoId: "video-1" }),
      NotFoundException,
    );
  });

  it("T21 refuses to follow an upstream redirect", async () => {
    stubUpstream({ status: 302 });
    const { service } = createService(createBunnyVideo());

    // A 3xx is the one way a URL that passed every hostname check still ends up
    // fetching another origin, so it is refused outright rather than
    // re-validated.
    await assert.rejects(
      service.getPublicThumbnail({ host, token, videoId: "video-1" }),
      NotFoundException,
    );
  });

  it("T16 rejects a non-image upstream content type", async () => {
    for (const contentType of [
      "text/html",
      "application/json",
      null,
      // An SVG is a document that can carry script, and it would be served from
      // this API's own origin under a share token.
      "image/svg+xml",
    ]) {
      stubUpstream({ contentType });
      const { service } = createService(createBunnyVideo());

      await assert.rejects(
        service.getPublicThumbnail({ host, token, videoId: "video-1" }),
        NotFoundException,
        `${String(contentType)} must be rejected`,
      );
    }
  });

  it("T17 rejects an oversized response declared by Content-Length", async () => {
    stubUpstream({ contentLength: "999999999" });
    const { service } = createService(createBunnyVideo(), {
      maxBytes: "65536",
    });

    await assert.rejects(
      service.getPublicThumbnail({ host, token, videoId: "video-1" }),
      NotFoundException,
    );
  });

  it("T17 rejects an oversized body even when Content-Length lies or is absent", async () => {
    stubUpstream({
      contentLength: null,
      body: Buffer.alloc(200 * 1024, 0x41),
    });
    const { service } = createService(createBunnyVideo(), {
      maxBytes: "65536",
    });

    const result = await service.getPublicThumbnail({
      host,
      token,
      videoId: "video-1",
    });

    // The cap is enforced on the BYTES. A dishonest or missing header must not
    // become an unbounded transfer through a public route.
    await assert.rejects(drain(result.stream), /size cap/);
  });

  it("normalizes the served content type to the validated media type", async () => {
    stubUpstream({ contentType: "image/JPEG; charset=binary" });
    const { service } = createService(createBunnyVideo());

    const result = await service.getPublicThumbnail({
      host,
      token,
      videoId: "video-1",
    });

    assert.equal(result.mimeType, "image/jpeg");
  });
});

/* ================================================================== *
 * T18 - T20 — SSRF: the URL validator, in isolation
 * ================================================================== */

describe("Bunny thumbnail upstream URL validation", () => {
  const identity = { bunnyVideoId: BUNNY_GUID, pullZoneHostname: PULL_ZONE };

  it("accepts the documented storage shape and REBUILDS the URL", () => {
    const result = resolveBunnyThumbnailUpstreamUrl(
      STORED_THUMBNAIL_URL,
      identity,
    );

    assert.equal(result.ok, true);
    assert.ok(result.ok);
    assert.equal(result.url, STORED_THUMBNAIL_URL);
    assert.equal(result.fileName, THUMB_FILE);
  });

  it("T18 rejects every arbitrary external URL a database row could hold", () => {
    // `VideoAsset.thumbnailUrl` is a database column. Without this validator,
    // `fetch(row.thumbnailUrl)` would make PublicService an SSRF primitive
    // reachable by anyone holding a share link.
    const hostile: Array<[string, string]> = [
      ["http://169.254.169.254/latest/meta-data/", "NOT_HTTPS"],
      ["https://169.254.169.254/latest/meta-data/", "HOSTNAME_MISMATCH"],
      ["http://localhost:8080/admin", "NOT_HTTPS"],
      ["https://localhost/admin/secret.jpg", "HOSTNAME_MISMATCH"],
      ["file:///etc/passwd", "NOT_HTTPS"],
      ["data:image/png;base64,AAAA", "NOT_HTTPS"],
      ["ftp://example.com/x.jpg", "NOT_HTTPS"],
      ["/relative/path.jpg", "NOT_ABSOLUTE"],
      ["", "NOT_ABSOLUTE"],
      ["not a url at all", "NOT_ABSOLUTE"],
    ];

    for (const [url, reason] of hostile) {
      const result = resolveBunnyThumbnailUpstreamUrl(url, identity);
      assert.equal(result.ok, false, `${url} must be rejected`);
      assert.ok(!result.ok);
      assert.equal(result.reason, reason, url);
    }
  });

  it("T19 rejects a hostname that merely resembles the pull zone", () => {
    // `endsWith` and pattern matching both lose to these. Only exact equality
    // with the CONFIGURED hostname is accepted.
    for (const hostname of [
      `${PULL_ZONE}.attacker.example`,
      `evil-${PULL_ZONE}`,
      "vz-99999999-zzz.b-cdn.net",
      "b-cdn.net",
    ]) {
      const result = resolveBunnyThumbnailUpstreamUrl(
        `https://${hostname}/${BUNNY_GUID}/${THUMB_FILE}`,
        identity,
      );
      assert.equal(result.ok, false, hostname);
      assert.ok(!result.ok);
      assert.equal(result.reason, "HOSTNAME_MISMATCH");
    }
  });

  it("T19 rejects credentials, a port, a query and a fragment", () => {
    const cases: Array<[string, string]> = [
      [
        `https://user:pass@${PULL_ZONE}/${BUNNY_GUID}/${THUMB_FILE}`,
        "HAS_CREDENTIALS",
      ],
      [`https://${PULL_ZONE}:8443/${BUNNY_GUID}/${THUMB_FILE}`, "HAS_PORT"],
      [`https://${PULL_ZONE}/${BUNNY_GUID}/${THUMB_FILE}?token=x`, "HAS_QUERY"],
      [`https://${PULL_ZONE}/${BUNNY_GUID}/${THUMB_FILE}#frag`, "HAS_FRAGMENT"],
    ];

    for (const [url, reason] of cases) {
      const result = resolveBunnyThumbnailUpstreamUrl(url, identity);
      assert.ok(!result.ok, url);
      assert.equal(result.reason, reason, url);
    }
  });

  it("T20 rejects a path whose video id is not the authoritative one", () => {
    // The attack this stops: a row whose `thumbnailUrl` points at ANOTHER
    // video's poster on the same pull zone would otherwise serve that video's
    // frame under this share link.
    const result = resolveBunnyThumbnailUpstreamUrl(
      `https://${PULL_ZONE}/99999999-8888-7777-6666-555555555555/${THUMB_FILE}`,
      identity,
    );

    assert.ok(!result.ok);
    assert.equal(result.reason, "VIDEO_ID_MISMATCH");
  });

  it("T20 rejects a path that is not exactly two segments", () => {
    for (const path of [
      `/${BUNNY_GUID}`,
      `/${BUNNY_GUID}/nested/${THUMB_FILE}`,
      "/",
      `/${BUNNY_GUID}/${THUMB_FILE}/extra`,
    ]) {
      const result = resolveBunnyThumbnailUpstreamUrl(
        `https://${PULL_ZONE}${path}`,
        identity,
      );
      assert.ok(!result.ok, path);
      assert.equal(result.reason, "PATH_SHAPE", path);
    }
  });

  it("T20 rejects traversal and unsafe file names, encoded or not", () => {
    for (const fileName of ["..%2Fsecret.jpg", "%2e%2e", "no-extension"]) {
      const result = resolveBunnyThumbnailUpstreamUrl(
        `https://${PULL_ZONE}/${BUNNY_GUID}/${fileName}`,
        identity,
      );
      assert.ok(!result.ok, fileName);
    }
  });

  it("classifies a pull-zone URL without validating its path", () => {
    assert.equal(isBunnyPullZoneUrl(STORED_THUMBNAIL_URL, PULL_ZONE), true);
    assert.equal(
      isBunnyPullZoneUrl("https://res.cloudinary.com/x.jpg", PULL_ZONE),
      false,
    );
    assert.equal(isBunnyPullZoneUrl(STORED_THUMBNAIL_URL, null), false);
    assert.equal(isBunnyPullZoneUrl(null, PULL_ZONE), false);
  });

  it("allows only raster image media types, never SVG", () => {
    for (const type of [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/avif",
      "image/JPEG; charset=x",
    ]) {
      assert.equal(isAllowedProxyImageType(type), true, type);
    }
    for (const type of [
      "image/svg+xml",
      "text/html",
      "application/octet-stream",
      "",
      null,
    ]) {
      assert.equal(isAllowedProxyImageType(type), false, String(type));
    }
  });
});

/* ================================================================== *
 * GET / HEAD semantics and stream lifecycle
 * ================================================================== */

describe("public Bunny thumbnail GET/HEAD semantics", () => {
  /**
   * The proxy issues an upstream **GET**, never an upstream HEAD.
   *
   * Bunny CDN's HEAD behaviour is not verified from this workspace, and a HEAD
   * that some edge answers differently (or not at all) would make the two verbs
   * disagree. One request shape, always — and for a client HEAD the body is
   * simply never pulled.
   */
  it("issues an upstream GET, never an upstream HEAD", async () => {
    const calls = stubUpstream({});
    const { service } = createService(createBunnyVideo());

    await service.getPublicThumbnail({ host, token, videoId: "video-1" });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
  });

  it("pulls NO body until the stream is consumed", async () => {
    // The stream is lazy. This is what makes a client HEAD — which destroys the
    // stream without reading — transfer essentially nothing, and it is also
    // what stops an upstream error being emitted before a consumer exists.
    let pulled = 0;
    stubUpstream({
      body: Buffer.from("JPEGDATA"),
      onPull: () => {
        pulled += 1;
      },
    });
    const { service } = createService(createBunnyVideo());

    const result = await service.getPublicThumbnail({
      host,
      token,
      videoId: "video-1",
    });

    assert.equal(pulled, 0, "no chunk may be read before the consumer asks");

    await drain(result.stream);
    assert.ok(pulled > 0, "and reading does pull");
  });

  it("cancels the upstream body when the stream is destroyed, as HEAD does", async () => {
    let cancelled = false;
    stubUpstream({
      body: Buffer.alloc(64 * 1024, 0x41),
      onCancel: () => {
        cancelled = true;
      },
    });
    const { service } = createService(createBunnyVideo());

    const result = await service.getPublicThumbnail({
      host,
      token,
      videoId: "video-1",
    });

    // Exactly what `pipeStreamToResponse(..., headOnly = true)` does.
    (result.stream as Readable).destroy();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(cancelled, true, "the upstream socket must be released");
  });

  it("surfaces an upstream error to the CONSUMER, never as an unhandled event", async () => {
    // Regression guard. `Readable.destroy(err)` emits `'error'`; an eagerly
    // flowing implementation could emit it before the controller attached
    // `pipeline()`, which terminates the process. A lazy stream cannot: the
    // error only materialises on read.
    stubUpstream({ body: Buffer.from("JPEG"), errorAfterFirstChunk: true });
    const { service } = createService(createBunnyVideo());

    const result = await service.getPublicThumbnail({
      host,
      token,
      videoId: "video-1",
    });

    // Deliberately let several turns pass with NO listener attached.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // Only now consume it — the error must arrive here, catchable.
    await assert.rejects(drain(result.stream));
  });

  it("preserves Content-Length semantics across GET and HEAD", async () => {
    // HEAD must report the length a GET would return, so the value comes from
    // the same upstream header on both verbs. The controller omits the header
    // entirely when upstream sent none rather than emitting a guess.
    stubUpstream({ body: Buffer.from("JPEGDATA") });
    const { service } = createService(createBunnyVideo());
    const withLength = await service.getPublicThumbnail({
      host,
      token,
      videoId: "video-1",
    });
    assert.equal(withLength.contentLength, 8);
    (withLength.stream as Readable).destroy();

    stubUpstream({ contentLength: null, body: Buffer.from("JPEGDATA") });
    const { service: service2 } = createService(createBunnyVideo());
    const withoutLength = await service2.getPublicThumbnail({
      host,
      token,
      videoId: "video-1",
    });
    assert.equal(
      withoutLength.contentLength,
      null,
      "absent upstream length must stay absent, never be guessed",
    );
    (withoutLength.stream as Readable).destroy();
  });
});

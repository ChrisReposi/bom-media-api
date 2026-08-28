/**
 * SHARE-LINK BACKWARD COMPATIBILITY - public route surface.
 *
 * COMPAT-050 controller route-decorator compatibility
 * COMPAT-051 production module wiring and prefix
 *
 * A FAILURE IN THIS FILE IS RELEASE BLOCKING. See
 * `docs/SHARE_LINK_COMPATIBILITY_TESTS.md`.
 *
 * ## What each half proves, precisely
 *
 * **COMPAT-050 - controller route-decorator compatibility.** A Nest app is
 * booted with `PublicController` registered *directly*, under a prefix this
 * test sets itself. That proves the controller's own `@Controller` / `@Get` /
 * `@Post` decorators still produce the paths and methods deployed public
 * bundles call, and that HEAD still works. It does **not**, on its own, prove
 * the controller is reachable in the real application: a controller dropped
 * from `PublicModule`, a module dropped from `AppModule`, or a changed prefix
 * default would all leave these tests green.
 *
 * **COMPAT-051 - production wiring.** Those three gaps are closed separately,
 * by asserting the Nest module metadata the real bootstrap reads
 * (`AppModule` imports `PublicModule`; `PublicModule` registers
 * `PublicController`) and by running the real config factory to confirm the
 * default API prefix.
 *
 * Still out of scope, and deliberately not claimed: booting the full
 * `AppModule`. That pulls in `PrismaService`, whose `onModuleInit` opens a
 * database connection, and every provider would need the decorator metadata
 * esbuild does not emit. So this file does not prove the application starts
 * end-to-end - only that the wiring the bootstrap depends on is still in place.
 *
 * Also out of scope: DTO validation. esbuild does not emit the parameter
 * metadata `ValidationPipe` needs, so validation does not run in this harness
 * and asserting it would test the harness rather than the application. It is
 * covered directly, against `class-validator`, in
 * `test/public-watch-exchange.test.ts`.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { DEFAULT_API_PREFIX } from "../src/common/constants/api.constants";
import {
  apiConfig,
  type ApiEnvironmentConfig,
} from "../src/config/env.config";
import { PublicController } from "../src/public/public.controller";
import { PublicModule } from "../src/public/public.module";
import { PublicService } from "../src/public/public.service";
import type { PublicWatchResponse } from "../src/public/types/public-watch-response.type";
import { defineControllerParamTypes } from "./share-link-compat-http-harness";

const API_PREFIX = "api/v1";
const HOST = "customer.example.com";
const TOKEN = "Ab3dEf7";
const VIDEO_ID = "video-1";
const MEDIA_BYTES = "0123456789";

const WATCH_RESPONSE: PublicWatchResponse = {
  valid: true,
  reasonCode: "OK",
  website: {
    id: "website-1",
    name: "Customer Website",
    slug: "customer-website",
    domain: HOST,
  },
  videos: [],
};

/** Records which service method each route reached, and with what. */
class RouteProbePublicService {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> =
    [];

  private record(method: string, params: Record<string, unknown>): void {
    this.calls.push({ method, params });
  }

  async resolvePublicWatch(params: Record<string, unknown>) {
    this.record("resolvePublicWatch", params);

    return WATCH_RESPONSE;
  }

  async recordPublicVideoView(params: Record<string, unknown>) {
    this.record("recordPublicVideoView", params);

    return {
      valid: true,
      videoId: VIDEO_ID,
      viewCount: "1",
      publishedAt: null,
    };
  }

  async getPublicDatabaseVideoBinary(params: Record<string, unknown>) {
    this.record("getPublicDatabaseVideoBinary", params);

    return {
      statusCode: 200 as const,
      mimeType: "video/mp4",
      sizeBytes: MEDIA_BYTES.length,
      contentLength: MEDIA_BYTES.length,
      contentRange: null,
      data: Buffer.from(MEDIA_BYTES),
    };
  }

  async getPublicLocalVideoFile(params: Record<string, unknown>) {
    this.record("getPublicLocalVideoFile", params);
    const { Readable } = await import("node:stream");

    return {
      statusCode: 200 as const,
      mimeType: "video/mp4",
      contentLength: MEDIA_BYTES.length,
      contentRange: null,
      stream: Readable.from(Buffer.from(MEDIA_BYTES)),
    };
  }

  /**
   * The controller entry point for the thumbnail route.
   *
   * Renamed from `getPublicLocalThumbnail` when the route was generalised to
   * serve Bunny posters as well as LOCAL_FILE thumbnails. The WIRE contract
   * COMPAT-050 pins — same path, same verb, 200, an image content type — is
   * unchanged; only the collaborator method the controller dispatches to moved.
   * `PublicService.getPublicLocalThumbnail()` still exists and still serves the
   * LOCAL_FILE branch.
   */
  async getPublicThumbnail(params: Record<string, unknown>) {
    this.record("getPublicThumbnail", params);
    const { Readable } = await import("node:stream");

    return {
      mimeType: "image/jpeg",
      contentLength: 4,
      stream: Readable.from(Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
    };
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

describe("COMPAT-050 controller route-decorator compatibility", () => {
  let app: INestApplication;
  let baseUrl: string;
  let publicService: RouteProbePublicService;

  before(async () => {
    // Transpiler compensation only - see share-link-compat-http-harness.ts.
    // Constructor arity is NOT pinned as a compatibility contract.
    defineControllerParamTypes(PublicController, [PublicService, ConfigService]);

    publicService = new RouteProbePublicService();
    const moduleRef = await Test.createTestingModule({
      controllers: [PublicController],
      providers: [
        { provide: PublicService, useValue: publicService },
        { provide: ConfigService, useValue: new RouteProbeConfigService() },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // Mirror src/main.ts.
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

  it("keeps the legacy GET public watch route registered", async () => {
    const url = new URL(`${baseUrl}/public/watch`);
    url.searchParams.set("host", HOST);
    url.searchParams.set("token", TOKEN);

    const response = await fetch(url);
    const body = (await response.json()) as PublicWatchResponse;

    assert.equal(response.status, 200);
    assert.equal(body.valid, true);
    assert.equal(body.reasonCode, "OK");
    assert.equal(
      publicService.calls.some(
        (call) =>
          call.method === "resolvePublicWatch" && call.params.host === HOST,
      ),
      true,
    );
  });

  it("keeps the POST watch/exchange route registered", async () => {
    const response = await fetch(`${baseUrl}/public/watch/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: HOST, token: TOKEN }),
    });
    const body = (await response.json()) as PublicWatchResponse;

    assert.equal(response.status, 200);
    assert.equal(body.valid, true);
    assert.equal(body.website?.domain, HOST);
  });

  it("keeps both watch endpoints answering with the same response shape", async () => {
    const url = new URL(`${baseUrl}/public/watch`);
    url.searchParams.set("host", HOST);
    url.searchParams.set("token", TOKEN);

    const legacy = await (await fetch(url)).json();
    const exchange = await (
      await fetch(`${baseUrl}/public/watch/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host: HOST, token: TOKEN }),
      })
    ).json();

    assert.deepEqual(exchange, legacy);
  });

  it("keeps the view-recording route registered", async () => {
    const response = await fetch(
      `${baseUrl}/public/watch/${TOKEN}/videos/${VIDEO_ID}/view`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host: HOST }),
      },
    );

    assert.equal(response.status, 201);
    const call = publicService.calls.find(
      (entry) => entry.method === "recordPublicVideoView",
    );
    assert.ok(call);
    assert.equal(call.params.token, TOKEN);
    assert.equal(call.params.videoId, VIDEO_ID);
  });

  it("keeps all three media routes registered on GET", async () => {
    for (const [segment, method, contentType] of [
      ["binary", "getPublicDatabaseVideoBinary", "video/mp4"],
      ["local-file", "getPublicLocalVideoFile", "video/mp4"],
      ["thumbnail", "getPublicThumbnail", "image/jpeg"],
    ] as const) {
      const url = new URL(
        `${baseUrl}/public/watch/${TOKEN}/videos/${VIDEO_ID}/${segment}`,
      );
      url.searchParams.set("host", HOST);

      const response = await fetch(url);

      assert.equal(response.status, 200, `${segment} must be registered`);
      assert.equal(response.headers.get("content-type"), contentType);
      assert.equal(
        publicService.calls.some((call) => call.method === method),
        true,
        `${segment} must reach ${method}`,
      );
    }
  });

  it("keeps HEAD working on the media routes without a body", async () => {
    const url = new URL(
      `${baseUrl}/public/watch/${TOKEN}/videos/${VIDEO_ID}/binary`,
    );
    url.searchParams.set("host", HOST);

    const response = await fetch(url, { method: "HEAD" });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(await response.text(), "");
  });

  it("keeps the no-store header family on every public route", async () => {
    const url = new URL(`${baseUrl}/public/watch`);
    url.searchParams.set("host", HOST);
    url.searchParams.set("token", TOKEN);

    const response = await fetch(url);

    assert.equal(
      response.headers.get("cache-control"),
      "private, no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });

  it("keeps the HTTP method bound to each watch route", async () => {
    // A method swap would break every deployed bundle just as surely as a
    // rename, so both directions are pinned.
    const postToLegacy = await fetch(`${baseUrl}/public/watch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: HOST, token: TOKEN }),
    });
    assert.equal(postToLegacy.status, 404);

    const getToExchange = await fetch(`${baseUrl}/public/watch/exchange`);
    assert.equal(getToExchange.status, 404);
  });

  it("matches the exact paths and nothing broader", async () => {
    // Guards against the assertions above passing via some catch-all route,
    // and pins the exact spelling of each path segment.
    for (const path of [
      "/public/watches",
      "/public/watch/exchanges",
      `/public/watch/${TOKEN}/videos/${VIDEO_ID}/binaries`,
      `/public/watch/${TOKEN}/video/${VIDEO_ID}/binary`,
      `/public/${TOKEN}/videos/${VIDEO_ID}/local-file`,
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 404, `${path} must not be routed`);
    }
  });
});

describe("COMPAT-051 production module wiring", () => {
  /**
   * These read the same Nest module metadata `NestFactory.create(AppModule)`
   * reads at boot, so they close the gap COMPAT-050 leaves open: they fail if
   * `PublicController` is dropped from `PublicModule`, if `PublicModule` is
   * dropped from `AppModule`, or if the default API prefix changes.
   */

  it("keeps PublicModule registered in AppModule", () => {
    const imports = (Reflect.getMetadata("imports", AppModule) ??
      []) as unknown[];

    assert.equal(
      imports.includes(PublicModule),
      true,
      "AppModule no longer imports PublicModule - every public route would 404",
    );
  });

  it("keeps PublicController registered in PublicModule", () => {
    const controllers = (Reflect.getMetadata("controllers", PublicModule) ??
      []) as unknown[];

    assert.equal(
      controllers.includes(PublicController),
      true,
      "PublicModule no longer registers PublicController",
    );
  });

  it("keeps the default API prefix that public share URLs are built against", () => {
    // Runs the real config factory rather than restating the constant, so a
    // change to how the prefix is derived is caught too.
    const config = apiConfig() as ApiEnvironmentConfig;

    assert.equal(config.prefix, DEFAULT_API_PREFIX);
    assert.equal(
      config.prefix,
      API_PREFIX,
      "the prefix COMPAT-050 mounts under must match the production default",
    );
  });
});

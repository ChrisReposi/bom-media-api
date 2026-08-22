/**
 * SHARE-LINK BACKWARD COMPATIBILITY - real HTTP wire contract.
 *
 * COMPAT-035 DB_BLOB media over a real Nest + Express server
 *
 * A FAILURE IN THIS FILE IS RELEASE BLOCKING. See
 * `docs/SHARE_LINK_COMPATIBILITY_TESTS.md`.
 *
 * ## Why this exists separately from `share-link-compat-media-delivery`
 *
 * That suite calls the controller with a hand-written response double. A double
 * cannot reproduce what Express does *after* the controller returns, and Express
 * does something load-bearing here:
 *
 *   res.setHeader("Content-Length", "10");
 *   res.send(Buffer.alloc(0));   // Express RESETS Content-Length to 0
 *
 * So the controller's explicit `if (request.method === "HEAD") res.end()`
 * short-circuit is **observable production behaviour**, not a redundant branch:
 * without it a `HEAD` reports `Content-Length: 0` instead of the resource size,
 * and a client using `HEAD` to learn the size before ranging gets a wrong
 * answer. Only a real HTTP server can catch that, so these cases run one.
 *
 * Scope: this boots the real `PublicController` and the real `PublicService`
 * over a real Express server on an ephemeral loopback port. Only Prisma is
 * faked. No database, no network beyond 127.0.0.1.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import type { ApiEnvironmentConfig } from "../src/config/env.config";
import { PublicController } from "../src/public/public.controller";
import { PublicService } from "../src/public/public.service";
import {
  createCompatHarness,
  type CompatPrismaService,
  dbBlobVideo,
  LEGACY_ALIAS,
  LEGACY_HOST,
} from "./share-link-compat-harness";
import { defineControllerParamTypes } from "./share-link-compat-http-harness";

const API_PREFIX = "api/v1";
const VIDEO_ID = "video-db-blob";
const MEDIA_BYTES = "0123456789";

class HttpConfigService {
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

describe("COMPAT-035 DB_BLOB media over real Nest + Express", () => {
  let app: INestApplication;
  let baseUrl: string;
  let prisma: CompatPrismaService;

  before(async () => {
    defineControllerParamTypes(PublicController, [PublicService, ConfigService]);

    const harness = createCompatHarness({ videos: [dbBlobVideo()] });
    prisma = harness.prisma;

    const moduleRef = await Test.createTestingModule({
      controllers: [PublicController],
      providers: [
        { provide: PublicService, useValue: harness.service },
        { provide: ConfigService, useValue: new HttpConfigService() },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(API_PREFIX);
    await app.init();
    await app.listen(0, "127.0.0.1");

    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/${API_PREFIX}`;
  });

  after(async () => {
    await app?.close();
  });

  function binaryUrl(): URL {
    const url = new URL(
      `${baseUrl}/public/watch/${LEGACY_ALIAS}/videos/${VIDEO_ID}/binary`,
    );
    url.searchParams.set("host", LEGACY_HOST);

    return url;
  }

  async function request(
    method: "GET" | "HEAD",
    rangeHeader?: string,
  ): Promise<{ response: Response; body: string; blobReads: number }> {
    const before = prisma.counters.queryRaw;
    const response = await fetch(binaryUrl(), {
      method,
      ...(rangeHeader === undefined
        ? {}
        : { headers: { range: rangeHeader } }),
    });
    // `fetch` discards a HEAD body per spec; reading it is still the honest way
    // to assert "no body", because a stray body would surface as a protocol
    // error or a non-empty read on GET.
    const body = await response.text();

    return { response, body, blobReads: prisma.counters.queryRaw - before };
  }

  /* ---------------- A: full HEAD ---------------- */

  it("A - full HEAD reports the full resource length and sends no body", async () => {
    const { response, body, blobReads } = await request("HEAD");

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(response.headers.get("content-type"), "video/mp4");
    // THE load-bearing assertion. Without the controller's HEAD short-circuit
    // Express rewrites this to "0" when send(Buffer.alloc(0)) is reached.
    assert.equal(
      response.headers.get("content-length"),
      String(MEDIA_BYTES.length),
      "HEAD must report the full resource length, not 0",
    );
    assert.equal(body, "");
    // The bounded blob read is skipped entirely for a HEAD.
    assert.equal(blobReads, 0);
  });

  /* ---------------- B: ranged HEAD ---------------- */

  it("B - ranged HEAD reports the range length and sends no body", async () => {
    const { response, body, blobReads } = await request("HEAD", "bytes=2-5");

    assert.equal(response.status, 206);
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(response.headers.get("content-type"), "video/mp4");
    assert.equal(
      response.headers.get("content-length"),
      "4",
      "ranged HEAD must report the range length, not 0",
    );
    assert.equal(response.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(body, "");
    assert.equal(blobReads, 0);
  });

  /* ---------------- C: invalid Range on HEAD ---------------- */

  it("C - unsatisfiable Range on HEAD returns 416 with Content-Range", async () => {
    const { response, body } = await request("HEAD", "bytes=20-30");

    assert.equal(response.status, 416);
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(response.headers.get("content-type"), "video/mp4");
    assert.equal(response.headers.get("content-range"), "bytes */10");
    assert.equal(body, "");
  });

  /* ---------------- GET counterparts, so HEAD is compared against something ---- */

  it("keeps GET returning the full body with the same length header", async () => {
    const { response, body } = await request("GET");

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-length"),
      String(MEDIA_BYTES.length),
    );
    assert.equal(body, MEDIA_BYTES);
  });

  it("keeps ranged GET returning exactly the requested bytes", async () => {
    const { response, body } = await request("GET", "bytes=2-5");

    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-length"), "4");
    assert.equal(response.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(body, "2345");
  });

  it("keeps HEAD and GET reporting the same headers for the same request", async () => {
    // The HTTP contract for HEAD is "identical headers, no body". This is the
    // property a client relies on when it probes with HEAD and then ranges.
    const head = await request("HEAD");
    const get = await request("GET");

    for (const header of [
      "status",
      "accept-ranges",
      "content-type",
      "content-length",
      "cache-control",
    ]) {
      const headValue =
        header === "status"
          ? String(head.response.status)
          : head.response.headers.get(header);
      const getValue =
        header === "status"
          ? String(get.response.status)
          : get.response.headers.get(header);

      assert.equal(headValue, getValue, `HEAD/GET differ on ${header}`);
    }
    assert.equal(head.body, "");
    assert.equal(get.body, MEDIA_BYTES);
  });

  it("keeps the no-store header family on the media route", async () => {
    const { response } = await request("GET");

    assert.equal(
      response.headers.get("cache-control"),
      "private, no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });
});

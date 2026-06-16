import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpStatus, RequestMethod } from "@nestjs/common";
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { validate } from "class-validator";
import type { Request, Response } from "express";
import type { ApiEnvironmentConfig } from "../src/config/env.config";
import { PublicController } from "../src/public/public.controller";
import { PublicWatchExchangeDto } from "../src/public/dto/public-watch-exchange.dto";
import type { PublicWatchResponse } from "../src/public/types/public-watch-response.type";
import {
  THROTTLE_PROFILE_METADATA,
  THROTTLE_PROFILES,
} from "../src/security/throttle-profile.decorator";

const publicWatchResponse: PublicWatchResponse = {
  valid: true,
  reasonCode: "OK",
  website: {
    id: "website-1",
    name: "Test Website",
    slug: "test-website",
    domain: "localhost:5500",
  },
  videos: [
    {
      id: "video-1",
      title: "Public video",
      description: null,
      sourceType: "LOCAL_FILE",
      playbackUrl: null,
      binaryPlaybackUrl: null,
      publicPlaybackUrl:
        "/api/v1/public/watch/test-share-token/videos/video-1/local-file?host=localhost%3A5500",
      binaryAsset: null,
      localFileAsset: {
        mimeType: "video/mp4",
        sizeBytes: "1024",
      },
      embedUrl: null,
      embedProvider: null,
      embedAllow: null,
      thumbnailUrl:
        "/api/v1/public/watch/test-share-token/videos/video-1/thumbnail?host=localhost%3A5500",
      publicThumbnailUrl:
        "/api/v1/public/watch/test-share-token/videos/video-1/thumbnail?host=localhost%3A5500",
      durationSeconds: 30,
      viewCount: "123",
      publishedAt: "2026-06-14T00:00:00.000Z",
    },
  ],
};

class FakePublicService {
  readonly calls: Array<{
    host: string;
    token?: string;
    requestMeta?: {
      ip?: string;
      referer?: string;
      userAgent?: string;
    };
  }> = [];

  async resolvePublicWatch(params: {
    host: string;
    token?: string;
    requestMeta?: {
      ip?: string;
      referer?: string;
      userAgent?: string;
    };
  }): Promise<PublicWatchResponse> {
    this.calls.push(params);

    if (params.token === "invalid-token") {
      return {
        valid: false,
        reasonCode: "INVALID_LINK",
        website: null,
        videos: [],
      };
    }

    return publicWatchResponse;
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

function createController(): {
  controller: PublicController;
  publicService: FakePublicService;
} {
  const publicService = new FakePublicService();
  const controller = new PublicController(
    publicService as never,
    new FakeConfigService() as never,
  );

  return { controller, publicService };
}

function createRequest(): Request {
  return {
    headers: {
      referer: "http://localhost:5500/",
      "user-agent": "Public site test",
    },
    ip: "127.0.0.1",
    socket: {},
  } as Request;
}

describe("PublicController watch exchange", () => {
  it("registers POST /public/watch/exchange with the public watch throttle", () => {
    const handler = PublicController.prototype.exchangePublicWatch;

    assert.equal(Reflect.getMetadata(PATH_METADATA, handler), "watch/exchange");
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

  it("returns the same public watch shape as the legacy GET flow", async () => {
    const { controller, publicService } = createController();
    const request = createRequest();
    const exchangeResponse = new FakeResponse();
    const legacyResponse = new FakeResponse();

    const exchange = await controller.exchangePublicWatch(
      { host: "localhost:5500", token: "test-share-token" },
      request,
      exchangeResponse as unknown as Response,
    );
    const legacy = await controller.resolvePublicWatch(
      { host: "localhost:5500", token: "test-share-token" },
      request,
      legacyResponse as unknown as Response,
    );

    assert.deepEqual(exchange, legacy);
    assert.equal(publicService.calls.length, 2);
    assert.deepEqual(publicService.calls[0], {
      host: "localhost:5500",
      token: "test-share-token",
      requestMeta: {
        ip: "127.0.0.1",
        referer: "http://localhost:5500/",
        userAgent: "Public site test",
      },
    });
    assert.equal(
      exchangeResponse.headers.get("Cache-Control"),
      "private, no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    assert.equal(
      publicWatchResponse.videos.some((video) =>
        [
          video.thumbnailUrl,
          video.publicThumbnailUrl,
          video.playbackUrl,
          video.publicPlaybackUrl,
          video.binaryPlaybackUrl,
        ].some((value) => value?.includes("/admin/")),
      ),
      false,
    );
  });

  it("keeps invalid token responses generic through the exchange endpoint", async () => {
    const { controller } = createController();

    const response = await controller.exchangePublicWatch(
      { host: "localhost:5500", token: "invalid-token" },
      createRequest(),
      new FakeResponse() as unknown as Response,
    );

    assert.deepEqual(response, {
      valid: false,
      reasonCode: "INVALID_LINK",
      website: null,
      videos: [],
    });
  });

  it("requires host and token in the exchange body", async () => {
    const dto = new PublicWatchExchangeDto();
    const errors = await validate(dto);
    const properties = errors.map((error) => error.property).sort();

    assert.deepEqual(properties, ["host", "token"]);
  });

  it("rejects empty and oversized exchange fields", async () => {
    const dto = new PublicWatchExchangeDto();
    dto.host = "";
    dto.token = "x".repeat(257);

    const errors = await validate(dto);
    const constraints = new Map(
      errors.map((error) => [error.property, error.constraints ?? {}]),
    );

    assert.ok(constraints.get("host")?.isNotEmpty);
    assert.ok(constraints.get("token")?.maxLength);
  });
});

import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Body,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import type { Request, Response } from "express";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ApiEnvironmentConfig } from "../config/env.config";
import {
  getClientIpFromRequest,
  readRequestHeader,
} from "../common/utils/request-security.util";
import {
  THROTTLE_PROFILES,
  ThrottleProfile,
} from "../security/throttle-profile.decorator";
import { PublicWatchCompatibleExchangeDto } from "./dto/public-watch-compatible-exchange.dto";
import { PublicWatchExchangeDto } from "./dto/public-watch-exchange.dto";
import { PublicWatchQueryDto } from "./dto/public-watch-query.dto";
import { RecordPublicVideoViewDto } from "./dto/record-public-video-view.dto";
import { PublicService } from "./public.service";
import {
  PublicVideoViewResponse,
  PublicWatchResponse,
} from "./types/public-watch-response.type";

@ApiTags("public")
@Controller("public")
export class PublicController {
  constructor(
    private readonly publicService: PublicService,
    private readonly configService: ConfigService,
  ) {}

  @Get("watch")
  @ThrottleProfile(THROTTLE_PROFILES.publicWatch)
  @ApiOperation({
    summary: "Resolve public watch videos by host and token.",
    description:
      "Public endpoint for static custom websites. Does not require admin authentication.",
  })
  @ApiOkResponse({
    type: PublicWatchResponse,
    description: "Public watch result.",
  })
  @ApiBadRequestResponse({
    description: "Invalid query shape.",
  })
  resolvePublicWatch(
    @Query() query: PublicWatchQueryDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PublicWatchResponse> {
    setNoStoreHeaders(response);

    return this.publicService.resolvePublicWatch({
      host: query.host,
      ...(query.token !== undefined ? { token: query.token } : {}),
      requestMeta: {
        ip: this.extractClientIp(request),
        referer: readRequestHeader(request, "referer"),
        userAgent: readRequestHeader(request, "user-agent"),
      },
    });
  }

  @Post("watch/exchange")
  @HttpCode(HttpStatus.OK)
  @ThrottleProfile(THROTTLE_PROFILES.publicWatch)
  @ApiOperation({
    summary: "Exchange a public share token for public watch videos.",
    description:
      "Preferred public endpoint for static custom websites. Uses the same validation and response shape as legacy GET /public/watch and does not require admin authentication.",
  })
  @ApiOkResponse({
    type: PublicWatchResponse,
    description: "Public watch result.",
  })
  @ApiBadRequestResponse({
    description: "Invalid request body.",
  })
  exchangePublicWatch(
    @Body() body: PublicWatchExchangeDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PublicWatchResponse> {
    setNoStoreHeaders(response);

    return this.publicService.resolvePublicWatch({
      host: body.host,
      token: body.token,
      requestMeta: {
        ip: this.extractClientIp(request),
        referer: readRequestHeader(request, "referer"),
        userAgent: readRequestHeader(request, "user-agent"),
      },
    });
  }

  /**
   * THE EMAIL-SAFE REVIEWER EXCHANGE.
   *
   * The fragment form `/watch#k=<credential>` is never transmitted and is
   * therefore stripped by some mail clients. The query form
   * `/watch?r=<transportAlias>` survives them, and the site redeems it here.
   *
   * The body carries a TRANSPORT ALIAS — a separate 128-bit identifier, and an
   * ALTERNATE BEARER CREDENTIAL for the same ShareLink — never the `#k`
   * credential. Both are secrets and both are redacted.
   * `PublicService.resolvePublicWatchCompatible()` swaps it
   * for the ShareLink's own alias and runs the UNMODIFIED V2 resolver, so the
   * response, the authorization chain, the view consumption and the media
   * URLs are exactly those of `POST watch/exchange` for the same link.
   *
   * POST only, and the alias travels in the BODY: no route parameter, no
   * query string, so nothing about it can reach the request log
   * (`safeRequestRoute()` logs the route template alone).
   */
  @Post("watch/exchange-compatible")
  @HttpCode(HttpStatus.OK)
  @ThrottleProfile(THROTTLE_PROFILES.publicWatch)
  @ApiOperation({
    summary: "Exchange an email-safe transport alias for public watch videos.",
    description:
      "Fragment-independent counterpart of POST watch/exchange for the `/watch?r=<transportAlias>` reviewer URL. Resolves the transport alias to its ShareLink and applies exactly the same authorization, view-consumption and response semantics as watch/exchange. Does not require admin authentication.",
  })
  @ApiOkResponse({
    type: PublicWatchResponse,
    description: "Public watch result.",
  })
  @ApiBadRequestResponse({
    description: "Invalid request body.",
  })
  exchangePublicWatchCompatible(
    @Body() body: PublicWatchCompatibleExchangeDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PublicWatchResponse> {
    setNoStoreHeaders(response);

    return this.publicService.resolvePublicWatchCompatible({
      host: body.host,
      alias: body.alias,
      requestMeta: {
        ip: this.extractClientIp(request),
        referer: readRequestHeader(request, "referer"),
        userAgent: readRequestHeader(request, "user-agent"),
      },
    });
  }

  @Post("watch/:token/videos/:videoId/view")
  @ThrottleProfile(THROTTLE_PROFILES.publicWatch)
  @ApiOperation({
    summary: "Record a public video display view.",
    description:
      "Public static sites call this once after real playback begins. It validates the public share token, host/domain, share-link status, video membership, and READY/playable status before applying capped, deduped display-view growth.",
  })
  @ApiOkResponse({
    type: PublicVideoViewResponse,
    description: "Generic view tracking result.",
  })
  @ApiBadRequestResponse({
    description: "Invalid request shape.",
  })
  recordPublicVideoView(
    @Param("token") token: string,
    @Param("videoId") videoId: string,
    @Body() body: RecordPublicVideoViewDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PublicVideoViewResponse> {
    setNoStoreHeaders(response);

    return this.publicService.recordPublicVideoView({
      host: body.host,
      token,
      videoId,
      requestMeta: {
        ip: this.extractClientIp(request),
        userAgent: readRequestHeader(request, "user-agent"),
      },
    });
  }

  @Get("watch/:token/videos/:videoId/binary")
  @ThrottleProfile(THROTTLE_PROFILES.publicMedia)
  @ApiOperation({
    summary: "Stream token-protected public DB_BLOB video binary.",
    description:
      "Validates the public share token, host/domain, share-link status, video membership, READY status, and DB binary asset before streaming. Supports HTTP Range requests.",
  })
  @ApiOkResponse({
    description: "Full binary response when no Range header is supplied.",
  })
  @ApiBadRequestResponse({
    description: "Invalid or unauthorized public video binary request.",
  })
  async streamPublicDatabaseVideo(
    @Param("token") token: string,
    @Param("videoId") videoId: string,
    @Query("host") host: string,
    @Query("grant") grant: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    setNoStoreHeaders(response);

    const binary = await this.publicService.getPublicDatabaseVideoBinary({
      host,
      token,
      videoId,
      ...(grant === undefined ? {} : { grant }),
      headOnly: request.method === "HEAD",
      rangeHeader: request.headers.range,
    });

    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Content-Type", binary.mimeType);

    if (binary.statusCode === HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE) {
      response.status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
      response.setHeader("Content-Range", binary.contentRange ?? "");
      response.end();
      return;
    }

    response.status(binary.statusCode);
    response.setHeader("Content-Length", String(binary.contentLength));

    if (binary.contentRange !== null) {
      response.setHeader("Content-Range", binary.contentRange);
    }

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    response.send(binary.data ?? Buffer.alloc(0));
  }

  @Get("watch/:token/videos/:videoId/local-file")
  @ThrottleProfile(THROTTLE_PROFILES.publicMedia)
  @ApiOperation({
    summary: "Stream token-protected public LOCAL_FILE video.",
    description:
      "Validates the public share token, host/domain, share-link status, video membership, READY status, and local file asset before streaming. Supports HTTP Range requests.",
  })
  @ApiOkResponse({
    description: "Full local video response when no Range header is supplied.",
  })
  @ApiBadRequestResponse({
    description: "Invalid or unauthorized public local video request.",
  })
  async streamPublicLocalVideo(
    @Param("token") token: string,
    @Param("videoId") videoId: string,
    @Query("host") host: string,
    @Query("grant") grant: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    setNoStoreHeaders(response);

    const result = await this.publicService.getPublicLocalVideoFile({
      host,
      token,
      videoId,
      ...(grant === undefined ? {} : { grant }),
      rangeHeader: request.headers.range,
    });

    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Content-Type", result.mimeType);

    if (result.statusCode === HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE) {
      response.status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
      response.setHeader("Content-Range", result.contentRange ?? "");
      response.end();
      return;
    }

    response.status(result.statusCode);
    response.setHeader("Content-Length", String(result.contentLength));

    if (result.contentRange !== null) {
      response.setHeader("Content-Range", result.contentRange);
    }

    await pipeStreamToResponse(
      result.stream,
      response,
      request.method === "HEAD",
    );
  }

  @Get("watch/:token/videos/:videoId/thumbnail")
  @ThrottleProfile(THROTTLE_PROFILES.publicMedia)
  @ApiOperation({
    summary: "Stream the token-protected public thumbnail for a video.",
    description:
      "Validates the public share token, host/domain, share-link status, video membership, ACTIVE assignment and READY status before streaming. Serves a LOCAL_FILE thumbnail from local storage, and a Bunny Stream poster by proxying the library pull zone under a configured upstream authorization mode. Never increments views. Every failure is the same generic 404.",
  })
  @ApiOkResponse({
    description: "Thumbnail image response.",
  })
  @ApiBadRequestResponse({
    description: "Invalid or unauthorized public thumbnail request.",
  })
  async streamPublicThumbnail(
    @Param("token") token: string,
    @Param("videoId") videoId: string,
    @Query("host") host: string,
    @Query("grant") grant: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    setNoStoreHeaders(response);

    const result = await this.publicService.getPublicThumbnail({
      host,
      token,
      videoId,
      ...(grant === undefined ? {} : { grant }),
    });

    response.status(HttpStatus.OK);
    response.setHeader("Content-Type", result.mimeType);
    // A proxied poster may arrive with no upstream `Content-Length`. Omitting
    // the header is correct there; emitting a guess would be a lie the client
    // acts on. A local asset always has one, so its response is unchanged.
    if (result.contentLength !== null) {
      response.setHeader("Content-Length", String(result.contentLength));
    }
    await pipeStreamToResponse(
      result.stream,
      response,
      request.method === "HEAD",
    );
  }

  private extractClientIp(request: Request): string | undefined {
    const apiEnvironment =
      this.configService.getOrThrow<ApiEnvironmentConfig>("api");

    return getClientIpFromRequest(request, {
      trustProxyEnabled: apiEnvironment.trustProxyEnabled,
      trustProxyCloudflareOnly: apiEnvironment.trustProxyCloudflareOnly,
      trustedProxyCidrs: apiEnvironment.trustedProxyCidrs,
    });
  }
}

function setNoStoreHeaders(response: Response): void {
  response.setHeader(
    "Cache-Control",
    "private, no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Expires", "0");
  response.setHeader("Surrogate-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

async function pipeStreamToResponse(
  stream: NodeJS.ReadableStream | null,
  response: Response,
  headOnly: boolean,
): Promise<void> {
  if (stream === null) {
    response.end();
    return;
  }

  const readable = stream as Readable;
  if (headOnly) {
    readable.destroy();
    response.end();
    return;
  }

  try {
    await pipeline(readable, response);
  } catch (error) {
    if (
      response.destroyed ||
      (typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "ERR_STREAM_PREMATURE_CLOSE")
    ) {
      readable.destroy();
      return;
    }
    throw error;
  }
}

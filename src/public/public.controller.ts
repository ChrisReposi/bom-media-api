import {
  Controller,
  Get,
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
import type { ApiEnvironmentConfig } from "../config/env.config";
import {
  getClientIpFromRequest,
  readRequestHeader,
} from "../common/utils/request-security.util";
import {
  THROTTLE_PROFILES,
  ThrottleProfile,
} from "../security/throttle-profile.decorator";
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
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    setNoStoreHeaders(response);

    const binary = await this.publicService.getPublicDatabaseVideoBinary({
      host,
      token,
      videoId,
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
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    setNoStoreHeaders(response);

    const result = await this.publicService.getPublicLocalVideoFile({
      host,
      token,
      videoId,
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

    pipeStreamToResponse(result.stream, response);
  }

  @Get("watch/:token/videos/:videoId/thumbnail")
  @ThrottleProfile(THROTTLE_PROFILES.publicMedia)
  @ApiOperation({
    summary: "Stream token-protected public LOCAL_FILE thumbnail.",
    description:
      "Validates the public share token, host/domain, share-link status, video membership, READY status, and local thumbnail asset before streaming.",
  })
  @ApiOkResponse({
    description: "Local thumbnail image response.",
  })
  @ApiBadRequestResponse({
    description: "Invalid or unauthorized public local thumbnail request.",
  })
  async streamPublicLocalThumbnail(
    @Param("token") token: string,
    @Param("videoId") videoId: string,
    @Query("host") host: string,
    @Res() response: Response,
  ): Promise<void> {
    setNoStoreHeaders(response);

    const result = await this.publicService.getPublicLocalThumbnail({
      host,
      token,
      videoId,
    });

    response.status(HttpStatus.OK);
    response.setHeader("Content-Type", result.mimeType);
    response.setHeader("Content-Length", String(result.contentLength));
    pipeStreamToResponse(result.stream, response);
  }

  private extractClientIp(request: Request): string | undefined {
    const apiEnvironment =
      this.configService.getOrThrow<ApiEnvironmentConfig>("api");

    return getClientIpFromRequest(request, {
      trustProxyEnabled: apiEnvironment.trustProxyEnabled,
      trustProxyCloudflareOnly: apiEnvironment.trustProxyCloudflareOnly,
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

function pipeStreamToResponse(
  stream: NodeJS.ReadableStream | null,
  response: Response,
): void {
  if (stream === null) {
    response.end();
    return;
  }

  let completed = false;
  response.on("finish", () => {
    completed = true;
  });
  response.on("close", () => {
    if (!completed) {
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    }
  });

  stream.pipe(response);
}

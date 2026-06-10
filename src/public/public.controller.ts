import {
  Controller,
  Get,
  HttpStatus,
  Param,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import type { Request, Response } from "express";
import { PublicWatchQueryDto } from "./dto/public-watch-query.dto";
import { PublicService } from "./public.service";
import { PublicWatchResponse } from "./types/public-watch-response.type";

@ApiTags("public")
@Controller("public")
export class PublicController {
  constructor(private readonly publicService: PublicService) {}

  @Get("watch")
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
        ip: extractClientIp(request),
        referer: readHeader(request, "referer"),
        userAgent: readHeader(request, "user-agent"),
      },
    });
  }

  @Get("watch/:token/videos/:videoId/binary")
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

function readHeader(request: Request, name: string): string | undefined {
  const value = request.headers[name];

  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function extractClientIp(request: Request): string | undefined {
  const forwardedFor = readHeader(request, "x-forwarded-for");
  const firstForwardedIp = forwardedFor?.split(",")[0]?.trim();

  return (
    firstForwardedIp || request.ip || request.socket.remoteAddress || undefined
  );
}

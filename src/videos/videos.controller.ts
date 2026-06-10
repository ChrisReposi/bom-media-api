import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  Delete,
  ExceptionFilter,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseFilters,
  UseInterceptors,
} from "@nestjs/common";
import {
  FileFieldsInterceptor,
  FileInterceptor,
} from "@nestjs/platform-express";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type { Request, Response } from "express";
import { diskStorage, memoryStorage, MulterError } from "multer";
import { CurrentAdmin } from "../admin-auth/decorators/current-admin.decorator";
import { AdminAccessTokenGuard } from "../admin-auth/guards/admin-access-token.guard";
import type { SafeAdminResponse } from "../admin-auth/types/admin-auth-response.type";
import { CreateEmbedVideoWithThumbnailDto } from "./dto/create-embed-video-with-thumbnail.dto";
import { CreateEmbedVideoDto } from "./dto/create-embed-video.dto";
import { CreateManualVideoWithThumbnailDto } from "./dto/create-manual-video-with-thumbnail.dto";
import { CreateVideoDto } from "./dto/create-video.dto";
import { ListVideosQueryDto } from "./dto/list-videos-query.dto";
import { PurgeVideoDto } from "./dto/purge-video.dto";
import { ReplaceDatabaseVideoBinaryDto } from "./dto/replace-database-video-binary.dto";
import { UploadDatabaseVideoDto } from "./dto/upload-database-video.dto";
import { UpdateVideoDto } from "./dto/update-video.dto";
import { UploadVideoDto } from "./dto/upload-video.dto";
import {
  DisableVideoResponse,
  PurgeVideoResponse,
  VideoListResponse,
  VideoResponse,
} from "./types/video-response.type";
import { VideosService } from "./videos.service";
import type { DatabaseVideoBinary } from "./videos.service";

const DEFAULT_UPLOAD_LIMIT_BYTES = 500 * 1024 * 1024;
const MAX_DATABASE_UPLOAD_LIMIT_MB = 100;
const MAX_DATABASE_UPLOAD_LIMIT_BYTES =
  MAX_DATABASE_UPLOAD_LIMIT_MB * 1024 * 1024;
const MAX_THUMBNAIL_UPLOAD_LIMIT_MB = 10;
const MAX_THUMBNAIL_UPLOAD_LIMIT_BYTES =
  MAX_THUMBNAIL_UPLOAD_LIMIT_MB * 1024 * 1024;

type VideoUploadFiles = {
  file?: Express.Multer.File[];
  thumbnailFile?: Express.Multer.File[];
};

function createDatabaseUploadFilename(
  _request: Express.Request,
  file: Express.Multer.File,
  callback: (error: Error | null, filename: string) => void,
): void {
  const rawExtension = file.originalname.includes(".")
    ? file.originalname.slice(file.originalname.lastIndexOf("."))
    : "";
  const extension = /^\.[a-z0-9]{1,12}$/i.test(rawExtension)
    ? rawExtension.toLowerCase()
    : "";

  callback(null, `video-db-${Date.now()}-${randomUUID()}${extension}`);
}

function sendRangeNotSatisfiable(response: Response, size: number): void {
  response.status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
  response.setHeader("Content-Range", `bytes */${size}`);
  response.end();
}

function streamDatabaseVideoBinary(
  binary: DatabaseVideoBinary,
  rangeHeader: string | undefined,
  response: Response,
): void {
  const buffer = binary.data;
  const size = buffer.length;

  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", binary.mimeType);

  if (size === 0) {
    response.status(HttpStatus.OK);
    response.setHeader("Content-Length", "0");
    response.end();
    return;
  }

  if (rangeHeader === undefined || rangeHeader.trim() === "") {
    response.status(HttpStatus.OK);
    response.setHeader("Content-Length", String(size));
    response.send(buffer);
    return;
  }

  const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (rangeMatch === null) {
    sendRangeNotSatisfiable(response, size);
    return;
  }

  const [, rawStart, rawEnd] = rangeMatch;

  if (rawStart === "" && rawEnd === "") {
    sendRangeNotSatisfiable(response, size);
    return;
  }

  let start: number;
  let end: number;

  if (rawStart === "") {
    const suffixLength = Number(rawEnd);

    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      sendRangeNotSatisfiable(response, size);
      return;
    }

    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    sendRangeNotSatisfiable(response, size);
    return;
  }

  const boundedEnd = Math.min(end, size - 1);
  const chunk = buffer.subarray(start, boundedEnd + 1);

  response.status(HttpStatus.PARTIAL_CONTENT);
  response.setHeader("Content-Range", `bytes ${start}-${boundedEnd}/${size}`);
  response.setHeader("Content-Length", String(chunk.length));
  response.send(chunk);
}

function getFirstUploadedFile(
  files: VideoUploadFiles | undefined,
  fieldName: keyof VideoUploadFiles,
): Express.Multer.File | undefined {
  return files?.[fieldName]?.[0];
}

@Catch(MulterError)
class DatabaseUploadMulterExceptionFilter implements ExceptionFilter {
  catch(exception: MulterError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const message =
      exception.code === "LIMIT_FILE_SIZE"
        ? `Database video file must be ${MAX_DATABASE_UPLOAD_LIMIT_MB}MB or smaller.`
        : exception.message || "Invalid database video upload.";

    response.status(HttpStatus.BAD_REQUEST).json({
      statusCode: HttpStatus.BAD_REQUEST,
      message,
      error: "Bad Request",
    });
  }
}

@Catch(MulterError)
class ThumbnailUploadMulterExceptionFilter implements ExceptionFilter {
  catch(exception: MulterError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const message =
      exception.code === "LIMIT_FILE_SIZE"
        ? `Thumbnail image file must be ${MAX_THUMBNAIL_UPLOAD_LIMIT_MB}MB or smaller.`
        : exception.message || "Invalid thumbnail upload.";

    response.status(HttpStatus.BAD_REQUEST).json({
      statusCode: HttpStatus.BAD_REQUEST,
      message,
      error: "Bad Request",
    });
  }
}

@ApiTags("admin-videos")
@ApiBearerAuth()
@UseGuards(AdminAccessTokenGuard)
@Controller("admin/videos")
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Get()
  @ApiOperation({
    summary: "List admin videos",
    description:
      "Returns paginated video metadata with optional search, status/provider filters, and sorting.",
  })
  @ApiOkResponse({ type: VideoListResponse })
  @ApiUnauthorizedResponse({
    description: "Missing, invalid, expired, or inactive access token.",
  })
  listVideos(@Query() query: ListVideosQueryDto): Promise<VideoListResponse> {
    return this.videosService.listVideos(query);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get admin video detail" })
  @ApiOkResponse({ type: VideoResponse })
  @ApiUnauthorizedResponse({
    description: "Missing, invalid, expired, or inactive access token.",
  })
  @ApiNotFoundResponse({ description: "Video not found." })
  getVideo(@Param("id") id: string): Promise<VideoResponse> {
    return this.videosService.getVideo(id);
  }

  @Get(":id/binary")
  @ApiOperation({
    summary: "Stream admin database-stored video binary",
    description:
      "Admin-only strict MVP playback endpoint for DB_BLOB videos. Supports Range requests and never exposes unauthenticated public raw video.",
  })
  @ApiOkResponse({
    description: "Full binary response when no Range header is supplied.",
  })
  @ApiUnauthorizedResponse({
    description: "Missing, invalid, expired, or inactive access token.",
  })
  @ApiNotFoundResponse({
    description: "Video binary asset not found.",
  })
  async streamDatabaseVideo(
    @Param("id") id: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const binary = await this.videosService.getDatabaseVideoBinary(id);

    streamDatabaseVideoBinary(binary, request.headers.range, response);
  }

  @Post()
  @ApiOperation({
    summary: "Create video metadata",
    description:
      "Creates a manual/provider-backed video metadata record without uploading video binary data.",
  })
  @ApiCreatedResponse({ type: VideoResponse })
  @ApiBadRequestResponse({ description: "Request body failed validation." })
  @ApiUnauthorizedResponse({
    description: "Missing, invalid, expired, or inactive access token.",
  })
  createVideo(
    @Body() dto: CreateVideoDto,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<VideoResponse> {
    return this.videosService.createVideo(dto, admin.id);
  }

  @Post("manual-with-thumbnail")
  @UseFilters(ThumbnailUploadMulterExceptionFilter)
  @UseInterceptors(
    FileInterceptor("thumbnailFile", {
      storage: memoryStorage(),
      limits: { fileSize: MAX_THUMBNAIL_UPLOAD_LIMIT_BYTES },
    }),
  )
  @ApiOperation({
    summary: "Create manual video metadata with optional thumbnail upload",
    description:
      "Multipart companion for POST /admin/videos. It uploads an optional thumbnail image to Cloudinary, then stores the returned secure URL on the video.",
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody({ type: CreateManualVideoWithThumbnailDto })
  @ApiCreatedResponse({ type: VideoResponse })
  @ApiBadRequestResponse({
    description:
      "Request body failed validation or thumbnail file is not an allowed image.",
  })
  @ApiUnauthorizedResponse({
    description: "Missing, invalid, expired, or inactive access token.",
  })
  createManualVideoWithThumbnail(
    @Body() dto: CreateManualVideoWithThumbnailDto,
    @UploadedFile() thumbnailFile: Express.Multer.File | undefined,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<VideoResponse> {
    return this.videosService.createVideo(dto, admin.id, thumbnailFile);
  }

  @Post("embed")
  @ApiOperation({
    summary: "Create video from embed code or embed URL",
    description:
      "Parses iframe HTML or an iframe src URL, validates the embed host, stores only normalized embed fields, and never stores raw iframe HTML.",
  })
  @ApiBody({
    type: CreateEmbedVideoDto,
    examples: {
      cloudinaryPlayer: {
        summary: "Cloudinary player iframe",
        value: {
          title: "Cloudinary player video",
          embedCodeOrUrl:
            '<iframe src="https://player.cloudinary.com/embed/?cloud_name=dekft3yz7&public_id=demo"></iframe>',
          viewCount: 1000,
          publishedAt: "2026-06-01T00:00:00.000Z",
        },
      },
    },
  })
  @ApiCreatedResponse({ type: VideoResponse })
  @ApiBadRequestResponse({
    description: "Invalid embed code, URL, provider metadata, or host.",
  })
  @ApiUnauthorizedResponse({
    description: "Missing, invalid, expired, or inactive access token.",
  })
  createEmbedVideo(
    @Body() dto: CreateEmbedVideoDto,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<VideoResponse> {
    return this.videosService.createEmbedVideo(dto, admin.id);
  }

  @Post("embed-with-thumbnail")
  @UseFilters(ThumbnailUploadMulterExceptionFilter)
  @UseInterceptors(
    FileInterceptor("thumbnailFile", {
      storage: memoryStorage(),
      limits: { fileSize: MAX_THUMBNAIL_UPLOAD_LIMIT_BYTES },
    }),
  )
  @ApiOperation({
    summary: "Create embed video with optional thumbnail upload",
    description:
      "Multipart companion for POST /admin/videos/embed. It uploads an optional thumbnail image to Cloudinary, then stores the returned secure URL on the video.",
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody({ type: CreateEmbedVideoWithThumbnailDto })
  @ApiCreatedResponse({ type: VideoResponse })
  @ApiBadRequestResponse({
    description:
      "Invalid embed code, URL, provider metadata, host, or thumbnail file.",
  })
  @ApiUnauthorizedResponse({
    description: "Missing, invalid, expired, or inactive access token.",
  })
  createEmbedVideoWithThumbnail(
    @Body() dto: CreateEmbedVideoWithThumbnailDto,
    @UploadedFile() thumbnailFile: Express.Multer.File | undefined,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<VideoResponse> {
    return this.videosService.createEmbedVideo(dto, admin.id, thumbnailFile);
  }

  @Post("upload")
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: "file", maxCount: 1 },
        { name: "thumbnailFile", maxCount: 1 },
      ],
      {
        storage: memoryStorage(),
        limits: { fileSize: DEFAULT_UPLOAD_LIMIT_BYTES },
      },
    ),
  )
  @ApiOperation({
    summary: "Upload video to Cloudinary",
    description:
      "Uploads a video file to Cloudinary, then stores returned public ID, secure playback URL, thumbnail URL, duration, and provider metadata.",
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody({ type: UploadVideoDto })
  @ApiCreatedResponse({ type: VideoResponse })
  @ApiBadRequestResponse({
    description: "Missing file, invalid video type, or failed validation.",
  })
  @ApiUnauthorizedResponse({
    description: "Missing, invalid, expired, or inactive access token.",
  })
  uploadVideo(
    @Body() dto: UploadVideoDto,
    @UploadedFiles() files: VideoUploadFiles | undefined,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<VideoResponse> {
    return this.videosService.uploadVideo(
      dto,
      getFirstUploadedFile(files, "file"),
      getFirstUploadedFile(files, "thumbnailFile"),
      admin.id,
    );
  }

  @Post("upload-db")
  @UseFilters(DatabaseUploadMulterExceptionFilter)
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: "file", maxCount: 1 },
        { name: "thumbnailFile", maxCount: 1 },
      ],
      {
        storage: diskStorage({
          destination: tmpdir(),
          filename: createDatabaseUploadFilename,
        }),
        // The service enforces VIDEO_DB_UPLOAD_MAX_MB. This decorator-level
        // Multer cap is the absolute transport ceiling because ConfigService is
        // not available inside the static interceptor metadata.
        limits: { fileSize: MAX_DATABASE_UPLOAD_LIMIT_BYTES },
      },
    ),
  )
  @ApiOperation({
    summary: "Upload small video into database fallback storage",
    description:
      "Strict MVP fallback. Disabled by default, limited to small files, stores binary data in VideoBinaryAsset, and does not expose public playback.",
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody({ type: UploadDatabaseVideoDto })
  @ApiCreatedResponse({ type: VideoResponse })
  @ApiBadRequestResponse({
    description:
      "Database storage disabled, missing file, invalid video type, file too large, or failed validation.",
  })
  @ApiUnauthorizedResponse({
    description: "Missing, invalid, expired, or inactive access token.",
  })
  uploadDatabaseVideo(
    @Body() dto: UploadDatabaseVideoDto,
    @UploadedFiles() files: VideoUploadFiles | undefined,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<VideoResponse> {
    return this.videosService.uploadDatabaseVideo(
      dto,
      getFirstUploadedFile(files, "file"),
      getFirstUploadedFile(files, "thumbnailFile"),
      admin.id,
    );
  }

  @Patch(":id/binary")
  @UseFilters(DatabaseUploadMulterExceptionFilter)
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: "file", maxCount: 1 },
        { name: "thumbnailFile", maxCount: 1 },
      ],
      {
        storage: diskStorage({
          destination: tmpdir(),
          filename: createDatabaseUploadFilename,
        }),
        limits: { fileSize: MAX_DATABASE_UPLOAD_LIMIT_BYTES },
      },
    ),
  )
  @ApiOperation({
    summary: "Replace database-stored video binary",
    description:
      "Admin-only DB_BLOB replacement endpoint. It keeps the VideoAsset id stable so existing share links point to the replacement binary.",
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody({ type: ReplaceDatabaseVideoBinaryDto })
  @ApiOkResponse({ type: VideoResponse })
  @ApiBadRequestResponse({
    description:
      "Database storage disabled, non-DB_BLOB video, missing file, invalid video type, or file too large.",
  })
  @ApiUnauthorizedResponse({
    description: "Missing, invalid, expired, or inactive access token.",
  })
  @ApiNotFoundResponse({ description: "Video not found." })
  replaceDatabaseVideoBinary(
    @Param("id") id: string,
    @Body() dto: ReplaceDatabaseVideoBinaryDto,
    @UploadedFiles() files: VideoUploadFiles | undefined,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<VideoResponse> {
    return this.videosService.replaceDatabaseVideoBinary(
      id,
      dto,
      getFirstUploadedFile(files, "file"),
      getFirstUploadedFile(files, "thumbnailFile"),
      admin.id,
    );
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update video metadata" })
  @ApiOkResponse({ type: VideoResponse })
  @ApiBadRequestResponse({ description: "Request body failed validation." })
  @ApiUnauthorizedResponse({
    description: "Missing, invalid, expired, or inactive access token.",
  })
  @ApiNotFoundResponse({ description: "Video not found." })
  updateVideo(
    @Param("id") id: string,
    @Body() dto: UpdateVideoDto,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<VideoResponse> {
    return this.videosService.updateVideo(id, dto, admin.id);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Disable video",
    description:
      "Soft-disables a video by setting status to DISABLED. It does not delete the database row or remote Cloudinary asset.",
  })
  @ApiOkResponse({ type: DisableVideoResponse })
  @ApiUnauthorizedResponse({
    description: "Missing, invalid, expired, or inactive access token.",
  })
  @ApiNotFoundResponse({ description: "Video not found." })
  disableVideo(
    @Param("id") id: string,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<DisableVideoResponse> {
    return this.videosService.disableVideo(id, admin.id);
  }

  @Post(":id/purge")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Permanently delete video",
    description:
      "Permanently deletes the video database row after explicit id confirmation and relation safety checks. Existing soft delete remains available through DELETE /admin/videos/:id.",
  })
  @ApiBody({
    type: PurgeVideoDto,
    examples: {
      dbOnly: {
        summary: "Delete only the database record",
        value: {
          confirmVideoId: "cm_video_123",
          deleteRemoteAsset: false,
        },
      },
      cloudinaryRemote: {
        summary: "Also attempt Cloudinary remote asset deletion",
        value: {
          confirmVideoId: "cm_video_123",
          deleteRemoteAsset: true,
        },
      },
    },
  })
  @ApiOkResponse({ type: PurgeVideoResponse })
  @ApiBadRequestResponse({
    description:
      "Confirmation mismatch or video is still assigned to websites/share links.",
  })
  @ApiUnauthorizedResponse({
    description: "Missing, invalid, expired, or inactive access token.",
  })
  @ApiNotFoundResponse({ description: "Video not found." })
  purgeVideo(
    @Param("id") id: string,
    @Body() dto: PurgeVideoDto,
    @CurrentAdmin() admin: SafeAdminResponse,
  ): Promise<PurgeVideoResponse> {
    return this.videosService.purgeVideo(id, dto, admin.id);
  }
}

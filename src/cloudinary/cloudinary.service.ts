import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { v2 as cloudinary } from "cloudinary";
import type { UploadApiResponse } from "cloudinary";
import { Readable } from "node:stream";
import type {
  CloudinaryImageUploadInput,
  CloudinaryImageUploadResult,
  CloudinaryUploadResult,
} from "./types/cloudinary-upload-result.type";

type UploadVideoInput = {
  fileBuffer: Buffer;
  originalFilename: string;
  title: string;
  description?: string | undefined;
  tags: string[];
};

type CloudinaryConfig = {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  folder: string;
  secure: boolean;
};

type CloudinaryDestroyResponse = {
  result?: string;
};

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);

  constructor(private readonly configService: ConfigService) {}

  getCloudName(): string {
    return this.readRequiredString("CLOUDINARY_CLOUD_NAME");
  }

  buildVideoThumbnailUrl(publicId: string): string | null {
    const cloudName = this.configService.get<string>("CLOUDINARY_CLOUD_NAME");
    if (cloudName === undefined || cloudName.trim() === "") {
      return null;
    }

    const encodedPublicId = publicId
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");

    return `https://res.cloudinary.com/${encodeURIComponent(
      cloudName.trim(),
    )}/video/upload/so_1,w_640,c_fill/${encodedPublicId}.jpg`;
  }

  async uploadVideo(input: UploadVideoInput): Promise<CloudinaryUploadResult> {
    const config = this.readConfig();

    cloudinary.config({
      cloud_name: config.cloudName,
      api_key: config.apiKey,
      api_secret: config.apiSecret,
      secure: config.secure,
    });

    try {
      const response = await this.uploadBuffer(input, config.folder);
      return this.toUploadResult(response);
    } catch (error) {
      this.logger.error(
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage:
            error instanceof Error ? error.message : "Unknown error",
        },
        "Cloudinary video upload failed.",
      );
      throw new InternalServerErrorException(
        "Video upload failed. Please try again.",
      );
    }
  }

  async uploadImage(
    input: CloudinaryImageUploadInput,
  ): Promise<CloudinaryImageUploadResult> {
    const config = this.readConfig();
    const folder =
      input.folder?.trim() ||
      this.readString(
        "CLOUDINARY_THUMBNAIL_UPLOAD_FOLDER",
        `${config.folder.replace(/\/+$/g, "")}/thumbnails`,
      );

    cloudinary.config({
      cloud_name: config.cloudName,
      api_key: config.apiKey,
      api_secret: config.apiSecret,
      secure: config.secure,
    });

    try {
      const response = await this.uploadImageBuffer(input, folder);
      return this.toImageUploadResult(response);
    } catch (error) {
      this.logger.error(
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage:
            error instanceof Error ? error.message : "Unknown error",
        },
        "Cloudinary image upload failed.",
      );
      throw new InternalServerErrorException(
        "Thumbnail upload failed. Please try again.",
      );
    }
  }

  async deleteVideoAsset(publicId: string): Promise<boolean> {
    const config = this.readConfig();

    cloudinary.config({
      cloud_name: config.cloudName,
      api_key: config.apiKey,
      api_secret: config.apiSecret,
      secure: config.secure,
    });

    try {
      const response = (await cloudinary.uploader.destroy(publicId, {
        invalidate: false,
        resource_type: "video",
      })) as CloudinaryDestroyResponse;

      return response.result === "ok" || response.result === "not found";
    } catch (error) {
      this.logger.error(
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "Cloudinary video asset deletion failed.",
      );
      throw new InternalServerErrorException(
        "Remote video asset deletion failed.",
      );
    }
  }

  async deleteImage(publicId: string): Promise<boolean> {
    const config = this.readConfig();

    cloudinary.config({
      cloud_name: config.cloudName,
      api_key: config.apiKey,
      api_secret: config.apiSecret,
      secure: config.secure,
    });

    try {
      const response = (await cloudinary.uploader.destroy(publicId, {
        invalidate: false,
        resource_type: "image",
      })) as CloudinaryDestroyResponse;

      return response.result === "ok" || response.result === "not found";
    } catch (error) {
      this.logger.warn(
        {
          publicId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "Cloudinary image deletion failed.",
      );

      return false;
    }
  }

  private uploadBuffer(
    input: UploadVideoInput,
    folder: string,
  ): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: "video",
          folder,
          tags: input.tags,
          context: {
            title: input.title,
            ...(input.description ? { description: input.description } : {}),
            original_filename: input.originalFilename,
          },
        },
        (error, result) => {
          if (error !== undefined) {
            reject(error);
            return;
          }

          if (result === undefined) {
            reject(new Error("Cloudinary upload returned no result."));
            return;
          }

          resolve(result);
        },
      );

      Readable.from(input.fileBuffer).pipe(uploadStream);
    });
  }

  private uploadImageBuffer(
    input: CloudinaryImageUploadInput,
    folder: string,
  ): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: "image",
          folder,
          tags: Array.from(
            new Set(["video-share-cms", "thumbnail", ...(input.tags ?? [])]),
          ),
          context: {
            original_filename: input.originalFilename,
          },
        },
        (error, result) => {
          if (error !== undefined) {
            reject(error);
            return;
          }

          if (result === undefined) {
            reject(new Error("Cloudinary image upload returned no result."));
            return;
          }

          resolve(result);
        },
      );

      Readable.from(input.fileBuffer).pipe(uploadStream);
    });
  }

  private readConfig(): CloudinaryConfig {
    return {
      cloudName: this.readRequiredString("CLOUDINARY_CLOUD_NAME"),
      apiKey: this.readRequiredString("CLOUDINARY_API_KEY"),
      apiSecret: this.readRequiredString("CLOUDINARY_API_SECRET"),
      folder: this.readString(
        "CLOUDINARY_UPLOAD_FOLDER",
        "video-share-cms/videos",
      ),
      secure: this.readBoolean("CLOUDINARY_SECURE", true),
    };
  }

  private readRequiredString(key: string): string {
    const value = this.configService.get<string>(key);
    if (value === undefined || value.trim() === "") {
      throw new InternalServerErrorException(`${key} is not configured.`);
    }

    return value.trim();
  }

  private readString(key: string, fallback: string): string {
    const value = this.configService.get<string>(key);
    if (value === undefined || value.trim() === "") {
      return fallback;
    }

    return value.trim();
  }

  private readBoolean(key: string, fallback: boolean): boolean {
    const value = this.configService.get<string>(key);
    if (value === undefined || value.trim() === "") {
      return fallback;
    }

    return value === "true" || value === "1";
  }

  private toUploadResult(response: UploadApiResponse): CloudinaryUploadResult {
    return {
      assetId: response.asset_id,
      publicId: response.public_id,
      version: response.version,
      format: response.format,
      resourceType: response.resource_type,
      bytes: response.bytes,
      width: response.width,
      height: response.height,
      duration: response.duration,
      originalFilename: response.original_filename,
      secureUrl: response.secure_url,
    };
  }

  private toImageUploadResult(
    response: UploadApiResponse,
  ): CloudinaryImageUploadResult {
    if (!response.secure_url || !response.secure_url.startsWith("https://")) {
      throw new Error("Cloudinary image upload returned no secure URL.");
    }

    return {
      assetId: response.asset_id,
      publicId: response.public_id,
      version: response.version,
      format: response.format,
      resourceType: response.resource_type,
      bytes: response.bytes,
      width: response.width,
      height: response.height,
      secureUrl: response.secure_url,
    };
  }
}

import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  statSync,
  statfsSync,
  type ReadStream,
  type WriteStream,
} from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import { once } from "node:events";
import type { ApiEnvironmentConfig } from "../../config/env.config";

export type LocalStorageRangeResult = {
  statusCode: 200 | 206 | 416;
  contentLength: number;
  contentRange: string | null;
  stream: ReadStream | null;
};

export type LocalStoredFileResult = {
  storageKey: string;
  sizeBytes: bigint;
  checksumSha256: string;
};

type LocalStorageConfig = ApiEnvironmentConfig["localFileStorage"];

const SAFE_EXTENSION_PATTERN = /^\.[a-z0-9]{1,12}$/i;
const STORAGE_KEY_SEGMENT_PATTERN = /^[a-zA-Z0-9._-]+$/;

@Injectable()
export class LocalVideoStorageService {
  private readonly logger = new Logger(LocalVideoStorageService.name);

  constructor(private readonly configService: ConfigService) {}

  assertEnabled(): void {
    if (!this.getConfig().enabled) {
      throw new BadRequestException("Local video storage is disabled.");
    }
  }

  getUploadMaxBytes(): number {
    return this.getConfig().videoUploadMaxMb * 1024 * 1024;
  }

  getChunkSizeBytes(): number {
    return this.getConfig().videoChunkSizeMb * 1024 * 1024;
  }

  getThumbnailMaxBytes(): number {
    return this.getConfig().thumbnailUploadMaxMb * 1024 * 1024;
  }

  getUploadSessionTtlMinutes(): number {
    return this.getConfig().uploadSessionTtlMinutes;
  }

  getStaleUploadMaxAgeHours(): number {
    return this.getConfig().staleUploadMaxAgeHours;
  }

  buildUploadTempKey(uploadId: string): string {
    return this.joinStorageKey("tmp", "uploads", uploadId);
  }

  buildFinalVideoKey(videoId: string, originalFilename: string): string {
    return this.joinStorageKey(
      "videos",
      videoId,
      "source",
      `${randomUUID()}${this.safeExtension(originalFilename)}`,
    );
  }

  buildThumbnailKey(videoId: string, originalFilename: string): string {
    return this.joinStorageKey(
      "videos",
      videoId,
      "thumbnails",
      `${randomUUID()}${this.safeExtension(originalFilename)}`,
    );
  }

  buildChunkKey(tempStorageKey: string, chunkIndex: number): string {
    return this.joinStorageKey(tempStorageKey, `chunk-${chunkIndex}`);
  }

  async ensureRootReady(): Promise<void> {
    this.assertEnabled();
    const root = this.getRoot();
    await mkdir(root, { recursive: true });
    await this.ensureMinimumFreeSpace(root);
  }

  async ensureDirectoryForKey(storageKey: string): Promise<void> {
    await mkdir(dirname(this.resolveStoragePath(storageKey)), {
      recursive: true,
    });
  }

  async saveUploadedChunk(params: {
    temporaryPath: string;
    tempStorageKey: string;
    chunkIndex: number;
  }): Promise<LocalStoredFileResult> {
    const storageKey = this.buildChunkKey(
      params.tempStorageKey,
      params.chunkIndex,
    );

    await this.ensureDirectoryForKey(storageKey);
    await this.moveOrCopy(
      params.temporaryPath,
      this.resolveStoragePath(storageKey),
    );

    const info = await this.statStorageKey(storageKey);
    const checksumSha256 = await this.computeFileChecksum(storageKey);

    return {
      storageKey,
      sizeBytes: BigInt(info.size),
      checksumSha256,
    };
  }

  async mergeChunksToFinalFile(params: {
    tempStorageKey: string;
    totalChunks: number;
    finalStorageKey: string;
  }): Promise<LocalStoredFileResult> {
    await this.ensureDirectoryForKey(params.finalStorageKey);

    const outputPath = this.resolveStoragePath(params.finalStorageKey);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const output = createWriteStream(outputPath, { flags: "wx" });

    try {
      for (let index = 0; index < params.totalChunks; index += 1) {
        const chunkKey = this.buildChunkKey(params.tempStorageKey, index);
        const chunkPath = this.resolveStoragePath(chunkKey);
        const input = createReadStream(chunkPath);

        for await (const chunk of input) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          hash.update(buffer);
          sizeBytes += buffer.length;
          if (!output.write(buffer)) {
            await once(output, "drain");
          }
        }

        await unlink(chunkPath);
      }

      await this.closeWriteStream(output);

      return {
        storageKey: params.finalStorageKey,
        sizeBytes: BigInt(sizeBytes),
        checksumSha256: hash.digest("hex"),
      };
    } catch (error) {
      output.destroy();
      await this.deleteStorageKeyBestEffort(params.finalStorageKey);
      throw error;
    }
  }

  async storeThumbnailFile(params: {
    temporaryPath: string;
    storageKey: string;
  }): Promise<LocalStoredFileResult> {
    await this.ensureDirectoryForKey(params.storageKey);
    await this.moveOrCopy(
      params.temporaryPath,
      this.resolveStoragePath(params.storageKey),
    );

    const info = await this.statStorageKey(params.storageKey);
    const checksumSha256 = await this.computeFileChecksum(params.storageKey);

    return {
      storageKey: params.storageKey,
      sizeBytes: BigInt(info.size),
      checksumSha256,
    };
  }

  async readMagicBytes(storageKey: string, byteCount = 16): Promise<Buffer> {
    const stream = createReadStream(this.resolveStoragePath(storageKey), {
      start: 0,
      end: Math.max(byteCount - 1, 0),
    });
    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  }

  async statStorageKey(storageKey: string): Promise<{ size: number }> {
    const info = await stat(this.resolveStoragePath(storageKey));
    if (!info.isFile()) {
      throw new BadRequestException("Stored file is unavailable.");
    }

    return { size: info.size };
  }

  createRangeReadStream(params: {
    storageKey: string;
    rangeHeader?: string | undefined;
  }): LocalStorageRangeResult {
    const filePath = this.resolveStoragePath(params.storageKey);
    const fileSize = this.getFileSizeSync(filePath);
    const range = this.parseRangeHeader(params.rangeHeader, fileSize);

    if (range === null) {
      return {
        statusCode: 416,
        contentLength: 0,
        contentRange: `bytes */${fileSize}`,
        stream: null,
      };
    }

    return {
      statusCode: range.statusCode,
      contentLength: range.length,
      contentRange:
        range.statusCode === 206
          ? `bytes ${range.start}-${range.end}/${fileSize}`
          : null,
      stream: createReadStream(filePath, {
        start: range.start,
        end: range.end,
      }),
    };
  }

  createFullReadStream(storageKey: string): {
    stream: ReadStream;
    contentLength: number;
  } {
    const filePath = this.resolveStoragePath(storageKey);
    return {
      stream: createReadStream(filePath),
      contentLength: this.getFileSizeSync(filePath),
    };
  }

  async deleteStorageKeyBestEffort(
    storageKey: string | null | undefined,
  ): Promise<boolean> {
    if (!storageKey) {
      return false;
    }

    try {
      await unlink(this.resolveStoragePath(storageKey));
      await this.pruneEmptyParents(storageKey);
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return false;
      }

      this.logger.warn(
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "Local video storage file cleanup failed.",
      );
      return false;
    }
  }

  async deleteDirectoryBestEffort(
    storageKey: string | null | undefined,
  ): Promise<boolean> {
    if (!storageKey) {
      return false;
    }

    try {
      await rm(this.resolveStoragePath(storageKey), {
        recursive: true,
        force: true,
      });
      await this.pruneEmptyParents(storageKey);
      return true;
    } catch (error) {
      this.logger.warn(
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "Local video storage directory cleanup failed.",
      );
      return false;
    }
  }

  sanitizeOriginalFilename(value: string): string {
    const name = basename(value.trim()).replace(/[\r\n\t]/g, " ");
    if (name.length === 0 || name === "." || name === "..") {
      throw new BadRequestException("Original filename is invalid.");
    }

    if (name.length > 255) {
      throw new BadRequestException("Original filename is too long.");
    }

    if (/[<>:"|?*\u0000-\u001f]/.test(name)) {
      throw new BadRequestException(
        "Original filename contains invalid characters.",
      );
    }

    return name;
  }

  resolveStoragePath(storageKey: string): string {
    const root = this.getRoot();
    const normalizedKey = this.normalizeStorageKey(storageKey);
    const absolutePath = resolve(root, normalizedKey);
    const relativePath = relative(root, absolutePath);

    if (
      relativePath === "" ||
      relativePath.startsWith("..") ||
      isAbsolute(relativePath)
    ) {
      throw new BadRequestException("Storage key is invalid.");
    }

    return absolutePath;
  }

  normalizeStorageKey(storageKey: string): string {
    const normalized = storageKey.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const parts = normalized.split("/").filter((part) => part.length > 0);

    if (parts.length === 0) {
      throw new BadRequestException("Storage key is invalid.");
    }

    for (const part of parts) {
      if (
        part === "." ||
        part === ".." ||
        !STORAGE_KEY_SEGMENT_PATTERN.test(part)
      ) {
        throw new BadRequestException("Storage key is invalid.");
      }
    }

    return parts.join("/");
  }

  private getConfig(): LocalStorageConfig {
    return this.configService.getOrThrow<ApiEnvironmentConfig>("api")
      .localFileStorage;
  }

  private getRoot(): string {
    const root = this.getConfig().root;

    if (root === null || root.trim() === "") {
      throw new InternalServerErrorException(
        "Local video storage root is not configured.",
      );
    }

    return resolve(root);
  }

  private joinStorageKey(...parts: string[]): string {
    return this.normalizeStorageKey(parts.join("/"));
  }

  private safeExtension(originalFilename: string): string {
    const extension = extname(originalFilename).toLowerCase();
    return SAFE_EXTENSION_PATTERN.test(extension) ? extension : "";
  }

  private async moveOrCopy(
    sourcePath: string,
    destinationPath: string,
  ): Promise<void> {
    try {
      await rename(sourcePath, destinationPath);
    } catch {
      await copyFile(sourcePath, destinationPath);
      await unlink(sourcePath);
    }
  }

  private async computeFileChecksum(storageKey: string): Promise<string> {
    const hash = createHash("sha256");

    for await (const chunk of createReadStream(
      this.resolveStoragePath(storageKey),
    )) {
      hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return hash.digest("hex");
  }

  private async closeWriteStream(output: WriteStream): Promise<void> {
    output.end();
    await once(output, "finish");
  }

  private getFileSizeSync(filePath: string): number {
    const info = statSync(filePath);
    if (!info.isFile()) {
      throw new BadRequestException("Stored file is unavailable.");
    }
    return info.size;
  }

  private parseRangeHeader(
    rangeHeader: string | undefined,
    totalSize: number,
  ): {
    statusCode: 200 | 206;
    start: number;
    end: number;
    length: number;
  } | null {
    if (totalSize <= 0) {
      return {
        statusCode: 200,
        start: 0,
        end: 0,
        length: 0,
      };
    }

    if (rangeHeader === undefined || rangeHeader.trim() === "") {
      return {
        statusCode: 200,
        start: 0,
        end: totalSize - 1,
        length: totalSize,
      };
    }

    const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (rangeMatch === null) {
      return null;
    }

    const [, rawStart, rawEnd] = rangeMatch;
    if (rawStart === "" && rawEnd === "") {
      return null;
    }

    let start: number;
    let end: number;

    if (rawStart === "") {
      const suffixLength = Number(rawEnd);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
        return null;
      }
      start = Math.max(totalSize - suffixLength, 0);
      end = totalSize - 1;
    } else {
      start = Number(rawStart);
      end = rawEnd === "" ? totalSize - 1 : Number(rawEnd);
    }

    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      start >= totalSize
    ) {
      return null;
    }

    const boundedEnd = Math.min(end, totalSize - 1);

    return {
      statusCode: 206,
      start,
      end: boundedEnd,
      length: boundedEnd - start + 1,
    };
  }

  private async ensureMinimumFreeSpace(root: string): Promise<void> {
    try {
      const statfs = statfsSync(root);
      const availableBytes = statfs.bavail * statfs.bsize;
      const minimumBytes = this.getConfig().minFreeSpaceMb * 1024 * 1024;
      if (availableBytes < minimumBytes) {
        throw new BadRequestException(
          "Local video storage free space is too low.",
        );
      }
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.warn(
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "Could not verify local video storage free space.",
      );
    }
  }

  private async pruneEmptyParents(storageKey: string): Promise<void> {
    const root = this.getRoot();
    let current = resolve(this.resolveStoragePath(storageKey), "..");

    while (relative(root, current) !== "") {
      try {
        const entries = await readdir(current);
        if (entries.length > 0) {
          return;
        }
        await rm(current, { force: true });
        current = resolve(current, "..");
      } catch {
        return;
      }
    }
  }
}

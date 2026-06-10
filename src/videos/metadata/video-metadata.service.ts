import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { lookup } from "node:dns/promises";
import { open, stat } from "node:fs/promises";
import { isIP } from "node:net";

export type ProbedVideoMetadata = {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
};

const EMPTY_METADATA: ProbedVideoMetadata = {
  durationSeconds: null,
  width: null,
  height: null,
};

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_REMOTE_MB = 100;
const PROBE_CHUNK_BYTES = 1024 * 1024;
const BOX_HEADER_BYTES = 8;
const LARGE_BOX_HEADER_BYTES = 16;

@Injectable()
export class VideoMetadataService {
  private readonly logger = new Logger(VideoMetadataService.name);

  constructor(private readonly configService: ConfigService) {}

  async probeLocalVideoFile(path: string): Promise<ProbedVideoMetadata> {
    if (!this.isProbeEnabled()) {
      return EMPTY_METADATA;
    }

    try {
      const fileStat = await stat(path);
      if (!fileStat.isFile() || fileStat.size <= 0) {
        return EMPTY_METADATA;
      }

      const handle = await open(path, "r");
      try {
        const head = await this.readLocalRange(handle, 0, PROBE_CHUNK_BYTES);
        const headMetadata = this.parseMp4Metadata(head);
        if (headMetadata.durationSeconds !== null) {
          return headMetadata;
        }

        if (fileStat.size <= PROBE_CHUNK_BYTES) {
          return EMPTY_METADATA;
        }

        const tailStart = Math.max(0, fileStat.size - PROBE_CHUNK_BYTES);
        const tail = await this.readLocalRange(
          handle,
          tailStart,
          PROBE_CHUNK_BYTES,
        );

        return this.parseMp4Metadata(tail);
      } finally {
        await handle.close();
      }
    } catch (error) {
      this.logProbeFailure("local", error);
      return EMPTY_METADATA;
    }
  }

  async probeRemoteVideoUrl(urlValue: string): Promise<ProbedVideoMetadata> {
    if (!this.isProbeEnabled()) {
      return EMPTY_METADATA;
    }

    try {
      const url = this.parseSafeRemoteUrl(urlValue);
      await this.ensurePublicHost(url.hostname);

      const timeoutMs = this.getProbeTimeoutMs();
      const maxRemoteBytes = this.getMaxRemoteBytes();
      const headResponse = await this.fetchWithTimeout(url, {
        method: "HEAD",
        timeoutMs,
      });

      if (!headResponse.ok) {
        return EMPTY_METADATA;
      }

      const contentLength = this.parseContentLength(headResponse);
      if (contentLength !== null && contentLength > maxRemoteBytes) {
        return EMPTY_METADATA;
      }

      const firstChunk = await this.fetchRange(url, 0, PROBE_CHUNK_BYTES - 1);
      const firstMetadata = this.parseMp4Metadata(firstChunk);
      if (firstMetadata.durationSeconds !== null) {
        return firstMetadata;
      }

      if (contentLength === null || contentLength <= PROBE_CHUNK_BYTES) {
        return EMPTY_METADATA;
      }

      const tailStart = Math.max(0, contentLength - PROBE_CHUNK_BYTES);
      const tailChunk = await this.fetchRange(
        url,
        tailStart,
        contentLength - 1,
      );

      return this.parseMp4Metadata(tailChunk);
    } catch (error) {
      this.logProbeFailure("remote", error);
      return EMPTY_METADATA;
    }
  }

  private async readLocalRange(
    handle: Awaited<ReturnType<typeof open>>,
    position: number,
    length: number,
  ): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, result.bytesRead);
  }

  private parseSafeRemoteUrl(value: string): URL {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Unsupported video metadata probe URL protocol.");
    }

    if (url.username !== "" || url.password !== "") {
      throw new Error("Video metadata probe URL credentials are not allowed.");
    }

    return url;
  }

  private async ensurePublicHost(hostname: string): Promise<void> {
    if (this.isBlockedHostname(hostname)) {
      throw new Error("Video metadata probe host is not public.");
    }

    const records = await lookup(hostname, { all: true, verbatim: true });
    if (records.length === 0) {
      throw new Error("Video metadata probe host could not be resolved.");
    }

    if (records.some((record) => this.isBlockedIp(record.address))) {
      throw new Error("Video metadata probe resolved to a private address.");
    }
  }

  private isBlockedHostname(hostname: string): boolean {
    const normalized = hostname.trim().toLowerCase();
    return (
      normalized === "localhost" ||
      normalized.endsWith(".localhost") ||
      normalized === "0.0.0.0" ||
      normalized === "::" ||
      normalized === "::1"
    );
  }

  private isBlockedIp(value: string): boolean {
    if (isIP(value) === 4) {
      return this.isBlockedIpv4(value);
    }

    if (isIP(value) === 6) {
      return this.isBlockedIpv6(value);
    }

    return true;
  }

  private isBlockedIpv4(value: string): boolean {
    const parts = value.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
      return true;
    }

    const [a = 0, b = 0, c = 0] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }

  private isBlockedIpv6(value: string): boolean {
    const normalized = value.toLowerCase();
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:") ||
      normalized.startsWith("::ffff:0:") ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.") ||
      /^::ffff:172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)
    );
  }

  private async fetchRange(
    url: URL,
    start: number,
    end: number,
  ): Promise<Buffer> {
    const response = await this.fetchWithTimeout(url, {
      headers: { Range: `bytes=${start}-${end}` },
      method: "GET",
      timeoutMs: this.getProbeTimeoutMs(),
    });

    if (response.status !== 206) {
      throw new Error("Video metadata probe requires ranged responses.");
    }

    const contentRangeTotal = this.parseContentRangeTotal(response);
    if (
      contentRangeTotal !== null &&
      contentRangeTotal > this.getMaxRemoteBytes()
    ) {
      throw new Error("Video metadata probe remote resource is too large.");
    }

    const contentLength = this.parseContentLength(response);
    if (contentLength !== null && contentLength > PROBE_CHUNK_BYTES) {
      throw new Error("Video metadata probe range response is too large.");
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > PROBE_CHUNK_BYTES) {
      throw new Error("Video metadata probe downloaded too many bytes.");
    }

    return Buffer.from(arrayBuffer);
  }

  private fetchWithTimeout(
    url: URL,
    options: {
      method: "HEAD" | "GET";
      headers?: Record<string, string> | undefined;
      timeoutMs: number;
    },
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    const requestInit: RequestInit = {
      method: options.method,
      redirect: "manual",
      signal: controller.signal,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
    };

    return fetch(url, requestInit).finally(() => clearTimeout(timeout));
  }

  private parseContentLength(response: Response): number | null {
    const value = response.headers.get("content-length");
    if (value === null || value.trim() === "") {
      return null;
    }

    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  private parseContentRangeTotal(response: Response): number | null {
    const value = response.headers.get("content-range");
    if (value === null || value.trim() === "") {
      return null;
    }

    const match = /\/(\d+)$/.exec(value.trim());
    if (match === null) {
      return null;
    }

    const parsed = Number(match[1]);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  private parseMp4Metadata(buffer: Buffer): ProbedVideoMetadata {
    const durationSeconds =
      this.findMp4DurationFromBoxes(buffer) ??
      this.findMp4DurationBySignature(buffer);

    return {
      durationSeconds,
      width: null,
      height: null,
    };
  }

  private findMp4DurationFromBoxes(buffer: Buffer): number | null {
    return this.findMp4DurationInRange(buffer, 0, buffer.length, 0);
  }

  private findMp4DurationInRange(
    buffer: Buffer,
    start: number,
    end: number,
    depth: number,
  ): number | null {
    if (depth > 4) {
      return null;
    }

    let offset = start;
    while (offset + BOX_HEADER_BYTES <= end) {
      const box = this.readBoxHeader(buffer, offset, end);
      if (box === null || box.size <= 0) {
        return null;
      }

      if (box.type === "mvhd") {
        return this.parseMvhdDuration(buffer, offset, box.size);
      }

      if (this.isContainerBox(box.type)) {
        const nestedDuration = this.findMp4DurationInRange(
          buffer,
          offset + box.headerSize,
          offset + box.size,
          depth + 1,
        );
        if (nestedDuration !== null) {
          return nestedDuration;
        }
      }

      offset += box.size;
    }

    return null;
  }

  private readBoxHeader(
    buffer: Buffer,
    offset: number,
    end: number,
  ): { size: number; type: string; headerSize: number } | null {
    if (offset + BOX_HEADER_BYTES > end) {
      return null;
    }

    const smallSize = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (!/^[\x20-\x7E]{4}$/.test(type)) {
      return null;
    }

    if (smallSize === 0) {
      return {
        size: end - offset,
        type,
        headerSize: BOX_HEADER_BYTES,
      };
    }

    if (smallSize === 1) {
      if (offset + LARGE_BOX_HEADER_BYTES > end) {
        return null;
      }

      const largeSize = buffer.readBigUInt64BE(offset + 8);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        return null;
      }

      const size = Number(largeSize);
      if (size < LARGE_BOX_HEADER_BYTES || offset + size > end) {
        return null;
      }

      return { size, type, headerSize: LARGE_BOX_HEADER_BYTES };
    }

    if (smallSize < BOX_HEADER_BYTES || offset + smallSize > end) {
      return null;
    }

    return {
      size: smallSize,
      type,
      headerSize: BOX_HEADER_BYTES,
    };
  }

  private isContainerBox(type: string): boolean {
    return ["moov", "trak", "mdia", "minf", "stbl", "edts", "udta"].includes(
      type,
    );
  }

  private findMp4DurationBySignature(buffer: Buffer): number | null {
    for (
      let offset = 4;
      offset + BOX_HEADER_BYTES < buffer.length;
      offset += 1
    ) {
      if (buffer.toString("ascii", offset, offset + 4) !== "mvhd") {
        continue;
      }

      const boxStart = offset - 4;
      const size = buffer.readUInt32BE(boxStart);
      if (size >= BOX_HEADER_BYTES && boxStart + size <= buffer.length) {
        const duration = this.parseMvhdDuration(buffer, boxStart, size);
        if (duration !== null) {
          return duration;
        }
      }
    }

    return null;
  }

  private parseMvhdDuration(
    buffer: Buffer,
    boxStart: number,
    boxSize: number,
  ): number | null {
    const versionOffset = boxStart + BOX_HEADER_BYTES;
    if (versionOffset >= buffer.length) {
      return null;
    }

    const version = buffer.readUInt8(versionOffset);
    if (version === 0) {
      const timescaleOffset = boxStart + 20;
      const durationOffset = boxStart + 24;
      if (durationOffset + 4 > boxStart + boxSize) {
        return null;
      }

      return this.normalizeDurationSeconds(
        buffer.readUInt32BE(durationOffset),
        buffer.readUInt32BE(timescaleOffset),
      );
    }

    if (version === 1) {
      const timescaleOffset = boxStart + 28;
      const durationOffset = boxStart + 32;
      if (durationOffset + 8 > boxStart + boxSize) {
        return null;
      }

      const duration = buffer.readBigUInt64BE(durationOffset);
      if (duration > BigInt(Number.MAX_SAFE_INTEGER)) {
        return null;
      }

      return this.normalizeDurationSeconds(
        Number(duration),
        buffer.readUInt32BE(timescaleOffset),
      );
    }

    return null;
  }

  private normalizeDurationSeconds(
    duration: number,
    timescale: number,
  ): number | null {
    if (
      !Number.isFinite(duration) ||
      !Number.isFinite(timescale) ||
      duration <= 0 ||
      timescale <= 0
    ) {
      return null;
    }

    const seconds = Math.round(duration / timescale);
    return seconds > 0 && seconds <= 2147483647 ? seconds : null;
  }

  private isProbeEnabled(): boolean {
    const value = this.configService.get<boolean | string>(
      "VIDEO_METADATA_PROBE_ENABLED",
    );
    if (typeof value === "boolean") {
      return value;
    }

    if (value === undefined || value.trim() === "") {
      return true;
    }

    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1";
  }

  private getProbeTimeoutMs(): number {
    const value = Number(
      this.configService.get<string>("VIDEO_METADATA_PROBE_TIMEOUT_MS") ??
        DEFAULT_TIMEOUT_MS,
    );

    return Number.isInteger(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
  }

  private getMaxRemoteBytes(): number {
    const value = Number(
      this.configService.get<string>("VIDEO_METADATA_PROBE_MAX_REMOTE_MB") ??
        DEFAULT_MAX_REMOTE_MB,
    );
    const megabytes =
      Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_REMOTE_MB;

    return megabytes * 1024 * 1024;
  }

  private logProbeFailure(kind: "local" | "remote", error: unknown): void {
    this.logger.debug(
      {
        kind,
        errorName: error instanceof Error ? error.name : "UnknownError",
      },
      "Video metadata probe failed.",
    );
  }
}

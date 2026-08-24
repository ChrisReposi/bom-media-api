import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import {
  BUNNY_FAILED_STATUSES,
  BUNNY_READY_STATUSES,
  BUNNY_STREAM_API_BASE_URL,
  BUNNY_STREAM_EMBED_BASE_URL,
  BUNNY_STREAM_REQUEST_TIMEOUT_MS,
  BUNNY_STREAM_TUS_ENDPOINT,
  DEFAULT_BUNNY_EMBED_TOKEN_TTL_SECONDS,
  DEFAULT_BUNNY_THUMBNAIL_TIME_MS,
  DEFAULT_BUNNY_TUS_TTL_SECONDS,
  MAX_BUNNY_EMBED_TOKEN_TTL_SECONDS,
  MAX_BUNNY_TUS_TTL_SECONDS,
  MIN_BUNNY_EMBED_TOKEN_TTL_SECONDS,
  MIN_BUNNY_TUS_TTL_SECONDS,
} from "./bunny-stream.constants";
import {
  isBunnyPullZoneHostname,
  isSafeBunnyFileName,
  isSafeBunnyPathSegment,
} from "./bunny-thumbnail.util";
import type {
  BunnyEmbedPlayerParams,
  BunnyProcessingState,
  BunnySignedEmbed,
  BunnyTusUploadCredentials,
  BunnyVideo,
} from "./types/bunny-stream.type";

type BunnyRequestInit = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
  /**
   * Raw bytes to send as `application/octet-stream` instead of a JSON body.
   *
   * Used by Set Thumbnail, which takes the image file itself. Mutually
   * exclusive with `body`; the bytes are never logged.
   */
  binaryBody?: Buffer;
};

/** Internal marker for a Bunny 404. Never surfaced to a client. */
export class BunnyNotFoundError extends Error {
  constructor() {
    super("Bunny Stream resource not found.");
    this.name = "BunnyNotFoundError";
  }
}

/**
 * Bunny Stream management client.
 *
 * SECRET BOUNDARY. `BUNNY_STREAM_API_KEY` and
 * `BUNNY_STREAM_TOKEN_SECURITY_KEY` are read here and nowhere else. Neither is
 * ever returned from a method, placed in an exception message, or logged. Only
 * values derived from them leave this class - a TUS signature and an embed
 * token - and both are short lived.
 */
@Injectable()
export class BunnyStreamService {
  private readonly logger = new Logger(BunnyStreamService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Whether Bunny Stream is turned on for this deployment. Every other method
   * assumes the caller checked this first.
   */
  isEnabled(): boolean {
    const value = this.configService.get<string>("BUNNY_STREAM_ENABLED");

    return value === "true" || value === "1";
  }

  /**
   * Throws the standard "Bunny is off" error. Kept in one place so every entry
   * point produces an identical, secret-free message.
   */
  ensureEnabled(): void {
    if (!this.isEnabled()) {
      throw new BadRequestException("Bunny Stream is not enabled.");
    }
  }

  getLibraryId(): string {
    return this.readRequiredString("BUNNY_STREAM_LIBRARY_ID");
  }

  /**
   * POST /library/{libraryId}/videos
   *
   * `thumbnailTime` is Bunny's documented "video time in ms to extract the main
   * video thumbnail". Sending it means every Bunny upload gets an automatic
   * poster during encoding, so a video with no operator-supplied image is never
   * left without one. Callers that pass nothing get the project default.
   */
  async createVideo(
    title: string,
    options: { thumbnailTimeMs?: number } = {},
  ): Promise<BunnyVideo> {
    this.ensureEnabled();
    const libraryId = this.getLibraryId();
    const thumbnailTime =
      options.thumbnailTimeMs ?? DEFAULT_BUNNY_THUMBNAIL_TIME_MS;
    const payload = await this.request({
      method: "POST",
      path: `/library/${encodeURIComponent(libraryId)}/videos`,
      body: { title, thumbnailTime },
    });

    return this.toBunnyVideo(payload);
  }

  /** GET /library/{libraryId}/videos/{videoId} */
  async getVideo(videoId: string): Promise<BunnyVideo> {
    this.ensureEnabled();
    const libraryId = this.getLibraryId();
    const payload = await this.request({
      method: "GET",
      path: `/library/${encodeURIComponent(libraryId)}/videos/${encodeURIComponent(videoId)}`,
    });

    return this.toBunnyVideo(payload);
  }

  /**
   * DELETE /library/{libraryId}/videos/{videoId}
   *
   * Resolves true only when Bunny confirmed the delete. A 404 counts as
   * confirmed - the remote asset is gone either way. Every other failure
   * throws, so a caller can never report a success Bunny did not give -
   * including the disabled case, which throws before any network request.
   */
  async deleteVideo(videoId: string): Promise<boolean> {
    // Gated before any configuration read, so a deployment that still holds
    // stale credentials cannot reach Bunny while the feature is off.
    this.ensureEnabled();
    const libraryId = this.getLibraryId();

    try {
      await this.request({
        method: "DELETE",
        path: `/library/${encodeURIComponent(libraryId)}/videos/${encodeURIComponent(videoId)}`,
      });

      return true;
    } catch (error) {
      if (error instanceof BunnyNotFoundError) {
        return true;
      }

      throw error;
    }
  }

  /**
   * Short-lived credentials for a direct browser to Bunny TUS upload.
   *
   * Signature: SHA256(libraryId + apiKey + expirationUnixSeconds + videoId),
   * hex encoded. The API key is an input to the hash and is never returned.
   */
  createTusUploadCredentials(
    videoId: string,
    now: Date = new Date(),
  ): BunnyTusUploadCredentials {
    const libraryId = this.getLibraryId();
    const apiKey = this.readRequiredString("BUNNY_STREAM_API_KEY");
    const expirationTime =
      Math.floor(now.getTime() / 1000) + this.getTusTtlSeconds();
    const signature = createHash("sha256")
      .update(`${libraryId}${apiKey}${expirationTime}${videoId}`)
      .digest("hex");

    return {
      videoId,
      libraryId,
      expirationTime,
      signature,
      tusEndpoint: BUNNY_STREAM_TUS_ENDPOINT,
    };
  }

  /**
   * Short-lived signed iframe embed URL.
   *
   * Token: SHA256(tokenSecurityKey + videoId + expirationUnixSeconds), hex
   * encoded. The token security key is an input to the hash and is never
   * returned.
   */
  createSignedEmbedUrl(
    videoId: string,
    now: Date = new Date(),
    playerParams: BunnyEmbedPlayerParams = {},
  ): BunnySignedEmbed {
    const libraryId = this.getLibraryId();
    const tokenSecurityKey = this.readRequiredString(
      "BUNNY_STREAM_TOKEN_SECURITY_KEY",
    );
    const expires =
      Math.floor(now.getTime() / 1000) + this.getEmbedTokenTtlSeconds();
    const token = createHash("sha256")
      .update(`${tokenSecurityKey}${videoId}${expires}`)
      .digest("hex");
    // Player parameters are appended AFTER the credential pair and are not part
    // of the hash - the token covers `videoId` and `expires` only. Callers that
    // pass none produce a byte-identical URL to before this parameter existed,
    // which is what keeps public watch resolution unchanged.
    const playerQuery = Object.entries(playerParams)
      .map(
        ([key, value]) =>
          `&${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
      )
      .join("");
    const embedUrl = `${BUNNY_STREAM_EMBED_BASE_URL}/${encodeURIComponent(
      libraryId,
    )}/${encodeURIComponent(videoId)}?token=${token}&expires=${expires}${playerQuery}`;

    return { embedUrl, token, expires };
  }

  /**
   * Whether a signed embed URL could be produced right now.
   *
   * A pure configuration check: it performs no hashing and mints no token, so
   * a caller can decide whether an asset is *potentially* playable without
   * generating a playback credential. Public watch resolution relies on this to
   * keep signing strictly after the authoritative view-consumption step.
   */
  canSignEmbedUrl(): boolean {
    return (
      this.isEnabled() &&
      this.hasConfiguredValue("BUNNY_STREAM_LIBRARY_ID") &&
      this.hasConfiguredValue("BUNNY_STREAM_TOKEN_SECURITY_KEY")
    );
  }

  /**
   * Unsigned iframe base URL. Stored on the local record so the asset has a
   * stable identity; the public watch response never returns it unsigned.
   */
  buildUnsignedEmbedUrl(videoId: string): string {
    return `${BUNNY_STREAM_EMBED_BASE_URL}/${encodeURIComponent(
      this.getLibraryId(),
    )}/${encodeURIComponent(videoId)}`;
  }

  /**
   * POST /library/{libraryId}/videos/{videoId}/thumbnail
   *
   * Sets the video's main thumbnail from raw image bytes, per Bunny's Set
   * Thumbnail endpoint: `Content-Type: application/octet-stream` with the file
   * itself as the body.
   *
   * The `thumbnailUrl` query mode is deliberately NOT used. It would require the
   * image to be publicly hosted first, and accepting a caller-supplied URL here
   * would turn this backend into an SSRF fetcher. Binary upload only.
   *
   * ORDERING. Call this only once Bunny reports the video READY. `thumbnailTime`
   * makes Bunny extract its own main thumbnail *during* encoding, so an image
   * written earlier can be replaced by that extraction.
   *
   * Bunny's response does not carry the resulting file name, so the caller must
   * re-read `getVideo()` to learn the authoritative `thumbnailFileName`. A
   * failure propagates truthfully - this never reports a success Bunny did not
   * give. The API key is an internal header and is never returned or logged.
   */
  async setVideoThumbnail(videoId: string, thumbnail: Buffer): Promise<void> {
    this.ensureEnabled();
    const libraryId = this.getLibraryId();

    await this.request({
      method: "POST",
      path: `/library/${encodeURIComponent(libraryId)}/videos/${encodeURIComponent(
        videoId,
      )}/thumbnail`,
      binaryBody: thumbnail,
    });
  }

  /**
   * The Stream CDN hostname the library's pull zone serves from, or null.
   *
   * `BUNNY_STREAM_PULL_ZONE_HOSTNAME`, normalised to lower case. A **hostname
   * only** - `vz-xxxxxxxx.b-cdn.net` - never a URL. Not a secret.
   *
   * Returns null rather than throwing so a deployment that has not configured
   * it yet degrades to "no poster" instead of failing playback. Boot-time
   * validation is what makes that state loud when Bunny is enabled.
   */
  getPullZoneHostname(): string | null {
    const value = this.configService
      .get<string>("BUNNY_STREAM_PULL_ZONE_HOSTNAME")
      ?.trim()
      .toLowerCase();

    return value !== undefined && isBunnyPullZoneHostname(value) ? value : null;
  }

  /**
   * Builds the poster delivery URL from Bunny's documented storage structure:
   *
   *     https://{pull_zone_hostname}/{videoId}/{thumbnailFileName}
   *
   * Bunny's Get Video response provides `thumbnailFileName`; the hostname comes
   * from configuration. Nothing here is derived from a pre-built URL field, and
   * no extra Bunny request is made.
   *
   * Returns null - never a guess - when the poster cannot be addressed:
   * no configured hostname, no `thumbnailFileName` yet (still encoding), or a
   * component that fails validation. A default file name is never invented.
   *
   * PATH SAFETY. Both components are matched against a strict allowlist before
   * use, so a traversal (`../secret`), a nested path (`foo/bar.jpg`,
   * `foo\bar.jpg`), a scheme, a query or a fragment can never reach the URL.
   * Percent-encoding is applied as a second layer.
   */
  buildThumbnailUrl(
    videoId: string,
    thumbnailFileName: string | null,
  ): string | null {
    const hostname = this.getPullZoneHostname();
    if (hostname === null) {
      return null;
    }

    const id = videoId.trim();
    const fileName = thumbnailFileName?.trim() ?? "";

    if (!isSafeBunnyPathSegment(id) || !isSafeBunnyFileName(fileName)) {
      return null;
    }

    return `https://${hostname}/${encodeURIComponent(id)}/${encodeURIComponent(
      fileName,
    )}`;
  }

  /**
   * Maps a Bunny `status` code onto the local lifecycle.
   *
   * Only 4 (Finished) is ready. 3 is Transcoding, which is still in progress.
   */
  mapProcessingState(status: number | null): BunnyProcessingState {
    if (status === null) {
      return "PROCESSING";
    }

    if (BUNNY_READY_STATUSES.includes(status)) {
      return "READY";
    }

    if (BUNNY_FAILED_STATUSES.includes(status)) {
      return "FAILED";
    }

    return "PROCESSING";
  }

  private getTusTtlSeconds(): number {
    return this.readBoundedInteger(
      "BUNNY_STREAM_TUS_TTL_SECONDS",
      DEFAULT_BUNNY_TUS_TTL_SECONDS,
      MIN_BUNNY_TUS_TTL_SECONDS,
      MAX_BUNNY_TUS_TTL_SECONDS,
    );
  }

  private getEmbedTokenTtlSeconds(): number {
    return this.readBoundedInteger(
      "BUNNY_STREAM_EMBED_TOKEN_TTL_SECONDS",
      DEFAULT_BUNNY_EMBED_TOKEN_TTL_SECONDS,
      MIN_BUNNY_EMBED_TOKEN_TTL_SECONDS,
      MAX_BUNNY_EMBED_TOKEN_TTL_SECONDS,
    );
  }

  /**
   * The single outbound call site, and the single enabled-gate boundary. The
   * `AccessKey` header is built here and the response body is never logged, so
   * a Bunny error page cannot carry a key back into the logs.
   */
  private async request(init: BunnyRequestInit): Promise<unknown> {
    // FEATURE-DISABLED ISOLATION. This is the structural guarantee: no Bunny
    // network request can leave this process while `BUNNY_STREAM_ENABLED` is
    // false, whatever a future caller does. The public methods gate too, so the
    // failure surfaces with a clear message before any configuration is read.
    this.ensureEnabled();
    const apiKey = this.readRequiredString("BUNNY_STREAM_API_KEY");
    const url = `${BUNNY_STREAM_API_BASE_URL}${init.path}`;
    let response: Response;

    try {
      response = await fetch(url, {
        method: init.method,
        headers: {
          AccessKey: apiKey,
          Accept: "application/json",
          ...(init.binaryBody !== undefined
            ? { "Content-Type": "application/octet-stream" }
            : init.body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
        },
        ...(init.binaryBody !== undefined
          ? { body: new Uint8Array(init.binaryBody) }
          : init.body === undefined
            ? {}
            : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(BUNNY_STREAM_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.error(
        {
          bunnyOperation: init.method,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "Bunny Stream request failed before a response was received.",
      );

      throw new ServiceUnavailableException(
        "Bunny Stream is currently unreachable.",
      );
    }

    if (response.status === 404) {
      throw new BunnyNotFoundError();
    }

    if (!response.ok) {
      this.logger.error(
        {
          bunnyOperation: init.method,
          bunnyStatusCode: response.status,
        },
        "Bunny Stream request returned an error status.",
      );

      throw new InternalServerErrorException("Bunny Stream request failed.");
    }

    if (response.status === 204) {
      return {};
    }

    try {
      return (await response.json()) as unknown;
    } catch {
      return {};
    }
  }

  private toBunnyVideo(payload: unknown): BunnyVideo {
    const record =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
    const guid = this.readStringField(record, "guid");

    if (guid === null) {
      throw new InternalServerErrorException(
        "Bunny Stream response did not include a video id.",
      );
    }

    return {
      guid,
      libraryId: this.readNumberField(record, "videoLibraryId"),
      title: this.readStringField(record, "title"),
      status: this.readNumberField(record, "status"),
      encodeProgress: this.readNumberField(record, "encodeProgress"),
      length: this.readNumberField(record, "length"),
      width: this.readNumberField(record, "width"),
      height: this.readNumberField(record, "height"),
      storageSize: this.readNumberField(record, "storageSize"),
      thumbnailFileName: this.readStringField(record, "thumbnailFileName"),
    };
  }

  private readStringField(
    record: Record<string, unknown>,
    key: string,
  ): string | null {
    const value = record[key];

    return typeof value === "string" && value.trim() !== ""
      ? value.trim()
      : null;
  }

  private readNumberField(
    record: Record<string, unknown>,
    key: string,
  ): number | null {
    const value = record[key];

    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  /** Presence only. Never returns or logs the value. */
  private hasConfiguredValue(key: string): boolean {
    const value = this.configService.get<string>(key);

    return value !== undefined && value.trim() !== "";
  }

  private readRequiredString(key: string): string {
    const value = this.configService.get<string>(key);

    if (value === undefined || value.trim() === "") {
      throw new InternalServerErrorException(`${key} is not configured.`);
    }

    return value.trim();
  }

  private readBoundedInteger(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const raw = this.configService.get<string>(key);
    const parsed = Number(raw ?? fallback);

    if (!Number.isInteger(parsed)) {
      return fallback;
    }

    return Math.min(Math.max(parsed, min), max);
  }
}

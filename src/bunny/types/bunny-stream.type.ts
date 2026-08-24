/**
 * Bunny Stream boundary types.
 *
 * None of these carry a secret. `BunnyTusUploadCredentials` in particular is
 * returned to the authenticated admin browser: it holds the short-lived
 * signature only, never `BUNNY_STREAM_API_KEY`.
 */

/** Subset of the Bunny `VideoModel` this integration reads. */
export type BunnyVideo = {
  guid: string;
  libraryId: number | null;
  title: string | null;
  status: number | null;
  encodeProgress: number | null;
  length: number | null;
  width: number | null;
  height: number | null;
  storageSize: number | null;
  /**
   * The poster's file name inside Bunny's video storage - for example
   * `thumbnail.jpg`. This is the authoritative field the Get Video endpoint
   * documents for thumbnails.
   *
   * Null until encoding has produced a thumbnail, so a `PROCESSING` video
   * legitimately has none.
   *
   * A **file name only** - never a path or a URL. The delivery URL is built
   * server-side from the documented storage structure
   * (`https://{pull_zone}/{videoId}/{thumbnailFileName}`) by
   * `BunnyStreamService.buildThumbnailUrl()`. Deliberately NOT read from any
   * pre-built URL field: relying on one would tie this integration to a
   * response shape the storage-structure contract does not guarantee.
   */
  thumbnailFileName: string | null;
};

/**
 * Everything the browser needs to run a direct TUS upload to Bunny.
 *
 * Deliberately excludes the API key. The signature is derived from it and
 * expires at `expirationTime`.
 */
export type BunnyTusUploadCredentials = {
  videoId: string;
  libraryId: string;
  expirationTime: number;
  signature: string;
  tusEndpoint: string;
};

/**
 * Per-embed Bunny player overrides appended to a signed embed URL.
 *
 * Bunny documents `autoplay`, `loop`, `muted`, `preload` and `responsive` as
 * query parameters that override the library's global Player settings for that
 * embed only. They are NOT covered by the embed token, so adding one cannot
 * invalidate the signature and cannot widen access.
 *
 * Used for the ADMIN preview, which must open paused. Public watch resolution
 * passes none and therefore keeps the library defaults.
 */
export type BunnyEmbedPlayerParams = Record<string, string>;

/** A short-lived, signed Bunny iframe embed URL. */
export type BunnySignedEmbed = {
  embedUrl: string;
  token: string;
  expires: number;
};

/** Local mapping of a Bunny processing state. */
export type BunnyProcessingState = "PROCESSING" | "READY" | "FAILED";

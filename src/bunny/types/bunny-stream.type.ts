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

/** A short-lived, signed Bunny iframe embed URL. */
export type BunnySignedEmbed = {
  embedUrl: string;
  token: string;
  expires: number;
};

/** Local mapping of a Bunny processing state. */
export type BunnyProcessingState = "PROCESSING" | "READY" | "FAILED";

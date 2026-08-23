/**
 * Bunny Stream integration constants.
 *
 * Every value here is a public, non-secret endpoint or protocol constant.
 * Secrets are read from configuration and never leave the backend — see
 * `bunny-stream.service.ts`.
 */

/** Official Bunny Stream management API base. */
export const BUNNY_STREAM_API_BASE_URL = "https://video.bunnycdn.com";

/** Official Bunny Stream TUS resumable-upload endpoint. */
export const BUNNY_STREAM_TUS_ENDPOINT = `${BUNNY_STREAM_API_BASE_URL}/tusupload`;

/** Host that serves the Bunny Stream iframe player. */
export const BUNNY_STREAM_EMBED_HOSTNAME = "iframe.mediadelivery.net";

/** Base of the Bunny Stream iframe embed URL, without library or video id. */
export const BUNNY_STREAM_EMBED_BASE_URL = `https://${BUNNY_STREAM_EMBED_HOSTNAME}/embed`;

/** Outbound request timeout for the Bunny management API. */
export const BUNNY_STREAM_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Bunny Stream `status` codes, verified against
 * https://bunny.net/docs/reference/video_getvideo.
 *
 * NOTE: `Finished` is 4, not 3. 3 is `Transcoding` — a video in that state is
 * still encoding and must NOT be treated as ready.
 */
export const BUNNY_VIDEO_STATUS = {
  CREATED: 0,
  UPLOADED: 1,
  PROCESSING: 2,
  TRANSCODING: 3,
  FINISHED: 4,
  ERROR: 5,
  UPLOAD_FAILED: 6,
  JIT_SEGMENTING: 7,
  JIT_PLAYLISTS_CREATED: 8,
} as const;

/** The only Bunny states that may promote a local asset to READY. */
export const BUNNY_READY_STATUSES: readonly number[] = [
  BUNNY_VIDEO_STATUS.FINISHED,
];

/** Bunny states that are terminal failures. */
export const BUNNY_FAILED_STATUSES: readonly number[] = [
  BUNNY_VIDEO_STATUS.ERROR,
  BUNNY_VIDEO_STATUS.UPLOAD_FAILED,
];

/** Marker key written into `VideoAsset.metadataJson` for Bunny-backed assets. */
export const BUNNY_STREAM_METADATA_KEY = "bunnyStream";

/** Default lifetime of a set of TUS upload credentials. */
export const DEFAULT_BUNNY_TUS_TTL_SECONDS = 60 * 60;
export const MIN_BUNNY_TUS_TTL_SECONDS = 5 * 60;
export const MAX_BUNNY_TUS_TTL_SECONDS = 24 * 60 * 60;

/** Default lifetime of a signed embed token. */
export const DEFAULT_BUNNY_EMBED_TOKEN_TTL_SECONDS = 5 * 60;
export const MIN_BUNNY_EMBED_TOKEN_TTL_SECONDS = 60;
export const MAX_BUNNY_EMBED_TOKEN_TTL_SECONDS = 60 * 60;

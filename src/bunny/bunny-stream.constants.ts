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

/**
 * Default `thumbnailTime` sent with every Bunny Create Video, in milliseconds.
 *
 * Bunny documents this as "video time in ms to extract the main video
 * thumbnail". One second in is far enough past a black or fade-in first frame
 * to be recognisable, and early enough to exist in even a very short clip -
 * which matters because these are reviewer evidence videos.
 *
 * Deliberately a constant, not configuration: it is a sensible product default,
 * not something an operator needs to tune, and it is overridden entirely
 * whenever a custom thumbnail is uploaded.
 */
export const DEFAULT_BUNNY_THUMBNAIL_TIME_MS = 1000;

/* ------------------------------------------------------------------ *
 * PUBLIC THUMBNAIL PROXY
 *
 * Reviewer-facing Bunny posters are served THROUGH this API rather than
 * fetched from the pull zone by the reviewer's browser. See
 * `bunny-thumbnail-proxy.service.ts` for why, and `docs/features/bunny-stream.md`
 * §4.5 for the operational contract.
 * ------------------------------------------------------------------ */

/**
 * How the BACKEND authorizes its own request to the Bunny pull zone.
 *
 * These are two entirely different mechanisms from Stream EMBED view tokens,
 * which `BUNNY_STREAM_TOKEN_SECURITY_KEY` signs. A pull zone and a Stream
 * library are separate products with separate security settings, and a key from
 * one does not authorize the other.
 *
 * - `none`    — send nothing extra. Correct when the pull zone is open, or is
 *               restricted by something the backend already satisfies.
 * - `referer` — send a configured `Referer` that the zone's Allowed Referrers
 *               list accepts. This is Bunny's hotlink protection: a
 *               compatibility mechanism, NOT strong authorization, and it is
 *               documented as such.
 *
 * CDN Token Authentication is deliberately absent: it requires a CDN token
 * security key that is not part of this deployment's environment contract.
 */
export const BUNNY_THUMBNAIL_PROXY_AUTH_MODES = {
  none: "none",
  referer: "referer",
} as const;

export type BunnyThumbnailProxyAuthMode =
  (typeof BUNNY_THUMBNAIL_PROXY_AUTH_MODES)[keyof typeof BUNNY_THUMBNAIL_PROXY_AUTH_MODES];

/**
 * Largest poster the proxy will relay, in bytes.
 *
 * 5 MB is far above any frame Bunny extracts from a video and far below
 * anything that would matter for memory or bandwidth on a public route. The cap
 * is enforced on the transferred bytes, not only on `Content-Length`.
 */
export const DEFAULT_BUNNY_THUMBNAIL_PROXY_MAX_BYTES = 5 * 1024 * 1024;
export const MIN_BUNNY_THUMBNAIL_PROXY_MAX_BYTES = 64 * 1024;
export const MAX_BUNNY_THUMBNAIL_PROXY_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Upstream request timeout, in milliseconds.
 *
 * Much shorter than `BUNNY_STREAM_REQUEST_TIMEOUT_MS` (15 s), and deliberately
 * so: that governs operator-triggered management calls, while this sits on an
 * unauthenticated public route where a slow CDN must never be able to pin API
 * request handlers.
 */
export const DEFAULT_BUNNY_THUMBNAIL_PROXY_TIMEOUT_MS = 5_000;
export const MIN_BUNNY_THUMBNAIL_PROXY_TIMEOUT_MS = 1_000;
export const MAX_BUNNY_THUMBNAIL_PROXY_TIMEOUT_MS = 15_000;

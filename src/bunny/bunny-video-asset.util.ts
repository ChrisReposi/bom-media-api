import {
  VideoProvider,
  VideoSourceType,
  VideoStatus,
} from "../generated/prisma/client";
import { BUNNY_STREAM_METADATA_KEY } from "./bunny-stream.constants";

/**
 * Classification of a `VideoAsset` with respect to the Bunny Stream provider.
 *
 * PROVIDER ISOLATION + FAIL CLOSED. Three outcomes, and only three:
 *
 * - `bunny` — the record satisfies the *complete* Bunny identification
 *   predicate. Playback must go through a dynamically signed embed URL.
 * - `bunny-malformed` — the record structurally *claims* to be a new-style
 *   Bunny asset (`provider = BUNNY` **and** `sourceType = EMBED`) but fails the
 *   predicate. It must **fail closed**: never publicly playable, and its stored
 *   `embedUrl` must never be emitted. Falling back to generic embed handling
 *   here would hand out a permanent unsigned Bunny URL.
 * - `not-bunny` — everything else, including a legacy record merely *labelled*
 *   `provider: BUNNY` with `sourceType: DIRECT_URL`. Those keep their existing
 *   behaviour exactly; the strict rule applies only to the Bunny EMBED shape.
 *
 * The complete predicate requires all of:
 *
 * 1. `provider === BUNNY`
 * 2. `sourceType === EMBED`
 * 3. a non-empty `providerAssetId` (the Bunny video GUID)
 * 4. `playbackId` equal to it
 * 5. `metadataJson.bunnyStream.videoId` equal to it
 *
 * That is exactly the shape `initBunnyVideoUpload()` writes, so any deviation
 * is a hand-edited or tampered record and is treated as malformed.
 */
export type BunnyVideoAssetFields = {
  provider: VideoProvider;
  sourceType: VideoSourceType;
  providerAssetId: string | null;
  playbackId: string | null;
  metadataJson: unknown;
};

export type BunnyVideoAssetRef = {
  bunnyVideoId: string;
  libraryId: string | null;
};

export type BunnyVideoClassification =
  | ({ kind: "bunny" } & BunnyVideoAssetRef)
  | { kind: "bunny-malformed" }
  | { kind: "not-bunny" };

/**
 * The single classifier every Bunny branch is gated on.
 *
 * Callers that only act on a fully valid asset can use `readBunnyVideoAsset()`;
 * callers that must also refuse a malformed one - public playback - must use
 * this and handle `bunny-malformed` explicitly.
 */
export function classifyBunnyVideoAsset(
  video: BunnyVideoAssetFields,
): BunnyVideoClassification {
  if (
    video.provider !== VideoProvider.BUNNY ||
    video.sourceType !== VideoSourceType.EMBED
  ) {
    // Includes the legacy `provider: BUNNY` + `sourceType: DIRECT_URL` record,
    // which must keep behaving exactly as it does today.
    return { kind: "not-bunny" };
  }

  const providerAssetId = video.providerAssetId?.trim();
  if (!providerAssetId) {
    return { kind: "bunny-malformed" };
  }

  if (video.playbackId?.trim() !== providerAssetId) {
    return { kind: "bunny-malformed" };
  }

  const marker = readBunnyMetadataMarker(video.metadataJson);
  if (marker === null || marker.videoId !== providerAssetId) {
    return { kind: "bunny-malformed" };
  }

  return {
    kind: "bunny",
    bunnyVideoId: providerAssetId,
    libraryId: marker.libraryId,
  };
}

/**
 * Returns the Bunny reference only for a fully valid Bunny-backed asset.
 *
 * Note this returns `null` for BOTH `not-bunny` and `bunny-malformed`, so it is
 * safe for branches where "do nothing" is the correct outcome (status sync,
 * remote purge) but is **not** sufficient for public playback, which must
 * distinguish the two. Use `classifyBunnyVideoAsset()` there.
 */
export function readBunnyVideoAsset(
  video: BunnyVideoAssetFields,
): BunnyVideoAssetRef | null {
  const classification = classifyBunnyVideoAsset(video);

  return classification.kind === "bunny"
    ? {
        bunnyVideoId: classification.bunnyVideoId,
        libraryId: classification.libraryId,
      }
    : null;
}

type BunnyMetadataMarker = {
  videoId: string;
  libraryId: string | null;
};

function readBunnyMetadataMarker(
  metadataJson: unknown,
): BunnyMetadataMarker | null {
  const metadata = asRecord(metadataJson);
  if (metadata === null) {
    return null;
  }

  const marker = asRecord(metadata[BUNNY_STREAM_METADATA_KEY]);
  if (marker === null) {
    return null;
  }

  const videoId = readTrimmedString(marker.videoId);
  if (videoId === null) {
    return null;
  }

  return { videoId, libraryId: readTrimmedString(marker.libraryId) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/* ------------------------------------------------------------------ *
 * REMOTE-MISSING RECONCILIATION
 *
 * An asset whose Bunny video was deleted outside the CMS - typically by hand
 * in the Bunny dashboard. The local row is deliberately PRESERVED: deleting it
 * automatically would destroy audit history and provenance on the strength of a
 * single HTTP response.
 *
 * The condition is recorded inside the EXISTING `metadataJson.bunnyStream`
 * marker rather than in a new column, so no Prisma migration is required and
 * every other Bunny branch keeps reading the same marker it always has.
 *
 * A remote-missing record still classifies as `kind: "bunny"`. Its identifiers
 * are untouched and remain valid for audit, for a later purge, and for
 * recovery. What makes it non-playable is its local `VideoStatus`, which is the
 * single gate both public watch resolution and share-link eligibility already
 * enforce.
 * ------------------------------------------------------------------ */

/**
 * The only reason code this integration writes.
 *
 * Deterministic on purpose: it means "Bunny answered an authoritative 404 for
 * this video id", never "a Bunny request failed". A timeout, a 5xx, a 429 or an
 * auth failure must never produce this marker.
 */
export const BUNNY_REMOTE_MISSING_REASON = "NOT_FOUND";

/** Key of the remote-missing marker inside `metadataJson.bunnyStream`. */
export const BUNNY_REMOTE_MISSING_KEY = "remoteMissing";

export type BunnyRemoteMissingMarker = {
  /** ISO 8601 instant at which the 404 was first observed. */
  detectedAt: string;
  reason: string;
};

/**
 * Reads the remote-missing marker, or null when the asset is not flagged.
 *
 * Tolerant of a partially written marker: a marker object with no usable
 * `detectedAt` still counts as missing, because its mere presence is the
 * signal. `reason` falls back to the deterministic code.
 */
export function readBunnyRemoteMissing(
  metadataJson: unknown,
): BunnyRemoteMissingMarker | null {
  const bunnyStream = asRecord(asRecord(metadataJson)?.[BUNNY_STREAM_METADATA_KEY]);
  if (bunnyStream === null) {
    return null;
  }

  const marker = asRecord(bunnyStream[BUNNY_REMOTE_MISSING_KEY]);
  if (marker === null) {
    return null;
  }

  return {
    detectedAt: readTrimmedString(marker.detectedAt) ?? "",
    reason: readTrimmedString(marker.reason) ?? BUNNY_REMOTE_MISSING_REASON,
  };
}

/** Convenience predicate over `readBunnyRemoteMissing()`. */
export function isBunnyRemoteMissing(metadataJson: unknown): boolean {
  return readBunnyRemoteMissing(metadataJson) !== null;
}

/**
 * Returns `metadataJson` with the remote-missing marker added.
 *
 * PRESERVES EVERYTHING. Unrelated top-level metadata keys (`thumbnail`, …) and
 * every existing `bunnyStream` field (`videoId`, `libraryId`, `createdAt`, …)
 * are carried through untouched - the provider identifiers in particular, which
 * a later purge and a later recovery both depend on.
 *
 * IDEMPOTENT. An asset already flagged is reported as `changed: false` and
 * keeps its ORIGINAL `detectedAt`, so repeated syncs neither churn the row nor
 * re-fire the audit event.
 *
 * Refuses to invent a `bunnyStream` block that does not exist: a record with no
 * marker fails the Bunny predicate and must never be flagged as though it were
 * a valid Bunny asset.
 */
export function applyBunnyRemoteMissingMarker(
  metadataJson: unknown,
  detectedAt: Date,
): { metadata: Record<string, unknown>; changed: boolean } {
  const metadata = { ...(asRecord(metadataJson) ?? {}) };
  const bunnyStream = asRecord(metadata[BUNNY_STREAM_METADATA_KEY]);

  if (bunnyStream === null) {
    return { metadata, changed: false };
  }

  if (asRecord(bunnyStream[BUNNY_REMOTE_MISSING_KEY]) !== null) {
    return { metadata, changed: false };
  }

  metadata[BUNNY_STREAM_METADATA_KEY] = {
    ...bunnyStream,
    [BUNNY_REMOTE_MISSING_KEY]: {
      detectedAt: detectedAt.toISOString(),
      reason: BUNNY_REMOTE_MISSING_REASON,
    } satisfies BunnyRemoteMissingMarker,
  };

  return { metadata, changed: true };
}

/**
 * Returns `metadataJson` with the remote-missing marker removed.
 *
 * Called when an authoritative Bunny GET succeeds again for the same asset, so
 * an earlier 404 can never poison a record permanently. Everything else is
 * preserved, exactly as in `applyBunnyRemoteMissingMarker()`.
 */
export function clearBunnyRemoteMissingMarker(
  metadataJson: unknown,
): { metadata: Record<string, unknown>; changed: boolean } {
  const metadata = { ...(asRecord(metadataJson) ?? {}) };
  const bunnyStream = asRecord(metadata[BUNNY_STREAM_METADATA_KEY]);

  if (
    bunnyStream === null ||
    !Object.hasOwn(bunnyStream, BUNNY_REMOTE_MISSING_KEY)
  ) {
    return { metadata, changed: false };
  }

  const nextBunnyStream = { ...bunnyStream };
  delete nextBunnyStream[BUNNY_REMOTE_MISSING_KEY];
  metadata[BUNNY_STREAM_METADATA_KEY] = nextBunnyStream;

  return { metadata, changed: true };
}

/**
 * Applies a Bunny ENCODING state to the local lifecycle.
 *
 * Deliberately conservative, and unchanged by remote-missing work:
 *
 * - `DISABLED` is never overwritten - that is an administrator's decision.
 * - `READY` is never demoted - a published asset does not lose its share links
 *   because of a transient Bunny read.
 * - `DRAFT`, `PROCESSING` and `FAILED` follow Bunny, so a failed upload that is
 *   retried can recover to `READY`.
 *
 * Exported as a pure function so the service and the operational reconciliation
 * script share ONE copy of these rules rather than each keeping their own.
 */
export function resolveBunnyLocalStatus(
  currentStatus: VideoStatus,
  processingState: "PROCESSING" | "READY" | "FAILED",
): VideoStatus {
  if (
    currentStatus === VideoStatus.DISABLED ||
    currentStatus === VideoStatus.READY
  ) {
    return currentStatus;
  }

  if (processingState === "READY") {
    return VideoStatus.READY;
  }

  if (processingState === "FAILED") {
    return VideoStatus.FAILED;
  }

  return VideoStatus.PROCESSING;
}

/**
 * Local status for an asset whose Bunny video answered an authoritative 404.
 *
 * THE ONE DELIBERATE EXCEPTION to "READY is never demoted". The no-demotion
 * rule exists to protect a published asset from a TRANSIENT provider read - a
 * timeout, a 5xx, a rate limit. A 404 is not that: it is Bunny stating the
 * asset does not exist. Leaving such a record READY would keep it publicly
 * playable, keep it eligible for new share links, and keep minting signed
 * playback URLs for a video that cannot play. `FAILED` is the existing
 * non-playable terminal state and needs no new enum value.
 *
 * `DISABLED` still wins, because an administrator's decision outranks a
 * provider observation and disable must stay reversible.
 */
export function resolveBunnyRemoteMissingStatus(
  currentStatus: VideoStatus,
): VideoStatus {
  return currentStatus === VideoStatus.DISABLED
    ? VideoStatus.DISABLED
    : VideoStatus.FAILED;
}

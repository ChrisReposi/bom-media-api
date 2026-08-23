import { VideoProvider, VideoSourceType } from "../generated/prisma/client";
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

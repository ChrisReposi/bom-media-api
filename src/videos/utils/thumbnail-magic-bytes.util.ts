/**
 * Content-sniffing for uploaded thumbnail images, over an in-memory buffer.
 *
 * A declared `Content-Type` is attacker-controlled: multipart clients send
 * whatever they like. Checking the leading bytes as well means a renamed
 * executable, or an SVG relabelled `image/png`, is refused before it is stored
 * or forwarded to a provider.
 *
 * The byte patterns match the ones the local-thumbnail path already enforces
 * (`validateLocalThumbnailMagicBytes`); this variant exists because the Bunny
 * path streams the image straight through and never writes it to storage.
 */

/** Types the project accepts as a thumbnail. SVG is deliberately absent. */
export const BUNNY_THUMBNAIL_ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * Whether the buffer's leading bytes match its declared image type.
 *
 * Returns false for an unknown type, so an unrecognised value can never pass by
 * default.
 */
export function hasThumbnailMagicBytes(
  buffer: Buffer,
  mimeType: string,
): boolean {
  const normalized = mimeType.toLowerCase();

  if (normalized === "image/jpeg") {
    return (
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    );
  }

  if (normalized === "image/png") {
    return buffer.subarray(0, 8).equals(PNG_SIGNATURE);
  }

  if (normalized === "image/gif") {
    return ["GIF87a", "GIF89a"].includes(
      buffer.subarray(0, 6).toString("ascii"),
    );
  }

  if (normalized === "image/webp") {
    // RIFF container whose form type is WEBP: "RIFF" ???? "WEBP".
    return (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }

  return false;
}

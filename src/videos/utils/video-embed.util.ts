import { BadRequestException } from "@nestjs/common";
import { EmbedProvider } from "../../generated/prisma/client";

export const DEFAULT_VIDEO_EMBED_ALLOWED_HOSTS = [
  "player.cloudinary.com",
  "www.youtube.com",
  "www.youtube-nocookie.com",
  "player.vimeo.com",
];

export const DEFAULT_VIDEO_EMBED_ALLOW =
  "autoplay; fullscreen; encrypted-media; picture-in-picture";

export type ParsedVideoEmbed = {
  provider: EmbedProvider;
  embedUrl: string;
  cloudName?: string;
  publicId?: string;
  allow: string;
};

export function parseVideoEmbedInput(params: {
  input: string;
  allowedHosts: string[];
  defaultAllow: string;
}): ParsedVideoEmbed {
  const rawInput = params.input.trim();

  if (rawInput.length === 0) {
    throw new BadRequestException("Embed code or URL is required.");
  }

  const src = rawInput.toLowerCase().includes("<iframe")
    ? extractIframeSrc(rawInput)
    : rawInput;

  const url = parseEmbedUrl(src);
  const hostname = url.hostname.toLowerCase();
  const allowedHosts = new Set(
    params.allowedHosts
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host.length > 0),
  );

  if (!allowedHosts.has(hostname)) {
    throw new BadRequestException("Embed host is not allowed.");
  }

  url.protocol = "https:";
  url.username = "";
  url.password = "";
  url.hash = "";

  const provider = detectEmbedProvider(hostname);
  const allow = normalizeAllow(params.defaultAllow);

  if (provider === EmbedProvider.CLOUDINARY_PLAYER) {
    const cloudName = url.searchParams.get("cloud_name")?.trim() ?? "";
    const publicId = url.searchParams.get("public_id")?.trim() ?? "";

    if (cloudName.length === 0 || publicId.length === 0) {
      throw new BadRequestException(
        "Cloudinary embed URL must include cloud_name and public_id.",
      );
    }

    if (cloudName.length > 120 || publicId.length > 512) {
      throw new BadRequestException("Cloudinary embed metadata is too long.");
    }

    const normalizedUrl = new URL("https://player.cloudinary.com/embed/");
    normalizedUrl.searchParams.set("cloud_name", cloudName);
    normalizedUrl.searchParams.set("public_id", publicId);

    return {
      provider,
      embedUrl: assertMaxLength(normalizedUrl.toString(), 2048, "Embed URL"),
      cloudName,
      publicId,
      allow,
    };
  }

  return {
    provider,
    embedUrl: assertMaxLength(url.toString(), 2048, "Embed URL"),
    allow,
  };
}

function extractIframeSrc(input: string): string {
  const match = input.match(/\ssrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
  const src = match?.[1] ?? match?.[2] ?? match?.[3];

  if (src === undefined || src.trim().length === 0) {
    throw new BadRequestException("Iframe embed code must include a src URL.");
  }

  return src.trim();
}

function parseEmbedUrl(input: string): URL {
  let url: URL;

  try {
    url = new URL(input.trim());
  } catch {
    throw new BadRequestException("Embed URL is invalid.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BadRequestException("Embed URL protocol is not allowed.");
  }

  return url;
}

function detectEmbedProvider(hostname: string): EmbedProvider {
  if (hostname === "player.cloudinary.com") {
    return EmbedProvider.CLOUDINARY_PLAYER;
  }

  if (hostname === "www.youtube.com") {
    return EmbedProvider.YOUTUBE;
  }

  if (hostname === "www.youtube-nocookie.com") {
    return EmbedProvider.YOUTUBE_NOCOOKIE;
  }

  if (hostname === "player.vimeo.com") {
    return EmbedProvider.VIMEO;
  }

  return EmbedProvider.GENERIC_IFRAME;
}

function normalizeAllow(value: string): string {
  const trimmed = value.trim() || DEFAULT_VIDEO_EMBED_ALLOW;

  return assertMaxLength(trimmed, 255, "Embed allow value");
}

function assertMaxLength(
  value: string,
  maxLength: number,
  label: string,
): string {
  if (value.length > maxLength) {
    throw new BadRequestException(`${label} is too long.`);
  }

  return value;
}

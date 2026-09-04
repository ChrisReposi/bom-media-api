import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import {
  decodeGrantPayload,
  encodeGrantPayload,
  signGrantPayload,
  verifyGrantSignature,
} from "./utils/grant-signature.util";

type MediaGrantPayload = {
  v: 1;
  sid: string;
  vid: string;
  host: string;
  exp: number;
  purpose: "public_media";
};

const DEFAULT_TTL_SECONDS = 6 * 60 * 60;
const MIN_TTL_SECONDS = 5 * 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;

/**
 * THE MEDIA GRANT'S MAC DOMAIN IS THE EMPTY STRING, AND MUST STAY THAT WAY.
 *
 * `signGrantPayload(secret, "", payload)` is `HMAC(secret, payload)` — exactly
 * the construction media grants have used since they shipped. Live grants sit
 * in reviewers' DOMs for up to `PUBLIC_MEDIA_GRANT_TTL_SECONDS` (default 6 h,
 * ceiling 24 h), and `verify()` has no key-id and no fallback branch, so
 * changing this would fail every outstanding grant mid-playback as a generic
 * 404. The resume grant gets domain separation instead, by carrying a
 * NON-empty domain of its own.
 */
const MEDIA_GRANT_DOMAIN = "";

@Injectable()
export class PublicMediaGrantService {
  constructor(private readonly configService: ConfigService) {}

  issue(params: {
    shareLinkId: string;
    videoId: string;
    host: string;
    shareLinkExpiresAt: Date | null;
    now?: Date;
  }): string {
    const now = params.now ?? new Date();
    const configuredExpiry = now.getTime() + this.getTtlSeconds() * 1000;
    const expiresAt = Math.min(
      configuredExpiry,
      params.shareLinkExpiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER,
    );
    const payload: MediaGrantPayload = {
      v: 1,
      sid: params.shareLinkId,
      vid: params.videoId,
      host: params.host,
      exp: Math.floor(expiresAt / 1000),
      purpose: "public_media",
    };
    const encodedPayload = encodeGrantPayload(payload);

    return `${encodedPayload}.${this.sign(encodedPayload)}`;
  }

  verify(
    grant: string | undefined,
    expected: {
      shareLinkId: string;
      videoId: string;
      host: string;
      now?: Date;
    },
  ): boolean {
    const encodedPayload = verifyGrantSignature({
      grant,
      secret: this.secret(),
      domain: MEDIA_GRANT_DOMAIN,
    });
    if (encodedPayload === null) {
      return false;
    }

    const payload =
      decodeGrantPayload<Partial<MediaGrantPayload>>(encodedPayload);
    if (payload === null) {
      return false;
    }

    const nowSeconds = Math.floor(
      (expected.now ?? new Date()).getTime() / 1000,
    );

    return (
      payload.v === 1 &&
      payload.purpose === "public_media" &&
      payload.sid === expected.shareLinkId &&
      payload.vid === expected.videoId &&
      payload.host === expected.host &&
      typeof payload.exp === "number" &&
      Number.isSafeInteger(payload.exp) &&
      payload.exp >= nowSeconds
    );
  }

  private sign(encodedPayload: string): string {
    return signGrantPayload(this.secret(), MEDIA_GRANT_DOMAIN, encodedPayload);
  }

  private secret(): string {
    return this.configService.getOrThrow<string>("PUBLIC_MEDIA_GRANT_SECRET");
  }

  private getTtlSeconds(): number {
    const configured = Number(
      this.configService.get<string>("PUBLIC_MEDIA_GRANT_TTL_SECONDS") ??
        DEFAULT_TTL_SECONDS,
    );
    if (!Number.isInteger(configured)) {
      return DEFAULT_TTL_SECONDS;
    }

    return Math.min(Math.max(configured, MIN_TTL_SECONDS), MAX_TTL_SECONDS);
  }
}

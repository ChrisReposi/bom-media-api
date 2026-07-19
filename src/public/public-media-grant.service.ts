import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "node:crypto";

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
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SHA256_BASE64URL_LENGTH = 43;

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
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
      "base64url",
    );

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
    if (
      typeof grant !== "string" ||
      grant.length === 0 ||
      grant.length > 2048
    ) {
      return false;
    }

    const [encodedPayload, signature, extra] = grant.split(".");
    if (
      !encodedPayload ||
      !signature ||
      extra !== undefined ||
      !BASE64URL_PATTERN.test(encodedPayload) ||
      !BASE64URL_PATTERN.test(signature) ||
      signature.length !== SHA256_BASE64URL_LENGTH
    ) {
      return false;
    }

    const received = Buffer.from(signature);
    const expectedSignature = Buffer.from(this.sign(encodedPayload));
    if (
      received.length !== expectedSignature.length ||
      !timingSafeEqual(received, expectedSignature)
    ) {
      return false;
    }

    try {
      const decodedPayload = Buffer.from(encodedPayload, "base64url");
      if (decodedPayload.toString("base64url") !== encodedPayload) {
        return false;
      }
      const payload = JSON.parse(
        decodedPayload.toString("utf8"),
      ) as Partial<MediaGrantPayload>;
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
    } catch {
      return false;
    }
  }

  private sign(encodedPayload: string): string {
    const secret = this.configService.getOrThrow<string>(
      "PUBLIC_MEDIA_GRANT_SECRET",
    );
    return createHmac("sha256", secret)
      .update(encodedPayload)
      .digest("base64url");
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

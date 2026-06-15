import type { ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import type { ThrottlerModuleOptions } from "@nestjs/throttler";
import type { ApiEnvironmentConfig } from "../config/env.config";
import { getClientIpFromRequest } from "../common/utils/request-security.util";
import {
  THROTTLE_PROFILE_METADATA,
  THROTTLE_PROFILES,
  type ThrottleProfile,
} from "./throttle-profile.decorator";

export function buildThrottlerOptions(
  configService: ConfigService,
): ThrottlerModuleOptions {
  const apiEnvironment = configService.getOrThrow<ApiEnvironmentConfig>("api");
  const proxyOptions = {
    trustProxyEnabled: apiEnvironment.trustProxyEnabled,
    trustProxyCloudflareOnly: apiEnvironment.trustProxyCloudflareOnly,
  };

  return {
    errorMessage: "Too many requests. Please try again later.",
    getTracker(request: Record<string, unknown>): string {
      return (
        getClientIpFromRequest(request as unknown as Request, proxyOptions) ??
        "unknown-client"
      );
    },
    throttlers: [
      {
        name: "default",
        ttl: secondsToMilliseconds(apiEnvironment.throttles.global.ttlSeconds),
        limit: apiEnvironment.throttles.global.limit,
        skipIf: hasExplicitThrottleProfile,
      },
      {
        name: THROTTLE_PROFILES.login,
        ttl: secondsToMilliseconds(apiEnvironment.throttles.login.ttlSeconds),
        limit: apiEnvironment.throttles.login.limit,
        skipIf: skipUnlessProfile(THROTTLE_PROFILES.login),
      },
      {
        name: THROTTLE_PROFILES.refresh,
        ttl: secondsToMilliseconds(apiEnvironment.throttles.refresh.ttlSeconds),
        limit: apiEnvironment.throttles.refresh.limit,
        skipIf: skipUnlessProfile(THROTTLE_PROFILES.refresh),
      },
      {
        name: THROTTLE_PROFILES.logout,
        ttl: secondsToMilliseconds(apiEnvironment.throttles.logout.ttlSeconds),
        limit: apiEnvironment.throttles.logout.limit,
        skipIf: skipUnlessProfile(THROTTLE_PROFILES.logout),
      },
      {
        name: THROTTLE_PROFILES.admin,
        ttl: secondsToMilliseconds(apiEnvironment.throttles.admin.ttlSeconds),
        limit: apiEnvironment.throttles.admin.limit,
        skipIf: skipUnlessProfile(THROTTLE_PROFILES.admin),
      },
      {
        name: THROTTLE_PROFILES.publicWatch,
        ttl: secondsToMilliseconds(
          apiEnvironment.throttles.publicWatch.ttlSeconds,
        ),
        limit: apiEnvironment.throttles.publicWatch.limit,
        skipIf: skipUnlessProfile(THROTTLE_PROFILES.publicWatch),
      },
      {
        name: THROTTLE_PROFILES.publicMedia,
        ttl: secondsToMilliseconds(
          apiEnvironment.throttles.publicMedia.ttlSeconds,
        ),
        limit: apiEnvironment.throttles.publicMedia.limit,
        skipIf: skipUnlessProfile(THROTTLE_PROFILES.publicMedia),
      },
    ],
  };
}

function secondsToMilliseconds(seconds: number): number {
  return seconds * 1000;
}

function hasExplicitThrottleProfile(context: ExecutionContext): boolean {
  return readThrottleProfile(context) !== undefined;
}

function skipUnlessProfile(profile: ThrottleProfile) {
  return (context: ExecutionContext): boolean => {
    return readThrottleProfile(context) !== profile;
  };
}

function readThrottleProfile(
  context: ExecutionContext,
): ThrottleProfile | undefined {
  return (
    Reflect.getMetadata(THROTTLE_PROFILE_METADATA, context.getHandler()) ??
    Reflect.getMetadata(THROTTLE_PROFILE_METADATA, context.getClass())
  );
}

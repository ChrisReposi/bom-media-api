import { registerAs } from "@nestjs/config";
import {
  DEFAULT_ADMIN_WEB_ORIGIN,
  DEFAULT_API_HOST,
  DEFAULT_API_PORT,
  DEFAULT_API_PREFIX,
} from "../common/constants/api.constants";
import { normalizePrefix } from "../common/utils/normalize-prefix";

export interface ApiEnvironmentConfig {
  nodeEnv: string;
  appEnv: string;
  isProduction: boolean;
  host: string;
  port: number;
  prefix: string;
  docsEnabled: boolean;
  corsAllowedOrigins: string[];
  corsAllowDbDomains: boolean;
  corsDbOriginCacheTtlMs: number;
  corsAllowLocalhostDbDomains: boolean;
  trustProxyEnabled: boolean;
  trustProxyHops: number;
  trustProxyCloudflareOnly: boolean;
  throttles: {
    global: ThrottleProfileConfig;
    login: ThrottleProfileConfig;
    refresh: ThrottleProfileConfig;
    logout: ThrottleProfileConfig;
    admin: ThrottleProfileConfig;
    publicWatch: ThrottleProfileConfig;
    publicMedia: ThrottleProfileConfig;
  };
  videoViewGrowth: {
    enabled: boolean;
    maxIncrementPerEvent: number;
    maxIncrementPerVideoHour: number;
    dedupeWindowMinutes: number;
    minWatchSeconds: number;
    randomMinIncrement: number;
  };
  database: {
    connectionLimit: number;
    connectTimeoutMs: number;
    acquireTimeoutMs: number;
    idleTimeoutSeconds: number;
  };
  localFileStorage: {
    enabled: boolean;
    root: string | null;
    videoUploadMaxMb: number;
    videoUploadHardMaxMb: number;
    videoChunkSizeMb: number;
    uploadSessionTtlMinutes: number;
    minFreeSpaceMb: number;
    staleUploadMaxAgeHours: number;
    thumbnailUploadMaxMb: number;
  };
}

export type ThrottleProfileConfig = {
  ttlSeconds: number;
  limit: number;
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  return value === "true" || value === "1";
}

function parseOrigins(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }

  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsedValue = Number(value);

  return Number.isInteger(parsedValue) && parsedValue > 0
    ? parsedValue
    : fallback;
}

export const apiConfig = registerAs("api", (): ApiEnvironmentConfig => {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const appEnv = process.env.APP_ENV ?? nodeEnv;
  const isProduction = nodeEnv === "production" || appEnv === "production";
  const adminOrigin = process.env.ADMIN_WEB_ORIGIN ?? DEFAULT_ADMIN_WEB_ORIGIN;
  const docsRequested = parseBoolean(
    process.env.API_INTERNAL_DOCS_ENABLED,
    !isProduction,
  );
  const docsAllowedInProduction = parseBoolean(
    process.env.API_DOCS_ALLOW_IN_PRODUCTION,
    false,
  );

  return {
    nodeEnv,
    appEnv,
    isProduction,
    host: process.env.API_HOST ?? DEFAULT_API_HOST,
    port: Number(process.env.API_PORT ?? DEFAULT_API_PORT),
    prefix: normalizePrefix(process.env.API_PREFIX ?? DEFAULT_API_PREFIX),
    docsEnabled:
      docsRequested && (!isProduction || docsAllowedInProduction === true),
    corsAllowedOrigins: Array.from(
      new Set([adminOrigin, ...parseOrigins(process.env.CORS_ALLOWED_ORIGINS)]),
    ),
    corsAllowDbDomains: parseBoolean(process.env.CORS_ALLOW_DB_DOMAINS, true),
    corsDbOriginCacheTtlMs: parsePositiveInteger(
      process.env.CORS_DB_ORIGIN_CACHE_TTL_MS,
      60_000,
    ),
    corsAllowLocalhostDbDomains: parseBoolean(
      process.env.CORS_ALLOW_LOCALHOST_DB_DOMAINS,
      !isProduction,
    ),
    trustProxyEnabled: parseBoolean(process.env.TRUST_PROXY_ENABLED, false),
    trustProxyHops: parsePositiveInteger(process.env.TRUST_PROXY_HOPS, 1),
    trustProxyCloudflareOnly: parseBoolean(
      process.env.TRUST_PROXY_CLOUDFLARE_ONLY,
      false,
    ),
    throttles: {
      global: {
        ttlSeconds: parsePositiveInteger(
          process.env.GLOBAL_THROTTLE_TTL_SECONDS,
          60,
        ),
        limit: parsePositiveInteger(process.env.GLOBAL_THROTTLE_LIMIT, 120),
      },
      login: {
        ttlSeconds: parsePositiveInteger(
          process.env.AUTH_LOGIN_THROTTLE_TTL_SECONDS,
          60,
        ),
        limit: parsePositiveInteger(process.env.AUTH_LOGIN_THROTTLE_LIMIT, 5),
      },
      refresh: {
        ttlSeconds: parsePositiveInteger(
          process.env.AUTH_REFRESH_THROTTLE_TTL_SECONDS,
          60,
        ),
        limit: parsePositiveInteger(
          process.env.AUTH_REFRESH_THROTTLE_LIMIT,
          20,
        ),
      },
      logout: {
        ttlSeconds: parsePositiveInteger(
          process.env.AUTH_LOGOUT_THROTTLE_TTL_SECONDS,
          60,
        ),
        limit: parsePositiveInteger(process.env.AUTH_LOGOUT_THROTTLE_LIMIT, 30),
      },
      admin: {
        ttlSeconds: parsePositiveInteger(
          process.env.ADMIN_API_THROTTLE_TTL_SECONDS,
          60,
        ),
        limit: parsePositiveInteger(process.env.ADMIN_API_THROTTLE_LIMIT, 120),
      },
      publicWatch: {
        ttlSeconds: parsePositiveInteger(
          process.env.PUBLIC_WATCH_THROTTLE_TTL_SECONDS,
          60,
        ),
        limit: parsePositiveInteger(
          process.env.PUBLIC_WATCH_THROTTLE_LIMIT,
          60,
        ),
      },
      publicMedia: {
        ttlSeconds: parsePositiveInteger(
          process.env.PUBLIC_MEDIA_THROTTLE_TTL_SECONDS,
          60,
        ),
        limit: parsePositiveInteger(
          process.env.PUBLIC_MEDIA_THROTTLE_LIMIT,
          1200,
        ),
      },
    },
    videoViewGrowth: {
      enabled: parseBoolean(
        process.env.VIDEO_VIEW_GROWTH_ENABLED,
        !isProduction,
      ),
      maxIncrementPerEvent: parsePositiveInteger(
        process.env.VIDEO_VIEW_MAX_INCREMENT_PER_EVENT,
        99,
      ),
      maxIncrementPerVideoHour: parsePositiveInteger(
        process.env.VIDEO_VIEW_MAX_INCREMENT_PER_VIDEO_HOUR,
        5000,
      ),
      dedupeWindowMinutes: parsePositiveInteger(
        process.env.VIDEO_VIEW_DEDUPE_WINDOW_MINUTES,
        15,
      ),
      minWatchSeconds: parsePositiveInteger(
        process.env.VIDEO_VIEW_MIN_WATCH_SECONDS,
        5,
      ),
      randomMinIncrement: parsePositiveInteger(
        process.env.VIDEO_VIEW_RANDOM_MIN_INCREMENT,
        1,
      ),
    },
    database: {
      connectionLimit: parsePositiveInteger(process.env.DB_CONNECTION_LIMIT, 5),
      connectTimeoutMs: parsePositiveInteger(
        process.env.DB_CONNECT_TIMEOUT_MS,
        10_000,
      ),
      acquireTimeoutMs: parsePositiveInteger(
        process.env.DB_ACQUIRE_TIMEOUT_MS,
        10_000,
      ),
      idleTimeoutSeconds: parsePositiveInteger(
        process.env.DB_IDLE_TIMEOUT_SECONDS,
        60,
      ),
    },
    localFileStorage: {
      enabled: parseBoolean(process.env.LOCAL_FILE_STORAGE_ENABLED, false),
      root:
        process.env.LOCAL_FILE_STORAGE_ROOT === undefined ||
        process.env.LOCAL_FILE_STORAGE_ROOT.trim() === ""
          ? null
          : process.env.LOCAL_FILE_STORAGE_ROOT.trim(),
      videoUploadMaxMb: parsePositiveInteger(
        process.env.LOCAL_VIDEO_UPLOAD_MAX_MB,
        500,
      ),
      videoUploadHardMaxMb: parsePositiveInteger(
        process.env.LOCAL_VIDEO_UPLOAD_HARD_MAX_MB,
        1024,
      ),
      videoChunkSizeMb: parsePositiveInteger(
        process.env.LOCAL_VIDEO_CHUNK_SIZE_MB,
        50,
      ),
      uploadSessionTtlMinutes: parsePositiveInteger(
        process.env.LOCAL_VIDEO_UPLOAD_SESSION_TTL_MINUTES,
        120,
      ),
      minFreeSpaceMb: parsePositiveInteger(
        process.env.LOCAL_VIDEO_MIN_FREE_SPACE_MB,
        1024,
      ),
      staleUploadMaxAgeHours: parsePositiveInteger(
        process.env.LOCAL_VIDEO_STALE_UPLOAD_MAX_AGE_HOURS,
        24,
      ),
      thumbnailUploadMaxMb: parsePositiveInteger(
        process.env.LOCAL_THUMBNAIL_UPLOAD_MAX_MB,
        10,
      ),
    },
  };
});

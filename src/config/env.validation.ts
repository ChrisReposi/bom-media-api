import {
  DEFAULT_ADMIN_WEB_ORIGIN,
  DEFAULT_API_HOST,
  DEFAULT_API_PORT,
  DEFAULT_API_PREFIX,
} from "../common/constants/api.constants";
import { normalizePrefix } from "../common/utils/normalize-prefix";
import { isAbsolute } from "node:path";
import proxyaddr from "proxy-addr";

const BOOLEAN_VALUES = new Set(["true", "false", "1", "0"]);
const DEFAULT_VIDEO_DB_UPLOAD_MB = 50;
const MAX_VIDEO_DB_UPLOAD_MB = 100;
const DEFAULT_VIDEO_THUMBNAIL_UPLOAD_MB = 5;
const MAX_VIDEO_THUMBNAIL_UPLOAD_MB = 10;
const DEFAULT_LOCAL_VIDEO_UPLOAD_MB = 500;
const MAX_LOCAL_VIDEO_UPLOAD_HARD_MB = 1024;
const DEFAULT_LOCAL_VIDEO_CHUNK_MB = 50;
const DEFAULT_LOCAL_VIDEO_UPLOAD_SESSION_TTL_MINUTES = 120;
const DEFAULT_LOCAL_VIDEO_MIN_FREE_SPACE_MB = 1024;
const DEFAULT_LOCAL_VIDEO_STALE_UPLOAD_MAX_AGE_HOURS = 24;
const DEFAULT_LOCAL_THUMBNAIL_UPLOAD_MB = 10;
const DEFAULT_MEMORY_CACHE_MAX_ENTRIES = 1000;
const DEFAULT_MEMORY_CACHE_DEFAULT_TTL_SECONDS = 60;
const DEFAULT_MEMORY_CACHE_INFLIGHT_TTL_MS = 5000;
const DEFAULT_ADMIN_VIDEOS_LIST_CACHE_TTL_SECONDS = 30;
const DEFAULT_ADMIN_WEBSITES_LIST_CACHE_TTL_SECONDS = 60;
const DEFAULT_PUBLIC_WATCH_METADATA_CACHE_TTL_SECONDS = 10;
const DEFAULT_MEDIA_METADATA_CACHE_TTL_SECONDS = 300;
const PROTOCOL_VALUES = new Set(["http", "https"]);
const JWT_EXPIRES_IN_PATTERN = /^\d+[smhd]?$/;

function readString(
  config: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = config[key];

  if (typeof value !== "string" || value.trim() === "") {
    process.env[key] = fallback;
    return fallback;
  }

  process.env[key] = value.trim();
  return value.trim();
}

function readRequiredString(
  config: Record<string, unknown>,
  key: string,
): string {
  const value = config[key];

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} is required`);
  }

  process.env[key] = value.trim();
  return value.trim();
}

function readBoolean(
  config: Record<string, unknown>,
  key: string,
  fallback: boolean,
): string {
  const value = config[key];

  if (value === undefined || value === null || value === "") {
    const fallbackValue = String(fallback);
    process.env[key] = fallbackValue;
    return fallbackValue;
  }

  if (typeof value !== "string" || !BOOLEAN_VALUES.has(value.toLowerCase())) {
    throw new Error(`${key} must be a boolean value`);
  }

  const normalized = value.toLowerCase() === "1" ? "true" : value.toLowerCase();
  const finalValue = normalized === "0" ? "false" : normalized;
  process.env[key] = finalValue;
  return finalValue;
}

function readOptionalProtocol(
  config: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = config[key];

  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  const protocol = value.trim().toLowerCase();

  if (!PROTOCOL_VALUES.has(protocol)) {
    throw new Error(`${key} must be either http or https`);
  }

  process.env[key] = protocol;
  return protocol;
}

function readPositiveInteger(
  config: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = Number(readString(config, key, String(fallback)));

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }

  return value;
}

function readBoundedInteger(
  config: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = readPositiveInteger(config, key, fallback);

  if (value < min || value > max) {
    throw new Error(`${key} must be between ${min} and ${max}`);
  }

  return value;
}

function readOptionalTrimmedString(
  config: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = config[key];

  if (typeof value !== "string" || value.trim() === "") {
    delete process.env[key];
    return undefined;
  }

  const trimmed = value.trim();
  process.env[key] = trimmed;
  return trimmed;
}

function isUnsafeLocalStorageRoot(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  const parts = normalized.split("/").filter((part) => part.length > 0);

  return (
    normalized === "/" ||
    parts.includes("public_html") ||
    parts.includes("htdocs") ||
    parts.includes("www") ||
    parts.includes("public") ||
    normalized.endsWith("/dist")
  );
}

export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const validated: Record<string, unknown> = { ...config };
  const nodeEnv = readString(config, "NODE_ENV", "development");
  const appEnv = readString(config, "APP_ENV", nodeEnv);
  const isProduction = nodeEnv === "production" || appEnv === "production";

  validated.NODE_ENV = nodeEnv;
  validated.APP_ENV = appEnv;
  validated.API_HOST = readString(config, "API_HOST", DEFAULT_API_HOST);

  const portValue = readString(config, "API_PORT", String(DEFAULT_API_PORT));
  const port = Number(portValue);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("API_PORT must be a valid TCP port number");
  }
  validated.API_PORT = String(port);

  const prefix = normalizePrefix(
    readString(config, "API_PREFIX", DEFAULT_API_PREFIX),
  );
  if (prefix.length === 0) {
    throw new Error("API_PREFIX must not be empty");
  }
  process.env.API_PREFIX = prefix;
  validated.API_PREFIX = prefix;

  validated.API_INTERNAL_DOCS_ENABLED = readBoolean(
    config,
    "API_INTERNAL_DOCS_ENABLED",
    !isProduction,
  );
  validated.API_DOCS_ALLOW_IN_PRODUCTION = readBoolean(
    config,
    "API_DOCS_ALLOW_IN_PRODUCTION",
    false,
  );
  validated.DATABASE_URL = readRequiredString(config, "DATABASE_URL");
  if (typeof config.SHADOW_DATABASE_URL === "string") {
    const shadowDatabaseUrl = config.SHADOW_DATABASE_URL.trim();
    if (shadowDatabaseUrl.length > 0) {
      process.env.SHADOW_DATABASE_URL = shadowDatabaseUrl;
      validated.SHADOW_DATABASE_URL = shadowDatabaseUrl;
    }
  }
  validated.JWT_ACCESS_SECRET = readRequiredString(config, "JWT_ACCESS_SECRET");
  validated.JWT_ACCESS_EXPIRES_IN = readString(
    config,
    "JWT_ACCESS_EXPIRES_IN",
    "15m",
  );
  if (!JWT_EXPIRES_IN_PATTERN.test(String(validated.JWT_ACCESS_EXPIRES_IN))) {
    throw new Error(
      "JWT_ACCESS_EXPIRES_IN must be a duration such as 900, 15m, 1h, or 7d",
    );
  }
  validated.REFRESH_TOKEN_PEPPER = readRequiredString(
    config,
    "REFRESH_TOKEN_PEPPER",
  );
  validated.SHARE_TOKEN_PEPPER = readRequiredString(
    config,
    "SHARE_TOKEN_PEPPER",
  );
  const mediaGrantSecret = isProduction
    ? readRequiredString(config, "PUBLIC_MEDIA_GRANT_SECRET")
    : readString(
        config,
        "PUBLIC_MEDIA_GRANT_SECRET",
        "local-public-media-grant-secret-change-me",
      );
  if (mediaGrantSecret.length < 32) {
    throw new Error("PUBLIC_MEDIA_GRANT_SECRET must be at least 32 characters");
  }
  validated.PUBLIC_MEDIA_GRANT_SECRET = mediaGrantSecret;
  validated.PUBLIC_MEDIA_GRANT_TTL_SECONDS = String(
    readBoundedInteger(
      config,
      "PUBLIC_MEDIA_GRANT_TTL_SECONDS",
      6 * 60 * 60,
      5 * 60,
      24 * 60 * 60,
    ),
  );
  validated.ACCESS_LOG_IP_PEPPER = readRequiredString(
    config,
    "ACCESS_LOG_IP_PEPPER",
  );

  const refreshTokenBytes = Number(
    readString(config, "REFRESH_TOKEN_BYTES", "32"),
  );
  if (!Number.isInteger(refreshTokenBytes) || refreshTokenBytes < 32) {
    throw new Error(
      "REFRESH_TOKEN_BYTES must be an integer greater than or equal to 32",
    );
  }
  validated.REFRESH_TOKEN_BYTES = String(refreshTokenBytes);

  const refreshTokenExpiresDays = Number(
    readString(config, "REFRESH_TOKEN_EXPIRES_DAYS", "30"),
  );
  if (
    !Number.isInteger(refreshTokenExpiresDays) ||
    refreshTokenExpiresDays <= 0
  ) {
    throw new Error("REFRESH_TOKEN_EXPIRES_DAYS must be a positive integer");
  }
  validated.REFRESH_TOKEN_EXPIRES_DAYS = String(refreshTokenExpiresDays);

  validated.ADMIN_REGISTER_ENABLED = readBoolean(
    config,
    "ADMIN_REGISTER_ENABLED",
    !isProduction,
  );
  validated.ADMIN_ACCOUNT_MANAGEMENT_ENABLED = readBoolean(
    config,
    "ADMIN_ACCOUNT_MANAGEMENT_ENABLED",
    !isProduction,
  );
  validated.ADMIN_TEMP_PASSWORD_TTL_HOURS = String(
    readBoundedInteger(config, "ADMIN_TEMP_PASSWORD_TTL_HOURS", 24, 1, 168),
  );

  if (typeof config.ADMIN_REGISTER_SECRET === "string") {
    const adminRegisterSecret = config.ADMIN_REGISTER_SECRET.trim();
    if (adminRegisterSecret.length > 0) {
      process.env.ADMIN_REGISTER_SECRET = adminRegisterSecret;
      validated.ADMIN_REGISTER_SECRET = adminRegisterSecret;
    }
  }

  if (isProduction) {
    validated.ADMIN_CHANGE_PASSWORD_SECRET = readRequiredString(
      config,
      "ADMIN_CHANGE_PASSWORD_SECRET",
    );
  } else if (typeof config.ADMIN_CHANGE_PASSWORD_SECRET === "string") {
    const adminChangePasswordSecret =
      config.ADMIN_CHANGE_PASSWORD_SECRET.trim();
    if (adminChangePasswordSecret.length > 0) {
      process.env.ADMIN_CHANGE_PASSWORD_SECRET = adminChangePasswordSecret;
      validated.ADMIN_CHANGE_PASSWORD_SECRET = adminChangePasswordSecret;
    }
  }

  const adminWebOrigin = readString(
    config,
    "ADMIN_WEB_ORIGIN",
    DEFAULT_ADMIN_WEB_ORIGIN,
  );
  if (isProduction) {
    let parsedAdminOrigin: URL;
    try {
      parsedAdminOrigin = new URL(adminWebOrigin);
    } catch {
      throw new Error("ADMIN_WEB_ORIGIN must be a valid HTTPS origin");
    }
    if (
      parsedAdminOrigin.protocol !== "https:" ||
      ["localhost", "127.0.0.1", "::1"].includes(parsedAdminOrigin.hostname)
    ) {
      throw new Error(
        "ADMIN_WEB_ORIGIN must be a non-local HTTPS origin in production",
      );
    }
  }
  validated.ADMIN_WEB_ORIGIN = adminWebOrigin;
  validated.ALLOW_LOCALHOST_DOMAIN_CLAIM = readBoolean(
    config,
    "ALLOW_LOCALHOST_DOMAIN_CLAIM",
    false,
  );
  const publicSiteProtocol = readOptionalProtocol(
    config,
    "PUBLIC_SITE_PROTOCOL",
  );
  if (publicSiteProtocol !== undefined) {
    validated.PUBLIC_SITE_PROTOCOL = publicSiteProtocol;
  }
  const publicShareLocalProtocol = readOptionalProtocol(
    config,
    "PUBLIC_SHARE_LOCAL_PROTOCOL",
  );
  if (publicShareLocalProtocol !== undefined) {
    validated.PUBLIC_SHARE_LOCAL_PROTOCOL = publicShareLocalProtocol;
  }
  if (typeof config.CORS_ALLOWED_ORIGINS === "string") {
    process.env.CORS_ALLOWED_ORIGINS = config.CORS_ALLOWED_ORIGINS;
    validated.CORS_ALLOWED_ORIGINS = config.CORS_ALLOWED_ORIGINS;
  }
  validated.CORS_ALLOW_DB_DOMAINS = readBoolean(
    config,
    "CORS_ALLOW_DB_DOMAINS",
    true,
  );

  const corsDbOriginCacheTtlMs = Number(
    readString(config, "CORS_DB_ORIGIN_CACHE_TTL_MS", "60000"),
  );
  if (
    !Number.isInteger(corsDbOriginCacheTtlMs) ||
    corsDbOriginCacheTtlMs <= 0
  ) {
    throw new Error("CORS_DB_ORIGIN_CACHE_TTL_MS must be a positive integer");
  }
  validated.CORS_DB_ORIGIN_CACHE_TTL_MS = String(corsDbOriginCacheTtlMs);

  validated.CORS_ALLOW_LOCALHOST_DB_DOMAINS = readBoolean(
    config,
    "CORS_ALLOW_LOCALHOST_DB_DOMAINS",
    !isProduction,
  );

  validated.TRUST_PROXY_ENABLED = readBoolean(
    config,
    "TRUST_PROXY_ENABLED",
    false,
  );
  validated.TRUST_PROXY_HOPS = String(
    readPositiveInteger(config, "TRUST_PROXY_HOPS", 1),
  );
  validated.TRUST_PROXY_CLOUDFLARE_ONLY = readBoolean(
    config,
    "TRUST_PROXY_CLOUDFLARE_ONLY",
    false,
  );
  const trustedProxyCidrs = readOptionalTrimmedString(
    config,
    "TRUSTED_PROXY_CIDRS",
  );
  if (
    isProduction &&
    validated.TRUST_PROXY_ENABLED === "true" &&
    trustedProxyCidrs === undefined
  ) {
    throw new Error(
      "TRUSTED_PROXY_CIDRS is required when trusted proxy is enabled in production",
    );
  }
  if (trustedProxyCidrs !== undefined) {
    const cidrs = trustedProxyCidrs
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (cidrs.length === 0) {
      throw new Error("TRUSTED_PROXY_CIDRS must contain at least one CIDR");
    }
    try {
      proxyaddr.compile(cidrs);
    } catch {
      throw new Error(
        "TRUSTED_PROXY_CIDRS contains an invalid address or CIDR",
      );
    }
    validated.TRUSTED_PROXY_CIDRS = cidrs.join(",");
    process.env.TRUSTED_PROXY_CIDRS = cidrs.join(",");
  }

  validated.MEMORY_CACHE_ENABLED = readBoolean(
    config,
    "MEMORY_CACHE_ENABLED",
    true,
  );
  validated.MEMORY_CACHE_MAX_ENTRIES = String(
    readBoundedInteger(
      config,
      "MEMORY_CACHE_MAX_ENTRIES",
      DEFAULT_MEMORY_CACHE_MAX_ENTRIES,
      100,
      10_000,
    ),
  );
  validated.MEMORY_CACHE_DEFAULT_TTL_SECONDS = String(
    readBoundedInteger(
      config,
      "MEMORY_CACHE_DEFAULT_TTL_SECONDS",
      DEFAULT_MEMORY_CACHE_DEFAULT_TTL_SECONDS,
      1,
      600,
    ),
  );
  validated.MEMORY_CACHE_INFLIGHT_TTL_MS = String(
    readBoundedInteger(
      config,
      "MEMORY_CACHE_INFLIGHT_TTL_MS",
      DEFAULT_MEMORY_CACHE_INFLIGHT_TTL_MS,
      500,
      30_000,
    ),
  );
  validated.ADMIN_VIDEOS_LIST_CACHE_TTL_SECONDS = String(
    readBoundedInteger(
      config,
      "ADMIN_VIDEOS_LIST_CACHE_TTL_SECONDS",
      DEFAULT_ADMIN_VIDEOS_LIST_CACHE_TTL_SECONDS,
      1,
      600,
    ),
  );
  validated.ADMIN_WEBSITES_LIST_CACHE_TTL_SECONDS = String(
    readBoundedInteger(
      config,
      "ADMIN_WEBSITES_LIST_CACHE_TTL_SECONDS",
      DEFAULT_ADMIN_WEBSITES_LIST_CACHE_TTL_SECONDS,
      1,
      600,
    ),
  );
  validated.PUBLIC_WATCH_METADATA_CACHE_TTL_SECONDS = String(
    readBoundedInteger(
      config,
      "PUBLIC_WATCH_METADATA_CACHE_TTL_SECONDS",
      DEFAULT_PUBLIC_WATCH_METADATA_CACHE_TTL_SECONDS,
      1,
      60,
    ),
  );
  validated.MEDIA_METADATA_CACHE_TTL_SECONDS = String(
    readBoundedInteger(
      config,
      "MEDIA_METADATA_CACHE_TTL_SECONDS",
      DEFAULT_MEDIA_METADATA_CACHE_TTL_SECONDS,
      1,
      3600,
    ),
  );

  validated.GLOBAL_THROTTLE_TTL_SECONDS = String(
    readPositiveInteger(config, "GLOBAL_THROTTLE_TTL_SECONDS", 60),
  );
  validated.GLOBAL_THROTTLE_LIMIT = String(
    readPositiveInteger(config, "GLOBAL_THROTTLE_LIMIT", 120),
  );
  validated.AUTH_LOGIN_THROTTLE_TTL_SECONDS = String(
    readPositiveInteger(config, "AUTH_LOGIN_THROTTLE_TTL_SECONDS", 60),
  );
  validated.AUTH_LOGIN_THROTTLE_LIMIT = String(
    readPositiveInteger(config, "AUTH_LOGIN_THROTTLE_LIMIT", 5),
  );
  validated.AUTH_REFRESH_THROTTLE_TTL_SECONDS = String(
    readPositiveInteger(config, "AUTH_REFRESH_THROTTLE_TTL_SECONDS", 60),
  );
  validated.AUTH_REFRESH_THROTTLE_LIMIT = String(
    readPositiveInteger(config, "AUTH_REFRESH_THROTTLE_LIMIT", 20),
  );
  validated.AUTH_LOGOUT_THROTTLE_TTL_SECONDS = String(
    readPositiveInteger(config, "AUTH_LOGOUT_THROTTLE_TTL_SECONDS", 60),
  );
  validated.AUTH_LOGOUT_THROTTLE_LIMIT = String(
    readPositiveInteger(config, "AUTH_LOGOUT_THROTTLE_LIMIT", 30),
  );
  validated.ADMIN_API_THROTTLE_TTL_SECONDS = String(
    readPositiveInteger(config, "ADMIN_API_THROTTLE_TTL_SECONDS", 60),
  );
  validated.ADMIN_API_THROTTLE_LIMIT = String(
    readPositiveInteger(config, "ADMIN_API_THROTTLE_LIMIT", 120),
  );
  validated.PUBLIC_WATCH_THROTTLE_TTL_SECONDS = String(
    readPositiveInteger(config, "PUBLIC_WATCH_THROTTLE_TTL_SECONDS", 60),
  );
  validated.PUBLIC_WATCH_THROTTLE_LIMIT = String(
    readPositiveInteger(config, "PUBLIC_WATCH_THROTTLE_LIMIT", 60),
  );
  validated.PUBLIC_MEDIA_THROTTLE_TTL_SECONDS = String(
    readPositiveInteger(config, "PUBLIC_MEDIA_THROTTLE_TTL_SECONDS", 60),
  );
  validated.PUBLIC_MEDIA_THROTTLE_LIMIT = String(
    readPositiveInteger(config, "PUBLIC_MEDIA_THROTTLE_LIMIT", 1200),
  );

  validated.VIDEO_VIEW_GROWTH_ENABLED = readBoolean(
    config,
    "VIDEO_VIEW_GROWTH_ENABLED",
    !isProduction,
  );
  const videoViewMaxIncrementPerEvent = readPositiveInteger(
    config,
    "VIDEO_VIEW_MAX_INCREMENT_PER_EVENT",
    99,
  );
  if (videoViewMaxIncrementPerEvent > 99) {
    throw new Error(
      "VIDEO_VIEW_MAX_INCREMENT_PER_EVENT must be less than or equal to 99",
    );
  }
  validated.VIDEO_VIEW_MAX_INCREMENT_PER_EVENT = String(
    videoViewMaxIncrementPerEvent,
  );

  validated.VIDEO_VIEW_MAX_INCREMENT_PER_VIDEO_HOUR = String(
    readPositiveInteger(
      config,
      "VIDEO_VIEW_MAX_INCREMENT_PER_VIDEO_HOUR",
      5000,
    ),
  );
  validated.VIDEO_VIEW_DEDUPE_WINDOW_MINUTES = String(
    readPositiveInteger(config, "VIDEO_VIEW_DEDUPE_WINDOW_MINUTES", 15),
  );
  validated.VIDEO_VIEW_MIN_WATCH_SECONDS = String(
    readPositiveInteger(config, "VIDEO_VIEW_MIN_WATCH_SECONDS", 5),
  );
  const videoViewRandomMinIncrement = readPositiveInteger(
    config,
    "VIDEO_VIEW_RANDOM_MIN_INCREMENT",
    1,
  );
  if (videoViewRandomMinIncrement > videoViewMaxIncrementPerEvent) {
    throw new Error(
      "VIDEO_VIEW_RANDOM_MIN_INCREMENT must be less than or equal to VIDEO_VIEW_MAX_INCREMENT_PER_EVENT",
    );
  }
  validated.VIDEO_VIEW_RANDOM_MIN_INCREMENT = String(
    videoViewRandomMinIncrement,
  );

  validated.DB_CONNECTION_LIMIT = String(
    readPositiveInteger(config, "DB_CONNECTION_LIMIT", 5),
  );
  validated.DB_CONNECT_TIMEOUT_MS = String(
    readPositiveInteger(config, "DB_CONNECT_TIMEOUT_MS", 10_000),
  );
  validated.DB_ACQUIRE_TIMEOUT_MS = String(
    readPositiveInteger(config, "DB_ACQUIRE_TIMEOUT_MS", 10_000),
  );
  validated.DB_IDLE_TIMEOUT_SECONDS = String(
    readPositiveInteger(config, "DB_IDLE_TIMEOUT_SECONDS", 60),
  );
  validated.DB_MARIADB_USE_TEXT_PROTOCOL = readBoolean(
    config,
    "DB_MARIADB_USE_TEXT_PROTOCOL",
    false,
  );

  if (typeof config.VIDEO_UPLOAD_MAX_MB === "string") {
    const uploadMaxMb = Number(config.VIDEO_UPLOAD_MAX_MB.trim());
    if (!Number.isInteger(uploadMaxMb) || uploadMaxMb <= 0) {
      throw new Error("VIDEO_UPLOAD_MAX_MB must be a positive integer");
    }
    process.env.VIDEO_UPLOAD_MAX_MB = String(uploadMaxMb);
    validated.VIDEO_UPLOAD_MAX_MB = String(uploadMaxMb);
  }

  validated.VIDEO_DB_STORAGE_ENABLED = readBoolean(
    config,
    "VIDEO_DB_STORAGE_ENABLED",
    false,
  );
  validated.VIDEO_DB_STORAGE_ALLOW_PRODUCTION_OVERRIDE = readBoolean(
    config,
    "VIDEO_DB_STORAGE_ALLOW_PRODUCTION_OVERRIDE",
    false,
  );

  if (
    isProduction &&
    validated.VIDEO_DB_STORAGE_ENABLED === "true" &&
    validated.VIDEO_DB_STORAGE_ALLOW_PRODUCTION_OVERRIDE !== "true"
  ) {
    throw new Error(
      "VIDEO_DB_STORAGE_ENABLED must be false in production unless VIDEO_DB_STORAGE_ALLOW_PRODUCTION_OVERRIDE=true",
    );
  }

  const dbUploadMaxMb = Number(
    readString(
      config,
      "VIDEO_DB_UPLOAD_MAX_MB",
      String(DEFAULT_VIDEO_DB_UPLOAD_MB),
    ),
  );
  if (!Number.isInteger(dbUploadMaxMb) || dbUploadMaxMb <= 0) {
    throw new Error("VIDEO_DB_UPLOAD_MAX_MB must be a positive integer");
  }
  if (dbUploadMaxMb > MAX_VIDEO_DB_UPLOAD_MB) {
    throw new Error(
      `VIDEO_DB_UPLOAD_MAX_MB must be ${MAX_VIDEO_DB_UPLOAD_MB} or smaller`,
    );
  }
  validated.VIDEO_DB_UPLOAD_MAX_MB = String(dbUploadMaxMb);

  if (typeof config.CLOUDINARY_UPLOAD_FOLDER === "string") {
    process.env.CLOUDINARY_UPLOAD_FOLDER =
      config.CLOUDINARY_UPLOAD_FOLDER.trim();
    validated.CLOUDINARY_UPLOAD_FOLDER = config.CLOUDINARY_UPLOAD_FOLDER.trim();
  }

  if (typeof config.CLOUDINARY_THUMBNAIL_UPLOAD_FOLDER === "string") {
    process.env.CLOUDINARY_THUMBNAIL_UPLOAD_FOLDER =
      config.CLOUDINARY_THUMBNAIL_UPLOAD_FOLDER.trim();
    validated.CLOUDINARY_THUMBNAIL_UPLOAD_FOLDER =
      config.CLOUDINARY_THUMBNAIL_UPLOAD_FOLDER.trim();
  }

  if (typeof config.CLOUDINARY_SECURE === "string") {
    validated.CLOUDINARY_SECURE = readBoolean(
      config,
      "CLOUDINARY_SECURE",
      true,
    );
  }

  const thumbnailUploadMaxMb = Number(
    readString(
      config,
      "VIDEO_THUMBNAIL_UPLOAD_MAX_MB",
      String(DEFAULT_VIDEO_THUMBNAIL_UPLOAD_MB),
    ),
  );
  if (!Number.isInteger(thumbnailUploadMaxMb) || thumbnailUploadMaxMb <= 0) {
    throw new Error("VIDEO_THUMBNAIL_UPLOAD_MAX_MB must be a positive integer");
  }
  if (thumbnailUploadMaxMb > MAX_VIDEO_THUMBNAIL_UPLOAD_MB) {
    throw new Error(
      `VIDEO_THUMBNAIL_UPLOAD_MAX_MB must be ${MAX_VIDEO_THUMBNAIL_UPLOAD_MB} or smaller`,
    );
  }
  validated.VIDEO_THUMBNAIL_UPLOAD_MAX_MB = String(thumbnailUploadMaxMb);

  validated.VIDEO_EMBED_ALLOWED_HOSTS = readString(
    config,
    "VIDEO_EMBED_ALLOWED_HOSTS",
    "player.cloudinary.com,www.youtube.com,www.youtube-nocookie.com,player.vimeo.com",
  );
  validated.VIDEO_EMBED_DEFAULT_ALLOW = readString(
    config,
    "VIDEO_EMBED_DEFAULT_ALLOW",
    "autoplay; fullscreen; encrypted-media; picture-in-picture",
  );

  validated.VIDEO_METADATA_PROBE_ENABLED = readBoolean(
    config,
    "VIDEO_METADATA_PROBE_ENABLED",
    true,
  );
  const manualVideoUrlAllowlist = readOptionalTrimmedString(
    config,
    "MANUAL_VIDEO_URL_ALLOWLIST",
  );
  if (manualVideoUrlAllowlist !== undefined) {
    validated.MANUAL_VIDEO_URL_ALLOWLIST = manualVideoUrlAllowlist;
  }

  const metadataProbeTimeoutMs = Number(
    readString(config, "VIDEO_METADATA_PROBE_TIMEOUT_MS", "8000"),
  );
  if (
    !Number.isInteger(metadataProbeTimeoutMs) ||
    metadataProbeTimeoutMs <= 0
  ) {
    throw new Error(
      "VIDEO_METADATA_PROBE_TIMEOUT_MS must be a positive integer",
    );
  }
  validated.VIDEO_METADATA_PROBE_TIMEOUT_MS = String(metadataProbeTimeoutMs);

  const metadataProbeMaxRemoteMb = Number(
    readString(config, "VIDEO_METADATA_PROBE_MAX_REMOTE_MB", "100"),
  );
  if (
    !Number.isInteger(metadataProbeMaxRemoteMb) ||
    metadataProbeMaxRemoteMb <= 0
  ) {
    throw new Error(
      "VIDEO_METADATA_PROBE_MAX_REMOTE_MB must be a positive integer",
    );
  }
  validated.VIDEO_METADATA_PROBE_MAX_REMOTE_MB = String(
    metadataProbeMaxRemoteMb,
  );

  validated.LOCAL_FILE_STORAGE_ENABLED = readBoolean(
    config,
    "LOCAL_FILE_STORAGE_ENABLED",
    false,
  );

  const localFileStorageRoot = readOptionalTrimmedString(
    config,
    "LOCAL_FILE_STORAGE_ROOT",
  );
  if (validated.LOCAL_FILE_STORAGE_ENABLED === "true") {
    if (localFileStorageRoot === undefined) {
      throw new Error(
        "LOCAL_FILE_STORAGE_ROOT is required when LOCAL_FILE_STORAGE_ENABLED=true",
      );
    }

    if (isUnsafeLocalStorageRoot(localFileStorageRoot)) {
      throw new Error(
        "LOCAL_FILE_STORAGE_ROOT must be outside public web roots such as public_html, htdocs, www, public, or dist",
      );
    }
    if (isProduction && !isAbsolute(localFileStorageRoot)) {
      throw new Error(
        "LOCAL_FILE_STORAGE_ROOT must be an absolute path in production",
      );
    }

    validated.LOCAL_FILE_STORAGE_ROOT = localFileStorageRoot;
  } else if (localFileStorageRoot !== undefined) {
    validated.LOCAL_FILE_STORAGE_ROOT = localFileStorageRoot;
  }

  const localVideoHardMaxMb = readPositiveInteger(
    config,
    "LOCAL_VIDEO_UPLOAD_HARD_MAX_MB",
    MAX_LOCAL_VIDEO_UPLOAD_HARD_MB,
  );
  if (localVideoHardMaxMb > MAX_LOCAL_VIDEO_UPLOAD_HARD_MB) {
    throw new Error(
      `LOCAL_VIDEO_UPLOAD_HARD_MAX_MB must be ${MAX_LOCAL_VIDEO_UPLOAD_HARD_MB} or smaller`,
    );
  }
  validated.LOCAL_VIDEO_UPLOAD_HARD_MAX_MB = String(localVideoHardMaxMb);

  const localVideoUploadMaxMb = readPositiveInteger(
    config,
    "LOCAL_VIDEO_UPLOAD_MAX_MB",
    DEFAULT_LOCAL_VIDEO_UPLOAD_MB,
  );
  if (localVideoUploadMaxMb > localVideoHardMaxMb) {
    throw new Error(
      "LOCAL_VIDEO_UPLOAD_MAX_MB must be less than or equal to LOCAL_VIDEO_UPLOAD_HARD_MAX_MB",
    );
  }
  validated.LOCAL_VIDEO_UPLOAD_MAX_MB = String(localVideoUploadMaxMb);

  const localVideoChunkSizeMb = readPositiveInteger(
    config,
    "LOCAL_VIDEO_CHUNK_SIZE_MB",
    DEFAULT_LOCAL_VIDEO_CHUNK_MB,
  );
  if (localVideoChunkSizeMb > localVideoUploadMaxMb) {
    throw new Error(
      "LOCAL_VIDEO_CHUNK_SIZE_MB must be less than or equal to LOCAL_VIDEO_UPLOAD_MAX_MB",
    );
  }
  if (localVideoChunkSizeMb > 100) {
    throw new Error("LOCAL_VIDEO_CHUNK_SIZE_MB must be 100 or smaller");
  }
  validated.LOCAL_VIDEO_CHUNK_SIZE_MB = String(localVideoChunkSizeMb);

  validated.LOCAL_VIDEO_UPLOAD_SESSION_TTL_MINUTES = String(
    readPositiveInteger(
      config,
      "LOCAL_VIDEO_UPLOAD_SESSION_TTL_MINUTES",
      DEFAULT_LOCAL_VIDEO_UPLOAD_SESSION_TTL_MINUTES,
    ),
  );
  validated.LOCAL_VIDEO_MIN_FREE_SPACE_MB = String(
    readPositiveInteger(
      config,
      "LOCAL_VIDEO_MIN_FREE_SPACE_MB",
      DEFAULT_LOCAL_VIDEO_MIN_FREE_SPACE_MB,
    ),
  );
  validated.LOCAL_VIDEO_STALE_UPLOAD_MAX_AGE_HOURS = String(
    readPositiveInteger(
      config,
      "LOCAL_VIDEO_STALE_UPLOAD_MAX_AGE_HOURS",
      DEFAULT_LOCAL_VIDEO_STALE_UPLOAD_MAX_AGE_HOURS,
    ),
  );
  const localThumbnailUploadMaxMb = readPositiveInteger(
    config,
    "LOCAL_THUMBNAIL_UPLOAD_MAX_MB",
    DEFAULT_LOCAL_THUMBNAIL_UPLOAD_MB,
  );
  if (localThumbnailUploadMaxMb > MAX_VIDEO_THUMBNAIL_UPLOAD_MB) {
    throw new Error(
      `LOCAL_THUMBNAIL_UPLOAD_MAX_MB must be ${MAX_VIDEO_THUMBNAIL_UPLOAD_MB} or smaller`,
    );
  }
  validated.LOCAL_THUMBNAIL_UPLOAD_MAX_MB = String(localThumbnailUploadMaxMb);

  // Optional release identity, injected at build/deploy time (never read from
  // .git at runtime). Absent values are always allowed — including in
  // production — so a deploy without them cannot fail readiness; present
  // values are validated strictly so a malformed injection fails at boot.
  if (typeof config.APP_RELEASE_VERSION === "string") {
    const releaseVersion = config.APP_RELEASE_VERSION.trim();
    if (releaseVersion.length > 64) {
      throw new Error("APP_RELEASE_VERSION must be 64 characters or fewer");
    }
    if (releaseVersion.length > 0) {
      process.env.APP_RELEASE_VERSION = releaseVersion;
      validated.APP_RELEASE_VERSION = releaseVersion;
    }
  }
  if (typeof config.APP_BUILD_SHA === "string") {
    const buildSha = config.APP_BUILD_SHA.trim();
    if (buildSha.length > 0 && !/^[0-9a-f]{7,40}$/i.test(buildSha)) {
      throw new Error(
        "APP_BUILD_SHA must be a 7-40 character hexadecimal commit SHA",
      );
    }
    if (buildSha.length > 0) {
      process.env.APP_BUILD_SHA = buildSha;
      validated.APP_BUILD_SHA = buildSha;
    }
  }
  if (typeof config.APP_BUILD_TIME === "string") {
    const buildTime = config.APP_BUILD_TIME.trim();
    if (buildTime.length > 0) {
      const parsedBuildTime = new Date(buildTime);
      if (
        Number.isNaN(parsedBuildTime.getTime()) ||
        parsedBuildTime.toISOString() !== buildTime
      ) {
        throw new Error(
          "APP_BUILD_TIME must be an ISO 8601 UTC timestamp such as 2026-07-18T00:00:00.000Z",
        );
      }
      process.env.APP_BUILD_TIME = buildTime;
      validated.APP_BUILD_TIME = buildTime;
    }
  }

  return validated;
}

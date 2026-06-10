import {
  DEFAULT_ADMIN_WEB_ORIGIN,
  DEFAULT_API_HOST,
  DEFAULT_API_PORT,
  DEFAULT_API_PREFIX,
} from "../common/constants/api.constants";
import { normalizePrefix } from "../common/utils/normalize-prefix";

const BOOLEAN_VALUES = new Set(["true", "false", "1", "0"]);
const DEFAULT_VIDEO_DB_UPLOAD_MB = 50;
const MAX_VIDEO_DB_UPLOAD_MB = 100;
const DEFAULT_VIDEO_THUMBNAIL_UPLOAD_MB = 5;
const MAX_VIDEO_THUMBNAIL_UPLOAD_MB = 10;
const PROTOCOL_VALUES = new Set(["http", "https"]);

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

export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const validated: Record<string, unknown> = { ...config };
  const nodeEnv = readString(config, "NODE_ENV", "development");

  validated.NODE_ENV = nodeEnv;
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
    nodeEnv !== "production",
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
  validated.REFRESH_TOKEN_PEPPER = readRequiredString(
    config,
    "REFRESH_TOKEN_PEPPER",
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
    true,
  );

  if (typeof config.ADMIN_REGISTER_SECRET === "string") {
    const adminRegisterSecret = config.ADMIN_REGISTER_SECRET.trim();
    if (adminRegisterSecret.length > 0) {
      process.env.ADMIN_REGISTER_SECRET = adminRegisterSecret;
      validated.ADMIN_REGISTER_SECRET = adminRegisterSecret;
    }
  }

  if (nodeEnv === "production") {
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

  validated.ADMIN_WEB_ORIGIN = readString(
    config,
    "ADMIN_WEB_ORIGIN",
    DEFAULT_ADMIN_WEB_ORIGIN,
  );
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

  return validated;
}

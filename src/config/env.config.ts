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
  isProduction: boolean;
  host: string;
  port: number;
  prefix: string;
  docsEnabled: boolean;
  corsAllowedOrigins: string[];
  corsAllowDbDomains: boolean;
  corsDbOriginCacheTtlMs: number;
  corsAllowLocalhostDbDomains: boolean;
}

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
  const adminOrigin = process.env.ADMIN_WEB_ORIGIN ?? DEFAULT_ADMIN_WEB_ORIGIN;

  return {
    nodeEnv,
    isProduction: nodeEnv === "production",
    host: process.env.API_HOST ?? DEFAULT_API_HOST,
    port: Number(process.env.API_PORT ?? DEFAULT_API_PORT),
    prefix: normalizePrefix(process.env.API_PREFIX ?? DEFAULT_API_PREFIX),
    docsEnabled: parseBoolean(
      process.env.API_INTERNAL_DOCS_ENABLED,
      nodeEnv !== "production",
    ),
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
      nodeEnv !== "production",
    ),
  };
});

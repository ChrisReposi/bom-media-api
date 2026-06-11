import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ApiEnvironmentConfig } from "../config/env.config";
import { PrismaService } from "../database/prisma.service";
import { DomainStatus, WebsiteStatus } from "../generated/prisma/client";
import { normalizeWebsiteDomain } from "../common/utils/domain.util";

type ParsedOrigin = {
  origin: string;
  host: string;
  hostname: string;
  protocol: "http:" | "https:";
};

type CorsDomainCache = {
  expiresAt: number;
  allowedHosts: Set<string>;
};

@Injectable()
export class CorsOriginService {
  private readonly logger = new Logger(CorsOriginService.name);
  private readonly staticOrigins: Set<string>;
  private domainCache: CorsDomainCache | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const apiEnvironment =
      this.configService.getOrThrow<ApiEnvironmentConfig>("api");

    this.staticOrigins = this.buildStaticOrigins(apiEnvironment);
  }

  async isOriginAllowed(origin: string | undefined): Promise<boolean> {
    if (origin === undefined || origin.trim() === "") {
      return true;
    }

    const parsedOrigin = this.parseOrigin(origin);
    if (parsedOrigin === null) {
      return false;
    }

    if (this.staticOrigins.has(parsedOrigin.origin)) {
      return true;
    }

    const apiEnvironment =
      this.configService.getOrThrow<ApiEnvironmentConfig>("api");
    if (!apiEnvironment.corsAllowDbDomains) {
      return false;
    }

    if (!this.isDbOriginProtocolAllowed(parsedOrigin, apiEnvironment)) {
      return false;
    }

    try {
      const allowedHosts = await this.getAllowedDbDomainHosts(apiEnvironment);

      return allowedHosts.has(parsedOrigin.host);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Dynamic CORS DB domain lookup failed; denying DB-backed origin. ${message}`,
      );

      return false;
    }
  }

  clearDomainOriginCache(): void {
    this.domainCache = null;
  }

  private buildStaticOrigins(
    apiEnvironment: ApiEnvironmentConfig,
  ): Set<string> {
    const origins = new Set<string>();

    for (const origin of apiEnvironment.corsAllowedOrigins) {
      const normalizedOrigin = this.normalizeStaticOrigin(origin);

      if (normalizedOrigin !== null) {
        origins.add(normalizedOrigin);
      }
    }

    origins.add(`http://localhost:${apiEnvironment.port}`);
    origins.add(`http://127.0.0.1:${apiEnvironment.port}`);

    if (
      apiEnvironment.host !== "0.0.0.0" &&
      apiEnvironment.host !== "::" &&
      apiEnvironment.host.trim() !== ""
    ) {
      const normalizedHost = apiEnvironment.host.trim().toLowerCase();
      origins.add(`http://${normalizedHost}:${apiEnvironment.port}`);
    }

    return origins;
  }

  private normalizeStaticOrigin(origin: string): string | null {
    return this.parseOrigin(origin)?.origin ?? null;
  }

  private parseOrigin(origin: string): ParsedOrigin | null {
    const trimmedOrigin = origin.trim();

    if (trimmedOrigin === "null") {
      return null;
    }

    try {
      const url = new URL(trimmedOrigin);

      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return null;
      }

      return {
        origin: url.origin,
        host: url.host.toLowerCase(),
        hostname: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
        protocol: url.protocol,
      };
    } catch {
      return null;
    }
  }

  private isDbOriginProtocolAllowed(
    origin: ParsedOrigin,
    apiEnvironment: ApiEnvironmentConfig,
  ): boolean {
    if (this.isLocalhostHostname(origin.hostname)) {
      return apiEnvironment.corsAllowLocalhostDbDomains;
    }

    if (apiEnvironment.isProduction) {
      return origin.protocol === "https:";
    }

    return origin.protocol === "http:" || origin.protocol === "https:";
  }

  private async getAllowedDbDomainHosts(
    apiEnvironment: ApiEnvironmentConfig,
  ): Promise<Set<string>> {
    const now = Date.now();

    if (this.domainCache !== null && this.domainCache.expiresAt > now) {
      return this.domainCache.allowedHosts;
    }

    const domains = await this.prisma.websiteDomain.findMany({
      where: {
        status: DomainStatus.ACTIVE,
        websiteId: { not: null },
        website: {
          is: {
            status: WebsiteStatus.ACTIVE,
          },
        },
      },
      select: {
        domain: true,
      },
    });

    const allowedHosts = new Set<string>();

    for (const item of domains) {
      const normalizedHost = normalizeWebsiteDomain(item.domain);

      if (normalizedHost !== null) {
        allowedHosts.add(normalizedHost);
      }
    }

    this.domainCache = {
      allowedHosts,
      expiresAt: now + apiEnvironment.corsDbOriginCacheTtlMs,
    };

    return allowedHosts;
  }

  private isLocalhostHostname(hostname: string): boolean {
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname.startsWith("127.") ||
      hostname === "0.0.0.0" ||
      hostname === "::1"
    );
  }
}

import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { ApiEnvironmentConfig } from "../config/env.config";
import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";

export interface HealthResponse {
  status: "ok";
  service: "api";
  timestamp: string;
  /**
   * Build/deploy-time release identity. Present only when the operator
   * injected APP_RELEASE_VERSION / APP_BUILD_SHA / APP_BUILD_TIME; never
   * derived from .git at runtime and never required for readiness.
   */
  release?: {
    version?: string;
    commit?: string;
    builtAt?: string;
  };
}

export interface ReadinessResponse extends HealthResponse {
  checks: {
    database: "ok";
    storage: "ok" | "disabled";
  };
}

@Injectable()
export class HealthService {
  private cachedReadiness:
    | { expiresAt: number; response: ReadinessResponse }
    | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  getHealth(): HealthResponse {
    return {
      status: "ok",
      service: "api",
      timestamp: new Date().toISOString(),
      ...this.buildReleaseField(),
    };
  }

  private buildReleaseField(): Pick<HealthResponse, "release"> {
    let release: ApiEnvironmentConfig["release"] | undefined;
    try {
      release =
        this.configService.getOrThrow<ApiEnvironmentConfig>("api").release;
    } catch {
      return {};
    }

    if (!release?.version && !release?.commit && !release?.builtAt) {
      return {};
    }

    return {
      release: {
        ...(release.version ? { version: release.version } : {}),
        ...(release.commit ? { commit: release.commit } : {}),
        ...(release.builtAt ? { builtAt: release.builtAt } : {}),
      },
    };
  }

  async getReadiness(): Promise<ReadinessResponse> {
    const now = Date.now();
    if (
      this.cachedReadiness !== undefined &&
      this.cachedReadiness.expiresAt > now
    ) {
      return this.cachedReadiness.response;
    }

    try {
      await this.prisma.$queryRaw(Prisma.sql`SELECT 1 AS \`ok\``);
      const config = this.configService.getOrThrow<ApiEnvironmentConfig>("api");
      let storage: "ok" | "disabled" = "disabled";
      if (config.localFileStorage.enabled) {
        if (!config.localFileStorage.root) {
          throw new Error("Storage root is unavailable.");
        }
        await access(
          config.localFileStorage.root,
          constants.R_OK | constants.W_OK,
        );
        storage = "ok";
      }

      const response: ReadinessResponse = {
        ...this.getHealth(),
        checks: { database: "ok", storage },
      };
      this.cachedReadiness = { expiresAt: now + 5000, response };
      return response;
    } catch {
      throw new ServiceUnavailableException("Service is not ready.");
    }
  }
}

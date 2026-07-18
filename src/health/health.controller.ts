import { Controller, Get } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { HealthService } from "./health.service";
import type { HealthResponse, ReadinessResponse } from "./health.service";

@ApiTags("health")
@SkipThrottle()
@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOkResponse({
    description: "API process is running.",
    schema: {
      example: {
        status: "ok",
        service: "api",
        timestamp: "2026-05-29T00:00:00.000Z",
        release: {
          version: "2026.07.18",
          commit: "210b9af",
          builtAt: "2026-07-18T00:00:00.000Z",
        },
      },
    },
  })
  getHealth(): HealthResponse {
    return this.healthService.getHealth();
  }

  @Get("ready")
  @ApiOkResponse({ description: "Database and private storage are ready." })
  getReadiness(): Promise<ReadinessResponse> {
    return this.healthService.getReadiness();
  }
}

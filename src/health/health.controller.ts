import { Controller, Get } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { HealthService } from "./health.service";
import type { HealthResponse } from "./health.service";

@ApiTags("health")
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
      },
    },
  })
  getHealth(): HealthResponse {
    return this.healthService.getHealth();
  }
}

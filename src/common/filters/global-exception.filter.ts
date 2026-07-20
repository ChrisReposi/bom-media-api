import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from "@nestjs/common";
import type { Request, Response } from "express";
import {
  isPrismaError,
  readDatabaseStage,
  toSafeDatabaseErrorContext,
} from "../errors/safe-database-error-context.util";
import { safeRequestRoute } from "../http/safe-request-route.util";

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request & { id?: unknown }>();
    const response = context.getResponse<Response>();
    if (response.headersSent) {
      response.end();
      return;
    }

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    if (status >= 500) {
      // One request-correlated failure log. `route` is a safe template (never
      // a raw URL/query string). `stage` is read from a tag the service put on
      // the error, so a single line ties requestId + route + stage + Prisma
      // context together. The util never exposes raw messages, SQL, query
      // args, or secrets; the client response below stays generic.
      const route = safeRequestRoute(request);
      const stage = readDatabaseStage(exception);
      this.logger.error(
        {
          requestId: request.id,
          method: request.method,
          ...(route ? { route } : {}),
          status,
          ...(stage ? { stage } : {}),
          errorName:
            exception instanceof Error ? exception.name : "UnknownError",
          ...(isPrismaError(exception)
            ? { database: toSafeDatabaseErrorContext(exception) }
            : {}),
        },
        "Request failed.",
      );
    }

    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      response.status(status).json({
        statusCode: status,
        message: "Internal server error",
        error: "Internal Server Error",
      });
      return;
    }

    const body =
      exception instanceof HttpException ? exception.getResponse() : null;
    response
      .status(status)
      .json(
        typeof body === "string"
          ? { statusCode: status, message: body, error: exceptionName(status) }
          : body,
      );
  }
}

function exceptionName(status: number): string {
  return HttpStatus[status]?.replace(/_/g, " ") ?? "Error";
}

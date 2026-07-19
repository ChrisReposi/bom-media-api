import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from "@nestjs/common";
import type { Request, Response } from "express";

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
      this.logger.error(
        {
          requestId: request.id,
          method: request.method,
          status,
          errorName:
            exception instanceof Error ? exception.name : "UnknownError",
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

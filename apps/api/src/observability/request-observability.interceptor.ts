import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { catchError, finalize, Observable, throwError } from 'rxjs';
import { RequestMetricsService } from './request-metrics.service';

function normalizedRoute(request: Request): string {
  const route = request.route?.path as string | undefined;
  if (route) return route;
  return request.path
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id')
    .replace(/\/[0-9]+(?=\/|$)/g, '/:id');
}

@Injectable()
export class RequestObservabilityInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RequestObservabilityInterceptor.name);

  constructor(private readonly metrics: RequestMetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const startedAt = process.hrtime.bigint();
    let recorded = false;
    const record = (status: number) => {
      if (recorded) return;
      recorded = true;
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      this.metrics.record(request.method, normalizedRoute(request), status, durationSeconds);
    };

    return next.handle().pipe(
      catchError((error: unknown) => {
        const status = error instanceof HttpException ? error.getStatus() : 500;
        record(status);
        if (status >= 500) {
          this.logger.error(
            JSON.stringify({
              event: 'request_error',
              errorId: randomUUID(),
              method: request.method,
              route: normalizedRoute(request),
              status,
              errorType: error instanceof Error ? error.name : 'UnknownError',
            }),
          );
        }
        return throwError(() => error);
      }),
      finalize(() => record(response.statusCode)),
    );
  }
}

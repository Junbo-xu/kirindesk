import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MetricsController } from './metrics.controller';
import { RequestMetricsService } from './request-metrics.service';
import { RequestObservabilityInterceptor } from './request-observability.interceptor';

@Module({
  controllers: [MetricsController],
  providers: [
    RequestMetricsService,
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestObservabilityInterceptor,
    },
  ],
})
export class ObservabilityModule {}

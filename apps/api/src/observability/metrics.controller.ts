import { Controller, Get, Header } from '@nestjs/common';
import { RequestMetricsService } from './request-metrics.service';

@Controller()
export class MetricsController {
  constructor(private readonly metrics: RequestMetricsService) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  getMetrics(): string {
    return this.metrics.render();
  }
}

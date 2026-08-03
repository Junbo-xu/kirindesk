import { describe, expect, it } from 'vitest';
import { RequestMetricsService } from './request-metrics.service';

describe('RequestMetricsService', () => {
  it('aggregates counts and durations without request identifiers', () => {
    const metrics = new RequestMetricsService();
    metrics.record('GET', '/api/inquiries/:id', 200, 0.01);
    metrics.record('GET', '/api/inquiries/:id', 200, 0.02);
    const output = metrics.render();
    expect(output).toContain(
      'kirindesk_http_requests_total{method="GET",route="/api/inquiries/:id",status="200"} 2',
    );
    expect(output).toContain(
      'kirindesk_http_request_duration_seconds_sum{method="GET",route="/api/inquiries/:id",status="200"} 0.030000',
    );
    expect(output).toContain(
      'kirindesk_http_request_duration_seconds_bucket{method="GET",route="/api/inquiries/:id",status="200",le="0.1"} 2',
    );
  });
});

import { Injectable } from '@nestjs/common';

interface RequestMetric {
  method: string;
  route: string;
  status: number;
  count: number;
  durationSeconds: number;
  buckets: number[];
}

const DURATION_BUCKETS = [0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, Number.POSITIVE_INFINITY];

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

@Injectable()
export class RequestMetricsService {
  private readonly requests = new Map<string, RequestMetric>();

  record(method: string, route: string, status: number, durationSeconds: number): void {
    const key = JSON.stringify([method, route, status]);
    const current = this.requests.get(key) ?? {
      method,
      route,
      status,
      count: 0,
      durationSeconds: 0,
      buckets: DURATION_BUCKETS.map(() => 0),
    };
    current.count += 1;
    current.durationSeconds += durationSeconds;
    DURATION_BUCKETS.forEach((upperBound, index) => {
      if (durationSeconds <= upperBound) current.buckets[index] += 1;
    });
    this.requests.set(key, current);
  }

  render(): string {
    const lines = [
      '# HELP kirindesk_http_requests_total Completed HTTP requests.',
      '# TYPE kirindesk_http_requests_total counter',
    ];
    const metrics = [...this.requests.values()].sort((left, right) =>
      `${left.method}:${left.route}:${left.status}`.localeCompare(
        `${right.method}:${right.route}:${right.status}`,
      ),
    );
    for (const metric of metrics) {
      const labels = `method="${escapeLabel(metric.method)}",route="${escapeLabel(metric.route)}",status="${metric.status}"`;
      lines.push(`kirindesk_http_requests_total{${labels}} ${metric.count}`);
    }
    lines.push(
      '# HELP kirindesk_http_request_duration_seconds HTTP request duration histogram.',
      '# TYPE kirindesk_http_request_duration_seconds histogram',
    );
    for (const metric of metrics) {
      DURATION_BUCKETS.forEach((upperBound, index) => {
        const labels = `method="${escapeLabel(metric.method)}",route="${escapeLabel(metric.route)}",status="${metric.status}",le="${upperBound === Number.POSITIVE_INFINITY ? '+Inf' : upperBound}"`;
        lines.push(
          `kirindesk_http_request_duration_seconds_bucket{${labels}} ${metric.buckets[index]}`,
        );
      });
    }
    for (const metric of metrics) {
      const labels = `method="${escapeLabel(metric.method)}",route="${escapeLabel(metric.route)}",status="${metric.status}"`;
      lines.push(
        `kirindesk_http_request_duration_seconds_sum{${labels}} ${metric.durationSeconds.toFixed(6)}`,
      );
    }
    for (const metric of metrics) {
      const labels = `method="${escapeLabel(metric.method)}",route="${escapeLabel(metric.route)}",status="${metric.status}"`;
      lines.push(`kirindesk_http_request_duration_seconds_count{${labels}} ${metric.count}`);
    }
    lines.push('');
    return lines.join('\n');
  }
}

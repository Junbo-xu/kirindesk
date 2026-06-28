import { Controller, Get, Inject, HttpException, HttpStatus } from '@nestjs/common';
import type { Pool } from 'pg';
import { APP_POOL } from '../database/database.module';

/**
 * Health endpoints for container orchestration / reverse-proxy probes
 * (Phase 3A, private deployment).
 *
 * No auth guard and NO tenant business data by design — these are infra probes.
 * Responses are intentionally minimal: a status string only, never a connection
 * string, version fingerprint, or tenant data (plan §4.1 R4).
 *
 *  - GET /healthz  liveness: the process is up and serving. Never touches the DB.
 *  - GET /readyz   readiness: a single read-only `SELECT 1` confirms the app DB
 *                  pool is reachable. Returns 503 when the DB is unavailable so a
 *                  probe can pull the instance out of rotation.
 *
 * The legacy GET /health (liveness, no DB) is kept for backward compatibility.
 */
@Controller()
export class HealthController {
  constructor(@Inject(APP_POOL) private readonly pool: Pool) {}

  @Get('health')
  getHealth() {
    return { status: 'ok', service: 'kirindesk-api' };
  }

  @Get('healthz')
  getHealthz() {
    return { status: 'ok' };
  }

  @Get('readyz')
  async getReadyz() {
    try {
      await this.pool.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      // Do not leak the underlying error detail (could contain the conn string).
      throw new HttpException({ status: 'fail' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }
}

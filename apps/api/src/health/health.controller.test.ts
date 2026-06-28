import { describe, expect, it } from 'vitest';
import { HttpException } from '@nestjs/common';
import type { Pool } from 'pg';
import { HealthController } from './health.controller';

function makeController(query: () => Promise<unknown>): HealthController {
  return new HealthController({ query } as unknown as Pool);
}

describe('HealthController', () => {
  it('healthz returns ok without touching the DB', () => {
    let called = false;
    const c = makeController(async () => {
      called = true;
      return {};
    });
    expect(c.getHealthz()).toEqual({ status: 'ok' });
    expect(called).toBe(false);
  });

  it('readyz returns ok when SELECT 1 succeeds', async () => {
    const c = makeController(async () => ({ rows: [{ '?column?': 1 }] }));
    await expect(c.getReadyz()).resolves.toEqual({ status: 'ok' });
  });

  it('readyz throws 503 when the DB query fails', async () => {
    const c = makeController(async () => {
      throw new Error('connection refused to postgres://user:pass@host');
    });
    await expect(c.getReadyz()).rejects.toBeInstanceOf(HttpException);
    try {
      await c.getReadyz();
    } catch (e) {
      const ex = e as HttpException;
      expect(ex.getStatus()).toBe(503);
      // Must not leak the underlying error detail (could contain a conn string).
      expect(ex.getResponse()).toEqual({ status: 'fail' });
    }
  });
});

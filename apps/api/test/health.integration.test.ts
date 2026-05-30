import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { APP_POOL } from '../src/database/database.module';

describe('GET /health (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    // init() wires the app and its in-memory HTTP server without listening on
    // a real TCP port, so no port (e.g. 3001) is occupied during tests.
    await app.init();
  });

  afterAll(async () => {
    // Explicitly close the app, then end the APP_POOL so Vitest does not hang
    // on an open connection (DatabaseModule has no destroy hook in C1).
    if (app) {
      const pool = app.get<Pool>(APP_POOL);
      await app.close();
      await pool.end();
    }
  });

  it('returns 200 with ok status', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('kirindesk-api');
  });
});

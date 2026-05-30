import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '..', '..', '..', '.env') });

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { APP_POOL } from './database/database.module';
import { assertNonSuperuserRole } from './database/role-self-check';
import type { Pool } from 'pg';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const pool = app.get<Pool>(APP_POOL);
  await assertNonSuperuserRole(pool);

  const port = process.env.API_PORT || 3001;
  await app.listen(port);
}
bootstrap();

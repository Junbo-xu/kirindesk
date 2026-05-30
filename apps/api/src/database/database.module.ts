import { Module, Global } from '@nestjs/common';
import pg from 'pg';

const { Pool } = pg;

export const APP_POOL = 'APP_POOL';

@Global()
@Module({
  providers: [
    {
      provide: APP_POOL,
      useFactory: () => {
        const connectionString = process.env.APP_DATABASE_URL;
        if (!connectionString) {
          throw new Error('APP_DATABASE_URL is not set');
        }
        return new Pool({ connectionString });
      },
    },
  ],
  exports: [APP_POOL],
})
export class DatabaseModule {}

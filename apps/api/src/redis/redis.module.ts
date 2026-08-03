import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';
import { RateLimitService } from './rate-limit.service';

export { REDIS_CLIENT } from './redis.constants';

@Injectable()
class RedisLifecycle implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis | null) {}

  onModuleDestroy(): void {
    this.client?.disconnect(false);
  }
}

/**
 * Phase 2B: shared Redis client (@Global). Used so far only for signup IP rate
 * limiting. Connection is OPTIONAL: when REDIS_URL is unset the provider is
 * null and consumers degrade gracefully (rate limiting fails open). lazyConnect
 * + a bounded retry strategy keep a missing/slow Redis from blocking startup or
 * crashing the process on transient errors.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (): Redis | null => {
        const url = process.env.REDIS_URL;
        if (!url) return null;
        const client = new Redis(url, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          // Cap reconnection backoff; never throw out of the constructor.
          retryStrategy: (times) => Math.min(times * 200, 2000),
        });
        // Swallow connection errors here so an unreachable Redis only disables
        // rate limiting (fail-open in RateLimitService) instead of crashing.
        client.on('error', () => {});
        client.connect().catch(() => {});
        return client;
      },
    },
    RateLimitService,
    RedisLifecycle,
  ],
  exports: [REDIS_CLIENT, RateLimitService],
})
export class RedisModule {}

// Phase 2B: injection token for the shared Redis client. Kept in its own file
// so providers (RateLimitService) can import it without a circular dependency
// on redis.module.ts (which imports those providers).
export const REDIS_CLIENT = 'REDIS_CLIENT';

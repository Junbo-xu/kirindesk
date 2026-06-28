/**
 * Startup environment validation (Phase 3A, private deployment).
 *
 * Aggregates the required-env check so a misconfigured deployment fails fast at
 * boot with a single message listing EVERY missing variable, instead of dying on
 * the first `requireEnv` deep inside module construction. This is operability,
 * not a new security control — the individual `requireEnv` calls (JWT secrets,
 * storage) remain the authoritative guards.
 */

/** Env vars without which the API cannot serve correctly in any environment. */
export const REQUIRED_ENV = [
  'APP_DATABASE_URL', // runtime DB role (non-superuser; RLS-enforced)
  'TENANT_JWT_SECRET',
  'PLATFORM_JWT_SECRET',
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
] as const;

/**
 * Throws a single aggregated error if any required env var is missing or empty.
 * Reads from the provided env map (defaults to process.env) so it is unit-testable.
 */
export function assertRequiredEnv(
  required: readonly string[] = REQUIRED_ENV,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const missing = required.filter((name) => {
    const v = env[name];
    return v === undefined || v === '';
  });
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        `Set them in the container environment (see .env.production.example).`,
    );
  }
}

import { describe, expect, it } from 'vitest';
import { assertRequiredEnv, REQUIRED_ENV } from './startup-env';

describe('assertRequiredEnv', () => {
  const full: NodeJS.ProcessEnv = Object.fromEntries(
    REQUIRED_ENV.map((k) => [k, 'set']),
  ) as NodeJS.ProcessEnv;

  it('passes when all required vars are present', () => {
    expect(() => assertRequiredEnv(REQUIRED_ENV, full)).not.toThrow();
  });

  it('throws listing every missing var', () => {
    const env = { ...full };
    delete env['APP_DATABASE_URL'];
    delete env['S3_BUCKET'];
    expect(() => assertRequiredEnv(REQUIRED_ENV, env)).toThrow(/APP_DATABASE_URL/);
    expect(() => assertRequiredEnv(REQUIRED_ENV, env)).toThrow(/S3_BUCKET/);
  });

  it('treats an empty string as missing', () => {
    const env = { ...full, TENANT_JWT_SECRET: '' };
    expect(() => assertRequiredEnv(REQUIRED_ENV, env)).toThrow(/TENANT_JWT_SECRET/);
  });

  it('does not throw for vars outside the required list', () => {
    const env = { ...full, SOME_OPTIONAL: undefined as unknown as string };
    expect(() => assertRequiredEnv(REQUIRED_ENV, env)).not.toThrow();
  });
});

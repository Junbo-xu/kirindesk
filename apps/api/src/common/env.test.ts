import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireEnv } from './env';

describe('requireEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the value when the variable is set', () => {
    vi.stubEnv('TEST_ONLY_VAR', 'hello');
    expect(requireEnv('TEST_ONLY_VAR')).toBe('hello');
  });

  it('throws when the variable is missing', () => {
    vi.stubEnv('TEST_ONLY_VAR', undefined as unknown as string);
    expect(() => requireEnv('TEST_ONLY_VAR')).toThrow(
      'Missing required environment variable: TEST_ONLY_VAR',
    );
  });

  it('throws when the variable is an empty string', () => {
    vi.stubEnv('TEST_ONLY_VAR', '');
    expect(() => requireEnv('TEST_ONLY_VAR')).toThrow(
      'Missing required environment variable: TEST_ONLY_VAR',
    );
  });
});

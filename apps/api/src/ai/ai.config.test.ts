import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_OCR_PROVIDER_ENV, resolveAiOcrProviderName } from './ai.config';

describe('resolveAiOcrProviderName', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to mock when the env var is unset', () => {
    vi.stubEnv(AI_OCR_PROVIDER_ENV, undefined as unknown as string);
    expect(resolveAiOcrProviderName()).toBe('mock');
  });

  it('defaults to mock when the env var is empty/whitespace', () => {
    vi.stubEnv(AI_OCR_PROVIDER_ENV, '   ');
    expect(resolveAiOcrProviderName()).toBe('mock');
  });

  it('accepts the supported mock value', () => {
    vi.stubEnv(AI_OCR_PROVIDER_ENV, 'mock');
    expect(resolveAiOcrProviderName()).toBe('mock');
  });

  it('fails fast on an unknown / unapproved provider name', () => {
    vi.stubEnv(AI_OCR_PROVIDER_ENV, 'deepseek');
    expect(() => resolveAiOcrProviderName()).toThrow(/Unsupported AI_OCR_PROVIDER=deepseek/);
  });
});

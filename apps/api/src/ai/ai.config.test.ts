import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_API_KEY_ENV,
  DEEPSEEK_API_URL_ENV,
  DEEPSEEK_MODEL_ENV,
  DEEPSEEK_TEST_BUDGET_CNY_ENV,
  DEEPSEEK_TEST_MAX_CALLS_ENV,
  resolveAiOcrProviderName,
  resolveAiTextProviderName,
  resolveDeepSeekConfig,
} from './ai.config';

function deepSeekEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    [DEEPSEEK_API_URL_ENV]: 'https://api.deepseek.com/chat/completions',
    [DEEPSEEK_MODEL_ENV]: 'deepseek-chat',
    [DEEPSEEK_API_KEY_ENV]: 'unit-test-placeholder-not-a-key',
    [DEEPSEEK_TEST_BUDGET_CNY_ENV]: '1',
    [DEEPSEEK_TEST_MAX_CALLS_ENV]: '5',
    ...overrides,
  };
}

describe('AI provider configuration', () => {
  it('keeps OCR and text AI on mock by default', () => {
    expect(resolveAiOcrProviderName({})).toBe('mock');
    expect(resolveAiTextProviderName({})).toBe('mock');
  });

  it('allows DeepSeek only as the text provider', () => {
    expect(resolveAiTextProviderName({ AI_TEXT_PROVIDER: 'deepseek' })).toBe('deepseek');
    expect(() => resolveAiOcrProviderName({ AI_OCR_PROVIDER: 'deepseek' })).toThrow(
      /Unsupported AI_OCR_PROVIDER=deepseek/,
    );
  });

  it('accepts the approved official endpoint, model, CNY 1 cap and five-call cap', () => {
    expect(resolveDeepSeekConfig(deepSeekEnv())).toMatchObject({
      apiUrl: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-chat',
      budgetCny: 1,
      maxCalls: 5,
    });
  });

  it.each([
    [{ [DEEPSEEK_API_KEY_ENV]: '' }, /Missing required DEEPSEEK_API_KEY/],
    [{ [DEEPSEEK_API_URL_ENV]: 'http://api.deepseek.com/chat/completions' }, /official HTTPS/],
    [{ [DEEPSEEK_API_URL_ENV]: 'https://gateway.example.test/chat/completions' }, /official HTTPS/],
    [{ [DEEPSEEK_MODEL_ENV]: 'deepseek-reasoner' }, /must be deepseek-chat/],
    [{ [DEEPSEEK_TEST_BUDGET_CNY_ENV]: '1.01' }, /exceeds approved CNY 1 cap/],
    [{ [DEEPSEEK_TEST_MAX_CALLS_ENV]: '6' }, /integer from 1 to 5/],
  ])('fails closed for invalid DeepSeek configuration %#', (overrides, expected) => {
    expect(() => resolveDeepSeekConfig(deepSeekEnv(overrides))).toThrow(expected);
  });
});

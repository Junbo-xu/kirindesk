import { describe, expect, it } from 'vitest';
import { MockAiProvider, MOCK_AI_MAX_TIMEOUT_MS } from './mock-ai-provider';
import { AiProviderException, AiTimeoutException } from './ai.errors';

describe('MockAiProvider', () => {
  describe('deterministic output', () => {
    it('reports its provider name, null token usage, and a fixed duration', async () => {
      const provider = new MockAiProvider();
      const result = await provider.complete({ task: 'summarize', input: 'x' });

      expect(provider.name).toBe('mock');
      expect(result.provider).toBe('mock');
      expect(result.tokensUsed).toBeNull();
      expect(result.durationMs).toBe(5);
    });

    it('returns identical output for identical input', async () => {
      const provider = new MockAiProvider();
      const a = await provider.complete({ task: 'summarize', input: 'x' });
      const b = await provider.complete({ task: 'summarize', input: 'x' });
      expect(a).toEqual(b);
    });

    it('returns a fixed JSON string for task=extract-order-fields', async () => {
      const provider = new MockAiProvider();
      const result = await provider.complete({
        task: 'extract-order-fields',
        input: 'x',
      });
      expect(JSON.parse(result.output)).toEqual({
        order_no: 'MOCK-ORD-0001',
        amount: '2000.00',
        customer: 'MOCK CUSTOMER',
      });
    });

    it('marks output as mock for an unknown task', async () => {
      const provider = new MockAiProvider();
      const result = await provider.complete({ task: 'whatever', input: 'x' });
      expect(result.output).toContain('[[MOCK AI]]');
      expect(result.output).toContain('task=whatever');
    });
  });

  describe('timeout path', () => {
    it('throws AiTimeoutException when injected delay exceeds the deadline', async () => {
      const provider = new MockAiProvider({ artificialDelayMs: 500 });
      await expect(
        provider.complete({ task: 'summarize', input: 'x', options: { timeoutMs: 100 } }),
      ).rejects.toBeInstanceOf(AiTimeoutException);
    });

    it('succeeds when the injected delay is within the deadline', async () => {
      const provider = new MockAiProvider({ artificialDelayMs: 50 });
      const result = await provider.complete({
        task: 'summarize',
        input: 'x',
        options: { timeoutMs: 100 },
      });
      expect(result.provider).toBe('mock');
    });

    it('clamps a caller deadline above the provider ceiling', async () => {
      const provider = new MockAiProvider({
        artificialDelayMs: MOCK_AI_MAX_TIMEOUT_MS + 1,
      });
      await expect(
        provider.complete({
          task: 'summarize',
          input: 'x',
          options: { timeoutMs: MOCK_AI_MAX_TIMEOUT_MS * 10 },
        }),
      ).rejects.toBeInstanceOf(AiTimeoutException);
    });
  });

  describe('error path', () => {
    it('throws a vendor-neutral AiProviderException on the force-error sentinel', async () => {
      const provider = new MockAiProvider();
      await expect(
        provider.complete({ task: '__force_error__', input: 'x' }),
      ).rejects.toBeInstanceOf(AiProviderException);
    });

    it('does not leak vendor detail in the error message', async () => {
      const provider = new MockAiProvider();
      await expect(provider.complete({ task: '__force_error__', input: 'x' })).rejects.toThrow(
        'AI operation failed: complete',
      );
    });
  });
});

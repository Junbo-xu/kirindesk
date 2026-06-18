import { describe, expect, it } from 'vitest';
import { MockOcrProvider, MOCK_OCR_MAX_TIMEOUT_MS } from './mock-ocr-provider';
import { OcrProviderException, OcrTimeoutException } from './ai.errors';

describe('MockOcrProvider', () => {
  describe('deterministic output', () => {
    it('reports its provider name and a fixed confidence/duration', async () => {
      const provider = new MockOcrProvider();
      const result = await provider.extract({ fileId: 'f1', docType: 'invoice' });

      expect(provider.name).toBe('mock');
      expect(result.provider).toBe('mock');
      expect(result.confidence).toBe(0.95);
      expect(result.durationMs).toBe(5);
    });

    it('returns identical output for identical input', async () => {
      const provider = new MockOcrProvider();
      const a = await provider.extract({ fileId: 'f1', docType: 'invoice' });
      const b = await provider.extract({ fileId: 'f1', docType: 'invoice' });
      expect(a).toEqual(b);
    });

    it('returns fixed invoice fields for docType=invoice', async () => {
      const provider = new MockOcrProvider();
      const result = await provider.extract({ fileId: 'f1', docType: 'invoice' });
      expect(result.fields).toEqual([
        { key: 'invoice_no', value: 'MOCK-INV-0001', confidence: 0.99 },
        { key: 'amount', value: '1000.00', confidence: 0.97 },
      ]);
    });

    it('returns fixed order fields for docType=order', async () => {
      const provider = new MockOcrProvider();
      const result = await provider.extract({ fileId: 'f1', docType: 'order' });
      expect(result.fields.map((f) => f.key)).toEqual(['order_no', 'amount', 'customer']);
    });

    it('returns empty fields for an unknown / missing docType', async () => {
      const provider = new MockOcrProvider();
      const generic = await provider.extract({ fileId: 'f1' });
      const other = await provider.extract({ fileId: 'f1', docType: 'whatever' });
      expect(generic.fields).toEqual([]);
      expect(other.fields).toEqual([]);
    });

    it('marks text as mock and never echoes raw file content', async () => {
      const provider = new MockOcrProvider();
      const result = await provider.extract({ fileId: 'f1', docType: 'generic' });
      expect(result.text).toContain('[[MOCK OCR]]');
      expect(result.text).toContain('docType=generic');
    });
  });

  describe('timeout path', () => {
    it('throws OcrTimeoutException when injected delay exceeds the deadline', async () => {
      const provider = new MockOcrProvider({ artificialDelayMs: 500 });
      await expect(
        provider.extract({ fileId: 'f1', options: { timeoutMs: 100 } }),
      ).rejects.toBeInstanceOf(OcrTimeoutException);
    });

    it('succeeds when the injected delay is within the deadline', async () => {
      const provider = new MockOcrProvider({ artificialDelayMs: 50 });
      const result = await provider.extract({
        fileId: 'f1',
        options: { timeoutMs: 100 },
      });
      expect(result.provider).toBe('mock');
    });

    it('clamps a caller deadline above the provider ceiling', async () => {
      // delay just over the ceiling must time out even though the caller asked
      // for more, because the deadline is clamped down to the ceiling.
      const provider = new MockOcrProvider({
        artificialDelayMs: MOCK_OCR_MAX_TIMEOUT_MS + 1,
      });
      await expect(
        provider.extract({
          fileId: 'f1',
          options: { timeoutMs: MOCK_OCR_MAX_TIMEOUT_MS * 10 },
        }),
      ).rejects.toBeInstanceOf(OcrTimeoutException);
    });
  });

  describe('error path', () => {
    it('throws a vendor-neutral OcrProviderException on the force-error sentinel', async () => {
      const provider = new MockOcrProvider();
      await expect(
        provider.extract({ fileId: 'f1', docType: '__force_error__' }),
      ).rejects.toBeInstanceOf(OcrProviderException);
    });

    it('does not leak vendor detail in the error message', async () => {
      const provider = new MockOcrProvider();
      await expect(provider.extract({ fileId: 'f1', docType: '__force_error__' })).rejects.toThrow(
        'OCR operation failed: extract',
      );
    });
  });
});

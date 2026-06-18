import { Injectable, Logger } from '@nestjs/common';
import { OcrExtractInput, OcrExtractResult, OcrField, OcrProvider } from './ocr-provider.interface';
import { OcrProviderException, OcrTimeoutException } from './ai.errors';

/** Provider-side hard ceiling on a single call (plan §3.5). */
export const MOCK_OCR_MAX_TIMEOUT_MS = 30_000;
/** Default deadline when the caller does not pass one. */
export const MOCK_OCR_DEFAULT_TIMEOUT_MS = 30_000;
/** Fixed reported processing time — deterministic, no wall-clock (plan §4.1, §4.4). */
const MOCK_OCR_DURATION_MS = 5;
/** Fixed aggregate confidence the mock reports. */
const MOCK_OCR_CONFIDENCE = 0.95;
/** docType sentinel that forces the error path, for tests only (plan §4.4). */
const FORCE_ERROR_DOCTYPE = '__force_error__';

export interface MockOcrConfig {
  /**
   * Simulated provider work time in ms. When it exceeds the (clamped) call
   * deadline, extract throws OcrTimeoutException — this is how the timeout path
   * is exercised deterministically (plan §4.4). Defaults to 0 (always fast).
   */
  artificialDelayMs?: number;
}

/**
 * Deterministic, fully local OCR stand-in: no network, no SDK, no API key
 * (CLAUDE.md §7/§8, plan §4). It does not read file bytes — fileId is only
 * echoed / used to shape deterministic output — so it stays decoupled from
 * object storage in this phase. Drives all three contract exits
 * (success / timeout / error) for upper-layer and audit tests.
 */
@Injectable()
export class MockOcrProvider implements OcrProvider {
  readonly name = 'mock';
  private readonly logger = new Logger(MockOcrProvider.name);
  private readonly artificialDelayMs: number;

  constructor(config: MockOcrConfig = {}) {
    this.artificialDelayMs = Math.max(0, config.artificialDelayMs ?? 0);
  }

  async extract(input: OcrExtractInput): Promise<OcrExtractResult> {
    const docType = input.docType ?? 'generic';

    // Deadline: caller value clamped to the provider ceiling (plan §3.5).
    const requested = input.options?.timeoutMs ?? MOCK_OCR_DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.min(Math.max(1, requested), MOCK_OCR_MAX_TIMEOUT_MS);

    // Timeout path: simulated work outruns the deadline.
    if (this.artificialDelayMs > timeoutMs) {
      throw new OcrTimeoutException(timeoutMs);
    }

    // Error path (tests only): explicit force-error sentinel.
    if (docType === FORCE_ERROR_DOCTYPE) {
      // A real provider would log the scrubbed vendor error here; the thrown
      // exception stays vendor-neutral (plan §3.4).
      this.logger.warn('MockOcrProvider forced error path invoked');
      throw new OcrProviderException('extract');
    }

    return {
      provider: this.name,
      text: this.mockText(docType),
      fields: this.mockFields(docType),
      confidence: MOCK_OCR_CONFIDENCE,
      durationMs: MOCK_OCR_DURATION_MS,
    };
  }

  private mockText(docType: string): string {
    return `[[MOCK OCR]] deterministic placeholder text for docType=${docType}`;
  }

  private mockFields(docType: string): OcrField[] {
    switch (docType) {
      case 'invoice':
        return [
          { key: 'invoice_no', value: 'MOCK-INV-0001', confidence: 0.99 },
          { key: 'amount', value: '1000.00', confidence: 0.97 },
        ];
      case 'order':
        return [
          { key: 'order_no', value: 'MOCK-ORD-0001', confidence: 0.99 },
          { key: 'amount', value: '2000.00', confidence: 0.97 },
          { key: 'customer', value: 'MOCK CUSTOMER', confidence: 0.95 },
        ];
      default:
        return [];
    }
  }
}

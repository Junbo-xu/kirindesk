import { Injectable, Logger } from '@nestjs/common';
import { AiCompleteInput, AiCompleteResult, AiProvider } from './ai-provider.interface';
import { AiProviderException, AiTimeoutException } from './ai.errors';

/** Provider-side hard ceiling on a single call (plan §3.5). */
export const MOCK_AI_MAX_TIMEOUT_MS = 30_000;
/** Default deadline when the caller does not pass one. */
export const MOCK_AI_DEFAULT_TIMEOUT_MS = 30_000;
/** Fixed reported processing time — deterministic, no wall-clock (plan §4.1, §4.4). */
const MOCK_AI_DURATION_MS = 5;
/** task sentinel that forces the error path, for tests only (plan §4.4). */
const FORCE_ERROR_TASK = '__force_error__';

export interface MockAiConfig {
  /**
   * Simulated provider work time in ms. When it exceeds the (clamped) call
   * deadline, complete throws AiTimeoutException — this is how the timeout path
   * is exercised deterministically (plan §4.4). Defaults to 0 (always fast).
   */
  artificialDelayMs?: number;
}

/**
 * Deterministic, fully local AI stand-in: no network, no SDK, no API key
 * (CLAUDE.md §7/§8, plan §4). Returns fixed output shaped by `task`, never
 * bills (tokensUsed is always null), and drives all three contract exits
 * (success / timeout / error) for upper-layer and audit tests.
 */
@Injectable()
export class MockAiProvider implements AiProvider {
  readonly name = 'mock';
  private readonly logger = new Logger(MockAiProvider.name);
  private readonly artificialDelayMs: number;

  constructor(config: MockAiConfig = {}) {
    this.artificialDelayMs = Math.max(0, config.artificialDelayMs ?? 0);
  }

  async complete(input: AiCompleteInput): Promise<AiCompleteResult> {
    // Deadline: caller value clamped to the provider ceiling (plan §3.5).
    const requested = input.options?.timeoutMs ?? MOCK_AI_DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.min(Math.max(1, requested), MOCK_AI_MAX_TIMEOUT_MS);

    // Timeout path: simulated work outruns the deadline.
    if (this.artificialDelayMs > timeoutMs) {
      throw new AiTimeoutException(timeoutMs);
    }

    // Error path (tests only): explicit force-error sentinel.
    if (input.task === FORCE_ERROR_TASK) {
      // A real provider would log the scrubbed vendor error here; the thrown
      // exception stays vendor-neutral (plan §3.4).
      this.logger.warn('MockAiProvider forced error path invoked');
      throw new AiProviderException('complete');
    }

    return {
      provider: this.name,
      output: this.mockOutput(input.task),
      tokensUsed: null,
      durationMs: MOCK_AI_DURATION_MS,
    };
  }

  private mockOutput(task: string): string {
    if (task === 'extract-order-fields') {
      // Deterministic JSON string; a real provider would return model output.
      return JSON.stringify({
        order_no: 'MOCK-ORD-0001',
        amount: '2000.00',
        customer: 'MOCK CUSTOMER',
      });
    }
    return `[[MOCK AI]] deterministic placeholder output for task=${task}`;
  }
}

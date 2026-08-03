import { Injectable } from '@nestjs/common';
import { AiCompleteInput, AiCompleteResult, AiProvider } from './ai-provider.interface';
import type { DeepSeekConfig } from './ai.config';
import {
  AiBudgetExceededException,
  AiProviderException,
  AiRateLimitException,
  AiResponseParseException,
  AiTimeoutException,
} from './ai.errors';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1_000;
const MAX_OUTPUT_TOKENS = 4_000;
const MAX_INPUT_BYTES = 20_000;

// Deliberately far above current public pricing. Reservations use this ceiling
// so the approved test run stops before its CNY cap even if prices move.
const BUDGET_CNY_PER_MILLION_TOKENS = 50;

interface DeepSeekResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

type FetchLike = typeof fetch;

@Injectable()
export class DeepSeekAiProvider implements AiProvider {
  readonly name = 'deepseek';
  private callsReserved = 0;
  private budgetReservedCny = 0;

  constructor(
    private readonly config: DeepSeekConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  budgetSnapshot(): { callsReserved: number; reservedCny: number; capCny: number } {
    return {
      callsReserved: this.callsReserved,
      reservedCny: Number(this.budgetReservedCny.toFixed(6)),
      capCny: this.config.budgetCny,
    };
  }

  async complete(input: AiCompleteInput): Promise<AiCompleteResult> {
    // The current owner approval permits synthetic data only. Business workflow
    // calls default to `business` and fail before any network request.
    if (input.dataClassification !== 'synthetic_test') {
      throw new AiProviderException('data_boundary');
    }

    const inputBytes = Buffer.byteLength(input.input, 'utf8');
    if (inputBytes === 0 || inputBytes > MAX_INPUT_BYTES) {
      throw new AiProviderException('input_boundary');
    }

    const timeoutMs = Math.min(
      Math.max(1, input.options?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      MAX_TIMEOUT_MS,
    );
    const maxOutputTokens = Math.min(
      Math.max(1, input.options?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS),
      MAX_OUTPUT_TOKENS,
    );
    this.reserveBudget(inputBytes, maxOutputTokens);

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.config.apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            {
              role: 'system',
              content:
                'Process only the supplied synthetic test fixture. Return one JSON object only.',
            },
            { role: 'user', content: input.input },
          ],
          max_tokens: maxOutputTokens,
          temperature: 0,
          response_format: { type: 'json_object' },
          stream: false,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted || (error as { name?: string })?.name === 'AbortError') {
        throw new AiTimeoutException(timeoutMs);
      }
      throw new AiProviderException('complete');
    }

    try {
      if (response.status === 429) throw new AiRateLimitException();
      if (!response.ok) throw new AiProviderException('complete');

      let responseText: string;
      try {
        responseText = await response.text();
      } catch (error) {
        if (controller.signal.aborted || (error as { name?: string })?.name === 'AbortError') {
          throw new AiTimeoutException(timeoutMs);
        }
        throw new AiProviderException('complete');
      }

      let payload: unknown;
      try {
        payload = JSON.parse(responseText);
      } catch {
        throw new AiResponseParseException();
      }
      if (!this.isDeepSeekResponse(payload)) throw new AiResponseParseException();

      const usage = payload.usage;
      const tokensUsed = this.nonNegativeInteger(usage?.total_tokens)
        ? usage.total_tokens
        : this.addKnownTokens(usage?.prompt_tokens, usage?.completion_tokens);
      const costEstimateCny =
        tokensUsed === null
          ? null
          : Number(((tokensUsed * BUDGET_CNY_PER_MILLION_TOKENS) / 1_000_000).toFixed(6));

      return {
        provider: this.name,
        output: payload.choices[0].message.content,
        tokensUsed,
        costEstimateCny,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private reserveBudget(inputBytes: number, maxOutputTokens: number): void {
    const reservation =
      ((inputBytes + maxOutputTokens) * BUDGET_CNY_PER_MILLION_TOKENS) / 1_000_000;
    if (
      this.callsReserved >= this.config.maxCalls ||
      this.budgetReservedCny + reservation > this.config.budgetCny
    ) {
      throw new AiBudgetExceededException();
    }
    this.callsReserved += 1;
    this.budgetReservedCny += reservation;
  }

  private isDeepSeekResponse(value: unknown): value is DeepSeekResponse {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const choices = (value as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) return false;
    const first = choices[0] as { message?: { content?: unknown } } | undefined;
    return typeof first?.message?.content === 'string' && first.message.content.trim().length > 0;
  }

  private nonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
  }

  private addKnownTokens(prompt: unknown, completion: unknown): number | null {
    if (!this.nonNegativeInteger(prompt) || !this.nonNegativeInteger(completion)) return null;
    return prompt + completion;
  }
}

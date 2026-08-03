/**
 * Abstraction over AI/text providers (mock now; real DeepSeek/OpenAI/etc. only
 * after explicit approval — CLAUDE.md §7). Business code depends only on this
 * interface and the AI_PROVIDER DI token, never on a concrete vendor.
 *
 * Callers must pass already-extracted, minimized text — never raw customer
 * files — so sensitive content does not flow through this boundary or into
 * logs/audit (plan §3.3, §5.6).
 */

/** DI token for the active AiProvider implementation. */
export const AI_PROVIDER = 'AI_PROVIDER';

export interface AiOptions {
  /** Hard cap in ms for the whole provider call. Provider clamps to its own
   *  maximum; callers cannot exceed it. */
  timeoutMs?: number;
  /** Upper bound on generated tokens; provider clamps. */
  maxOutputTokens?: number;
}

export interface AiCompleteInput {
  /** Task discriminator, e.g. 'extract-order-fields' | 'summarize'. */
  task: string;
  /** Prompt / instruction text. Callers must not place raw customer files
   *  here; pass already-extracted, minimized text. */
  input: string;
  /** DeepSeek is currently approved only for explicitly synthetic test data. */
  dataClassification?: 'business' | 'synthetic_test';
  options?: AiOptions;
}

export interface AiCompleteResult {
  /** Echoes the resolved provider name, e.g. 'mock'. */
  provider: string;
  /** Generated output text. */
  output: string;
  /** Optional usage for audit (tokens_used / cost_estimate); null in mock. */
  tokensUsed: number | null;
  /** Conservative CNY estimate persisted with the invocation, never billed here. */
  costEstimateCny?: number | null;
  /** Provider-side processing time in ms (for audit duration_ms). */
  durationMs: number;
}

export interface AiProvider {
  /** Name of this implementation, e.g. 'mock'. Recorded as provider_name. */
  readonly name: string;
  /** Runs the task. Rejects with AiProviderException on failure and
   *  AiTimeoutException on deadline breach. */
  complete(input: AiCompleteInput): Promise<AiCompleteResult>;
}

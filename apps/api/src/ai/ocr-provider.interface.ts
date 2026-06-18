/**
 * Abstraction over OCR providers (mock now; real DeepSeek/OpenAI/OCR vendors
 * only after explicit approval — CLAUDE.md §7). Business code depends only on
 * this interface and the OCR_PROVIDER DI token, never on a concrete vendor.
 *
 * The interface deliberately takes a tenant-scoped file id, not raw bytes: a
 * real provider resolves the object via StorageProvider on its own side, so
 * customer file content never crosses this boundary or lands in logs/audit
 * (plan §3.1, §5.6).
 */

/** DI token for the active OcrProvider implementation. */
export const OCR_PROVIDER = 'OCR_PROVIDER';

export interface OcrOptions {
  /** Hard cap in ms for the whole provider call. Provider clamps to its own
   *  maximum; callers cannot exceed it. */
  timeoutMs?: number;
  /** Preferred result language(s), BCP-47; advisory only. */
  languages?: string[];
}

export interface OcrExtractInput {
  /** Tenant-scoped id of an already-stored file (Phase 1E). The provider
   *  resolves bytes via StorageProvider; raw file content never crosses this
   *  interface. */
  fileId: string;
  /** Optional hint for downstream parsing, e.g. 'invoice' | 'order' | 'generic'. */
  docType?: string;
  /** Per-call overrides; provider clamps to its own maximum. */
  options?: OcrOptions;
}

export interface OcrField {
  key: string;
  value: string;
  /** 0..1 model confidence; mock returns a fixed value. */
  confidence: number;
}

export interface OcrExtractResult {
  /** Echoes the resolved provider name, e.g. 'mock'. */
  provider: string;
  /** Full recognized text, normalized to UTF-8. */
  text: string;
  /** Structured key/value extractions (may be empty). */
  fields: OcrField[];
  /** Aggregate confidence 0..1. */
  confidence: number;
  /** Provider-side processing time in ms (for audit duration_ms). */
  durationMs: number;
}

export interface OcrProvider {
  /** Name of this implementation, e.g. 'mock'. Recorded as provider_name. */
  readonly name: string;
  /** Runs OCR over the referenced file. Rejects with OcrProviderException on
   *  failure and OcrTimeoutException on deadline breach. */
  extract(input: OcrExtractInput): Promise<OcrExtractResult>;
}

import {
  InternalServerErrorException,
  NotFoundException,
  RequestTimeoutException,
} from '@nestjs/common';

/**
 * Raised when an OCR/AI provider backend fails. Like StorageException, it
 * carries a generic, vendor-neutral message so raw provider errors — which can
 * include endpoint, model, quota, or key details — never reach the client or
 * escape unscrubbed. The original error is logged server-side (summary only)
 * at the provider boundary (plan §3.4, §5.6).
 */
export class OcrProviderException extends InternalServerErrorException {
  constructor(operation: string) {
    super(`OCR operation failed: ${operation}`);
  }
}

export class AiProviderException extends InternalServerErrorException {
  constructor(operation: string) {
    super(`AI operation failed: ${operation}`);
  }
}

/**
 * Raised when a provider call exceeds its deadline. Distinct from
 * OcrProviderException (HTTP 408 vs 500) so callers and audit can attribute
 * timeouts separately (plan §3.5).
 */
export class OcrTimeoutException extends RequestTimeoutException {
  constructor(timeoutMs: number) {
    super(`OCR operation timed out after ${timeoutMs}ms`);
  }
}

export class AiTimeoutException extends RequestTimeoutException {
  constructor(timeoutMs: number) {
    super(`AI operation timed out after ${timeoutMs}ms`);
  }
}

/**
 * Raised when the file targeted by an OCR call is not visible to the caller —
 * wrong tenant, out of dataScope, deleted, or non-existent. Deliberately opaque
 * (a single 404 for all of these) so existence is never revealed across scope
 * boundaries (plan §6.4, §7.2).
 */
export class FileNotInScopeException extends NotFoundException {
  constructor() {
    super('File not found');
  }
}

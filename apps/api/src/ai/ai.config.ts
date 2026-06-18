/**
 * Selects which AI/OCR provider implementation is wired (plan §3.6). The only
 * value this phase accepts is `mock`. Real DeepSeek/OpenAI/OCR vendors require
 * explicit approval (CLAUDE.md §7) and are NOT reachable through config — an
 * unknown / unapproved name fails fast at startup rather than silently falling
 * back to a real vendor.
 */

export const SUPPORTED_AI_OCR_PROVIDERS = ['mock'] as const;
export type AiOcrProviderName = (typeof SUPPORTED_AI_OCR_PROVIDERS)[number];

/** Env var that selects the provider. Defaults to `mock` when unset. */
export const AI_OCR_PROVIDER_ENV = 'AI_OCR_PROVIDER';

/**
 * Resolves the configured provider name, defaulting to `mock`. Throws at
 * startup on any value outside the supported set, so a typo or an
 * unapproved vendor name can never start the app on a real backend.
 */
export function resolveAiOcrProviderName(): AiOcrProviderName {
  const raw = process.env[AI_OCR_PROVIDER_ENV]?.trim() || 'mock';
  if (!SUPPORTED_AI_OCR_PROVIDERS.includes(raw as AiOcrProviderName)) {
    throw new Error(
      `Unsupported ${AI_OCR_PROVIDER_ENV}=${raw}. ` +
        `Supported: ${SUPPORTED_AI_OCR_PROVIDERS.join(', ')}. ` +
        `Real providers require explicit approval (CLAUDE.md §7).`,
    );
  }
  return raw as AiOcrProviderName;
}

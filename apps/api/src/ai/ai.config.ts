/** Provider selection and fail-closed DeepSeek configuration. */

export const SUPPORTED_AI_OCR_PROVIDERS = ['mock'] as const;
export type AiOcrProviderName = (typeof SUPPORTED_AI_OCR_PROVIDERS)[number];

export const SUPPORTED_AI_TEXT_PROVIDERS = ['mock', 'deepseek'] as const;
export type AiTextProviderName = (typeof SUPPORTED_AI_TEXT_PROVIDERS)[number];

export const AI_OCR_PROVIDER_ENV = 'AI_OCR_PROVIDER';
export const AI_TEXT_PROVIDER_ENV = 'AI_TEXT_PROVIDER';
export const DEEPSEEK_API_URL_ENV = 'DEEPSEEK_API_URL';
export const DEEPSEEK_MODEL_ENV = 'DEEPSEEK_MODEL';
export const DEEPSEEK_API_KEY_ENV = 'DEEPSEEK_API_KEY';
export const DEEPSEEK_TEST_BUDGET_CNY_ENV = 'DEEPSEEK_TEST_BUDGET_CNY';
export const DEEPSEEK_TEST_MAX_CALLS_ENV = 'DEEPSEEK_TEST_MAX_CALLS';

export const DEEPSEEK_OFFICIAL_API_URL = 'https://api.deepseek.com/chat/completions';
export const DEEPSEEK_APPROVED_MODEL = 'deepseek-chat';
export const DEEPSEEK_APPROVED_BUDGET_CNY = 1;
export const DEEPSEEK_MAX_TEST_CALLS = 5;

export interface DeepSeekConfig {
  apiUrl: string;
  model: typeof DEEPSEEK_APPROVED_MODEL;
  apiKey: string;
  budgetCny: number;
  maxCalls: number;
}

function requireValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required ${name} for DeepSeek provider`);
  return value;
}

function requirePositiveNumber(env: NodeJS.ProcessEnv, name: string): number {
  const raw = requireValue(env, name);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

export function resolveAiOcrProviderName(env: NodeJS.ProcessEnv = process.env): AiOcrProviderName {
  const raw = env[AI_OCR_PROVIDER_ENV]?.trim() || 'mock';
  if (!SUPPORTED_AI_OCR_PROVIDERS.includes(raw as AiOcrProviderName)) {
    throw new Error(
      `Unsupported ${AI_OCR_PROVIDER_ENV}=${raw}. Supported: ${SUPPORTED_AI_OCR_PROVIDERS.join(', ')}`,
    );
  }
  return raw as AiOcrProviderName;
}

export function resolveAiTextProviderName(
  env: NodeJS.ProcessEnv = process.env,
): AiTextProviderName {
  const raw = env[AI_TEXT_PROVIDER_ENV]?.trim() || 'mock';
  if (!SUPPORTED_AI_TEXT_PROVIDERS.includes(raw as AiTextProviderName)) {
    throw new Error(
      `Unsupported ${AI_TEXT_PROVIDER_ENV}=${raw}. Supported: ${SUPPORTED_AI_TEXT_PROVIDERS.join(', ')}`,
    );
  }
  return raw as AiTextProviderName;
}

/**
 * DeepSeek is approved only for official-API, synthetic-data verification.
 * Endpoint, model, key and spend controls are all explicit so a typo cannot
 * silently redirect data, select a more expensive model, or remove the cap.
 */
export function resolveDeepSeekConfig(env: NodeJS.ProcessEnv = process.env): DeepSeekConfig {
  const apiUrl = requireValue(env, DEEPSEEK_API_URL_ENV);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(apiUrl);
  } catch {
    throw new Error(`${DEEPSEEK_API_URL_ENV} must be a valid URL`);
  }
  if (
    parsedUrl.protocol !== 'https:' ||
    parsedUrl.hostname !== 'api.deepseek.com' ||
    parsedUrl.port !== '' ||
    parsedUrl.pathname.replace(/\/$/, '') !== '/chat/completions' ||
    parsedUrl.search !== '' ||
    parsedUrl.hash !== '' ||
    parsedUrl.username !== '' ||
    parsedUrl.password !== ''
  ) {
    throw new Error(`${DEEPSEEK_API_URL_ENV} must be the approved official HTTPS endpoint`);
  }

  const model = requireValue(env, DEEPSEEK_MODEL_ENV);
  if (model !== DEEPSEEK_APPROVED_MODEL) {
    throw new Error(`${DEEPSEEK_MODEL_ENV} must be ${DEEPSEEK_APPROVED_MODEL}`);
  }

  const apiKey = requireValue(env, DEEPSEEK_API_KEY_ENV);
  const budgetCny = requirePositiveNumber(env, DEEPSEEK_TEST_BUDGET_CNY_ENV);
  if (budgetCny > DEEPSEEK_APPROVED_BUDGET_CNY) {
    throw new Error(
      `${DEEPSEEK_TEST_BUDGET_CNY_ENV} exceeds approved CNY ${DEEPSEEK_APPROVED_BUDGET_CNY} cap`,
    );
  }

  const maxCalls = requirePositiveNumber(env, DEEPSEEK_TEST_MAX_CALLS_ENV);
  if (!Number.isInteger(maxCalls) || maxCalls > DEEPSEEK_MAX_TEST_CALLS) {
    throw new Error(
      `${DEEPSEEK_TEST_MAX_CALLS_ENV} must be an integer from 1 to ${DEEPSEEK_MAX_TEST_CALLS}`,
    );
  }

  return {
    apiUrl: parsedUrl.toString(),
    model: DEEPSEEK_APPROVED_MODEL,
    apiKey,
    budgetCny,
    maxCalls,
  };
}
